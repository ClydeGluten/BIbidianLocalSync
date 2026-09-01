import type WebSocket from "ws";
import { ServerHandshake } from "../crypto/handshake";
import type { SecureSession } from "../crypto/session";
import { parseEnvelope, parseHandshakeMessage, type SecureMessage } from "../protocol/messages";
import { SerialQueue } from "../sync/serial-queue";
import type { PeerCallbacks, SecurePeer } from "./secure-peer";

export interface LocalSyncServerOptions {
  port: number;
  vaultId: string;
  deviceId: string;
  pairingKey: string;
  maxPayloadBytes: number;
  authenticationTimeoutMs?: number;
}

class ServerPeer implements SecurePeer {
  private session: SecureSession | null = null;
  private readonly receiveQueue = new SerialQueue();
  private readonly sendQueue = new SerialQueue();
  private authenticationTimer: ReturnType<typeof setTimeout> | null;
  private closed = false;
  private disconnectedNotified = false;
  deviceId = "unauthenticated";

  constructor(
    private readonly socket: WebSocket,
    readonly vaultId: string,
    private readonly handshake: ServerHandshake,
    private readonly callbacks: PeerCallbacks,
    authenticationTimeoutMs: number
  ) {
    this.authenticationTimer = setTimeout(() => this.close(1008, "Authentication timeout"), authenticationTimeoutMs);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.close(1003, "Binary protocol frames are not supported");
        return;
      }
      void this.receiveQueue.run(() => this.receive(data.toString())).catch((error: unknown) => {
        callbacks.onError(error instanceof Error ? error : new Error(String(error)));
        this.close(1008, "Invalid protocol message");
      });
    });
    socket.on("close", (_code, reason) => this.disconnected(reason.toString() || "Connection closed"));
    socket.on("error", (error) => callbacks.onError(error));
    socket.send(JSON.stringify(handshake.hello));
  }

  async send(message: SecureMessage): Promise<void> {
    if (!this.session || this.closed) throw new Error("Peer is not authenticated");
    await this.sendQueue.run(async () => {
      if (!this.session || this.closed) throw new Error("Peer disconnected before send");
      const envelope = await this.session.encrypt(message);
      await new Promise<void>((resolve, reject) => {
        this.socket.send(JSON.stringify(envelope), (error) => error ? reject(error) : resolve());
      });
    });
  }

  close(code = 1000, reason = "Closing"): void {
    if (this.closed) return;
    this.closed = true;
    this.clearAuthenticationTimer();
    this.socket.close(code, reason.slice(0, 123));
  }

  private async receive(raw: string): Promise<void> {
    if (!this.session) {
      const message = parseHandshakeMessage(raw);
      if (message.type !== "CLIENT_PROOF") throw new Error("Expected a client proof");
      const completed = await this.handshake.accept(message);
      this.deviceId = completed.peerDeviceId;
      this.session = completed.session;
      this.clearAuthenticationTimer();
      this.socket.send(JSON.stringify(completed.response));
      await this.callbacks.onAuthenticated(this);
      return;
    }
    await this.callbacks.onMessage(this, await this.session.decrypt(parseEnvelope(raw)));
  }

  private disconnected(reason: string): void {
    if (this.disconnectedNotified) return;
    this.disconnectedNotified = true;
    this.closed = true;
    this.clearAuthenticationTimer();
    void this.callbacks.onDisconnected(this.session ? this : null, reason);
  }

  private clearAuthenticationTimer(): void {
    if (this.authenticationTimer) clearTimeout(this.authenticationTimer);
    this.authenticationTimer = null;
  }
}

export class LocalSyncServer {
  private peers = new Set<ServerPeer>();
  private webSocketServer: import("ws").WebSocketServer | null = null;

  constructor(
    private readonly options: LocalSyncServerOptions,
    private readonly callbacks: PeerCallbacks
  ) {}

  async start(): Promise<void> {
    if (this.webSocketServer) return;
    const { WebSocketServer } = await import("ws");
    const server = new WebSocketServer({
      host: "0.0.0.0",
      port: this.options.port,
      maxPayload: this.options.maxPayloadBytes,
      perMessageDeflate: false,
      clientTracking: false
    });
    this.webSocketServer = server;
    server.on("connection", (socket) => {
      if (this.peers.size >= 32) {
        socket.close(1013, "Connection limit reached");
        return;
      }
      const peer = new ServerPeer(
        socket,
        this.options.vaultId,
        new ServerHandshake(this.options.pairingKey, this.options.vaultId, this.options.deviceId),
        {
          ...this.callbacks,
          onDisconnected: async (disconnected, reason) => {
            this.peers.delete(peer);
            await this.callbacks.onDisconnected(disconnected, reason);
          }
        },
        this.options.authenticationTimeoutMs ?? 10_000
      );
      this.peers.add(peer);
    });
    server.on("error", (error) => this.callbacks.onError(error));
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  }

  async broadcast(message: SecureMessage, exceptDeviceId?: string): Promise<void> {
    const results = await Promise.allSettled(
      [...this.peers]
        .filter((peer) => peer.deviceId !== "unauthenticated" && peer.deviceId !== exceptDeviceId)
        .map((peer) => peer.send(message))
    );
    for (const result of results) {
      if (result.status === "rejected") {
        this.callbacks.onError(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
      }
    }
  }

  async stop(): Promise<void> {
    const server = this.webSocketServer;
    this.webSocketServer = null;
    for (const peer of this.peers) peer.close(1001, "Server stopping");
    this.peers.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
