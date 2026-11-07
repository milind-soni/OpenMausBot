import { createHash, webcrypto } from "node:crypto";

import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";

import { PHONE_SECRET_INFO } from "../phone-secret.ts";

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

export async function keyMaterial() {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const raw = Buffer.from(await webcrypto.subtle.exportKey("raw", pair.publicKey));
  const privateKey = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  const keyId = createHash("sha256").update(raw).digest().subarray(0, 16).toString("base64url");
  return {
    publicKey: await suite.kem.deserializePublicKey(raw),
    message: { type: "openmausbot:phone-secret-key", version: 1, keyId, privateKey },
    keyId,
  };
}

export async function seal<T extends object>(
  fields: T,
  aad: Uint8Array,
  publicKey: CryptoKey,
  value = "elevenlabs-secret",
): Promise<T & { encapsulatedKey: string; ciphertext: string }> {
  const encrypted = await suite.seal(
    { recipientPublicKey: publicKey, info: new TextEncoder().encode(PHONE_SECRET_INFO) },
    new TextEncoder().encode(value),
    aad,
  );
  return {
    ...fields,
    encapsulatedKey: Buffer.from(encrypted.enc).toString("base64url"),
    ciphertext: Buffer.from(encrypted.ct).toString("base64url"),
  };
}
