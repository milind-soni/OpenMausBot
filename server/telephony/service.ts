// Twilio account wiring for phone calls and SMS. The bot dials and texts from the
// account's own number; the owner's number is the one caller ID that is ever trusted.
// Keys come from the environment (or a local `.env` for anything it does not set);
// no number is ever assumed by default.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { redactSecretsInText } from "../redact.ts";

export interface TelephonyConfig {
  accountSid: string;
  /** Basic auth user: the account SID with an auth token, or an API key SID with its secret. */
  authUser: string;
  authToken: string;
  /** The number Twilio assigns the bot (E.164). Empty when unset: calls and SMS refuse. */
  botPhoneNumber: string;
  /** The one number the door treats as the owner (E.164). Empty: nobody is the owner. */
  ownerPhoneNumber: string;
  /** The public base of the webhook receiver, as Twilio dials it (scheme, host, port). */
  publicUrl?: string;
  /** A LiveKit SIP address a call is bridged into; empty keeps the call on Twilio itself. */
  livekitSipUri?: string;
}

const E164 = /^\+[1-9]\d{6,14}$/;
const TWILIO_API = "https://api.twilio.com/2010-04-01";

/** A `.env` beside the server fills only what the process environment leaves out. */
function loadEnvFile(path = resolve(".env")): Record<string, string> {
  if (!existsSync(path)) return {};
  const file: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const value = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[match[1]] === undefined) file[match[1]!] = value;
  }
  return file;
}

export function loadTelephonyConfig(env: NodeJS.ProcessEnv = process.env): TelephonyConfig {
  const vars = { ...loadEnvFile(), ...onlySet(env) };
  const accountSid = vars.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const authToken = vars.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const apiKeySid = vars.TWILIO_API_KEY_SID?.trim() ?? "";
  const apiKeySecret = vars.TWILIO_API_KEY_SECRET?.trim() ?? "";
  return {
    accountSid,
    authUser: apiKeySid && apiKeySecret ? apiKeySid : accountSid,
    authToken: apiKeySid && apiKeySecret ? apiKeySecret : authToken,
    botPhoneNumber: vars.TWILIO_PHONE_NUMBER?.trim() ?? "",
    ownerPhoneNumber: vars.USER_AUTHORIZED_PHONE_NUMBER?.trim() ?? "",
    publicUrl: withoutSlash(vars.TELEPHONY_PUBLIC_URL || vars.OMB_PUBLIC_URL || vars.OMB_WEBHOOK_PUBLIC_URL),
    livekitSipUri: vars.LIVEKIT_SIP_URI?.trim() || undefined,
  };
}

const onlySet = (env: NodeJS.ProcessEnv) => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = `${value}`;
  return out;
};

const withoutSlash = (url?: string) => (url?.trim() ? url.trim().replace(/\/+$/, "") : undefined);

export function configured(config: TelephonyConfig): boolean {
  return Boolean(config.accountSid && config.authUser && config.authToken && config.botPhoneNumber);
}

export function e164(number: string): boolean {
  return E164.test(number.trim());
}

/** Only the owner's number, matched exactly: a number ending in the same digits is a stranger. */
export function isOwner(fromNumber: string, config: TelephonyConfig): boolean {
  const caller = fromNumber.replace(/[^\d]/g, "");
  const owner = config.ownerPhoneNumber.replace(/[^\d]/g, "");
  return Boolean(caller && owner && caller === owner);
}

export interface TwilioResult {
  ok: boolean;
  sid?: string;
  error?: string;
}

async function twilioPost(
  config: TelephonyConfig,
  path: string,
  params: Record<string, string>,
  fetcher: typeof fetch,
): Promise<TwilioResult> {
  if (!configured(config)) {
    return { ok: false, error: "Twilio is not configured. Set TWILIO_ACCOUNT_SID, an auth token or API key, and TWILIO_PHONE_NUMBER in .env." };
  }
  const auth = "Basic " + Buffer.from(`${config.authUser}:${config.authToken}`).toString("base64");
  try {
    const res = await fetcher(`${TWILIO_API}/Accounts/${config.accountSid}${path}`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!res.ok) return { ok: false, error: redactSecretsInText(data.message || `Twilio answered HTTP ${res.status}`) };
    return { ok: true, sid: data.sid };
  } catch (error) {
    return { ok: false, error: redactSecretsInText(error instanceof Error ? error.message : String(error)) };
  }
}

/** One SMS from the bot's number. The body is the caller-visible text, so it stays plain. */
export async function sendSms(
  config: TelephonyConfig,
  input: { to: string; body: string },
  fetcher: typeof fetch = fetch,
): Promise<TwilioResult> {
  if (!e164(input.to)) return { ok: false, error: "The destination number is not a phone number." };
  if (!input.body.trim()) return { ok: false, error: "An empty SMS says nothing." };
  if (input.body.length > 1600) return { ok: false, error: "An SMS longer than 1600 characters cannot be sent." };
  return twilioPost(
    config,
    "/Messages.json",
    { To: input.to.trim(), From: config.botPhoneNumber, Body: input.body },
    fetcher,
  );
}

/** One outbound call. The webhook that answers it is the public door's voice URL, so a call without a public URL refuses. */
export async function placeCall(
  config: TelephonyConfig,
  input: { to: string; objective: string },
  fetcher: typeof fetch = fetch,
): Promise<TwilioResult> {
  if (!e164(input.to)) return { ok: false, error: "The destination number is not a phone number." };
  if (!input.objective.trim()) return { ok: false, error: "An empty objective cannot be a call." };
  if (!config.publicUrl) return { ok: false, error: "Outbound calls need TELEPHONY_PUBLIC_URL: the public base of this server's webhook receiver." };
  const url = `${config.publicUrl}/hooks/telephony/voice/outbound?objective=${encodeURIComponent(input.objective.trim())}`;
  return twilioPost(
    config,
    "/Calls.json",
    { To: input.to.trim(), From: config.botPhoneNumber, Url: url },
    fetcher,
  );
}