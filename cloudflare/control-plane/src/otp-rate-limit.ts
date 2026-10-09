import { z } from "zod";

import { json } from "./http";

const OTP_SEND_PATH = "/api/auth/email-otp/send-verification-otp";
const RECIPIENT_WINDOW_MS = 15 * 60 * 1_000;
const RECIPIENT_MAX_ATTEMPTS = 3;
const RETENTION_MS = 24 * 60 * 60 * 1_000;
const recipientSchema = z.object({
  email: z.string().trim().min(1).max(254).toLowerCase(),
});

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function recipientKey(email: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email)));
}

async function normalizedRecipient(request: Request): Promise<string | null> {
  try {
    const parsed = recipientSchema.safeParse(await request.clone().json());
    return parsed.success ? parsed.data.email : null;
  } catch {
    return null;
  }
}

/**
 * Returns Better Auth's generic success response only when the recipient limit
 * is exhausted. Invalid requests keep flowing to Better Auth for validation.
 */
export async function limitedOTPResponse(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== OTP_SEND_PATH) return null;

  const email = await normalizedRecipient(request);
  if (!email) return null;

  const now = Date.now();
  const windowCutoff = now - RECIPIENT_WINDOW_MS;
  const key = await recipientKey(email, env.BETTER_AUTH_SECRET);
  // The limit and its retention sweep share one D1 batch: one round trip and
  // one transaction. The sweep never removes a row this request just wrote.
  const [result] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO otp_recipient_rate_limits
        (recipient_key, window_started_at, attempts, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(recipient_key) DO UPDATE SET
         window_started_at = CASE
           WHEN window_started_at <= ? THEN excluded.window_started_at
           ELSE window_started_at
         END,
         attempts = CASE
           WHEN window_started_at <= ? THEN 1
           ELSE attempts + 1
         END,
         updated_at = excluded.updated_at
       WHERE window_started_at <= ? OR attempts < ?`,
    ).bind(key, now, now, windowCutoff, windowCutoff, windowCutoff, RECIPIENT_MAX_ATTEMPTS),
    env.DB.prepare(
      "DELETE FROM otp_recipient_rate_limits WHERE updated_at < ?",
    ).bind(now - RETENTION_MS),
  ]);

  return result.meta.changes === 0 ? json({ success: true }) : null;
}
