// A Codex turn refused by the ChatGPT account's own Codex usage limit: the server writes these words, the app
// recognizes them to offer OpenAI's usage page instead of Retry.

export const CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage";

export const CODEX_USAGE_LIMIT_REACHED = "Your ChatGPT account (used by Codex) reached its Codex usage limit.";

export function codexUsageLimitReached(message: string): boolean {
  return message.includes(CODEX_USAGE_LIMIT_REACHED);
}
