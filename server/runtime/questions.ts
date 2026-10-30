// A bot's question to the person, read the same way wherever it was asked.
import type { Assignment } from "./types.ts";

/** At Full access ("Just do it") a teammate's question is its requester's to answer, in work the person or their routine
 * started. Security: work an outside event started (a webhook, a relay, a guest) still asks the person, since its brief
 * is not the person's authority. */
export const requesterDecides = (a: Pick<Assignment, "level" | "requester" | "origin">): boolean =>
  a.level === "full" && a.requester.kind === "bot_turn" && a.origin.kind !== "outside";

// What only the person can do, however a bot words it: sign in (or pass a sign-in code), pay, or hand over a secret or
// an account of their own. English and German stems; anything else a bot can decide.
const PERSON_ONLY = new RegExp([
  "sign(?:ed|ing)?[- ]?(?:in|on)", "log(?:ged|ging)?[- ]?in", "login", "2fa", "two[- ]factor", "one[- ]time (?:code|password)", "otp\\b",
  "verification code", "security code", "captcha", "passkey", "password", "passcode", "secret", "api[- ]?key", "access token",
  "credential", "pay\\b", "pays\\b", "paying", "payment", "purchas", "buy\\b", "buying", "credit card", "card details",
  "(?:your|their) (?:own )?accounts?\\b", "connect your", "anmeld", "einlogg", "passwort", "kennwort", "zugangsdaten", "schlüssel",
  "bezahl", "zahlung", "kaufen", "kreditkarte", "(?:ihr|dein)(?:em|en|e)? konto",
].map((stem) => `\\b${stem}`).join("|"), "iu");

/** Whether a question asks for something no bot can give: a sign-in, a payment, a secret or the person's own account. */
export function personOnly(question: string): boolean {
  return PERSON_ONLY.test(question);
}

/** A NEEDS INPUT question split from the default its asker named after it (`Default: …`), when it named one. */
export function withDefault(question: string): { question: string; default?: string } {
  const named = /^([\s\S]*?)\s*\bDefault:\s*(\S[^\r\n]*)/i.exec(question);
  const asked = named?.[1]?.trim();
  return named && asked ? { question: asked, default: named[2]!.trim() } : { question };
}
