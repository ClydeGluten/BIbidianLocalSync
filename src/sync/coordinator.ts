import type { ManifestEntry } from "../model";
import type { SecureMessage } from "../protocol/messages";
import type { SecurePeer } from "../network/secure-peer";
import type { SyncFileStore } from "./file-store";
import type { BackupManager } from "../storage/backup-manager";
import type { ApplyResult, ReconcileAction, SyncEngine } from "./engine";
import { TransferManager } from "./transfer-manager";
import { FlushManager } from "./flush-manager";
import type { PathPolicy } from "./path-policy";

export interface CoordinatorCallbacks {
  onStatus(message: string): void;
  onConflict(path: string, conflictPath?: string): void;
  onError(error: Error): void;
  onPeerAuthenticated?(peer: SecurePeer): void | Promise<void>;
}

export class SyncCoordinator {
  private readonly peers = new Set<SecurePeer>();
  private readonly transfers: TransferManager;
  private readonly flush: FlushManager;

  constructor(
    private readonly engine: SyncEngine,
    files: SyncFileStore,
    maxFileSizeBytes: number,
    backups: BackupManager,
    pathPolicy: PathPolicy,
    private readonly isServer: () => boolean,
    allowIncomingFlush: () => boolean,
    private readonly callbacks: CoordinatorCallbacks
  ) {
    this.transfers = new TransferManager(engine, files, maxFileSizeBytes);
    this.flush = new FlushManager(engine, backups, pathPolicy, allowIncomingFlush);
  }

  async authenticated(peer: SecurePeer): Promise<void> {
    this.peers.add(peer);
    await this.callbacks.onPeerAuthenticated?.(peer);
    if (!this.isServer()) {
      await peer.send({
        type: "MANIFEST",
        requestId: crypto.randomUUID(),
        entries: await this.engine.scan()
      });
    }
    this.callbacks.onStatus(`Authenticated ${peer.deviceId}`);
  }

  disconnected(peer: SecurePeer | null, reason: string): void {
    if (peer) {
      this.peers.delete(peer);
      this.transfers.abortPeer(peer.deviceId);
      this.flush.disconnected(peer.deviceId);
    }
    this.callbacks.onStatus(reason);
  }

  async handle(peer: SecurePeer, message: SecureMessage): Promise<void> {
    switch (message.type) {
      case "MANIFEST_REQUEST":
        await peer.send({ type: "MANIFEST", requestId: message.requestId, entries: await this.engine.scan() });
        break;
      case "MANIFEST":
        if (!this.isServer()) throw new Error("Only the host may reconcile a client manifest");
        await this.executePlan(peer, await this.engine.reconcile(message.entries));
        break;
      case "FILE_REQUEST": {
        const state = this.engine.manifest().find((entry) => entry.path === message.path);
        if (!state) {
          await peer.send({
            type: "OPERATION_RESULT",
            requestId: message.requestId,
            status: "FAILED",
            path: message.path,
            message: "Requested path is not present in local metadata"
          });
        } else {
          await this.transfers.sendFile(peer, state, message.requestId);
        }
        break;
      }
      case "FILE_BEGIN":
        this.transfers.begin(peer, message);
        break;
      case "FILE_CHUNK":
        this.transfers.addChunk(peer, message);
        break;
      case "FILE_END":
      {
        const completed = await this.transfers.finish(peer, message.requestId);
        if (completed.type === "staged") {
          await this.flush.stage(peer, completed.transactionId, completed.entry, completed.content);
        } else {
          await this.completeIncoming(peer, message.requestId, completed.result);
        }
        break;
      }
      case "DELETE":
        await this.completeIncoming(peer, message.requestId, await this.engine.applyDelete(message.entry));
        break;
      case "OPERATION_RESULT":
        if (message.status === "CONFLICT") this.callbacks.onConflict(message.path, message.conflictPath);
        if (message.status === "FAILED") this.callbacks.onError(new Error(message.message ?? `Sync failed for ${message.path}`));
        break;
      case "PING":
        await peer.send({ type: "PONG", requestId: message.requestId, sentAt: message.sentAt });
        break;
      case "PONG":
        break;
      case "FLUSH_PREPARE":
        try {
          await peer.send(await this.flush.prepare(peer, message));
        } catch (error) {
          await peer.send({
            type: "FLUSH_RESULT",
            requestId: message.requestId,
            status: "ABORTED",
            message: this.asError(error).message
          });
        }
        break;
      case "FLUSH_RESULT":
        this.callbacks.onStatus(message.message ?? `Flush: ${message.status}`);
        await this.flush.handleResult(
          peer,
          message,
          (target, entry, requestId, transactionId) =>
            this.transfers.sendFile(target, entry, requestId, transactionId)
        );
        break;
      case "FLUSH_COMMIT":
        await peer.send(await this.flush.commit(peer, message.requestId));
        await this.requestManifest();
        break;
      case "FLUSH_ABORT":
        await this.flush.abort(peer, message.requestId, message.message);
        break;
    }
  }

  async publish(entry: ManifestEntry, exceptDeviceId?: string): Promise<void> {
    const targets = [...this.peers].filter((peer) => peer.deviceId !== exceptDeviceId);
    const results = await Promise.allSettled(
      targets.map((peer) => this.transfers.sendFile(peer, entry))
    );
    for (const result of results) {
      if (result.status === "rejected") this.callbacks.onError(this.asError(result.reason));
    }
  }

  async requestManifest(): Promise<void> {
    if (this.isServer()) {
      await Promise.all([...this.peers].map((peer) => peer.send({
        type: "MANIFEST_REQUEST",
        requestId: crypto.randomUUID()
      })));
    } else {
      const entries = await this.engine.scan();
      await Promise.all([...this.peers].map((peer) => peer.send({
        type: "MANIFEST",
        requestId: crypto.randomUUID(),
        entries
      })));
    }
  }

  async initiateFlush(): Promise<number> {
    if (!this.isServer()) throw new Error("Only the host may initiate a flush");
    const entries = await this.engine.scan();
    for (const peer of this.peers) await this.flush.start(peer, entries);
    return this.peers.size;
  }

  closePeers(): void {
    for (const peer of this.peers) peer.close(1001, "Plugin stopping");
    this.peers.clear();
  }

  private async executePlan(peer: SecurePeer, actions: ReconcileAction[]): Promise<void> {
    for (const action of actions) {
      switch (action.type) {
        case "push":
        case "delete-remote":
          await this.transfers.sendFile(peer, action.entry);
          break;
        case "pull":
        case "conflict": {
          const entry = action.type === "pull" ? action.entry : action.remote;
          await peer.send({
            type: "FILE_REQUEST",
            requestId: crypto.randomUUID(),
            path: entry.path,
            expectedVersion: entry.version
          });
          break;
        }
        case "delete-local": {
          const result = await this.engine.applyDelete(action.entry);
          await this.completeIncoming(peer, crypto.randomUUID(), result);
          break;
        }
      }
    }
  }

  private async completeIncoming(peer: SecurePeer, requestId: string, result: ApplyResult): Promise<void> {
    await peer.send({
      type: "OPERATION_RESULT",
      requestId,
      status: result.status,
      path: result.path,
      conflictPath: result.conflictPath,
      state: result.state
    });

    if (result.status === "CONFLICT") this.callbacks.onConflict(result.path, result.conflictPath);
    if (result.status === "REJECTED" || result.status === "CONFLICT") {
      await this.publish(result.state);
    } else if (result.status === "APPLIED") {
      await this.publish(result.state, peer.deviceId);
    }
    if (result.conflictState) await this.publish(result.conflictState);
  }

  private asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
  }
}
