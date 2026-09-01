import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { FileKind } from "../model";
import type { ListedFile, SyncFileStore, WrittenFile } from "../sync/file-store";
import { PathPolicy } from "../sync/path-policy";

const TEXT_EXTENSIONS = new Set([
  "canvas", "css", "csv", "htm", "html", "js", "json", "jsx", "md", "mdx",
  "mermaid", "scss", "svg", "toml", "ts", "tsx", "txt", "xml", "yaml", "yml"
]);

function kindFor(file: TFile): Exclude<FileKind, "deleted"> {
  return TEXT_EXTENSIONS.has(file.extension.toLowerCase()) ? "text" : "binary";
}

export class VaultFileStore implements SyncFileStore {
  constructor(
    private readonly app: App,
    private readonly policy: PathPolicy,
    private readonly maxFileSizeBytes: number,
    private readonly beforeRemoteMutation?: (path: string) => void
  ) {}

  async list(): Promise<ListedFile[]> {
    return this.app.vault.getFiles()
      .filter((file) => this.policy.allows(file.path))
      .map((file) => this.describe(file));
  }

  async read(path: string): Promise<ArrayBuffer> {
    const normalized = this.policy.normalizeAndValidate(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!(file instanceof TFile)) throw new Error(`File does not exist: ${normalized}`);
    if (file.stat.size > this.maxFileSizeBytes) throw new Error(`File exceeds the configured limit: ${normalized}`);
    return this.app.vault.readBinary(file);
  }

  async write(path: string, content: ArrayBuffer): Promise<WrittenFile> {
    const normalized = this.policy.normalizeAndValidate(path);
    if (content.byteLength > this.maxFileSizeBytes) throw new Error(`File exceeds the configured limit: ${normalized}`);
    await this.ensureParentFolders(normalized);
    this.beforeRemoteMutation?.(normalized);
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    let file: TFile;
    if (existing instanceof TFolder) throw new Error(`A folder already exists at the file path: ${normalized}`);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, content);
      file = existing;
    } else {
      file = await this.app.vault.createBinary(normalized, content);
    }
    return { size: file.stat.size, mtime: file.stat.mtime };
  }

  async trash(path: string): Promise<void> {
    const normalized = this.policy.normalizeAndValidate(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    if (!file) return;
    if (!(file instanceof TFile)) throw new Error(`Refusing to trash a non-file path: ${normalized}`);
    this.beforeRemoteMutation?.(normalized);
    await this.app.fileManager.trashFile(file);
  }

  async stat(path: string): Promise<ListedFile | null> {
    const normalized = this.policy.normalizeAndValidate(path);
    const file = this.app.vault.getAbstractFileByPath(normalized);
    return file instanceof TFile ? this.describe(file) : null;
  }

  conflictPath(path: string, sourceDeviceId: string, changedAt: number): string {
    const normalized = this.policy.normalizeAndValidate(path);
    const slash = normalized.lastIndexOf("/");
    const directory = slash >= 0 ? normalized.slice(0, slash + 1) : "";
    const filename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
    const dot = filename.lastIndexOf(".");
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const extension = dot > 0 ? filename.slice(dot) : "";
    const device = sourceDeviceId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12) || "peer";
    const timestamp = new Date(changedAt).toISOString().replace(/[:.]/g, "-");
    return normalizePath(`${directory}${stem}_conflict_${device}_${timestamp}${extension}`);
  }

  private describe(file: TFile): ListedFile {
    return {
      path: file.path,
      kind: kindFor(file),
      size: file.stat.size,
      mtime: file.stat.mtime
    };
  }

  private async ensureParentFolders(path: string): Promise<void> {
    const segments = path.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFile) throw new Error(`A file blocks the parent folder: ${current}`);
      if (!existing) {
        try {
          await this.app.vault.createFolder(current);
        } catch (error) {
          if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error;
        }
      }
    }
  }
}
