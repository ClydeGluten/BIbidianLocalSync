export const PROTOCOL_VERSION = 2 as const;
export const METADATA_SCHEMA_VERSION = 2 as const;

export type DeviceId = string;
export type VaultId = string;
export type VersionVector = Readonly<Record<DeviceId, number>>;
export type FileKind = "text" | "binary" | "deleted";

export interface FileState {
  path: string;
  kind: FileKind;
  contentHash: string | null;
  size: number;
  version: VersionVector;
  changedAt: number;
  observedMtime?: number;
}

export interface ManifestEntry {
  path: string;
  kind: FileKind;
  contentHash: string | null;
  size: number;
  version: VersionVector;
  changedAt: number;
}

export interface SyncMetadata {
  schemaVersion: typeof METADATA_SCHEMA_VERSION;
  vaultId: VaultId;
  deviceId: DeviceId;
  localCounter: number;
  files: Record<string, FileState>;
}

export interface LocalSyncSettings {
  serverMode: boolean;
  serverAddress: string;
  serverPort: number;
  pairingSecretName: string;
  expectedVaultId: string;
  liveSync: boolean;
  syncIntervalMinutes: number;
  maxBackups: number;
  maxFileSizeBytes: number;
  ignoredPathPrefixes: string[];
}

export interface PluginData {
  settings: LocalSyncSettings;
  metadata: SyncMetadata;
}

export const DEFAULT_SETTINGS: LocalSyncSettings = {
  serverMode: false,
  serverAddress: "127.0.0.1",
  serverPort: 8080,
  pairingSecretName: "",
  expectedVaultId: "",
  liveSync: true,
  syncIntervalMinutes: 2,
  maxBackups: 5,
  maxFileSizeBytes: 64 * 1024 * 1024,
  ignoredPathPrefixes: []
};

export function toManifestEntry(state: FileState): ManifestEntry {
  return {
    path: state.path,
    kind: state.kind,
    contentHash: state.contentHash,
    size: state.size,
    version: state.version,
    changedAt: state.changedAt
  };
}
