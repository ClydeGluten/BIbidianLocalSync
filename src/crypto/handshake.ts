import { PROTOCOL_VERSION } from "../model";
import type { ClientProof, ServerHello, ServerProof } from "../protocol/messages";
import { randomBase64 } from "./encoding";
import {
  createProof,
  SecureSession,
  verifyProof,
  type HandshakeTranscript
} from "./session";

export interface CompletedServerHandshake {
  response: ServerProof;
  session: SecureSession;
  peerDeviceId: string;
}

export class ServerHandshake {
  readonly hello: ServerHello;

  constructor(
    private readonly pairingKey: string,
    private readonly vaultId: string,
    private readonly deviceId: string
  ) {
    this.hello = {
      type: "SERVER_HELLO",
      protocolVersion: PROTOCOL_VERSION,
      vaultId,
      serverDeviceId: deviceId,
      sessionId: crypto.randomUUID(),
      serverNonce: randomBase64()
    };
  }

  async accept(message: ClientProof): Promise<CompletedServerHandshake> {
    if (message.vaultId !== this.vaultId || message.sessionId !== this.hello.sessionId) {
      throw new Error("Client proof targets the wrong vault or session");
    }
    const transcript: HandshakeTranscript = {
      vaultId: this.vaultId,
      sessionId: this.hello.sessionId,
      serverDeviceId: this.deviceId,
      clientDeviceId: message.clientDeviceId,
      serverNonce: this.hello.serverNonce,
      clientNonce: message.clientNonce
    };
    if (!(await verifyProof(this.pairingKey, transcript, "client", message.proof))) {
      throw new Error("Client authentication failed");
    }
    return {
      response: {
        type: "SERVER_PROOF",
        protocolVersion: PROTOCOL_VERSION,
        vaultId: this.vaultId,
        serverDeviceId: this.deviceId,
        sessionId: this.hello.sessionId,
        proof: await createProof(this.pairingKey, transcript, "server")
      },
      session: await SecureSession.create(this.pairingKey, transcript, "server"),
      peerDeviceId: message.clientDeviceId
    };
  }
}

export interface StartedClientHandshake {
  response: ClientProof;
  complete: (message: ServerProof) => Promise<SecureSession>;
}

export class ClientHandshake {
  constructor(
    private readonly pairingKey: string,
    private readonly deviceId: string,
    private readonly expectedVaultId: string
  ) {}

  async start(hello: ServerHello): Promise<StartedClientHandshake> {
    if (this.expectedVaultId && hello.vaultId !== this.expectedVaultId) {
      throw new Error("The server belongs to a different vault");
    }
    const clientNonce = randomBase64();
    const transcript: HandshakeTranscript = {
      vaultId: hello.vaultId,
      sessionId: hello.sessionId,
      serverDeviceId: hello.serverDeviceId,
      clientDeviceId: this.deviceId,
      serverNonce: hello.serverNonce,
      clientNonce
    };
    const response: ClientProof = {
      type: "CLIENT_PROOF",
      protocolVersion: PROTOCOL_VERSION,
      vaultId: hello.vaultId,
      clientDeviceId: this.deviceId,
      sessionId: hello.sessionId,
      clientNonce,
      proof: await createProof(this.pairingKey, transcript, "client")
    };
    return {
      response,
      complete: async (message: ServerProof) => {
        if (
          message.vaultId !== hello.vaultId ||
          message.sessionId !== hello.sessionId ||
          message.serverDeviceId !== hello.serverDeviceId ||
          !(await verifyProof(this.pairingKey, transcript, "server", message.proof))
        ) throw new Error("Server authentication failed");
        return SecureSession.create(this.pairingKey, transcript, "client");
      }
    };
  }
}
