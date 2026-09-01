import type { DataAdapter } from "obsidian";
import { sha256Bytes } from "../crypto/hash";
import type { SyncFileStore } from "../sync/file-store";
import { PathPolicy } from "../sync/path-policy";

interface BackupEntry {
  path: string;
  existed: boolean;
  size: number;
  contentHash: string | null;
  storageName: string | null;
}

interface BackupManifest {
  schemaVersion: 1;
  id: string;
  createdAt: number;
  entries: BackupEntry[];
}

export interface BackupSummary {
  id: string;
  createdAt: number;
  fileCount: number;
}

const SAFE_ID = /^[a-zA-Z0-9_-]{8,128}$/;

export class BackupManager {
  private readonly backupRoot: string;
  private readonly stagingRoot: string;

  constructor(
    private readonly adapter: DataAdapter,
    configDir: string,
    private readonly files: SyncFileStore,
    private readonly pathPolicy: PathPolicy,
    private readonly maxBackups: number
  ) {
    this.backupRoot = `${configDir}/local-vault-sync-backups`;
    this.stagingRoot = `${configDir}/local-vault-sync-staging`;
  }

  async create(paths: readonly string[], cleanup = true): Promise<BackupSummary> {
    const id = `backup_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const directory = `${this.backupRoot}/${id}`;
    await this.ensureDirectory(directory);
    const entries: BackupEntry[] = [];
    try {
      for (const [index, input] of [...new Set(paths)].sort().entries()) {
        const path = this.pathPolicy.normalizeAndValidate(input);
        const stat = await this.files.stat(path);
        if (!stat) {
          entries.push({ path, existed: false, size: 0, contentHash: null, storageName: null });
          continue;
        }
        const content = await this.files.read(path);
        const contentHash = await sha256Bytes(content);
        const storageName = `${index}.bin`;
        const storagePath = `${directory}/${storageName}`;
        await this.adapter.writeBinary(storagePath, content);
        const verified = await this.adapter.readBinary(storagePath);
        if (verified.byteLength !== content.byteLength || await sha256Bytes(verified) !== contentHash) {
          throw new Error(`Backup verification failed for ${path}`);
        }
        entries.push({ path, existed: true, size: content.byteLength, contentHash, storageName });
      }
      const manifest: BackupManifest = {
        schemaVersion: 1,
        id,
        createdAt: Date.now(),
        entries
      };
      await this.adapter.write(`${directory}/manifest.json`, JSON.stringify(manifest));
      const verifiedManifest = await this.readManifest(id);
      if (verifiedManifest.entries.length !== entries.length) throw new Error("Backup manifest verification failed");
      if (cleanup) await this.cleanupOldBackups();
      return { id, createdAt: manifest.createdAt, fileCount: entries.filter((entry) => entry.existed).length };
    } catch (error) {
      await this.removeDirectory(directory);
      throw error;
    }
  }

  async restore(id: string): Promise<void> {
    const manifest = await this.readManifest(id);
    const staged = new Map<string, ArrayBuffer | null>();
    for (const entry of manifest.entries) {
      this.pathPolicy.normalizeAndValidate(entry.path);
      if (!entry.existed) {
        staged.set(entry.path, null);
        continue;
      }
      if (!entry.storageName || !entry.contentHash) throw new Error("Incomplete backup entry");
      const content = await this.adapter.readBinary(`${this.backupRoot}/${id}/${entry.storageName}`);
      if (content.byteLength !== entry.size || await sha256Bytes(content) !== entry.contentHash) {
        throw new Error(`Backup is corrupt for ${entry.path}`);
      }
      staged.set(entry.path, content);
    }

    for (const entry of manifest.entries) {
      const content = staged.get(entry.path);
      if (content === null) await this.files.trash(entry.path);
      else if (content) await this.files.write(entry.path, content);
    }
  }

  async list(): Promise<BackupSummary[]> {
    if (!(await this.adapter.exists(this.backupRoot))) return [];
    const listed = await this.adapter.list(this.backupRoot);
    const summaries: BackupSummary[] = [];
    for (const folder of listed.folders) {
      const id = folder.split("/").at(-1) ?? "";
      if (!SAFE_ID.test(id)) continue;
      try {
        const manifest = await this.readManifest(id);
        summaries.push({
          id,
          createdAt: manifest.createdAt,
          fileCount: manifest.entries.filter((entry) => entry.existed).length
        });
      } catch {
        // Invalid/incomplete backups are intentionally omitted from the restore UI.
      }
    }
    return summaries.sort((left, right) => right.createdAt - left.createdAt);
  }

  async delete(id: string): Promise<void> {
    this.validateId(id);
    await this.removeDirectory(`${this.backupRoot}/${id}`);
  }

  async createStaging(transactionId: string): Promise<void> {
    this.validateId(transactionId);
    const directory = `${this.stagingRoot}/${transactionId}`;
    if (await this.adapter.exists(directory)) await this.removeDirectory(directory);
    await this.ensureDirectory(directory);
  }

  async stage(
    transactionId: string,
    index: number,
    content: ArrayBuffer,
    expectedHash: string
  ): Promise<string> {
    this.validateId(transactionId);
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid staging index");
    const storageName = `${index}.bin`;
    const path = `${this.stagingRoot}/${transactionId}/${storageName}`;
    await this.adapter.writeBinary(path, content);
    const verified = await this.adapter.readBinary(path);
    if (verified.byteLength !== content.byteLength || await sha256Bytes(verified) !== expectedHash) {
      throw new Error("Staged file verification failed");
    }
    return storageName;
  }

  async readStaged(transactionId: string, storageName: string): Promise<ArrayBuffer> {
    this.validateId(transactionId);
    if (!/^\d+\.bin$/.test(storageName)) throw new Error("Invalid staged filename");
    return this.adapter.readBinary(`${this.stagingRoot}/${transactionId}/${storageName}`);
  }

  async discardStaging(transactionId: string): Promise<void> {
    this.validateId(transactionId);
    await this.removeDirectory(`${this.stagingRoot}/${transactionId}`);
  }

  private async readManifest(id: string): Promise<BackupManifest> {
    this.validateId(id);
    const value: unknown = JSON.parse(await this.adapter.read(`${this.backupRoot}/${id}/manifest.json`));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid backup manifest");
    const manifest = value as Partial<BackupManifest>;
    if (
      manifest.schemaVersion !== 1 || manifest.id !== id ||
      !Number.isFinite(manifest.createdAt) || !Array.isArray(manifest.entries)
    ) throw new Error("Invalid backup manifest");
    for (const entry of manifest.entries) {
      if (
        !entry || typeof entry !== "object" || typeof entry.path !== "string" ||
        typeof entry.existed !== "boolean" || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        (entry.existed && (typeof entry.contentHash !== "string" || typeof entry.storageName !== "string"))
      ) throw new Error("Invalid backup entry");
    }
    return manifest as BackupManifest;
  }

  private async cleanupOldBackups(): Promise<void> {
    const backups = await this.list();
    for (const backup of backups.slice(this.maxBackups)) await this.delete(backup.id);
  }

  private validateId(id: string): void {
    if (!SAFE_ID.test(id)) throw new Error("Invalid backup or transaction ID");
  }

  private async ensureDirectory(path: string): Promise<void> {
    const segments = path.split("/");
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await this.adapter.exists(current))) await this.adapter.mkdir(current);
    }
  }

  private async removeDirectory(path: string): Promise<void> {
    if (await this.adapter.exists(path)) await this.adapter.rmdir(path, true);
  }
}
