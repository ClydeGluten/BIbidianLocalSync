import { sha256Bytes } from "../crypto/hash";
import type { ManifestEntry } from "../model";
import type {
  FlushPrepareMessage,
  FlushResultMessage
} from "../protocol/messages";
import type { SecurePeer } from "../network/secure-peer";
import type { BackupManager } from "../storage/backup-manager";
import type { SyncEngine } from "./engine";
import { PathPolicy } from "./path-policy";

interface StagedFile {
  entry: ManifestEntry;
  storageName: string;
}

interface IncomingFlush {
  peerDeviceId: string;
  entries: Map<string, ManifestEntry>;
  requestedPaths: Set<string>;
  deletePaths: string[];
  affectedPaths: string[];
  baselineHashes: Map<string, string | null>;
  staged: Map<string, StagedFile>;
  backupId: string;
}

interface OutgoingFlush {
  peerDeviceId: string;
  entries: Map<string, ManifestEntry>;
}

export type SendTransactionalFile = (
  peer: SecurePeer,
  entry: ManifestEntry,
  requestId: string,
  transactionId: string
) => Promise<void>;

export class FlushManager {
  private readonly incoming = new Map<string, IncomingFlush>();
  private readonly outgoing = new Map<string, OutgoingFlush>();

  constructor(
    private readonly engine: SyncEngine,
    private readonly backups: BackupManager,
    private readonly pathPolicy: PathPolicy,
    private readonly allowIncoming: () => boolean
  ) {}

  async start(peer: SecurePeer, entries: readonly ManifestEntry[]): Promise<string> {
    const requestId = crypto.randomUUID();
    const byPath = this.fileEntries(entries);
    this.outgoing.set(requestId, { peerDeviceId: peer.deviceId, entries: byPath });
    await peer.send({
      type: "FLUSH_PREPARE",
      requestId,
      sourceDeviceId: this.engine.deviceId,
      entries: [...byPath.values()]
    });
    return requestId;
  }

  async prepare(peer: SecurePeer, message: FlushPrepareMessage): Promise<FlushResultMessage> {
    if (!this.allowIncoming()) throw new Error("This device does not accept incoming flush operations");
    if (message.sourceDeviceId !== peer.deviceId) throw new Error("Flush source does not match its authenticated peer");
    if (this.incoming.has(message.requestId)) throw new Error("Duplicate flush transaction");

    await this.engine.scan();
    const desired = this.fileEntries(message.entries);
    const local = new Map(
      this.engine.manifest()
        .filter((entry) => entry.kind !== "deleted")
        .map((entry) => [entry.path, entry])
    );
    const requestedPaths = new Set<string>();
    for (const [path, entry] of desired) {
      const current = local.get(path);
      if (!current || current.kind !== entry.kind || current.contentHash !== entry.contentHash) {
        requestedPaths.add(path);
      }
    }
    const deletePaths = [...local.keys()].filter((path) => !desired.has(path));
    const affected = [...new Set([...requestedPaths, ...deletePaths])];
    const baselineHashes = new Map(
      affected.map((path) => [path, local.get(path)?.contentHash ?? null])
    );
    const backup = await this.backups.create(affected);
    await this.backups.createStaging(message.requestId);
    this.incoming.set(message.requestId, {
      peerDeviceId: peer.deviceId,
      entries: desired,
      requestedPaths,
      deletePaths,
      affectedPaths: affected,
      baselineHashes,
      staged: new Map(),
      backupId: backup.id
    });
    return {
      type: "FLUSH_RESULT",
      requestId: message.requestId,
      status: "READY",
      requestedPaths: [...requestedPaths],
      backupId: backup.id
    };
  }

  async stage(
    peer: SecurePeer,
    transactionId: string,
    entry: ManifestEntry,
    content: ArrayBuffer
  ): Promise<void> {
    const transaction = this.requireIncoming(peer, transactionId);
    const expected = transaction.entries.get(entry.path);
    if (
      !expected || !transaction.requestedPaths.has(entry.path) || transaction.staged.has(entry.path) ||
      expected.contentHash !== entry.contentHash || expected.size !== entry.size || expected.kind !== entry.kind
    ) throw new Error("Unexpected file in flush transaction");
    if (content.byteLength !== entry.size || await sha256Bytes(content) !== entry.contentHash) {
      throw new Error("Flush file failed content verification");
    }
    const storageName = await this.backups.stage(
      transactionId,
      transaction.staged.size,
      content,
      entry.contentHash!
    );
    transaction.staged.set(entry.path, { entry, storageName });
  }

