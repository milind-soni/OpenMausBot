import { ECDH } from "node:crypto";

/** Accept only a canonical, on-curve uncompressed P-256 public point. */
export function normalizedPhoneSecretPublicKey(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]{87}$/.test(encoded)) return null;
  try {
    const raw = Buffer.from(encoded, "base64url");
    if (raw.length !== 65 || raw[0] !== 4 || raw.toString("base64url") !== encoded) return null;
    const point = ECDH.convertKey(raw, "prime256v1", undefined, undefined, "uncompressed");
    return Buffer.isBuffer(point) && point.equals(raw) ? encoded : null;
  } catch {
    return null;
  }
}
