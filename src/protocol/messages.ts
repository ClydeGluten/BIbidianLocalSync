import type { ManifestEntry, VersionVector } from "../model";
import { PROTOCOL_VERSION } from "../model";
import { validateVector } from "../sync/version-vector";
import { base64ToBytes } from "../crypto/encoding";

export interface ServerHello {
  type: "SERVER_HELLO";
  protocolVersion: typeof PROTOCOL_VERSION;
  vaultId: string;
  serverDeviceId: string;
  sessionId: string;
  serverNonce: string;
}

export interface ClientProof {
  type: "CLIENT_PROOF";
  protocolVersion: typeof PROTOCOL_VERSION;
  vaultId: string;
  clientDeviceId: string;
  sessionId: string;
  clientNonce: string;
  proof: string;
}

export interface ServerProof {
  type: "SERVER_PROOF";
  protocolVersion: typeof PROTOCOL_VERSION;
  vaultId: string;
  serverDeviceId: string;
  sessionId: string;
  proof: string;
}

export interface AuthError {
  type: "AUTH_ERROR";
  protocolVersion: typeof PROTOCOL_VERSION;
  code: "AUTH_FAILED" | "VAULT_MISMATCH" | "PROTOCOL_MISMATCH" | "INVALID_MESSAGE";
}

export type HandshakeMessage = ServerHello | ClientProof | ServerProof | AuthError;

export interface ManifestMessage {
  type: "MANIFEST";
  requestId: string;
  entries: ManifestEntry[];
}

export interface ManifestRequestMessage {
  type: "MANIFEST_REQUEST";
  requestId: string;
}

export interface FileRequestMessage {
  type: "FILE_REQUEST";
  requestId: string;
  path: string;
  expectedVersion: VersionVector;
}

export interface FileBeginMessage {
  type: "FILE_BEGIN";
  requestId: string;
  entry: ManifestEntry;
  chunkCount: number;
  transferSize: number;
  transactionId?: string;
}

export interface FileChunkMessage {
  type: "FILE_CHUNK";
  requestId: string;
  index: number;
  data: string;
}

export interface FileEndMessage {
  type: "FILE_END";
  requestId: string;
}

export interface OperationResultMessage {
  type: "OPERATION_RESULT";
  requestId: string;
  status: "APPLIED" | "UNCHANGED" | "CONFLICT" | "REJECTED" | "FAILED";
  path: string;
  conflictPath?: string;
  message?: string;
  state?: ManifestEntry;
}

export interface DeleteMessage {
  type: "DELETE";
  requestId: string;
  entry: ManifestEntry;
}

export interface FlushPrepareMessage {
  type: "FLUSH_PREPARE";
  requestId: string;
  sourceDeviceId: string;
  entries: ManifestEntry[];
}

export interface FlushResultMessage {
  type: "FLUSH_RESULT";
  requestId: string;
  status: "READY" | "COMMITTED" | "ABORTED";
  message?: string;
  requestedPaths?: string[];
  backupId?: string;
}

export interface FlushCommitMessage {
  type: "FLUSH_COMMIT";
  requestId: string;
}

export interface FlushAbortMessage {
  type: "FLUSH_ABORT";
  requestId: string;
  message: string;
}

export interface PingMessage {
  type: "PING" | "PONG";
  requestId: string;
  sentAt: number;
}

export type SecureMessage =
  | ManifestMessage
  | ManifestRequestMessage
  | FileRequestMessage
  | FileBeginMessage
  | FileChunkMessage
  | FileEndMessage
  | OperationResultMessage
  | DeleteMessage
  | FlushPrepareMessage
  | FlushResultMessage
  | FlushCommitMessage
  | FlushAbortMessage
  | PingMessage;

export interface EncryptedEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  sequence: number;
  ciphertext: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 128;
}

function isBase64Bytes(value: unknown, byteLength: number): value is string {
  if (typeof value !== "string" || value.length > byteLength * 2) return false;
  try {
    return base64ToBytes(value).byteLength === byteLength;
  } catch {
    return false;
  }
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  if (!isRecord(value)) return false;
  const deleted = value.kind === "deleted";
  return (
    typeof value.path === "string" &&
    value.path.length > 0 &&
    (value.kind === "text" || value.kind === "binary" || deleted) &&
    (deleted ? value.contentHash === null : typeof value.contentHash === "string" && /^[a-f0-9]{64}$/.test(value.contentHash)) &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0 &&
    Number.isFinite(value.changedAt) && (value.changedAt as number) > 0 &&
    validateVector(value.version)
  );
}

