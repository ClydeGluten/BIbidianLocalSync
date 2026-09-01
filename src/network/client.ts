import { ClientHandshake, type StartedClientHandshake } from "../crypto/handshake";
import type { SecureSession } from "../crypto/session";
import { parseEnvelope, parseHandshakeMessage, type SecureMessage } from "../protocol/messages";
import { SerialQueue } from "../sync/serial-queue";
import type { PeerCallbacks, SecurePeer } from "./secure-peer";

export interface LocalSyncClientOptions {
  url: string;
  deviceId: string;
  expectedVaultId: string;
  pairingKey: string;
  maxPayloadBytes: number;
  authenticationTimeoutMs?: number;
}

export class LocalSyncClient implements SecurePeer {
  private socket: WebSocket | null = null;
  private session: SecureSession | null = null;
  private startedHandshake: StartedClientHandshake | null = null;
  private receiveQueue = new SerialQueue();
  private sendQueue = new SerialQueue();
  private authenticationTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  deviceId = "server-unauthenticated";
  vaultId = "unknown";

  constructor(
    private readonly options: LocalSyncClientOptions,
    private readonly callbacks: PeerCallbacks
  ) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    const socket = new WebSocket(this.options.url);
    this.socket = socket;
    this.authenticationTimer = setTimeout(
      () => this.close(1008, "Authentication timeout"),
      this.options.authenticationTimeoutMs ?? 10_000
    );
    socket.addEventListener("message", (event) => {
      if (socket !== this.socket || typeof event.data !== "string") {
        if (socket === this.socket) this.close(1003, "Expected a text protocol frame");
        return;
      }
      if (event.data.length > this.options.maxPayloadBytes) {
        this.close(1009, "Protocol message exceeds the configured limit");
        return;
      }
      void this.receiveQueue.run(() => this.receive(event.data)).catch((error: unknown) => {
        this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
        this.close(1008, "Invalid protocol message");
      });
    });
    socket.addEventListener("error", () => this.callbacks.onError(new Error("WebSocket client error")));
    socket.addEventListener("close", (event) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.session = null;
      this.startedHandshake = null;
      this.stopped = true;
      this.clearAuthenticationTimer();
      void this.callbacks.onDisconnected(this, event.reason || `Connection closed (${event.code})`);
    });
  }

  async send(message: SecureMessage): Promise<void> {
    await this.sendQueue.run(async () => {
      const socket = this.socket;
      const session = this.session;
      if (!socket || socket.readyState !== WebSocket.OPEN || !session) throw new Error("Client is not authenticated");
      socket.send(JSON.stringify(await session.encrypt(message)));
    });
  }

  close(code = 1000, reason = "Closing"): void {
    this.stopped = true;
    this.clearAuthenticationTimer();
    const socket = this.socket;
    this.session = null;
    this.startedHandshake = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(code, reason.slice(0, 123));
  }

  private async receive(raw: string): Promise<void> {
    if (!this.session) {
      const message = parseHandshakeMessage(raw);
      if (message.type === "SERVER_HELLO") {
        this.vaultId = message.vaultId;
        this.deviceId = message.serverDeviceId;
        const started = await new ClientHandshake(
          this.options.pairingKey,
          this.options.deviceId,
          this.options.expectedVaultId
        ).start(message);
        this.startedHandshake = started;
        this.socket?.send(JSON.stringify(started.response));
        return;
      }
      if (message.type === "SERVER_PROOF" && this.startedHandshake) {
        this.session = await this.startedHandshake.complete(message);
        this.startedHandshake = null;
        this.clearAuthenticationTimer();
        await this.callbacks.onAuthenticated(this);
        return;
      }
      if (message.type === "AUTH_ERROR") throw new Error(`Authentication failed: ${message.code}`);
      throw new Error("Unexpected handshake message");
    }
    await this.callbacks.onMessage(this, await this.session.decrypt(parseEnvelope(raw)));
  }

  private clearAuthenticationTimer(): void {
    if (this.authenticationTimer) clearTimeout(this.authenticationTimer);
    this.authenticationTimer = null;
  }
}
