import { concat, utf8, type Bytes } from "./bytes.ts";

const KEY_ID_BYTES = 16;

const PSK_LABEL = utf8("omb-e2e psk v1");
const ADMISSION_LABEL = utf8("omb-relay admission v1");

export async function sha256(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function hmacSha256(key: Bytes, message: Bytes): Promise<Bytes> {
  const hmacKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, message));
}

/** `SHA256(cred)` of the token's UTF-8 bytes. */
export const credentialHash = (token: string): Promise<Bytes> => sha256(utf8(token));

export const keyId = async (transportPublicKey: Bytes): Promise<Bytes> =>
  (await sha256(transportPublicKey)).subarray(0, KEY_ID_BYTES);

export const psk = (credHash: Bytes, transportKeyId: Bytes): Promise<Bytes> =>
  hmacSha256(credHash, concat(PSK_LABEL, transportKeyId));

export const admission = (credHash: Bytes, hostId: Bytes): Promise<Bytes> =>
  hmacSha256(credHash, concat(ADMISSION_LABEL, hostId));
