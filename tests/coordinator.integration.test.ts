import { describe, expect, it } from "vitest";
import type { ManifestEntry } from "../src/model";
import type { SecurePeer } from "../src/network/secure-peer";
import type { SecureMessage } from "../src/protocol/messages";
import type { BackupManager } from "../src/storage/backup-manager";
import { SyncCoordinator } from "../src/sync/coordinator";
import { SyncEngine } from "../src/sync/engine";
import type { ListedFile, SyncFileStore, WrittenFile } from "../src/sync/file-store";
import { createMetadata, MetadataRepository } from "../src/sync/metadata-repository";
import { PathPolicy } from "../src/sync/path-policy";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class PeerFiles implements SyncFileStore {
  private clock = 1;
  readonly values = new Map<string, ArrayBuffer>();
  readonly mtimes = new Map<string, number>();

  constructor(initial: Record<string, string>) {
    for (const [path, value] of Object.entries(initial)) {
      this.values.set(path, encoder.encode(value).buffer);
      this.mtimes.set(path, this.clock++);
    }
  }

  async list(): Promise<ListedFile[]> {
    return [...this.values.keys()].map((path) => this.describe(path));
  }

  async read(path: string): Promise<ArrayBuffer> {
    const value = this.values.get(path);
    if (!value) throw new Error(`missing ${path}`);
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

  conflictPath(path: string, sourceDeviceId: string): string {
    return `${path}.conflict-${sourceDeviceId}`;
  }

  text(path: string): string | null {
    const value = this.values.get(path);
    return value ? decoder.decode(value) : null;
  }

  private describe(path: string): ListedFile {
    const value = this.values.get(path)!;
    return { path, kind: "text", size: value.byteLength, mtime: this.mtimes.get(path)! };
  }
}

function createEngine(files: PeerFiles, deviceId: string, policy: PathPolicy): SyncEngine {
  return new SyncEngine(
    files,
    new MetadataRepository(createMetadata(deviceId, "vault-id-1234"), async () => undefined),
    policy
  );
}

describe("host-coordinated integration", () => {
  it("converges concurrent initial edits without overwriting either version", async () => {
    const policy = new PathPolicy({ configDir: ".obsidian", ignoredPathPrefixes: [] });
    const hostFiles = new PeerFiles({ "note.md": "host text" });
    const clientFiles = new PeerFiles({ "note.md": "client text" });
    const hostEngine = createEngine(hostFiles, "host-device-1234", policy);
    const clientEngine = createEngine(clientFiles, "client-device-1234", policy);
    await hostEngine.scan();
    await clientEngine.scan();

    const errors: Error[] = [];
    const callbacks = {
      onStatus: () => undefined,
      onConflict: () => undefined,
      onError: (error: Error) => { errors.push(error); }
    };
    const unusedBackups = {} as BackupManager;
    const host = new SyncCoordinator(
      hostEngine, hostFiles, 1024, unusedBackups, policy, () => true, () => false, callbacks
    );
    const client = new SyncCoordinator(
      clientEngine, clientFiles, 1024, unusedBackups, policy, () => false, () => true, callbacks
    );

    const clientViewOfHost: SecurePeer = {
      deviceId: "host-device-1234",
      vaultId: "vault-id-1234",
      send: async (message: SecureMessage) => host.handle(hostViewOfClient, message),
      close: () => undefined
    };
    const hostViewOfClient: SecurePeer = {
      deviceId: "client-device-1234",
      vaultId: "vault-id-1234",
      send: async (message: SecureMessage) => client.handle(clientViewOfHost, message),
      close: () => undefined
    };

    await host.authenticated(hostViewOfClient);
    await client.authenticated(clientViewOfHost);

    expect(errors).toEqual([]);
    expect(hostFiles.text("note.md")).toBe("host text");
    expect(clientFiles.text("note.md")).toBe("host text");
    const hostConflict = [...hostFiles.values.keys()].find((path) => path.includes("conflict"));
    const clientConflict = [...clientFiles.values.keys()].find((path) => path.includes("conflict"));
    expect(hostConflict).toBeTruthy();
    expect(clientConflict).toBe(hostConflict);
    expect(hostFiles.text(hostConflict!)).toBe("client text");
    expect(clientFiles.text(clientConflict!)).toBe("client text");

    const hostManifest: ManifestEntry[] = hostEngine.manifest();
    const clientManifest: ManifestEntry[] = clientEngine.manifest();
    expect(clientManifest.map((entry) => [entry.path, entry.contentHash]))
      .toEqual(hostManifest.map((entry) => [entry.path, entry.contentHash]));
  });
});
