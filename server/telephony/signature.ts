// Twilio webhook request signatures: HMAC-SHA1 over the request URL and the sorted
// POST parameters, base64-encoded in the X-Twilio-Signature header
// (https://twilio.com/docs/usage/security#validating-requests).
import { createHmac, timingSafeEqual } from "node:crypto";

export const TWILIO_SIGNATURE_HEADER = "x-twilio-signature";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function twilioSignature(url: string, params: Readonly<Record<string, string>>, token: string): string {
  const sorted = Object.keys({ ...params })
    .sort()
    .map((key) => `${key}${params[key]}`);
  return createHmac("sha1", token).update(`${url}${sorted.join("")}`).digest("base64");
}

/** A door's auth: Twilio signs the URL exactly as it requested it, so the caller must pass
 * the same public base URL the webhook is registered under, not the receiving socket's. */
export function verifyTwilioSignature(input: {
  url: string;
  params: Readonly<Record<string, string>>;
  header: string | undefined;
  token: string;
}): boolean {
  if (!input.header || !input.token) return false;
  return safeEqual(twilioSignature(input.url, input.params, input.token), input.header);
}

/** Twilio posts webhooks form-encoded. */
export function parseForm(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) params[key] = value;
  return params;
}