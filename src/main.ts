import {
  Notice,
  Platform,
  Plugin,
  TFile
} from "obsidian";
import { base64ToBytes, randomBase64 } from "./crypto/encoding";
import { DEFAULT_SETTINGS, type LocalSyncSettings, type PluginData, type SyncMetadata } from "./model";
import { LocalSyncClient } from "./network/client";
import type { PeerCallbacks } from "./network/secure-peer";
import { LocalSyncServer } from "./network/server";
import { LocalSyncSettingTab } from "./settings";
import { VaultFileStore } from "./storage/vault-file-store";
import { BackupManager } from "./storage/backup-manager";
import type { BackupSummary } from "./storage/backup-manager";
import { SyncCoordinator } from "./sync/coordinator";
import { SyncEngine } from "./sync/engine";
import { hydrateMetadata, MetadataRepository } from "./sync/metadata-repository";
import { RemoteMutationGuard } from "./sync/mutation-guard";
import { PathPolicy } from "./sync/path-policy";
import { SerialQueue } from "./sync/serial-queue";

interface LegacyData {
  sharedSecret?: unknown;
  serverMode?: unknown;
  serverIP?: unknown;
  serverPort?: unknown;
  syncInterval?: unknown;
  liveSync?: unknown;
  maxBackups?: unknown;
}

function numberInRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function loadSettings(raw: unknown): LocalSyncSettings {
  const container = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const source = container.settings && typeof container.settings === "object"
    ? container.settings as Partial<LocalSyncSettings>
    : container as LegacyData;
  return {
    ...DEFAULT_SETTINGS,
    serverMode: typeof source.serverMode === "boolean" ? source.serverMode : DEFAULT_SETTINGS.serverMode,
    serverAddress: "serverAddress" in source && typeof source.serverAddress === "string"
      ? source.serverAddress
      : "serverIP" in source && typeof source.serverIP === "string"
        ? source.serverIP
        : DEFAULT_SETTINGS.serverAddress,
    serverPort: numberInRange(source.serverPort, DEFAULT_SETTINGS.serverPort, 1, 65535),
    pairingSecretName: "pairingSecretName" in source && typeof source.pairingSecretName === "string"
      ? source.pairingSecretName
      : "",
    expectedVaultId: "expectedVaultId" in source && typeof source.expectedVaultId === "string"
      ? source.expectedVaultId
      : "",
    liveSync: typeof source.liveSync === "boolean" ? source.liveSync : DEFAULT_SETTINGS.liveSync,
    syncIntervalMinutes: "syncIntervalMinutes" in source
      ? numberInRange(source.syncIntervalMinutes, DEFAULT_SETTINGS.syncIntervalMinutes, 0, 1440)
      : "syncInterval" in source
        ? numberInRange(source.syncInterval, DEFAULT_SETTINGS.syncIntervalMinutes, 0, 1440)
        : DEFAULT_SETTINGS.syncIntervalMinutes,
    maxBackups: numberInRange(source.maxBackups, DEFAULT_SETTINGS.maxBackups, 1, 100),
    maxFileSizeBytes: "maxFileSizeBytes" in source
      ? numberInRange(source.maxFileSizeBytes, DEFAULT_SETTINGS.maxFileSizeBytes, 1024, 1024 ** 3)
      : DEFAULT_SETTINGS.maxFileSizeBytes,
    ignoredPathPrefixes: "ignoredPathPrefixes" in source && Array.isArray(source.ignoredPathPrefixes)
      ? source.ignoredPathPrefixes.filter((value): value is string => typeof value === "string")
      : []
  };
}

export default class LocalSyncPlugin extends Plugin {
  override settings: LocalSyncSettings = { ...DEFAULT_SETTINGS };
  connectionStatus = "Starting…";

  private metadataRepository!: MetadataRepository;
  private engine!: SyncEngine;
  private coordinator!: SyncCoordinator;
  private fileStore!: VaultFileStore;
  private backupManager!: BackupManager;
  private pathPolicy!: PathPolicy;
  private server: LocalSyncServer | null = null;
  private client: LocalSyncClient | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private networkGeneration = 0;
  private lastManifestRequest = 0;
  private readonly debounceTimers = new Map<string, number>();
  private readonly persistenceQueue = new SerialQueue();
  private readonly mutationGuard = new RemoteMutationGuard();
  private unloaded = false;

