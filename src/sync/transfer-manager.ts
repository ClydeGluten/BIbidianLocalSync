import { base64ToBytes, bytesToBase64 } from "../crypto/encoding";
import { sha256Bytes } from "../crypto/hash";
import type { ManifestEntry } from "../model";
import type { FileBeginMessage, FileChunkMessage } from "../protocol/messages";
import type { SecurePeer } from "../network/secure-peer";
import type { SyncFileStore } from "./file-store";
import type { ApplyResult, SyncEngine } from "./engine";

const DEFAULT_CHUNK_SIZE = 192 * 1024;

interface IncomingTransfer {
  peerDeviceId: string;
  entry: ManifestEntry;
  chunkCount: number;
  chunks: Uint8Array[];
  receivedBytes: number;
  nextIndex: number;
  transactionId?: string;
}

export type CompletedTransfer =
  | { type: "applied"; result: ApplyResult }
  | { type: "staged"; transactionId: string; entry: ManifestEntry; content: ArrayBuffer };

export class TransferManager {
  private readonly incoming = new Map<string, IncomingTransfer>();

  constructor(
    private readonly engine: SyncEngine,
    private readonly files: SyncFileStore,
    private readonly maxFileSizeBytes: number,
    private readonly maxConcurrentIncoming = 8,
    private readonly chunkSize = DEFAULT_CHUNK_SIZE
  ) {}

  async sendFile(
    peer: SecurePeer,
    entry: ManifestEntry,
    requestId: string = crypto.randomUUID(),
    transactionId?: string
  ): Promise<void> {
    if (entry.kind === "deleted") {
      await peer.send({ type: "DELETE", requestId, entry });
      return;
    }
    const content = await this.files.read(entry.path);
    if (content.byteLength !== entry.size || await sha256Bytes(content) !== entry.contentHash) {
      throw new Error(`Refusing to send stale file metadata for ${entry.path}`);
    }
    const bytes = new Uint8Array(content);
    const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / this.chunkSize));
    await peer.send({
      type: "FILE_BEGIN",
      requestId,
      entry,
      chunkCount,
      transferSize: bytes.byteLength,
      transactionId
    });
    for (let index = 0; index < chunkCount; index++) {
      const chunk = bytes.subarray(index * this.chunkSize, Math.min((index + 1) * this.chunkSize, bytes.length));
      await peer.send({ type: "FILE_CHUNK", requestId, index, data: bytesToBase64(chunk) });
    }
    await peer.send({ type: "FILE_END", requestId });
  }

  begin(peer: SecurePeer, message: FileBeginMessage): void {
    if (this.incoming.has(message.requestId)) throw new Error("Duplicate transfer request ID");
    if (this.incoming.size >= this.maxConcurrentIncoming) throw new Error("Too many concurrent incoming transfers");
    if (message.transferSize !== message.entry.size || message.transferSize > this.maxFileSizeBytes) {
      throw new Error("Incoming transfer exceeds its declared or configured size");
    }
    const maximumChunks = Math.max(1, Math.ceil(message.transferSize / this.chunkSize));
    if (message.chunkCount !== maximumChunks) throw new Error("Invalid transfer chunk count");
    this.incoming.set(message.requestId, {
      peerDeviceId: peer.deviceId,
      entry: message.entry,
      chunkCount: message.chunkCount,
      chunks: [],
      receivedBytes: 0,
      nextIndex: 0,
      transactionId: message.transactionId
    });
  }

  addChunk(peer: SecurePeer, message: FileChunkMessage): void {
    const transfer = this.incoming.get(message.requestId);
    if (!transfer) throw new Error("File chunk has no transfer header");
    if (transfer.peerDeviceId !== peer.deviceId) throw new Error("File chunk belongs to a different peer");
    if (message.index !== transfer.nextIndex || message.index >= transfer.chunkCount) {
      throw new Error("File chunks must arrive exactly once and in order");
    }
    const chunk = base64ToBytes(message.data);
    const expectedMaximum = Math.min(this.chunkSize, transfer.entry.size - transfer.receivedBytes);
    if (chunk.byteLength > expectedMaximum || transfer.receivedBytes + chunk.byteLength > transfer.entry.size) {
      throw new Error("Incoming chunk exceeds its declared transfer size");
    }
    transfer.chunks.push(chunk);
    transfer.receivedBytes += chunk.byteLength;
    transfer.nextIndex += 1;
  }

  async finish(peer: SecurePeer, requestId: string): Promise<CompletedTransfer> {
    const transfer = this.incoming.get(requestId);
    if (!transfer) throw new Error("File transfer has no header");
    if (transfer.peerDeviceId !== peer.deviceId) throw new Error("File transfer belongs to a different peer");
    this.incoming.delete(requestId);
    if (
      transfer.nextIndex !== transfer.chunkCount ||
      transfer.receivedBytes !== transfer.entry.size
    ) throw new Error("File transfer ended before all content arrived");

    const joined = new Uint8Array(transfer.receivedBytes);
    let offset = 0;
    for (const chunk of transfer.chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (transfer.transactionId) {
      return {
        type: "staged",
        transactionId: transfer.transactionId,
        entry: transfer.entry,
        content: joined.buffer
      };
    }
    return {
      type: "applied",
      result: await this.engine.applyFile(transfer.entry, joined.buffer, transfer.peerDeviceId)
    };
  }

  abortPeer(deviceId: string): void {
    for (const [requestId, transfer] of this.incoming) {
      if (transfer.peerDeviceId === deviceId) this.incoming.delete(requestId);
    }
  }
}
