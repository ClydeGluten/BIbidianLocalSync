import {
  METADATA_SCHEMA_VERSION,
  type DeviceId,
  type FileState,
  type SyncMetadata,
  type VaultId,
  type VersionVector
} from "../model";
import { incrementVector, validateVector } from "./version-vector";

function newId(): string {
  return crypto.randomUUID();
}

export function createMetadata(deviceId: DeviceId = newId(), vaultId: VaultId = newId()): SyncMetadata {
  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    deviceId,
    vaultId,
    localCounter: 0,
    files: Object.create(null) as Record<string, FileState>
  };
}

export function isSyncMetadata(value: unknown): value is SyncMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<SyncMetadata>;
  return (
    candidate.schemaVersion === METADATA_SCHEMA_VERSION &&
    typeof candidate.deviceId === "string" && candidate.deviceId.length >= 8 &&
    typeof candidate.vaultId === "string" && candidate.vaultId.length >= 8 &&
    Number.isSafeInteger(candidate.localCounter) && (candidate.localCounter ?? -1) >= 0 &&
    !!candidate.files && typeof candidate.files === "object" && !Array.isArray(candidate.files) &&
    Object.entries(candidate.files).every(([path, state]) => {
      if (!state || typeof state !== "object" || Array.isArray(state)) return false;
      const file = state as Partial<FileState>;
      return (
        file.path === path &&
        (file.kind === "text" || file.kind === "binary" || file.kind === "deleted") &&
        (file.kind === "deleted" ? file.contentHash === null : typeof file.contentHash === "string") &&
        Number.isSafeInteger(file.size) && (file.size ?? -1) >= 0 &&
        Number.isFinite(file.changedAt) && validateVector(file.version)
      );
    })
  );
}

export function hydrateMetadata(value: unknown): SyncMetadata {
  if (!isSyncMetadata(value)) return createMetadata();
  const files = Object.create(null) as Record<string, FileState>;
  for (const [path, state] of Object.entries(value.files)) {
    files[path] = {
      ...state,
      version: { ...state.version }
    };
  }
  const ownCounter = Math.max(
    0,
    ...Object.values(files).map((state) => state.version[value.deviceId] ?? 0)
  );
  return {
    ...value,
    localCounter: Math.max(value.localCounter, ownCounter),
    files
  };
}

export class MetadataRepository {
  private saveTail: Promise<void> = Promise.resolve();

  constructor(
    readonly metadata: SyncMetadata,
    private readonly persist: (metadata: SyncMetadata) => Promise<void>
  ) {}

  get deviceId(): DeviceId {
    return this.metadata.deviceId;
  }

  get vaultId(): VaultId {
    return this.metadata.vaultId;
  }

  adoptVaultId(vaultId: VaultId): void {
    if (!vaultId || vaultId.length < 8) throw new Error("Invalid vault ID");
    this.metadata.vaultId = vaultId;
  }

  get(path: string): FileState | undefined {
    return this.metadata.files[path];
  }

  set(state: FileState): void {
    this.metadata.files[state.path] = state;
  }

  entries(): FileState[] {
    return Object.values(this.metadata.files);
  }

  nextVersion(base: VersionVector = {}): VersionVector {
    this.metadata.localCounter += 1;
    return incrementVector(base, this.deviceId, this.metadata.localCounter);
  }

  save(): Promise<void> {
    const snapshot = structuredClone(this.metadata);
    const operation = this.saveTail.then(() => this.persist(snapshot));
    this.saveTail = operation.catch(() => undefined);
    return operation;
  }

  async idle(): Promise<void> {
    await this.saveTail;
  }
}