export function parseHandshakeMessage(input: string): HandshakeMessage {
  const value: unknown = JSON.parse(input);
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid handshake message");
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error("Unsupported protocol version");
  }
  if (value.type === "AUTH_ERROR") {
    if (
      value.code !== "AUTH_FAILED" && value.code !== "VAULT_MISMATCH" &&
      value.code !== "PROTOCOL_MISMATCH" && value.code !== "INVALID_MESSAGE"
    ) throw new Error("Invalid authentication error");
    return value as unknown as AuthError;
  }
  if (!isId(value.vaultId) || !isId(value.sessionId)) throw new Error("Invalid handshake identifiers");
  if (value.type === "SERVER_HELLO") {
    if (!isId(value.serverDeviceId) || !isBase64Bytes(value.serverNonce, 32)) {
      throw new Error("Invalid server hello");
    }
    return value as unknown as ServerHello;
  }
  if (value.type === "CLIENT_PROOF") {
    if (!isId(value.clientDeviceId) || !isBase64Bytes(value.clientNonce, 32) || !isBase64Bytes(value.proof, 32)) {
      throw new Error("Invalid client proof");
    }
    return value as unknown as ClientProof;
  }
  if (value.type === "SERVER_PROOF") {
    if (!isId(value.serverDeviceId) || !isBase64Bytes(value.proof, 32)) {
      throw new Error("Invalid server proof");
    }
    return value as unknown as ServerProof;
  }
  throw new Error("Unknown handshake message");
}

export function parseEnvelope(input: string): EncryptedEnvelope {
  const value: unknown = JSON.parse(input);
  if (
    !isRecord(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !isId(value.sessionId) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) <= 0 ||
    typeof value.ciphertext !== "string"
  ) throw new Error("Invalid encrypted envelope");
  return value as unknown as EncryptedEnvelope;
}

export function parseSecureMessage(input: unknown): SecureMessage {
  if (!isRecord(input) || typeof input.type !== "string" || !isId(input.requestId)) {
    throw new Error("Invalid secure message");
  }

  switch (input.type) {
    case "MANIFEST":
      if (!Array.isArray(input.entries) || !input.entries.every(isManifestEntry)) throw new Error("Invalid manifest");
      break;
    case "MANIFEST_REQUEST":
    case "FILE_END":
      break;
    case "FILE_REQUEST":
      if (typeof input.path !== "string" || !validateVector(input.expectedVersion)) throw new Error("Invalid file request");
      break;
    case "FILE_BEGIN":
      if (
        !isManifestEntry(input.entry) || input.entry.kind === "deleted" ||
        !Number.isSafeInteger(input.chunkCount) || (input.chunkCount as number) <= 0 ||
        !Number.isSafeInteger(input.transferSize) || (input.transferSize as number) < 0 ||
        (input.transactionId !== undefined && !isId(input.transactionId))
      ) throw new Error("Invalid file transfer header");
      break;
    case "FILE_CHUNK":
      if (!Number.isSafeInteger(input.index) || (input.index as number) < 0 || typeof input.data !== "string") {
        throw new Error("Invalid file chunk");
      }
      break;
    case "DELETE":
      if (!isManifestEntry(input.entry) || input.entry.kind !== "deleted") throw new Error("Invalid deletion");
      break;
    case "OPERATION_RESULT":
      if (
        typeof input.path !== "string" ||
        !["APPLIED", "UNCHANGED", "CONFLICT", "REJECTED", "FAILED"].includes(String(input.status)) ||
        (input.state !== undefined && !isManifestEntry(input.state))
      ) throw new Error("Invalid operation result");
      break;
    case "FLUSH_PREPARE":
      if (!isId(input.sourceDeviceId) || !Array.isArray(input.entries) || !input.entries.every(isManifestEntry)) {
        throw new Error("Invalid flush preparation");
      }
      break;
    case "FLUSH_RESULT":
      if (
        !["READY", "COMMITTED", "ABORTED"].includes(String(input.status)) ||
        (input.requestedPaths !== undefined && (
          !Array.isArray(input.requestedPaths) || !input.requestedPaths.every((path) => typeof path === "string")
        )) || (input.backupId !== undefined && typeof input.backupId !== "string")
      ) throw new Error("Invalid flush result");
      break;
    case "FLUSH_COMMIT":
      break;
    case "FLUSH_ABORT":
      if (typeof input.message !== "string") throw new Error("Invalid flush abort");
      break;
    case "PING":
    case "PONG":
      if (!Number.isFinite(input.sentAt)) throw new Error("Invalid ping");
      break;
    default:
      throw new Error("Unknown secure message type");
  }
  return input as unknown as SecureMessage;
}
