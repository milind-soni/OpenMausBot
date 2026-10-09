// The free trial's Claude credit refusing a call (docs/cloud-pro.md, "Trial
// Claude credit"): what the Admin's relay, an OpenAI-compatible API, answers
// when it will not run one, and the words a person reads instead of the raw
// API error. The credit's engine (cloud-credit-provider.ts), OpenMausBot's own
// chat engine, reads it.

import type { TrialCreditRefusal } from "../shared/trial-credit.ts";

// The words a person reads for each refusal live beside the app's own copy
// of them (shared/trial-credit.ts), which words them in the reader's language.
export { TRIAL_CREDIT_REFUSED, type TrialCreditRefusal } from "../shared/trial-credit.ts";
/** The refusals that end the credit on this Cloud. */
export type TrialCreditEnd = "used_up" | "ended";
export const trialCreditEnds = (refusal: TrialCreditRefusal): refusal is TrialCreditEnd => refusal === "used_up" || refusal === "ended";

/** The credit's engine once the person's own AI can run on My Cloud: theirs always wins. */
export const TRIAL_CREDIT_OWN_AI = "Your own AI is connected on My Cloud, so bots use it instead of the trial Claude credit.";

/** The relay's own codes, which it puts first in its error object (the chat
 * engine keeps only the start of an error body). */
const RELAY_CODE = /"code"\s*:\s*"(trial_credit_used_up|trial_credit_ended|trial_credit_too_low|invalid_api_key)"/;

/** What the relay said about the credit, from its HTTP status and its own
 * error code: 402 `trial_credit_used_up` is used up, 402
 * `trial_credit_ended` or 401 `invalid_api_key` (a token it no longer knows)
 * is no longer on this Cloud, 400 `trial_credit_too_low` is too little left
 * for this request, and any 429 is paused for now. A 401, 402 or 403 without
 * the relay's own code (a proxy's page, say) is an ordinary failed call, as
 * is anything else (a 5xx, a request it could not read): never the end of
 * the credit. */
export function trialCreditRefusal(status: number, body = ""): TrialCreditRefusal | null {
  if (status === 429) return "paused";
  const code = RELAY_CODE.exec(body)?.[1];
  if (status === 402 && code === "trial_credit_used_up") return "used_up";
  if ((status === 402 && code === "trial_credit_ended") || (status === 401 && code === "invalid_api_key")) return "ended";
  if (status === 400 && code === "trial_credit_too_low") return "too_low";
  return null;
}

/** The chat engine's failure line for an HTTP answer it was refused
 * (drivers/openai-chat.ts: "upstream HTTP 402: <the start of the body>"),
 * read back. A model's reply never takes this shape, so one that talks about
 * credit is never taken for a refusal. */
const HTTP_FAILURE = /^upstream HTTP (\d{3})(?::\s?([\s\S]*))?$/;
export function trialCreditFailure(message: string): TrialCreditRefusal | null {
  const match = HTTP_FAILURE.exec(message);
  return match ? trialCreditRefusal(Number(match[1]), match[2] ?? "") : null;
}
