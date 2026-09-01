import { describe, expect, it } from "vitest";
import { sha256Bytes } from "../src/crypto/hash";
import type { ManifestEntry } from "../src/model";
import type { ListedFile, SyncFileStore, WrittenFile } from "../src/sync/file-store";
import { SyncEngine } from "../src/sync/engine";
import { createMetadata, MetadataRepository } from "../src/sync/metadata-repository";
import { PathPolicy } from "../src/sync/path-policy";

const encoder = new TextEncoder();

function bytes(text: string): ArrayBuffer {
  return encoder.encode(text).buffer;
}

class MemoryFiles implements SyncFileStore {
  private clock = 100;
  readonly content = new Map<string, ArrayBuffer>();
  readonly mtimes = new Map<string, number>();
  readonly trashed: string[] = [];

  constructor(initial: Record<string, string> = {}) {
    for (const [path, value] of Object.entries(initial)) {
      this.content.set(path, bytes(value));
      this.mtimes.set(path, this.clock++);
    }
  }

  async list(): Promise<ListedFile[]> {
    return [...this.content.keys()].map((path) => this.describe(path));
  }

  async read(path: string): Promise<ArrayBuffer> {
    const content = this.content.get(path);
    if (!content) throw new Error("missing");
    return content.slice(0);
  }

  async write(path: string, content: ArrayBuffer): Promise<WrittenFile> {
    this.content.set(path, content.slice(0));
    this.mtimes.set(path, this.clock++);
    const listed = this.describe(path);
    return { size: listed.size, mtime: listed.mtime };
  }

  async trash(path: string): Promise<void> {
    if (this.content.delete(path)) this.trashed.push(path);
    this.mtimes.delete(path);
  }

  async stat(path: string): Promise<ListedFile | null> {
    return this.content.has(path) ? this.describe(path) : null;
  }

  conflictPath(path: string, sourceDeviceId: string): string {
    const dot = path.lastIndexOf(".");
    const stem = dot > 0 ? path.slice(0, dot) : path;
    const extension = dot > 0 ? path.slice(dot) : "";
    return `${stem}_conflict_${sourceDeviceId}${extension}`;
  }

  touch(path: string): void {
    this.mtimes.set(path, this.clock++);
  }

  private describe(path: string): ListedFile {
    const content = this.content.get(path)!;
    return {
      path,
      kind: path.endsWith(".md") ? "text" : "binary",
      size: content.byteLength,
      mtime: this.mtimes.get(path)!
    };
  }
}

function setup(initial: Record<string, string>, deviceId = "device-local-1234") {
  const files = new MemoryFiles(initial);
  const metadata = createMetadata(deviceId, "vault-id-1234");
  const repository = new MetadataRepository(metadata, async () => undefined);
  const policy = new PathPolicy({ configDir: ".obsidian", ignoredPathPrefixes: [] });
  return { files, metadata, engine: new SyncEngine(files, repository, policy) };
}

describe("SyncEngine", () => {
  it("does not create a new revision when only mtime changes", async () => {
    const { engine, files, metadata } = setup({ "note.md": "same" });
    await engine.scan();
    expect(metadata.localCounter).toBe(1);
    files.touch("note.md");
    await engine.scan();
    expect(metadata.localCounter).toBe(1);
  });

  it("merges vectors for identical content instead of transferring it", async () => {
    const { engine } = setup({ "note.md": "same" });
    const [local] = await engine.scan();
    const remote: ManifestEntry = {
      ...local!,
      version: { ...local!.version, "device-remote-1234": 4 }
    };
    expect(await engine.reconcile([remote])).toEqual([]);
    expect(engine.manifest()[0]!.version).toEqual({
      "device-local-1234": 1,
      "device-remote-1234": 4
    });
  });

  it("preserves concurrent incoming content as a conflict file", async () => {
    const { engine, files } = setup({ "note.md": "local" });
    await engine.scan();
    const remoteContent = bytes("remote");
    const remote: ManifestEntry = {
      path: "note.md",
      kind: "text",
      contentHash: await sha256Bytes(remoteContent),
      size: remoteContent.byteLength,
      version: { "device-remote-1234": 1 },
      changedAt: 123
    };
    const result = await engine.applyFile(remote, remoteContent, "device-remote-1234");
    expect(result.status).toBe("CONFLICT");
    expect(files.content.has("note_conflict_device-remote-1234.md")).toBe(true);
    expect(new TextDecoder().decode(await files.read("note.md"))).toBe("local");
  });

  it("refuses a concurrent deletion and preserves the local file", async () => {
    const { engine, files } = setup({ "note.md": "local" });
    await engine.scan();
    const result = await engine.applyDelete({
      path: "note.md",
      kind: "deleted",
      contentHash: null,
      size: 0,
      version: { "device-remote-1234": 1 },
      changedAt: 123
    });
    expect(result.status).toBe("CONFLICT");
    expect(files.trashed).toEqual([]);
    expect(files.content.has("note.md")).toBe(true);
  });
});
