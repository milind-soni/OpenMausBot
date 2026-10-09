// The free trial's Claude credit refusing a turn, in the plain English words
// the server stores in the failed turn's row (server/trial-credit.ts): the
// phones read those words whole, and the app words them again in the
// reader's language by telling which refusal a row carries.

/** Used up or no longer on this Cloud (both for good, until another token
 * comes), paused for now, or too little left for this one request. */
export type TrialCreditRefusal = "used_up" | "ended" | "paused" | "too_low";

export const TRIAL_CREDIT_REFUSED: Record<TrialCreditRefusal, string> = {
  used_up: "Your trial Claude credit is used up. To keep your bots working, sign in with your own Claude or ChatGPT account, or add an API key.",
  ended: "Trial Claude credit isn't available on My Cloud anymore. Sign in with your own Claude or ChatGPT account, or add an API key.",
  paused: "Trial Claude credit is paused for now. Try again later, or sign in with your own Claude or ChatGPT account, or add an API key.",
  too_low: "Your trial Claude credit has too little left for this chat. Start a new chat, or sign in with your own Claude or ChatGPT account, or add an API key.",
};

/** Which refusal a failed turn's cause is, or null for any other failure. */
export function trialCreditKind(cause: string): TrialCreditRefusal | null {
  return (Object.keys(TRIAL_CREDIT_REFUSED) as TrialCreditRefusal[]).find(kind => TRIAL_CREDIT_REFUSED[kind] === cause.trim()) ?? null;
}
