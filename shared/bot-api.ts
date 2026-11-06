/** The Bot API's public address and the command the app shows for it. The receiver that takes webhooks
 * (`<base>/hooks/…`) takes these calls too, so a Cloud and a self-hosted edge need no second route. */
export const BOT_API_KEY_PLACEHOLDER = "YOUR_KEY";
/** What a caller or a person is told on the Starter plan. */
export const BOT_API_UPGRADE = "Bot API comes with a higher plan. Upgrade this Cloud to use it.";

export function botApiEndpoint(hooksBaseUrl: string, botId: string): string {
  return `${hooksBaseUrl.replace(/\/+$/, "")}/hooks/api/bots/${encodeURIComponent(botId)}/messages`;
}

/** Runs as pasted in a POSIX shell: the key sits in double quotes, the JSON body in single quotes. */
export function botApiCurl(endpoint: string, key: string = BOT_API_KEY_PLACEHOLDER): string {
  return [
    `curl -X POST "${endpoint}" \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"message": "Hello! What can you do?"}'`,
  ].join("\n");
}

/** A Bot API answer: `reply` once the bot answered; otherwise what the caller should do next. */
export type BotApiReply =
  | { reply: string; thread: string }
  | { thread: string; status: "working" | "needs_approval" };
