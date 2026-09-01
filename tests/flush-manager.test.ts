import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import { BackupManager } from "../src/storage/backup-manager";
import type { ListedFile, SyncFileStore, WrittenFile } from "../src/sync/file-store";
import { FlushManager } from "../src/sync/flush-manager";
import { SyncEngine } from "../src/sync/engine";
import { createMetadata, MetadataRepository } from "../src/sync/metadata-repository";
import { PathPolicy } from "../src/sync/path-policy";
import type { SecurePeer } from "../src/network/secure-peer";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function buffer(value: string): ArrayBuffer {
  return encoder.encode(value).buffer;
}

class MemoryAdapter {
  readonly directories = new Set<string>();
  readonly text = new Map<string, string>();
  readonly binary = new Map<string, ArrayBuffer>();

  async exists(path: string): Promise<boolean> {
    return this.directories.has(path) || this.text.has(path) || this.binary.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async write(path: string, value: string): Promise<void> {
    this.text.set(path, value);
  }

  async read(path: string): Promise<string> {
    const value = this.text.get(path);
    if (value === undefined) throw new Error(`missing ${path}`);
    return value;
  }

  async writeBinary(path: string, value: ArrayBuffer): Promise<void> {
    this.binary.set(path, value.slice(0));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.binary.get(path);
    if (!value) throw new Error(`missing ${path}`);
    return value.slice(0);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path}/`;
    const files = [...this.text.keys(), ...this.binary.keys()]
      .filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/"));
    const folders = [...this.directories]
      .filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/"));
    return { files, folders };
  }

  async rmdir(path: string): Promise<void> {
    const prefix = `${path}/`;
    for (const item of [...this.directories]) if (item === path || item.startsWith(prefix)) this.directories.delete(item);
    for (const item of [...this.text.keys()]) if (item.startsWith(prefix)) this.text.delete(item);
    for (const item of [...this.binary.keys()]) if (item.startsWith(prefix)) this.binary.delete(item);
  }
}

class MemoryFiles implements SyncFileStore {
  private clock = 1;
  readonly values = new Map<string, ArrayBuffer>();
  readonly mtimes = new Map<string, number>();

  constructor(initial: Record<string, string>) {
    for (const [path, value] of Object.entries(initial)) {
      this.values.set(path, buffer(value));
      this.mtimes.set(path, this.clock++);
    }
  }

  async list(): Promise<ListedFile[]> {
    return [...this.values.keys()].map((path) => this.describe(path));
  }

  async read(path: string): Promise<ArrayBuffer> {
    const value = this.values.get(path);
    if (!value) throw new Error("missing");
    return value.slice(0);
  }

  async write(path: string, content: ArrayBuffer): Promise<WrittenFile> {
    this.values.set(path, content.slice(0));
    this.mtimes.set(path, this.clock++);
    const stat = this.describe(path);
    return { size: stat.size, mtime: stat.mtime };
  }

  async trash(path: string): Promise<void> {
    this.values.delete(path);
    this.mtimes.delete(path);
  }

  async stat(path: string): Promise<ListedFile | null> {
    return this.values.has(path) ? this.describe(path) : null;
  }

  conflictPath(path: string): string {
    return `${path}.conflict`;
  }

  value(path: string): string | null {
    const value = this.values.get(path);
    return value ? decoder.decode(value) : null;
  }

  private describe(path: string): ListedFile {
    const value = this.values.get(path)!;
    return { path, kind: "text", size: value.byteLength, mtime: this.mtimes.get(path)! };
  }
}

function engineFor(files: MemoryFiles, deviceId: string, policy: PathPolicy): SyncEngine {
  return new SyncEngine(
    files,
    new MetadataRepository(createMetadata(deviceId, "vault-id-1234"), async () => undefined),
    policy
  );
}

describe("transactional flush", () => {
  it("backs up, stages, verifies, commits, and remains restorable", async () => {
    const policy = new PathPolicy({ configDir: ".obsidian", ignoredPathPrefixes: [] });
    const hostFiles = new MemoryFiles({ "note.md": "host version" });
    const clientFiles = new MemoryFiles({ "note.md": "client version", "extra.md": "keep in backup" });
    const hostEngine = engineFor(hostFiles, "host-device-1234", policy);
    const clientEngine = engineFor(clientFiles, "client-device-1234", policy);
    const hostManifest = await hostEngine.scan();
    await clientEngine.scan();

    const adapter = new MemoryAdapter();
    const backups = new BackupManager(
      adapter as unknown as DataAdapter,
      ".obsidian",
      clientFiles,
      policy,
      5
    );
    const flush = new FlushManager(clientEngine, backups, policy, () => true);
    const peer = {
      deviceId: "host-device-1234",
      vaultId: "vault-id-1234",
      send: async () => undefined,
      close: () => undefined
    } as SecurePeer;
    const transactionId = "transaction-1234";
    const ready = await flush.prepare(peer, {
      type: "FLUSH_PREPARE",
      requestId: transactionId,
      sourceDeviceId: peer.deviceId,
      entries: hostManifest
    });
    expect(ready.status).toBe("READY");
    expect(ready.requestedPaths).toEqual(["note.md"]);

    const hostContent = await hostFiles.read("note.md");
    await flush.stage(peer, transactionId, hostManifest[0]!, hostContent);
    const committed = await flush.commit(peer, transactionId);
    expect(committed.status).toBe("COMMITTED");
    expect(clientFiles.value("note.md")).toBe("host version");
    expect(clientFiles.value("extra.md")).toBeNull();

    await backups.restore(committed.backupId!);
    expect(clientFiles.value("note.md")).toBe("client version");
    expect(clientFiles.value("extra.md")).toBe("keep in backup");
  });

  it("aborts before mutation when an affected local file changes after preparation", async () => {
    const policy = new PathPolicy({ configDir: ".obsidian", ignoredPathPrefixes: [] });
    const hostFiles = new MemoryFiles({ "note.md": "host version" });
    const clientFiles = new MemoryFiles({ "note.md": "client version" });
    const hostEngine = engineFor(hostFiles, "host-device-1234", policy);
    const clientEngine = engineFor(clientFiles, "client-device-1234", policy);
    const hostManifest = await hostEngine.scan();
    await clientEngine.scan();

    const backups = new BackupManager(
      new MemoryAdapter() as unknown as DataAdapter,
      ".obsidian",
      clientFiles,
      policy,
      5
    );
    const flush = new FlushManager(clientEngine, backups, policy, () => true);
    const peer = {
      deviceId: "host-device-1234",
      vaultId: "vault-id-1234",
      send: async () => undefined,
      close: () => undefined
    } as SecurePeer;
    const transactionId = "transaction-1234";
    await flush.prepare(peer, {
      type: "FLUSH_PREPARE",
      requestId: transactionId,
      sourceDeviceId: peer.deviceId,
      entries: hostManifest
    });
    await flush.stage(peer, transactionId, hostManifest[0]!, await hostFiles.read("note.md"));
    await clientFiles.write("note.md", buffer("new local edit"));

    const result = await flush.commit(peer, transactionId);
    expect(result.status).toBe("ABORTED");
    expect(result.message).toMatch(/changed after preparation/);
    expect(clientFiles.value("note.md")).toBe("new local edit");
  });
});
