// Ed25519 keys and signed envelopes for the box channel. An envelope is the relay token's shape:
// b64u(payload JSON) "." b64u(Ed25519 signature over the ASCII bytes of the first part), and the payload names the key
// (`kid`) that signed it. The Admin copies this file as it is: it imports only node:crypto.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

/** The DER prefix that makes a raw 32-byte Ed25519 public key an SPKI document (RFC 8410). */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const B64U = /^[A-Za-z0-9_-]*$/;
export const MAX_ENVELOPE_BYTES = 256 * 1024;

export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

export function fromB64u(text: string): Buffer | null {
  return typeof text === "string" && B64U.test(text) ? Buffer.from(text, "base64url") : null;
}

/** A public key as the wire carries it: the raw 32 bytes, base64url (43 characters). */
export function isPublicKey(value: unknown): value is string {
  return typeof value === "string" && value.length === 43 && fromB64u(value)?.length === 32;
}

export interface KeyPair {
  /** Raw 32 bytes, base64url. */
  publicKey: string;
  /** PKCS #8 DER, base64url. A secret. */
  privateKey: string;
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return { publicKey: b64u(spki.subarray(SPKI_PREFIX.length)), privateKey: b64u(privateKey.export({ format: "der", type: "pkcs8" })) };
}

export function publicKeyOf(privateKey: string): string {
  const spki = createPublicKey(privateKeyObject(privateKey)).export({ format: "der", type: "spki" });
  return b64u(spki.subarray(SPKI_PREFIX.length));
}

function privateKeyObject(privateKey: string): KeyObject {
  return createPrivateKey({ key: fromB64u(privateKey) ?? Buffer.alloc(0), format: "der", type: "pkcs8" });
}

function publicKeyObject(publicKey: string): KeyObject | null {
  if (!isPublicKey(publicKey)) return null;
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, fromB64u(publicKey)!]), format: "der", type: "spki" });
}

export function signText(privateKey: string, text: string): string {
  return b64u(sign(null, Buffer.from(text, "utf8"), privateKeyObject(privateKey)));
}

export function verifyText(publicKey: string, text: string, signature: string): boolean {
  const key = publicKeyObject(publicKey);
  const bytes = fromB64u(signature);
  if (!key || !bytes || bytes.length !== 64) return false;
  try {
    return verify(null, Buffer.from(text, "utf8"), key, bytes);
  } catch {
    return false;
  }
}

/** Signs `payload`, which gains `kid`. */
export function seal(payload: Record<string, unknown>, kid: string, privateKey: string): string {
  const body = b64u(Buffer.from(JSON.stringify({ ...payload, kid }), "utf8"));
  return `${body}.${signText(privateKey, body)}`;
}

/** The payload of an envelope signed by one of `keys` (by its `kid`), or why not. Nothing in an unverified envelope is trusted. */
export function unseal(envelope: unknown, keys: Readonly<Record<string, string>>): { ok: true; payload: Record<string, unknown> } | { ok: false; why: string } {
  if (typeof envelope !== "string" || envelope.length > MAX_ENVELOPE_BYTES) return { ok: false, why: "not an envelope" };
  const dot = envelope.indexOf(".");
  if (dot <= 0 || envelope.indexOf(".", dot + 1) !== -1) return { ok: false, why: "not an envelope" };
  const body = envelope.slice(0, dot);
  const json = fromB64u(body);
  if (!json) return { ok: false, why: "not an envelope" };
  let payload: unknown;
  try { payload = JSON.parse(json.toString("utf8")); } catch { return { ok: false, why: "not an envelope" }; }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { ok: false, why: "not an envelope" };
  const kid = (payload as { kid?: unknown }).kid;
  if (typeof kid !== "string" || !Object.hasOwn(keys, kid)) return { ok: false, why: "signed by a key this side does not know" };
  if (!verifyText(keys[kid]!, body, envelope.slice(dot + 1))) return { ok: false, why: "the signature does not verify" };
  return { ok: true, payload: payload as Record<string, unknown> };
}
