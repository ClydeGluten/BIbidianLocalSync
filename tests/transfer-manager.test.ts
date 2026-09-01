import { describe, expect, it, vi } from "vitest";
import { sha256Bytes } from "../src/crypto/hash";
import type { ManifestEntry } from "../src/model";
import type { SecurePeer } from "../src/network/secure-peer";
import type { SecureMessage } from "../src/protocol/messages";
import type { SyncFileStore } from "../src/sync/file-store";
import type { SyncEngine } from "../src/sync/engine";
import { TransferManager } from "../src/sync/transfer-manager";

const encoder = new TextEncoder();

describe("TransferManager", () => {
  it("chunks and reconstructs binary content before applying it", async () => {
    const content = encoder.encode("abcdefghij").buffer;
    const entry: ManifestEntry = {
      path: "asset.bin",
      kind: "binary",
      contentHash: await sha256Bytes(content),
      size: content.byteLength,
      version: { "device-source-1234": 1 },
      changedAt: 1
    };
    const sent: SecureMessage[] = [];
    const peer: SecurePeer = {
      deviceId: "device-source-1234",
      vaultId: "vault-id-1234",
      send: async (message) => { sent.push(message); },
      close: () => undefined
    };
    const files = { read: async () => content.slice(0) } as unknown as SyncFileStore;
    const applied: ArrayBuffer[] = [];
    const applyFile = vi.fn(async (_entry: ManifestEntry, received: ArrayBuffer) => {
      applied.push(received);
      return { status: "APPLIED" as const, path: entry.path, state: entry };
    });
    const engine = { applyFile } as unknown as SyncEngine;
    const sender = new TransferManager(engine, files, 100, 2, 4);
    await sender.sendFile(peer, entry, "request-1234");

    const receiver = new TransferManager(engine, files, 100, 2, 4);
    for (const message of sent) {
      if (message.type === "FILE_BEGIN") receiver.begin(peer, message);
      if (message.type === "FILE_CHUNK") receiver.addChunk(peer, message);
    }
    const result = await receiver.finish(peer, "request-1234");
    expect(result.type).toBe("applied");
    if (result.type !== "applied") throw new Error("expected applied transfer");
    expect(result.result.status).toBe("APPLIED");
    expect(applyFile).toHaveBeenCalledOnce();
    expect(new Uint8Array(applied[0]!)).toEqual(new Uint8Array(content));
  });

  it("rejects out-of-order chunks", async () => {
    const content = encoder.encode("abcdefgh").buffer;
    const entry: ManifestEntry = {
      path: "asset.bin",
      kind: "binary",
      contentHash: await sha256Bytes(content),
      size: 8,
      version: { "device-source-1234": 1 },
      changedAt: 1
    };
    const peer = { deviceId: "device-source-1234" } as SecurePeer;
    const manager = new TransferManager({} as SyncEngine, {} as SyncFileStore, 100, 2, 4);
    manager.begin(peer, { type: "FILE_BEGIN", requestId: "request-1234", entry, chunkCount: 2, transferSize: 8 });
    expect(() => manager.addChunk(peer, {
      type: "FILE_CHUNK",
      requestId: "request-1234",
      index: 1,
      data: "YQ=="
    }))
      .toThrow(/order/);
  });

  it("does not let another peer append to an in-flight transfer", async () => {
    const content = encoder.encode("abcd").buffer;
    const entry: ManifestEntry = {
      path: "asset.bin",
      kind: "binary",
      contentHash: await sha256Bytes(content),
      size: 4,
      version: { "device-source-1234": 1 },
      changedAt: 1
    };
    const owner = { deviceId: "device-source-1234" } as SecurePeer;
    const other = { deviceId: "device-other-1234" } as SecurePeer;
    const manager = new TransferManager({} as SyncEngine, {} as SyncFileStore, 100, 2, 4);
    manager.begin(owner, {
      type: "FILE_BEGIN",
      requestId: "request-1234",
      entry,
      chunkCount: 1,
      transferSize: 4
    });

    expect(() => manager.addChunk(other, {
      type: "FILE_CHUNK",
      requestId: "request-1234",
      index: 0,
      data: "YWJjZA=="
    })).toThrow(/different peer/);
    await expect(manager.finish(other, "request-1234")).rejects.toThrow(/different peer/);
  });
});
