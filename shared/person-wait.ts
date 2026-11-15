// What a conversation waits on the person for: the one reading behind the sidebar's Waiting, the inbox, the phone's
// Updates, what a "done" notification may say and what other bots are told.
import { liveCardKind } from "./live-approval.ts";
import { signInWaits } from "./sign-in-request.ts";
import type { WireMessage } from "./wire.ts";

export type PersonWaitKind = "approval" | "question" | "review" | "password" | "sign-in" | "connect";

export interface PersonWait {
  kind: PersonWaitKind;
  messageId: string;
  at: number;
  /** The person's words for what is needed: a question, a proposal's title, a key's name, a site or an app. */
  label: string;
  /** In a room, the bot that asked. */
  botId?: string;
  tool?: string;
}

/** A first-hour offer to connect an app is the product suggesting something; no work waits on it. */
export const FIRST_HOUR_OFFER_KEY = "first-hour-";

type WaitRow = Pick<WireMessage, "id" | "at" | "kind" | "card" | "secret" | "signIn" | "connector" | "from" | "inbox">;

/** What this row waits on the person for, or null: anything superseded, cancelled, declined, stopped, answered or expired
 * waits on nobody. */
export function personWait(row: WaitRow): PersonWait | null {
  const own = { messageId: row.id, at: row.at, ...(row.from?.botId ? { botId: row.from.botId } : {}) };
  const { secret, signIn, connector, card } = row;
  if (row.kind === "secret") {
    if (!secret || secret.provided || secret.dismissed || secret.superseded || secret.resumed || secret.stopped) return null;
    return { ...own, kind: "password", label: secret.label };
  }
  if (row.kind === "signin") {
    if (!signIn || !signInWaits(signIn) || signIn.resumed || signIn.stopped) return null;
    return { ...own, kind: "sign-in", label: signIn.site };
  }
  if (row.kind === "connector") {
    if (!connector || connector.status === "connected" || connector.dismissed || connector.superseded || connector.resumed || connector.stopped) return null;
    return connector.resumeKey.startsWith(FIRST_HOUR_OFFER_KEY) ? null : { ...own, kind: "connect", label: connector.label };
  }
  if (row.kind !== "options" || row.inbox || card?.quotaSwitch || card?.teamMemoryRequest || card?.autoApplied) return null;
  const kind = liveCardKind(card);
  if (!kind) return null;
  return { ...own, kind, label: card?.subtitle || card?.title || "", ...(card?.tool ? { tool: card.tool } : {}) };
}

/** The newest thing this conversation's visible branch waits on the person for. */
export function openPersonWait(path: readonly WaitRow[]): PersonWait | undefined {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const wait = personWait(path[index]!);
    if (wait) return wait;
  }
  return undefined;
}

/** An approval lives and ends with the running turn it paused; every other card still waits once its turn has ended. */
export const outlivesTurn = (wait: Pick<PersonWait, "kind">): boolean => wait.kind !== "approval";

type SpokenRow = Pick<WireMessage, "role" | "peerAsk" | "relayed" | "via" | "automated" | "replyToId">;
type PathRow = WaitRow & SpokenRow;

/** A line the person wrote themselves, not one another bot, a relay, the API or an automation put in the conversation. */
export const personWrote = (row: SpokenRow): boolean =>
  row.role === "user" && !row.peerAsk && !row.relayed && row.via !== "api" && !row.automated;

/** The questions on this branch the person has written past: they no longer wait on them. In a room the person talks to
 * the others too, so only a reply to the question itself passes it. */
export function overtakenQuestions(path: readonly PathRow[], room: boolean): Set<string> {
  const passed = new Set<string>();
  const repliedTo = new Set<string>();
  let spoke = false;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const row = path[index]!;
    if (personWrote(row)) {
      spoke = true;
      if (row.replyToId) repliedTo.add(row.replyToId);
    } else if (personWait(row)?.kind === "question" && (room ? repliedTo.has(row.id) : spoke)) passed.add(row.id);
  }
  return passed;
}

/** The newest wait still open once no turn is running, so the conversation rests on the person. */
export function restingOnPerson(path: readonly PathRow[], room = false): PersonWait | undefined {
  const passed = overtakenQuestions(path, room);
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const wait = personWait(path[index]!);
    if (wait && outlivesTurn(wait) && !passed.has(wait.messageId)) return wait;
  }
  return undefined;
}
