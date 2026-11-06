// Secrets derived from a device or pairing token, the relay admission value, and the relay host token.
// Wire spec: companion/src/e2e/README.md, "Identities and derived secrets" and "Relay token".
import { createHash, createHmac, createPrivateKey, createPublicKey, sign, timingSafeEqual, verify, type KeyObject } from "node:crypto";

const B64U = /^[A-Za-z0-9_-]*$/;

export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** Strict: unpadded URL-safe alphabet only, and canonical (re-encoding gives the same text). Node's own decoder
 * skips characters it does not know, which would let two spellings mean one value. */
export function fromB64u(text: string): Buffer | null {
  if (!B64U.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
}

export const sha256 = (bytes: Uint8Array | string): Buffer => createHash("sha256").update(bytes).digest();
export const hmacSha256 = (key: Uint8Array, message: Uint8Array): Buffer => createHmac("sha256", key).update(message).digest();

/** Full-length and constant-time; different lengths are simply unequal. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export const KEY_ID_BYTES = 16;
export const HOST_ID_BYTES = 16;

const PSK_LABEL = Buffer.from("omb-e2e psk v1", "utf8");
const ADMISSION_LABEL = Buffer.from("omb-relay admission v1", "utf8");

/** `SHA256(cred)`: the raw digest of the token's UTF-8 bytes. The desktop stores its hex as `tokenHash`. */
export const credentialHash = (token: string): Buffer => sha256(Buffer.from(token, "utf8"));

/** Accepts the stored hex form; null for anything that is not 64 hex characters. */
export function credentialHashFromHex(hex: string): Buffer | null {
  return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
}

export const keyId = (transportPublicKey: Uint8Array): Buffer => sha256(transportPublicKey).subarray(0, KEY_ID_BYTES);

export const psk = (credHash: Uint8Array, transportKeyId: Uint8Array): Buffer =>
  hmacSha256(credHash, Buffer.concat([PSK_LABEL, transportKeyId]));

export const admission = (credHash: Uint8Array, hostId: Uint8Array): Buffer =>
  hmacSha256(credHash, Buffer.concat([ADMISSION_LABEL, hostId]));

/** What the host puts in its relay admission set, and all the relay ever stores. */
export const admissionHash = (adm: Uint8Array): string => b64u(sha256(adm));

export const RELAY_TOKEN_TTL_S = 12 * 60 * 60;
export const RELAY_TOKEN_MAX_CHARS = 2048;
const KID = /^k[0-9]{1,3}$/;

export interface RelayTokenClaims {
  v: 1;
  kid: string;
  /** b64u of the 16-byte hostId */
  hid: string;
  iid: string;
  iat: number;
  exp: number;
}

/** Ed25519 from its 32-byte seed (RFC 8032 private key) via a fixed PKCS#8 prefix. */
export function ed25519PrivateKey(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

export function ed25519PublicKey(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

export const ed25519RawPublicKey = (key: KeyObject): Buffer =>
  Buffer.from(createPublicKey(key).export({ format: "der", type: "spki" })).subarray(-32);

/** Field order is part of the format: the signature covers these exact bytes. */
export function mintRelayToken(claims: RelayTokenClaims, signingKey: KeyObject): string {
  const body = b64u(Buffer.from(JSON.stringify({
    v: claims.v, kid: claims.kid, hid: claims.hid, iid: claims.iid, iat: claims.iat, exp: claims.exp,
  }), "utf8"));
  return `${body}.${b64u(sign(null, Buffer.from(body, "ascii"), signingKey))}`;
}

export type RelayTokenError = "malformed" | "kid" | "signature" | "expired" | "hid";

const isSeconds = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** `keys` maps kid to a raw 32-byte Ed25519 public key. `expectHid` is the hostId already bound to the socket,
 * for a refresh. */
export function verifyRelayToken(
  token: string,
  keys: ReadonlyMap<string, Uint8Array>,
  nowS: number,
  expectHid?: string,
): { ok: true; claims: RelayTokenClaims } | { ok: false; error: RelayTokenError } {
  const fail = (error: RelayTokenError) => ({ ok: false as const, error });
  if (typeof token !== "string" || token.length > RELAY_TOKEN_MAX_CHARS) return fail("malformed");
  const parts = token.split(".");
  if (parts.length !== 2) return fail("malformed");
  const [body, signatureText] = parts;
  const payload = fromB64u(body);
  const signature = fromB64u(signatureText);
  if (!payload || !signature || signature.length !== 64) return fail("malformed");
  let claims: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(payload.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("malformed");
    claims = parsed as Record<string, unknown>;
  } catch {
    return fail("malformed");
  }
  if (claims.v !== 1 || typeof claims.kid !== "string" || !KID.test(claims.kid)) return fail("malformed");
  const raw = keys.get(claims.kid);
  if (!raw) return fail("kid");
  if (!verify(null, Buffer.from(body, "ascii"), ed25519PublicKey(raw), signature)) return fail("signature");
  const hid = typeof claims.hid === "string" ? fromB64u(claims.hid) : null;
  if (!hid || hid.length !== HOST_ID_BYTES) return fail("malformed");
  if (typeof claims.iid !== "string" || claims.iid.length === 0 || claims.iid.length > 64) return fail("malformed");
  if (!isSeconds(claims.iat) || !isSeconds(claims.exp) || claims.exp <= claims.iat) return fail("malformed");
  if (claims.exp - claims.iat > RELAY_TOKEN_TTL_S) return fail("malformed");
  if (nowS >= claims.exp) return fail("expired");
  if (expectHid !== undefined && claims.hid !== expectHid) return fail("hid");
  return { ok: true, claims: claims as unknown as RelayTokenClaims };
}