  override async onload(): Promise<void> {
    const raw: unknown = await this.loadData();
    this.settings = loadSettings(raw);
    const rawMetadata = raw && typeof raw === "object" && "metadata" in raw
      ? (raw as { metadata?: unknown }).metadata
      : undefined;
    const metadata = hydrateMetadata(rawMetadata);
    this.metadataRepository = new MetadataRepository(metadata, (next) => this.persist(next));

    const policy = new PathPolicy({
      configDir: this.app.vault.configDir,
      ignoredPathPrefixes: this.settings.ignoredPathPrefixes
    });
    this.pathPolicy = policy;
    this.fileStore = new VaultFileStore(
      this.app,
      policy,
      this.settings.maxFileSizeBytes,
      (path) => this.mutationGuard.mark(path)
    );
    this.engine = new SyncEngine(this.fileStore, this.metadataRepository, policy);
    this.backupManager = new BackupManager(
      this.app.vault.adapter,
      this.app.vault.configDir,
      this.fileStore,
      policy,
      this.settings.maxBackups
    );
    this.coordinator = new SyncCoordinator(
      this.engine,
      this.fileStore,
      this.settings.maxFileSizeBytes,
      this.backupManager,
      policy,
      () => this.settings.serverMode,
      () => !this.settings.serverMode,
      {
        onStatus: (message) => { this.connectionStatus = message; },
        onConflict: (path, conflictPath) => {
          new Notice(conflictPath
            ? `Sync conflict in ${path}; preserved peer version as ${conflictPath}`
            : `Sync conflict in ${path}; local edit was preserved`);
        },
        onError: (error) => this.reportError(error),
        onPeerAuthenticated: async (peer) => {
          if (!this.settings.serverMode) {
            if (!this.settings.expectedVaultId) this.settings.expectedVaultId = peer.vaultId;
            if (this.metadataRepository.vaultId !== peer.vaultId) {
              this.metadataRepository.adoptVaultId(peer.vaultId);
            }
            await this.persist(this.metadataRepository.metadata);
          }
        }
      }
    );

    this.addSettingTab(new LocalSyncSettingTab(this.app, this));
    this.addCommand({
      id: "force-sync",
      name: "Force sync",
      callback: () => { void this.forceSync(); }
    });
    this.addCommand({
      id: "flush-vault",
      name: "Flush vault to connected clients",
      checkCallback: (checking) => {
        if (!this.settings.serverMode) return false;
        if (!checking) void this.initiateFlush();
        return true;
      }
    });
    this.addCommand({
      id: "reconnect",
      name: "Reconnect",
      callback: () => { void this.restartNetwork(); }
    });

    this.registerInterval(window.setInterval(() => {
      const intervalMs = this.settings.syncIntervalMinutes * 60_000;
      if (intervalMs > 0 && Date.now() - this.lastManifestRequest >= intervalMs) {
        void this.forceSync();
      }
    }, 30_000));

    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.registerVaultEvents();
      void this.engine.scan()
        .then(() => this.startNetwork())
        .catch((error: unknown) => this.reportError(this.asError(error)));
    });

    if (raw && typeof raw === "object" && typeof (raw as LegacyData).sharedSecret === "string") {
      new Notice("Local Vault Sync v2 requires a new generated pairing key; the legacy plaintext secret was not migrated.", 10_000);
    }
    await this.persist(metadata);
  }

  override onunload(): void {
    this.unloaded = true;
    for (const timer of this.debounceTimers.values()) window.clearTimeout(timer);
    this.debounceTimers.clear();
    this.mutationGuard.clear();
    void this.stopNetwork();
    void this.metadataRepository.idle();
  }

  async saveSettings(restart: boolean): Promise<void> {
    await this.persist(this.metadataRepository.metadata);
    if (restart) await this.restartNetwork();
  }

  async generatePairingKey(): Promise<void> {
    if (
      this.settings.pairingSecretName &&
      !window.confirm("Generate a new pairing key? Existing clients will disconnect until they receive the new key.")
    ) return;
    const vaultToken = this.metadataRepository.vaultId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
    const secretName = `local-vault-sync-${vaultToken}-${Date.now().toString(36)}`;
    this.app.secretStorage.setSecret(secretName, randomBase64(32));
    this.settings.pairingSecretName = secretName;
    await this.saveSettings(true);
    new Notice("A new pairing key was generated.");
  }

  async copyPairingKey(): Promise<void> {
    const key = this.getPairingKey();
    await navigator.clipboard.writeText(key);
  }

  async restartNetwork(): Promise<void> {
    await this.stopNetwork();
    await this.startNetwork();
  }

  async initiateFlush(): Promise<void> {
    if (!this.settings.serverMode) throw new Error("Flush can only originate from the desktop host");
    if (!window.confirm(
      "Flush the host vault to every connected client? Each client will create and verify a backup before committing."
    )) return;
    const peers = await this.coordinator.initiateFlush();
    new Notice(peers > 0 ? `Prepared transactional flush for ${peers} client(s).` : "No authenticated clients are connected.");
  }

  async getBackups(): Promise<BackupSummary[]> {
    return this.backupManager.list();
  }

  async restoreBackup(id: string): Promise<void> {
    if (!window.confirm(`Restore backup ${id}? Current versions of affected files will be replaced or trashed.`)) return;
    await this.backupManager.restore(id);
    await this.engine.scan();
    await this.coordinator.requestManifest();
    new Notice(`Restored backup ${id}.`);
  }

  async deleteBackup(id: string): Promise<void> {
    if (!window.confirm(`Permanently delete backup ${id}?`)) return;
    await this.backupManager.delete(id);
    new Notice(`Deleted backup ${id}.`);
  }

  private registerVaultEvents(): void {
    const publishChange = (file: TFile) => {
      if (!this.settings.liveSync || !this.pathPolicy.allows(file.path) || this.mutationGuard.consume(file.path)) return;
      const existing = this.debounceTimers.get(file.path);
      if (existing !== undefined) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        this.debounceTimers.delete(file.path);
        void this.engine.recordLocalChange(file.path)
          .then((entry) => this.coordinator.publish(entry))
          .catch((error: unknown) => this.reportError(this.asError(error)));
      }, 750);
      this.debounceTimers.set(file.path, timer);
    };

    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile) publishChange(file);
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) publishChange(file);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (
        !(file instanceof TFile) || !this.settings.liveSync ||
        !this.pathPolicy.allows(file.path) || this.mutationGuard.consume(file.path)
      ) return;
      const timer = this.debounceTimers.get(file.path);
      if (timer !== undefined) window.clearTimeout(timer);
      this.debounceTimers.delete(file.path);
      void this.engine.recordLocalDelete(file.path)
        .then((entry) => this.coordinator.publish(entry))
        .catch((error: unknown) => this.reportError(this.asError(error)));
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile) || !this.settings.liveSync) return;
      void (async () => {
        if (this.pathPolicy.allows(oldPath)) {
          await this.coordinator.publish(await this.engine.recordLocalDelete(oldPath));
        }
        if (this.pathPolicy.allows(file.path)) {
          await this.coordinator.publish(await this.engine.recordLocalChange(file.path));
        }
      })().catch((error: unknown) => this.reportError(this.asError(error)));
    }));
  }

  private async forceSync(): Promise<void> {
    try {
      await this.engine.scan();
      await this.coordinator.requestManifest();
      this.lastManifestRequest = Date.now();
      this.connectionStatus = "Manifest sync requested";
    } catch (error) {
      this.reportError(this.asError(error));
    }
  }

  private async startNetwork(): Promise<void> {
    if (this.unloaded) return;
    let pairingKey: string;
    try {
      pairingKey = this.getPairingKey();
    } catch (error) {
      this.connectionStatus = this.asError(error).message;
      return;
    }
    const generation = ++this.networkGeneration;
    if (this.settings.serverMode) {
      if (!Platform.isDesktopApp) {
        this.connectionStatus = "Server mode is available only on desktop";
        return;
      }
      const server = new LocalSyncServer({
        port: this.settings.serverPort,
        vaultId: this.metadataRepository.vaultId,
        deviceId: this.metadataRepository.deviceId,
        pairingKey,
        maxPayloadBytes: Math.min(this.settings.maxFileSizeBytes, 512 * 1024) + 64 * 1024
      }, this.networkCallbacks(generation, false));
      this.server = server;
      await server.start();
      this.connectionStatus = `Hosting protocol v2 on port ${this.settings.serverPort}`;
    } else {
      await this.startClient(pairingKey, generation);
    }
  }

  private async startClient(pairingKey: string, generation: number): Promise<void> {
    if (generation !== this.networkGeneration || this.unloaded) return;
    const address = this.settings.serverAddress.trim();
    if (!address || /[\s/?#@]/.test(address)) throw new Error("Server address must be a hostname or IP address");
    const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
    const client = new LocalSyncClient({
      url: `ws://${host}:${this.settings.serverPort}`,
      deviceId: this.metadataRepository.deviceId,
      expectedVaultId: this.settings.expectedVaultId,
      pairingKey,
      maxPayloadBytes: Math.min(this.settings.maxFileSizeBytes, 512 * 1024) + 64 * 1024
    }, this.networkCallbacks(generation, true));
    this.client = client;
    this.connectionStatus = `Connecting to ${host}:${this.settings.serverPort}`;
    await client.start();
  }

  private networkCallbacks(generation: number, reconnect: boolean): PeerCallbacks {
    return {
      onAuthenticated: async (peer) => {
        if (generation !== this.networkGeneration) return peer.close(1001, "Stale connection");
        this.reconnectAttempt = 0;
        await this.coordinator.authenticated(peer);
      },
      onMessage: async (peer, message) => {
        if (generation === this.networkGeneration) await this.coordinator.handle(peer, message);
      },
      onDisconnected: (peer, reason) => {
        this.coordinator.disconnected(peer, reason);
        if (reconnect && generation === this.networkGeneration && !this.unloaded) this.scheduleReconnect(generation);
      },
      onError: (error) => this.reportError(error)
    };
  }

  private scheduleReconnect(generation: number): void {
    if (this.reconnectTimer !== null) return;
    const exponential = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt++, 5));
    const delay = Math.round(exponential * (0.8 + Math.random() * 0.4));
    this.connectionStatus = `Disconnected; reconnecting in ${Math.ceil(delay / 1000)}s`;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (generation !== this.networkGeneration || this.unloaded) return;
      try {
        void this.startClient(this.getPairingKey(), generation)
          .catch((error: unknown) => {
            this.reportError(this.asError(error));
            this.scheduleReconnect(generation);
          });
      } catch (error) {
        this.reportError(this.asError(error));
      }
    }, delay);
  }

  private async stopNetwork(): Promise<void> {
    this.networkGeneration += 1;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.coordinator.closePeers();
    this.client?.close(1001, "Network restarting");
    this.client = null;
    const server = this.server;
    this.server = null;
    if (server) await server.stop();
    this.connectionStatus = "Offline";
  }

  private getPairingKey(): string {
    const secretName = this.settings.pairingSecretName;
    if (!secretName) throw new Error("Choose or generate a pairing secret before connecting");
    const key = this.app.secretStorage.getSecret(secretName);
    if (!key) throw new Error(`Pairing secret not found: ${secretName}`);
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(key);
    } catch {
      throw new Error("Pairing secret is not valid base64");
    }
    if (bytes.byteLength !== 32) throw new Error("Pairing secret must be a generated 256-bit key");
    return key;
  }

  private persist(metadata: SyncMetadata): Promise<void> {
    return this.persistenceQueue.run(async () => {
      const data: PluginData = {
        settings: structuredClone(this.settings),
        metadata: structuredClone(metadata)
      };
      await this.saveData(data);
    });
  }

  private reportError(error: Error): void {
    console.error("Local Vault Sync", error);
    this.connectionStatus = error.message;
    new Notice(`Local Vault Sync: ${error.message}`, 8_000);
  }

  private asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
  }
}
