import type { SecureMessage } from "../protocol/messages";

export interface SecurePeer {
  readonly deviceId: string;
  readonly vaultId: string;
  send(message: SecureMessage): Promise<void>;
  close(code?: number, reason?: string): void;
}

export interface PeerCallbacks {
  onAuthenticated(peer: SecurePeer): void | Promise<void>;
  onMessage(peer: SecurePeer, message: SecureMessage): void | Promise<void>;
  onDisconnected(peer: SecurePeer | null, reason: string): void | Promise<void>;
  onError(error: Error): void;
}
