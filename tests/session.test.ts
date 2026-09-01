import { describe, expect, it } from "vitest";
import { randomBase64 } from "../src/crypto/encoding";
import { createProof, SecureSession, verifyProof, type HandshakeTranscript } from "../src/crypto/session";
import type { SecureMessage } from "../src/protocol/messages";

const transcript: HandshakeTranscript = {
  vaultId: "vault-id-1234",
  sessionId: "session-id-1234",
  serverDeviceId: "server-device-1234",
  clientDeviceId: "client-device-1234",
  serverNonce: "server-nonce",
  clientNonce: "client-nonce"
};

describe("secure sessions", () => {
  it("requires role-separated mutual proofs", async () => {
    const key = randomBase64();
    const clientProof = await createProof(key, transcript, "client");
    expect(await verifyProof(key, transcript, "client", clientProof)).toBe(true);
    expect(await verifyProof(key, transcript, "server", clientProof)).toBe(false);
  });

  it("encrypts in both directions", async () => {
    const key = randomBase64();
    const client = await SecureSession.create(key, transcript, "client");
    const server = await SecureSession.create(key, transcript, "server");
    const request: SecureMessage = {
      type: "MANIFEST_REQUEST",
      requestId: "request-1234"
    };
    const response: SecureMessage = {
      type: "PING",
      requestId: "request-5678",
      sentAt: 123
    };

    expect(await server.decrypt(await client.encrypt(request))).toEqual(request);
    expect(await client.decrypt(await server.encrypt(response))).toEqual(response);
  });

  it("rejects replayed and tampered messages", async () => {
    const key = randomBase64();
    const client = await SecureSession.create(key, transcript, "client");
    const server = await SecureSession.create(key, transcript, "server");
    const envelope = await client.encrypt({ type: "PING", requestId: "request-1234", sentAt: 1 });
    await server.decrypt(envelope);
    await expect(server.decrypt(envelope)).rejects.toThrow(/replayed/);

    const freshServer = await SecureSession.create(key, transcript, "server");
    const last = envelope.ciphertext.at(-1) ?? "A";
    const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}${last === "A" ? "B" : "A"}` };
    await expect(freshServer.decrypt(tampered)).rejects.toThrow();
  });
});
