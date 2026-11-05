import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { decodeB64u, parseObject } from "./wire.ts";

/** The control plane mints tokens with `exp = iat + 12 h`. */
export const TOKEN_LIFETIME_S = 12 * 60 * 60;
const MAX_TOKEN_CHARS = 2048;
const MAX_KEYS = 2;
const KID = /^k[0-9]{1,3}$/;

export interface TokenClaims {
  kid: string;
  hid: Buffer;
  hidText: string;
  iid: string;
  iat: number;
  exp: number;
}

/** The wire spec's names; only pass or fail is normative. */
export type TokenFailure = "malformed" | "kid" | "signature" | "expired" | "hid";
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
    if (!KID.test(kid)) throw new Error("RELAY_TOKEN_KEYS has a key id that is not k0 … k999");
    if (!decodeB64u(value, 32)) throw new Error(`RELAY_TOKEN_KEYS.${kid} is not a base64url 32-byte Ed25519 public key`);
    keys.set(kid, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: value as string }, format: "jwk" }));
  }
  return keys;
}

const isSeconds = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/**
 * Checks `b64u(payloadJSON) "." b64u(Ed25519 signature over the ASCII of the first part)` (wire spec "Relay token").
 * `expectHid` is the host already bound to the socket, for a refresh.
 */
export function verifyToken(token: unknown, keys: ReadonlyMap<string, KeyObject>, nowSeconds: number, expectHid?: string): TokenResult {
  const fail = (reason: TokenFailure): TokenResult => ({ ok: false, reason });
  if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return fail("malformed");
  const parts = token.split(".");
  if (parts.length !== 2) return fail("malformed");
  const [body, signatureText] = parts as [string, string];
  const payloadBytes = decodeB64u(body, undefined, MAX_TOKEN_CHARS);
  const signature = decodeB64u(signatureText, 64);
  if (!payloadBytes || !signature) return fail("malformed");
  const payload = parseObject(payloadBytes.toString("utf8"));
  if (!payload || payload.v !== 1 || typeof payload.kid !== "string" || !KID.test(payload.kid)) return fail("malformed");
  const key = keys.get(payload.kid);
  if (!key) return fail("kid");
  if (!verify(null, Buffer.from(body, "ascii"), key, signature)) return fail("signature");

  const hid = decodeB64u(payload.hid, 16);
  const { iid, iat, exp } = payload;
  if (!hid || typeof iid !== "string" || iid.length === 0 || iid.length > 64) return fail("malformed");
  if (!isSeconds(iat) || !isSeconds(exp) || exp <= iat || exp - iat > TOKEN_LIFETIME_S) return fail("malformed");
  if (nowSeconds >= exp) return fail("expired");
  if (expectHid !== undefined && payload.hid !== expectHid) return fail("hid");
  return { ok: true, claims: { kid: payload.kid, hid, hidText: payload.hid as string, iid, iat, exp } };
}
