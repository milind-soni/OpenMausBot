/**
 * A bot asking the person to sign in to a website themselves, in the place the
 * bot works. OpenMausBot never receives a website password: the person types it
 * into the page, and the bot uses the session the page keeps.
 */
import type { SignInRequestCardData, Surface } from "./wire.ts";

/** The steps a bot hands to the person. */
export type HandoffNeed = "sign_in" | "captcha" | "payment" | "approval" | "other";

/** What a handoff card adds to a site sign-in. Without `instruction` the card is a site sign-in, where `site` is the
 * headline; with it, `url` and `site` are the page the bot had open, or empty when none was. */
export interface HandoffCardFields {
  /** The bot's one sentence on the step the person does. */
  instruction?: string;
  /** What kind of step it is. */
  need?: HandoffNeed;
  /** When an unanswered handoff ends on its own (epoch ms). */
  expiresAt?: number;
  /** Nobody answered before `expiresAt`; the bot was told. */
  expired?: boolean;
  /** The person's own words sent with Done or Skip, passed to the bot. */
  note?: string;
}

/** Where the login has to happen: the place the asking turn worked in.
 * The built-in browser keeps its own sign-ins, apart from any computer's
 * browser, so a login made anywhere else would not reach the bot. */
export type SignInPlace = Surface;

/** The site as a page address and the host shown on the card. A bare
 * domain means its https home page. Anything that is not a plain http(s)
 * address — a script URL, a file, an address carrying a username or
 * password — is refused, so the card can never open more than a page. */
export function normalizeSignInSite(raw: unknown): { url: string; site: string } | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  // eslint-disable-next-line no-control-regex -- Reject control characters and spaces before URL parsing normalizes them.
  if (!text || text.length > 2048 || /[\u0000- \u007f\\]/u.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) return null;
  // A bare word is no site ("example" would parse as a host); localhost and
  // addresses are the exceptions a developer's own app needs.
  if (!url.hostname.includes(".") && url.hostname !== "localhost" && !url.hostname.startsWith("[")) return null;
  return { url: url.href, site: url.hostname.replace(/^www\./, "") };
}

/** A still-open sign-in card for this site — the set a newer request
 * supersedes. Done, cancelled, already-superseded and answered-in-chat
 * cards keep their settled state. In a room only the asking bot's own
 * cards count. */
export function isPendingSignInRequest(
  message: {
    kind?: unknown;
    signIn?: { site?: unknown; done?: unknown; cancelled?: unknown; superseded?: unknown; answeredInChat?: unknown };
    from?: { botId?: unknown };
  },
  site: string,
  requestingBotId: string,
  roomThread: boolean,
): boolean {
  return (
    message.kind === "signin" &&
    message.signIn?.site === site &&
    signInWaits(message.signIn) &&
    (!roomThread || message.from?.botId === requestingBotId)
  );
}

/** Whether the card still waits on the person: not done, cancelled, expired, superseded or answered in the chat. */
export function signInWaits(card: { done?: unknown; cancelled?: unknown; expired?: unknown; superseded?: unknown; answeredInChat?: unknown }): boolean {
  return card.done !== true && card.cancelled !== true && card.expired !== true && card.superseded !== true && card.answeredInChat !== true;
}

/** Whether a sign-in card, if there still is one, waits on the person: not stopped and still open. */
export function signInCardWaits(card: ({ stopped?: unknown } & Parameters<typeof signInWaits>[0]) | undefined): boolean {
  return card !== undefined && card.stopped !== true && signInWaits(card);
}

export type SignInCardOutcome = "done" | "cancelled" | "expired";

/** How a card ended, or null while it is open. */
export function signInOutcome(state: { done?: unknown; cancelled?: unknown; expired?: unknown }): SignInCardOutcome | null {
  if (state.done === true) return "done";
  if (state.cancelled === true) return "cancelled";
  if (state.expired === true) return "expired";
  return null;
}

/** The line that resumes the bot, through the same continuation the
 * credential card uses. */
export function signInResumePrompt(site: string, outcome: "done" | "cancelled"): string {
  return outcome === "done"
    ? `OpenMausBot sign-in update: the person finished signing in to ${site}. Check you are signed in, then continue the task that paused for it. Never ask them for a password or a one-time code in chat.`
    : `OpenMausBot sign-in update: the person declined to sign in to ${site}. Continue without it if you can, or briefly explain what you could not do. Never ask them for a password or a one-time code in chat.`;
}

export const HANDOFF_NEEDS: readonly HandoffNeed[] = ["sign_in", "captcha", "payment", "approval", "other"];

/** How long a handoff waits for the person before it ends on its own. */
export const HANDOFF_EXPIRY_MS = 30 * 60_000;

export const HANDOFF_INSTRUCTION_MAX = 300;
export const HANDOFF_NOTE_MAX = 400;

/** A card that hands a step to the person, with the bot's own instruction, rather than a site sign-in. */
export function isHandoff(card: Pick<SignInRequestCardData, "instruction"> | undefined): boolean {
  return typeof card?.instruction === "string" && card.instruction.length > 0;
}

export function handoffNeed(raw: unknown): HandoffNeed | null {
  return HANDOFF_NEEDS.find((need) => need === raw) ?? null;
}

/** The person's note as the bot is given it: one line, trimmed and bounded. */
export function handoffNote(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const note = raw.replace(/\s+/gu, " ").trim().slice(0, HANDOFF_NOTE_MAX);
  return note || undefined;
}

const NEVER_IN_CHAT = "Never ask for a password, a one-time code or payment details in chat.";

/** The line that resumes the bot once a handoff ends. "Done" is the person's claim, so the bot looks again before it
 * goes on: its old page refs are stale after a person used the page. */
export function handoffResumePrompt(card: Pick<SignInRequestCardData, "instruction" | "note">, outcome: SignInCardOutcome): string {
  const step = JSON.stringify(card.instruction ?? "");
  const note = card.note ? ` They added: ${JSON.stringify(card.note)}.` : "";
  const look = "Re-read the page first (a new snapshot or screenshot): your earlier refs are stale.";
  if (outcome === "done") {
    return `OpenMausBot handoff update: outcome done. The person pressed I'm done on ${step}.${note} That is their claim and is unverified. ${look} Check the step really happened before you say or do anything that relies on it; if it did not, say what you see and ask what to do next. ${NEVER_IN_CHAT}`;
  }
  if (outcome === "cancelled") {
    return `OpenMausBot handoff update: outcome skipped. The person skipped ${step}.${note} Continue without that step if you can, or say briefly what you could not do. ${look} ${NEVER_IN_CHAT}`;
  }
  return `OpenMausBot handoff update: outcome expired. Nobody answered ${step} in time, so the request ended. ${look} Continue without it if you can, or say in one line that the step still needs the person. ${NEVER_IN_CHAT}`;
}

/** The resume line for any sign-in card: a handoff's own, else the site sign-in's. */
export function signInCardResumePrompt(card: Pick<SignInRequestCardData, "site" | "instruction" | "note">, outcome: SignInCardOutcome): string {
  if (isHandoff(card)) return handoffResumePrompt(card, outcome);
  return signInResumePrompt(card.site, outcome === "done" ? "done" : "cancelled");
}