  async commit(peer: SecurePeer, transactionId: string): Promise<FlushResultMessage> {
    const transaction = this.requireIncoming(peer, transactionId);
    try {
      for (const path of transaction.requestedPaths) {
        if (!transaction.staged.has(path)) throw new Error(`Flush is missing staged file: ${path}`);
      }
      await this.engine.scan();
      const currentHashes = new Map(
        this.engine.manifest()
          .filter((entry) => entry.kind !== "deleted")
          .map((entry) => [entry.path, entry.contentHash])
      );
      for (const path of transaction.affectedPaths) {
        if ((currentHashes.get(path) ?? null) !== transaction.baselineHashes.get(path)) {
          await this.backups.discardStaging(transactionId);
          this.incoming.delete(transactionId);
          return {
            type: "FLUSH_RESULT",
            requestId: transactionId,
            status: "ABORTED",
            backupId: transaction.backupId,
            message: `Flush aborted because a local file changed after preparation: ${path}`
          };
        }
      }
      for (const path of [...transaction.requestedPaths].sort()) {
        const staged = transaction.staged.get(path)!;
        const content = await this.backups.readStaged(transactionId, staged.storageName);
        await this.engine.forceApplyFile(staged.entry, content, transaction.baselineHashes.get(path) ?? null);
      }
      for (const path of transaction.deletePaths.sort()) {
        await this.engine.forceDelete(path, transaction.baselineHashes.get(path) ?? null);
      }
      await this.backups.discardStaging(transactionId);
      this.incoming.delete(transactionId);
      return {
        type: "FLUSH_RESULT",
        requestId: transactionId,
        status: "COMMITTED",
        backupId: transaction.backupId,
        message: `Flush committed with verified backup ${transaction.backupId}`
      };
    } catch (error) {
      let rollbackMessage: string;
      try {
        const interrupted = await this.backups.create(transaction.affectedPaths, false);
        await this.backups.restore(transaction.backupId);
        await this.engine.scan();
        rollbackMessage = ` Interrupted state was preserved as ${interrupted.id}.`;
      } catch (rollbackError) {
        rollbackMessage = ` Automatic rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}.`;
      }
      await this.backups.discardStaging(transactionId).catch(() => undefined);
      this.incoming.delete(transactionId);
      return {
        type: "FLUSH_RESULT",
        requestId: transactionId,
        status: "ABORTED",
        backupId: transaction.backupId,
        message: `Flush failed: ${error instanceof Error ? error.message : String(error)}.${rollbackMessage}`
      };
    }
  }

  async handleResult(
    peer: SecurePeer,
    message: FlushResultMessage,
    sendFile: SendTransactionalFile
  ): Promise<void> {
    const transaction = this.outgoing.get(message.requestId);
    if (!transaction || transaction.peerDeviceId !== peer.deviceId) return;
    if (message.status === "READY") {
      if (!message.requestedPaths) throw new Error("Ready flush response omitted requested paths");
      for (const path of message.requestedPaths) {
        const normalized = this.pathPolicy.normalizeAndValidate(path);
        const entry = transaction.entries.get(normalized);
        if (!entry) throw new Error(`Peer requested a path absent from the flush source: ${normalized}`);
        await sendFile(peer, entry, crypto.randomUUID(), message.requestId);
      }
      await peer.send({ type: "FLUSH_COMMIT", requestId: message.requestId });
      return;
    }
    this.outgoing.delete(message.requestId);
  }

  async abort(peer: SecurePeer, transactionId: string, message: string): Promise<void> {
    const transaction = this.incoming.get(transactionId);
    if (transaction?.peerDeviceId === peer.deviceId) {
      await this.backups.discardStaging(transactionId);
      this.incoming.delete(transactionId);
    }
    this.outgoing.delete(transactionId);
    await peer.send({ type: "FLUSH_RESULT", requestId: transactionId, status: "ABORTED", message });
  }

  disconnected(deviceId: string): void {
    for (const [id, transaction] of this.outgoing) {
      if (transaction.peerDeviceId === deviceId) this.outgoing.delete(id);
    }
    for (const [id, transaction] of this.incoming) {
      if (transaction.peerDeviceId === deviceId) {
        void this.backups.discardStaging(id);
        this.incoming.delete(id);
      }
    }
  }

  private fileEntries(entries: readonly ManifestEntry[]): Map<string, ManifestEntry> {
    const result = new Map<string, ManifestEntry>();
    for (const entry of entries) {
      if (entry.kind === "deleted") continue;
      const path = this.pathPolicy.normalizeAndValidate(entry.path);
      if (path !== entry.path || result.has(path)) throw new Error(`Invalid or duplicate flush path: ${entry.path}`);
      result.set(path, entry);
    }
    return result;
  }

  private requireIncoming(peer: SecurePeer, transactionId: string): IncomingFlush {
    const transaction = this.incoming.get(transactionId);
    if (!transaction || transaction.peerDeviceId !== peer.deviceId) throw new Error("Unknown flush transaction");
    return transaction;
  }
}
