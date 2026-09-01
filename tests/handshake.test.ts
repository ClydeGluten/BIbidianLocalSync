import { describe, expect, it } from "vitest";
import { ClientHandshake, ServerHandshake } from "../src/crypto/handshake";
import { randomBase64 } from "../src/crypto/encoding";

describe("mutual handshake", () => {
  it("creates compatible sessions only after both proofs", async () => {
    const key = randomBase64();
    const server = new ServerHandshake(key, "vault-id-1234", "server-device-1234");
    const client = await new ClientHandshake(key, "client-device-1234", "vault-id-1234")
      .start(server.hello);
    const accepted = await server.accept(client.response);
    const clientSession = await client.complete(accepted.response);

    const envelope = await clientSession.encrypt({
      type: "MANIFEST_REQUEST",
      requestId: "request-1234"
    });
    expect(await accepted.session.decrypt(envelope)).toEqual({
      type: "MANIFEST_REQUEST",
      requestId: "request-1234"
    });
  });

  it("rejects a client using the wrong pairing key", async () => {
    const server = new ServerHandshake(randomBase64(), "vault-id-1234", "server-device-1234");
    const client = await new ClientHandshake(randomBase64(), "client-device-1234", "vault-id-1234")
      .start(server.hello);
    await expect(server.accept(client.response)).rejects.toThrow(/authentication/);
  });

  it("rejects an unexpected vault before disclosing a client proof", async () => {
    const server = new ServerHandshake(randomBase64(), "vault-id-1234", "server-device-1234");
    await expect(
      new ClientHandshake(randomBase64(), "client-device-1234", "another-vault-1234").start(server.hello)
    ).rejects.toThrow(/different vault/);
  });
});
