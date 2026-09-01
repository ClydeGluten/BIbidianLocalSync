import { bytesToHex, ownedArrayBuffer, utf8 } from "./encoding";

export async function sha256Bytes(value: ArrayBuffer | ArrayBufferView): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(value)));
}

export async function sha256Text(value: string): Promise<string> {
  return sha256Bytes(utf8(value));
}
