// Reactions on chat messages. A 👍 or 👎 on a bot's message is the person's reply to it; the others say how they feel.

/** Every reaction a client offers and the server accepts, in the order clients show them. */
export const REACTIONS = ["👍", "👎", "❤️", "😂", "🎉", "👀"] as const;
export type Reaction = (typeof REACTIONS)[number];

/** What a reaction did, as POST /api/threads/:threadId/messages/:messageId/reactions reports it: a turn `started` with
 * it as the person's reply to that message, or the reply waits `queued` behind the running turn; the open card on the
 * message was `answered`; a feeling the bot reads with its next turn (`noted`); or nothing reached a bot. */
export type ReactionDelivery = "started" | "queued" | "answered" | "noted" | "none";

/** 👍 answers yes and 👎 answers no; any other reaction answers nothing. */
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
