// The setting that fixes a failed turn, read from its stored row: another model for the bot (its AI is out of credits,
// at a usage or rate limit, overloaded, or cannot run this model), the AI's sign-in, or the workspace's spend limit.
// Null for anything a setting does not fix.
import { failedTurnCause, type FailedTurnTool } from "./failed-turn.ts";

export type SettingFix = "model" | "sign-in" | "spend-limit";

/** How our own spend-cap refusal (server/spend.ts) begins; no provider's words about its own limits begin this way. */
export const SPEND_LIMIT_REFUSAL = "this workspace has reached its monthly spend limit";

const MODEL_NOTICES = /^chat\.notice\.(?:usageLimit|usageLimitResets|claudeExtraUsage|claudeLimit\w*|toolCount\w*|modelNoRoute\w*)$/;
/** engine-errors.ts's own sentences for an AI that is out of credits, limited, overloaded or failing. */
const MODEL_WORDS = /\baccount is out of credits\b|\bhit a rate limit\b|\bhas reached its usage limit\b|\bis overloaded right now\b|\bhad a temporary server problem\b|\bswitch (?:this|the) bot to another (?:AI|model)\b/i;
const SIGNED_OUT = /\b(?:is signed out|isn't signed in|sign in again|sign-in has expired)\b/i;

export function settingFix(tool: Pick<FailedTurnTool, "name" | "nameCode" | "setup">): SettingFix | null {
  const cause = failedTurnCause(tool.name);
  if (cause === null) return null;
  if (cause.toLowerCase().includes(SPEND_LIMIT_REFUSAL)) return "spend-limit";
  if (tool.nameCode && MODEL_NOTICES.test(tool.nameCode)) return "model";
  if (MODEL_WORDS.test(cause)) return "model";
  if (tool.setup && SIGNED_OUT.test(cause)) return "sign-in";
  return null;
}
