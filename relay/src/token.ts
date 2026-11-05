import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { decodeB64u, parseObject } from "./wire.ts";

/** The control plane mints tokens with `exp = iat + 12 h`. */
export const TOKEN_LIFETIME_S = 12 * 60 * 60;
/** How far a token's `iat` may be ahead of this node's clock. */
export const CLOCK_SKEW_S = 300;
const MAX_TOKEN_CHARS = 2048;
const MAX_KEYS = 2;
const KID = /^[A-Za-z0-9_-]{1,16}$/;
const IID = /^[A-Za-z0-9_-]{1,64}$/;

export interface TokenClaims {
  kid: string;
  hid: Buffer;
  hidText: string;
  iid: string;
  iat: number;
  exp: number;
}

export type TokenFailure = "malformed" | "signature" | "claims" | "expired";
export type TokenResult = { ok: true; claims: TokenClaims } | { ok: false; reason: TokenFailure };

/**
 * `RELAY_TOKEN_KEYS`: `{"k1":"<b64u 32-byte Ed25519 public key>"}`, one or two entries so a key can be rotated. The relay
 * only ever holds public keys, so a node that is taken over cannot mint host tokens.
 */
export function parseTokenKeys(json: string): Map<string, KeyObject> {
  const object = parseObject(json);
  if (!object) throw new Error("RELAY_TOKEN_KEYS must be a JSON object");
  const entries = Object.entries(object);
  if (entries.length < 1 || entries.length > MAX_KEYS) throw new Error(`RELAY_TOKEN_KEYS must hold 1 to ${MAX_KEYS} keys`);
  const keys = new Map<string, KeyObject>();
  for (const [kid, value] of entries) {
    if (!KID.test(kid)) throw new Error("RELAY_TOKEN_KEYS has a key id that is not 1-16 of [A-Za-z0-9_-]");
    if (!decodeB64u(value, 32)) throw new Error(`RELAY_TOKEN_KEYS.${kid} is not a base64url 32-byte Ed25519 public key`);
    keys.set(kid, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: value as string }, format: "jwk" }));
  }
  return keys;
}

/**
 * Checks `b64u(payloadJSON) "." b64u(Ed25519 signature over the ASCII of the first part)`. The signature is checked
 * before the payload is parsed, so nothing unauthenticated is interpreted, and the key that verified it must be the
 * payload's `kid`.
 */
export function verifyToken(token: unknown, keys: ReadonlyMap<string, KeyObject>, nowSeconds: number): TokenResult {
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return { ok: false, reason: "malformed" };
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return { ok: false, reason: "malformed" };
  const payloadPart = token.slice(0, dot);
  const payloadBytes = decodeB64u(payloadPart);
  const signature = decodeB64u(token.slice(dot + 1), 64);
  if (!payloadBytes || !signature) return { ok: false, reason: "malformed" };

  const signed = Buffer.from(payloadPart, "ascii");
  let signer: string | undefined;
  for (const [kid, key] of keys) {
    if (verify(null, signed, key, signature)) {
      signer = kid;
      break;
    }
  }
  if (!signer) return { ok: false, reason: "signature" };

  const payload = parseObject(payloadBytes.toString("utf8"));
  if (!payload || payload.v !== 1 || payload.kid !== signer) return { ok: false, reason: "claims" };
  const hid = decodeB64u(payload.hid, 16);
  const { iat, exp, iid } = payload;
  if (!hid || typeof iid !== "string" || !IID.test(iid)) return { ok: false, reason: "claims" };
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return { ok: false, reason: "claims" };
  const issued = iat as number;
  const expires = exp as number;
  if (expires <= issued || expires - issued > TOKEN_LIFETIME_S || issued > nowSeconds + CLOCK_SKEW_S) {
    return { ok: false, reason: "claims" };
  }
  if (nowSeconds >= expires) return { ok: false, reason: "expired" };
  return { ok: true, claims: { kid: signer, hid, hidText: payload.hid as string, iid, iat: issued, exp: expires } };
}
