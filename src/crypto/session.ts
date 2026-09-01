import { PROTOCOL_VERSION } from "../model";
import type { EncryptedEnvelope, SecureMessage } from "../protocol/messages";
import { parseSecureMessage } from "../protocol/messages";
import { base64ToBytes, bytesToBase64, ownedArrayBuffer, utf8 } from "./encoding";

export type SessionRole = "client" | "server";

export interface HandshakeTranscript {
  vaultId: string;
  sessionId: string;
  serverDeviceId: string;
  clientDeviceId: string;
  serverNonce: string;
  clientNonce: string;
}

interface DirectionMaterial {
  key: CryptoKey;
  ivPrefix: Uint8Array;
}

function transcriptBytes(transcript: HandshakeTranscript, proofRole: SessionRole): Uint8Array {
  return utf8([
    "local-vault-sync",
    String(PROTOCOL_VERSION),
    transcript.vaultId,
    transcript.sessionId,
    transcript.serverDeviceId,
    transcript.clientDeviceId,
    transcript.serverNonce,
    transcript.clientNonce,
    proofRole
  ].join("\0"));
}

function pairingKeyBytes(pairingKey: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(pairingKey);
  } catch {
    throw new Error("The pairing key is not valid base64");
  }
  if (bytes.byteLength !== 32) throw new Error("The pairing key must contain exactly 256 bits");
  return bytes;
}

export async function createProof(
  pairingKey: string,
  transcript: HandshakeTranscript,
  role: SessionRole
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(pairingKeyBytes(pairingKey)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return bytesToBase64(await crypto.subtle.sign(
    "HMAC",
    key,
    ownedArrayBuffer(transcriptBytes(transcript, role))
  ));
}

export async function verifyProof(
  pairingKey: string,
  transcript: HandshakeTranscript,
  role: SessionRole,
  proof: string
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      ownedArrayBuffer(pairingKeyBytes(pairingKey)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    return crypto.subtle.verify(
      "HMAC",
      key,
      ownedArrayBuffer(base64ToBytes(proof)),
      ownedArrayBuffer(transcriptBytes(transcript, role))
    );
  } catch {
    return false;
  }
}

async function deriveDirections(
  pairingKey: string,
  transcript: HandshakeTranscript
): Promise<{ clientToServer: DirectionMaterial; serverToClient: DirectionMaterial }> {
  const key = await crypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(pairingKeyBytes(pairingKey)),
    "HKDF",
    false,
    ["deriveBits"]
  );
  const salt = await crypto.subtle.digest(
    "SHA-256",
    ownedArrayBuffer(utf8(`${transcript.serverNonce}\0${transcript.clientNonce}`))
  );
  const material = new Uint8Array(await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: ownedArrayBuffer(
        utf8(`local-vault-sync\0${PROTOCOL_VERSION}\0${transcript.vaultId}\0${transcript.sessionId}`)
      )
    },
    key,
    72 * 8
  ));

  const importAes = (bytes: Uint8Array) => crypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(bytes),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  return {
    clientToServer: {
      key: await importAes(material.slice(0, 32)),
      ivPrefix: material.slice(64, 68)
    },
    serverToClient: {
      key: await importAes(material.slice(32, 64)),
      ivPrefix: material.slice(68, 72)
    }
  };
}

function ivFor(prefix: Uint8Array, sequence: number): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setBigUint64(4, BigInt(sequence), false);
  return iv;
}

function additionalData(sessionId: string, sequence: number): Uint8Array {
  return utf8(`${PROTOCOL_VERSION}\0${sessionId}\0${sequence}`);
}

export class SecureSession {
  private sendSequence = 0;
  private receiveSequence = 0;

  private constructor(
    readonly sessionId: string,
    private readonly send: DirectionMaterial,
    private readonly receive: DirectionMaterial
  ) {}

  static async create(
    pairingKey: string,
    transcript: HandshakeTranscript,
    role: SessionRole
  ): Promise<SecureSession> {
    const directions = await deriveDirections(pairingKey, transcript);
    return role === "client"
      ? new SecureSession(transcript.sessionId, directions.clientToServer, directions.serverToClient)
      : new SecureSession(transcript.sessionId, directions.serverToClient, directions.clientToServer);
  }

  async encrypt(message: SecureMessage): Promise<EncryptedEnvelope> {
    if (this.sendSequence >= Number.MAX_SAFE_INTEGER) throw new Error("Session sequence exhausted");
    const sequence = ++this.sendSequence;
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownedArrayBuffer(ivFor(this.send.ivPrefix, sequence)),
        additionalData: ownedArrayBuffer(additionalData(this.sessionId, sequence)),
        tagLength: 128
      },
      this.send.key,
      ownedArrayBuffer(utf8(JSON.stringify(message)))
    );
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      sequence,
      ciphertext: bytesToBase64(ciphertext)
    };
  }

  async decrypt(envelope: EncryptedEnvelope): Promise<SecureMessage> {
    if (envelope.sessionId !== this.sessionId) throw new Error("Envelope session mismatch");
    if (envelope.sequence !== this.receiveSequence + 1) throw new Error("Out-of-order or replayed envelope");

    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedArrayBuffer(ivFor(this.receive.ivPrefix, envelope.sequence)),
        additionalData: ownedArrayBuffer(additionalData(this.sessionId, envelope.sequence)),
        tagLength: 128
      },
      this.receive.key,
      ownedArrayBuffer(base64ToBytes(envelope.ciphertext))
    );
    const message: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    const parsed = parseSecureMessage(message);
    this.receiveSequence = envelope.sequence;
    return parsed;
  }
}
