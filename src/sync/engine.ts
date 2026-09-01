import type { DeviceId, FileState, ManifestEntry, VersionVector } from "../model";
import { toManifestEntry } from "../model";
import { sha256Bytes } from "../crypto/hash";
import { KeyedSerialQueue } from "./serial-queue";
import type { ListedFile, SyncFileStore } from "./file-store";
import { MetadataRepository } from "./metadata-repository";
import { PathPolicy } from "./path-policy";
import { compareVectors, mergeVectors, validateVector } from "./version-vector";

export type ReconcileAction =
  | { type: "push"; entry: ManifestEntry }
  | { type: "pull"; entry: ManifestEntry }
  | { type: "delete-local"; entry: ManifestEntry }
  | { type: "delete-remote"; entry: ManifestEntry }
  | { type: "conflict"; local: ManifestEntry; remote: ManifestEntry };

export interface ApplyResult {
  status: "APPLIED" | "UNCHANGED" | "CONFLICT" | "REJECTED";
  path: string;
  state: ManifestEntry;
  conflictPath?: string;
  conflictState?: ManifestEntry;
}

function stateFromListed(file: ListedFile, hash: string, version: VersionVector): FileState {
  return {
    path: file.path,
    kind: file.kind,
    contentHash: hash,
    size: file.size,
    version,
    changedAt: Date.now(),
    observedMtime: file.mtime
  };
}

function validateEntry(entry: ManifestEntry, normalizedPath: string): void {
  if (entry.path !== normalizedPath) throw new Error("Manifest path is not normalized");
  if (!validateVector(entry.version)) throw new Error("Invalid manifest version vector");
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("Invalid manifest size");
  if (!Number.isFinite(entry.changedAt) || entry.changedAt <= 0) throw new Error("Invalid change time");
  if (entry.kind === "deleted") {
    if (entry.contentHash !== null || entry.size !== 0) throw new Error("Invalid tombstone");
  } else if (!/^[a-f0-9]{64}$/.test(entry.contentHash ?? "")) {
    throw new Error("Invalid content hash");
  }
}

export class SyncEngine {
  private readonly queue = new KeyedSerialQueue();

  constructor(
    private readonly files: SyncFileStore,
    private readonly metadata: MetadataRepository,
    private readonly pathPolicy: PathPolicy
  ) {}

  get deviceId(): DeviceId {
    return this.metadata.deviceId;
  }

  get vaultId(): string {
    return this.metadata.vaultId;
  }

  async scan(): Promise<ManifestEntry[]> {
    const listed = await this.files.list();
    const seen = new Set<string>();

    for (const file of listed) {
      const path = this.pathPolicy.normalizeAndValidate(file.path);
      seen.add(path);
      const previous = this.metadata.get(path);
      if (
        previous && previous.kind !== "deleted" &&
        previous.observedMtime === file.mtime && previous.size === file.size
      ) continue;

      const hash = await sha256Bytes(await this.files.read(path));
      if (previous && previous.kind !== "deleted" && previous.contentHash === hash) {
        this.metadata.set({ ...previous, kind: file.kind, size: file.size, observedMtime: file.mtime });
      } else {
        this.metadata.set(stateFromListed(
          file,
          hash,
          this.metadata.nextVersion(previous?.version)
        ));
      }
    }

    for (const previous of this.metadata.entries()) {
      if (previous.kind !== "deleted" && this.pathPolicy.allows(previous.path) && !seen.has(previous.path)) {
        this.metadata.set({
          path: previous.path,
          kind: "deleted",
          contentHash: null,
          size: 0,
          version: this.metadata.nextVersion(previous.version),
          changedAt: Date.now()
        });
      }
    }

    await this.metadata.save();
    return this.manifest();
  }

