// Reactions on chat messages. A 👍 or 👎 answers an open card or a line in a person's inbox; any other reaction, and a
// 👍 or 👎 on any other bot message, is quiet feedback the bot reads with its next turn: no line is posted, no turn starts.

/** Every reaction a client offers and the server accepts, in the order clients show them. */
export const REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "👀"] as const;
export type Reaction = (typeof REACTIONS)[number];

/** What a reaction did, as POST /api/threads/:threadId/messages/:messageId/reactions reports it: an inbox line's answer
 * `started` a turn where the line came from, or waits `queued` behind the running turn; the open card on the message was
 * `answered`; feedback the bot reads with its next turn (`noted`); or nothing reached a bot. */
export type ReactionDelivery = "started" | "queued" | "answered" | "noted" | "none";

/** On a card or an inbox line, 👍 answers yes and 👎 answers no; any other reaction answers nothing. */
export function reactionAnswer(emoji: string | null | undefined): "yes" | "no" | null {
  return emoji === "👍" ? "yes" : emoji === "👎" ? "no" : null;
}

/** Slack sends a reaction's short name. Telegram, Discord and WhatsApp send the emoji itself. */
const SLACK_NAMES: Readonly<Record<string, Reaction>> = {
  "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎", heart: "❤️", joy: "😂", tada: "🎉", eyes: "👀",
};
const SLACK_NAME = /^:?([a-z0-9_+-]+)(?:::skin-tone-[2-6])?:?$/;
/** Skin tones and the emoji presentation selector, which each platform adds or drops on its own. */
const VARIANTS = /[\u{1F3FB}-\u{1F3FF}]|\uFE0F/gu;

/** The reaction a person meant, from any client or chat channel: the emoji in any skin tone or presentation, or
 * Slack's name for it. Null for anything outside REACTIONS. */
export function normalizeReaction(raw: unknown): Reaction | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const value = raw.trim();
  const name = SLACK_NAME.exec(value.toLowerCase())?.[1];
  if (name) return Object.hasOwn(SLACK_NAMES, name) ? SLACK_NAMES[name]! : null;
  const bare = value.replace(VARIANTS, "");
  return REACTIONS.find((reaction) => reaction.replace(VARIANTS, "") === bare) ?? null;
}
