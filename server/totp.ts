// TOTP (RFC 6238 over RFC 4226 HOTP) for saved logins; counter-based keys are refused, since a code that advances on use cannot be shared with the person's own app.
import { createHmac } from "node:crypto";

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpKey {
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, case-insensitive; spaces, dashes and padding ignored. */
export function decodeBase32(text: string): Buffer | null {
  const clean = text.replace(/[\s-]/gu, "").replace(/=+$/u, "").toUpperCase();
  if (!clean || !/^[A-Z2-7]+$/u.test(clean)) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    buffer = (buffer << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function parseTotpKey(raw: unknown): TotpKey | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > 2048) return null;
  let secret = text;
  let algorithm: TotpAlgorithm = "SHA1";
  let digits = 6;
  let period = 30;
  if (/^otpauth:/iu.test(text)) {
    let url: URL;
    try { url = new URL(text); } catch { return null; }
    if (url.hostname.toLowerCase() !== "totp") return null;
    secret = url.searchParams.get("secret") ?? "";
    const named = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase().replace("-", "");
    if (named !== "SHA1" && named !== "SHA256" && named !== "SHA512") return null;
    algorithm = named;
    digits = Number(url.searchParams.get("digits") ?? 6);
    period = Number(url.searchParams.get("period") ?? 30);
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) return null;
  if (!Number.isInteger(period) || period < 10 || period > 300) return null;
  const bytes = decodeBase32(secret);
  if (!bytes || bytes.length < 10) return null;
  return { secret: secret.replace(/[\s-]/gu, "").replace(/=+$/u, "").toUpperCase(), algorithm, digits, period };
}

/** RFC 4226 HOTP over a raw key: dynamic truncation of HMAC(key, counter). */
export function hotp(key: Buffer, counter: number, digits: number, algorithm: TotpAlgorithm = "SHA1"): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm.toLowerCase(), key).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The code a key shows at `nowMs` (RFC 6238, T0 = 0). */
export function totpCode(key: TotpKey, nowMs: number = Date.now()): string {
  const bytes = decodeBase32(key.secret);
  if (!bytes) throw new Error("The saved 2FA key is not valid base32.");
  return hotp(bytes, Math.floor(nowMs / 1000 / key.period), key.digits, key.algorithm);
}