  manifest(): ManifestEntry[] {
    return this.metadata.entries()
      .filter((state) => this.pathPolicy.allows(state.path))
      .map(toManifestEntry)
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async recordLocalChange(path: string): Promise<ManifestEntry> {
    const normalized = this.pathPolicy.normalizeAndValidate(path);
    return this.queue.run(normalized, () => this.recordLocalChangeUnlocked(normalized));
  }

  async recordLocalDelete(path: string): Promise<ManifestEntry> {
    const normalized = this.pathPolicy.normalizeAndValidate(path);
    return this.queue.run(normalized, () => this.recordLocalDeleteUnlocked(normalized));
  }

  private async recordLocalChangeUnlocked(normalized: string): Promise<ManifestEntry> {
    const listed = await this.files.stat(normalized);
    if (!listed) return this.recordLocalDeleteUnlocked(normalized);
    const hash = await sha256Bytes(await this.files.read(normalized));
    const previous = this.metadata.get(normalized);
    if (previous && previous.kind !== "deleted" && previous.contentHash === hash) {
      const unchanged = { ...previous, size: listed.size, observedMtime: listed.mtime };
      this.metadata.set(unchanged);
      await this.metadata.save();
      return toManifestEntry(unchanged);
    }
    const state = stateFromListed(listed, hash, this.metadata.nextVersion(previous?.version));
    this.metadata.set(state);
    await this.metadata.save();
    return toManifestEntry(state);
  }

  private async recordLocalDeleteUnlocked(normalized: string): Promise<ManifestEntry> {
    const previous = this.metadata.get(normalized);
    if (previous?.kind === "deleted") return toManifestEntry(previous);
    const state: FileState = {
      path: normalized,
      kind: "deleted",
      contentHash: null,
      size: 0,
      version: this.metadata.nextVersion(previous?.version),
      changedAt: Date.now()
    };
    this.metadata.set(state);
    await this.metadata.save();
    return toManifestEntry(state);
  }

  async reconcile(remoteEntries: readonly ManifestEntry[]): Promise<ReconcileAction[]> {
    const remote = new Map<string, ManifestEntry>();
    for (const entry of remoteEntries) {
      const path = this.pathPolicy.normalizeAndValidate(entry.path);
      validateEntry(entry, path);
      if (remote.has(path)) throw new Error(`Duplicate manifest path: ${path}`);
      remote.set(path, entry);
    }

    const actions: ReconcileAction[] = [];
    const paths = new Set([...this.metadata.entries().map((entry) => entry.path), ...remote.keys()]);
    for (const path of [...paths].sort()) {
      const localState = this.metadata.get(path);
      const remoteState = remote.get(path);
      if (!localState && remoteState) {
        if (remoteState.kind === "deleted") {
          this.metadata.set({ ...remoteState });
        } else {
          actions.push({ type: "pull", entry: remoteState });
        }
        continue;
      }
      if (localState && !remoteState) {
        actions.push(localState.kind === "deleted"
          ? { type: "delete-remote", entry: toManifestEntry(localState) }
          : { type: "push", entry: toManifestEntry(localState) });
        continue;
      }
      if (!localState || !remoteState) continue;

      if (localState.kind === remoteState.kind && localState.contentHash === remoteState.contentHash) {
        this.metadata.set({ ...localState, version: mergeVectors(localState.version, remoteState.version) });
        continue;
      }

      const relation = compareVectors(localState.version, remoteState.version);
      if (relation === "before") {
        actions.push(remoteState.kind === "deleted"
          ? { type: "delete-local", entry: remoteState }
          : { type: "pull", entry: remoteState });
      } else if (relation === "after") {
        actions.push(localState.kind === "deleted"
          ? { type: "delete-remote", entry: toManifestEntry(localState) }
          : { type: "push", entry: toManifestEntry(localState) });
      } else {
        actions.push({ type: "conflict", local: toManifestEntry(localState), remote: remoteState });
      }
    }
    await this.metadata.save();
    return actions;
  }

  async applyFile(entry: ManifestEntry, content: ArrayBuffer, sourceDeviceId: string): Promise<ApplyResult> {
    const path = this.pathPolicy.normalizeAndValidate(entry.path);
    validateEntry(entry, path);
    if (entry.kind === "deleted") throw new Error("A tombstone cannot be applied as a file");
    if (content.byteLength !== entry.size) throw new Error("Transferred file size does not match its manifest");
    if (await sha256Bytes(content) !== entry.contentHash) throw new Error("Transferred file hash does not match its manifest");

    return this.queue.run(path, async () => {
      await this.refreshIfChanged(path);
      const local = this.metadata.get(path);
      if (local && local.kind !== "deleted" && local.contentHash === entry.contentHash) {
        const merged = { ...local, version: mergeVectors(local.version, entry.version) };
        this.metadata.set(merged);
        await this.metadata.save();
        return { status: "UNCHANGED", path, state: toManifestEntry(merged) };
      }

      const relation = local ? compareVectors(local.version, entry.version) : "before";
      if (relation === "after") {
        return { status: "REJECTED", path, state: toManifestEntry(local!) };
      }
      if (local && (relation === "concurrent" || relation === "equal")) {
        const conflictState = await this.writeConflict(entry, content, sourceDeviceId, local.version);
        const resolvedLocal: FileState = {
          ...local,
          version: this.metadata.nextVersion(mergeVectors(local.version, entry.version)),
          changedAt: Date.now()
        };
        this.metadata.set(resolvedLocal);
        await this.metadata.save();
        return {
          status: "CONFLICT",
          path,
          conflictPath: conflictState.path,
          conflictState: toManifestEntry(conflictState),
          state: toManifestEntry(resolvedLocal)
        };
      }

      const written = await this.files.write(path, content);
      const state: FileState = { ...entry, observedMtime: written.mtime, size: written.size };
      this.metadata.set(state);
      await this.metadata.save();
      return { status: "APPLIED", path, state: toManifestEntry(state) };
    });
  }

  async applyDelete(entry: ManifestEntry): Promise<ApplyResult> {
    const path = this.pathPolicy.normalizeAndValidate(entry.path);
    validateEntry(entry, path);
    if (entry.kind !== "deleted") throw new Error("A deletion requires a tombstone");
    return this.queue.run(path, async () => {
      await this.refreshIfChanged(path);
      const local = this.metadata.get(path);
      if (local?.kind === "deleted" && compareVectors(local.version, entry.version) !== "before") {
        return { status: "UNCHANGED", path, state: toManifestEntry(local) };
      }
      const relation = local ? compareVectors(local.version, entry.version) : "before";
      if (local && (relation === "after" || relation === "concurrent" || relation === "equal")) {
        if (relation === "after") return { status: "REJECTED", path, state: toManifestEntry(local) };
        const resolved: FileState = {
          ...local,
          version: this.metadata.nextVersion(mergeVectors(local.version, entry.version)),
          changedAt: Date.now()
        };
        this.metadata.set(resolved);
        await this.metadata.save();
        return { status: "CONFLICT", path, state: toManifestEntry(resolved) };
      }
      await this.files.trash(path);
      this.metadata.set({ ...entry });
      await this.metadata.save();
      return { status: "APPLIED", path, state: entry };
    });
  }

  async forceApplyFile(
    entry: ManifestEntry,
    content: ArrayBuffer,
    expectedLocalHash: string | null
  ): Promise<ManifestEntry> {
    const path = this.pathPolicy.normalizeAndValidate(entry.path);
    validateEntry(entry, path);
    if (entry.kind === "deleted") throw new Error("Cannot force-apply a tombstone as a file");
    if (content.byteLength !== entry.size || await sha256Bytes(content) !== entry.contentHash) {
      throw new Error("Staged flush content failed verification");
    }
    return this.queue.run(path, async () => {
      await this.refreshIfChanged(path);
      const local = this.metadata.get(path);
      const localHash = local && local.kind !== "deleted" ? local.contentHash : null;
      if (localHash !== expectedLocalHash) throw new Error(`Local file changed during flush: ${path}`);
      const written = await this.files.write(path, content);
      const state: FileState = {
        ...entry,
        version: mergeVectors(local?.version ?? {}, entry.version),
        size: written.size,
        observedMtime: written.mtime
      };
      this.metadata.set(state);
      await this.metadata.save();
      return toManifestEntry(state);
    });
  }

  async forceDelete(path: string, expectedLocalHash: string | null): Promise<ManifestEntry> {
    const normalized = this.pathPolicy.normalizeAndValidate(path);
    return this.queue.run(normalized, async () => {
      await this.refreshIfChanged(normalized);
      const local = this.metadata.get(normalized);
      const localHash = local && local.kind !== "deleted" ? local.contentHash : null;
      if (localHash !== expectedLocalHash) throw new Error(`Local file changed during flush: ${normalized}`);
      await this.files.trash(normalized);
      const state: FileState = {
        path: normalized,
        kind: "deleted",
        contentHash: null,
        size: 0,
        version: this.metadata.nextVersion(local?.version),
        changedAt: Date.now()
      };
      this.metadata.set(state);
      await this.metadata.save();
      return toManifestEntry(state);
    });
  }

  private async refreshIfChanged(path: string): Promise<void> {
    const listed = await this.files.stat(path);
    const current = this.metadata.get(path);
    if (!listed) {
      if (current && current.kind !== "deleted") await this.recordLocalDeleteUnlocked(path);
      return;
    }
    if (
      !current || current.kind === "deleted" ||
      current.observedMtime !== listed.mtime || current.size !== listed.size
    ) await this.recordLocalChangeUnlocked(path);
  }

  private async writeConflict(
    remote: ManifestEntry,
    content: ArrayBuffer,
    sourceDeviceId: string,
    localVersion: VersionVector
  ): Promise<FileState> {
    let conflictPath = this.files.conflictPath(remote.path, sourceDeviceId, remote.changedAt);
    for (let suffix = 2; await this.files.stat(conflictPath); suffix++) {
      conflictPath = this.files.conflictPath(remote.path, `${sourceDeviceId}-${suffix}`, remote.changedAt);
    }
    const written = await this.files.write(conflictPath, content);
    const state: FileState = {
      path: conflictPath,
      kind: remote.kind,
      contentHash: remote.contentHash,
      size: written.size,
      version: this.metadata.nextVersion(mergeVectors(localVersion, remote.version)),
      changedAt: Date.now(),
      observedMtime: written.mtime
    };
    this.metadata.set(state);
    await this.metadata.save();
    return state;
  }
}
