import { createHash } from "node:crypto";

/** The relay's WebSocket subprotocol. Every path requires it. */
export const SUBPROTOCOL = "omb-relay.v1";

/** Close codes the relay sends (wire spec §3.9). */
export const Close = {
  Malformed: 4400,
  TokenInvalid: 4401,
  NotFound: 4404,
  NoDataSocket: 4408,
  Replaced: 4409,
  Limited: 4429,
  Unavailable: 4503,
} as const;

/** Codes the two ends of a spliced session use with each other; the relay passes these through unchanged. */
export const PASS_THROUGH_CODES: ReadonlySet<number> = new Set([1000, 1001, 4000, 4001, 4002]);

const B64U = /^[A-Za-z0-9_-]*$/;

/**
 * Strict base64url without padding. Buffer.from(…, "base64url") skips characters it does not know and accepts stray
 * trailing bits, so two different strings could name the same bytes; re-encoding and comparing makes the text canonical.
 */
export function decodeB64u(text: unknown, bytes?: number, maxChars = 4096): Buffer | undefined {
  if (typeof text !== "string" || text.length > maxChars || !B64U.test(text)) return undefined;
  const out = Buffer.from(text, "base64url");
  if (out.toString("base64url") !== text) return undefined;
  if (bytes !== undefined && out.length !== bytes) return undefined;
  return out;
}

export const sha256 = (data: Buffer | string): Buffer => createHash("sha256").update(data).digest();

/** A JSON object, or undefined for anything else (array, null, a primitive, or text that is not JSON). */
export function parseObject(text: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export interface PhoneHello {
  hid: Buffer;
  hidText: string;
  adm: Buffer;
}

/** `{"t":"phone","v":1,"hid":"<b64u 16 bytes>","adm":"<b64u 32 bytes>"}` */
export function parsePhoneHello(message: Record<string, unknown>): PhoneHello | undefined {
  if (message.t !== "phone" || message.v !== 1) return undefined;
  const hid = decodeB64u(message.hid, 16);
  const adm = decodeB64u(message.adm, 32);
  if (!hid || !adm) return undefined;
  return { hid, hidText: message.hid as string, adm };
}

/** `{"t":"auth","v":1,"token":"…"}`; the token itself is checked by verifyToken. */
export function parseAuth(message: Record<string, unknown>): string | undefined {
  if (message.t !== "auth" || message.v !== 1 || typeof message.token !== "string") return undefined;
  return message.token;
}

/** `{"t":"data","v":1,"sid":"<b64u 16 bytes>","token":"…"}` */
export function parseData(message: Record<string, unknown>): { sid: string; token: string } | undefined {
  if (message.t !== "data" || message.v !== 1 || typeof message.token !== "string") return undefined;
  if (!decodeB64u(message.sid, 16)) return undefined;
  return { sid: message.sid as string, token: message.token };
}

/** `{"t":"admit","set":["<b64u SHA256(adm)>", …]}`, at most `max` distinct 32-byte entries. */
export function parseAdmit(message: Record<string, unknown>, max: number): Buffer[] | undefined {
  if (message.t !== "admit" || !Array.isArray(message.set) || message.set.length > max) return undefined;
  const seen = new Set<string>();
  const set: Buffer[] = [];
  for (const entry of message.set) {
    const hash = decodeB64u(entry, 32);
    if (!hash) return undefined;
    if (seen.has(entry as string)) continue;
    seen.add(entry as string);
    set.push(hash);
  }
  return set;
}
