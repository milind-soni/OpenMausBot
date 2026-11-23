// A wait's follow-up starts its turn with a user-role line the app wrote; keyed on role alone it would read as the person's own.
import { t } from "@/lib/i18n";
import { peerLine } from "@/lib/peer-message";
import type { WireMessage as Message } from "../../shared/wire.ts";

export interface AutomationNote {
  /** The person's words for what the wait was for. Absent on a second start that only carries the app's own line. */
  wait?: string;
  /** A wait's follow-up whose wait no loaded card confirms: its own card not loaded yet, or an older line, with no id, that two cards match whole or none names. */
  unnamed?: true;
  /** What the bot was asked to do then. Empty when the line holds none. */
  instructions: string;
  /** The run's second start: what cut the first one off. */
  resumed?: "restart" | "interrupted";
}

const PREFIX = "[Wait finished: ";
const SECOND_START = /(?:^|\n\n)\[OpenMausBot: this run's first start ([^\]]*?) before it finished\. [^\]]*\]$/;

/** The waits a transcript's own cards record: what each was called and what it was to do afterwards. */
export type KnownWait = { waitId?: string; label: string; followUp: string };
const known = new WeakMap<object, KnownWait[]>();
export function knownWaits(messages: readonly Pick<Message, "card">[]): KnownWait[] {
  let waits = known.get(messages);
  if (!waits) known.set(messages, (waits = messages.flatMap((message) => (message.card?.waitRequest ? [message.card.waitRequest] : []))));
  return waits;
}

// A label may itself hold "] ", where the text alone cannot tell it from the instructions: only the wait's card can.
// A line with the wait's id takes that wait's card or no name at all, since a paged transcript may not hold it yet.
// A line without one takes the card that matches it whole, second-start part aside, then one that starts it, then the longest name;
// null, never a guess, when two cards match it whole or no card names it.
function waitLabel(text: string, waitId: string | undefined, waits: readonly KnownWait[]): string | null | undefined {
  if (!text.startsWith(PREFIX)) return undefined;
  const named = waits.filter((wait) => text.startsWith(`${PREFIX}${wait.label}] `)).sort((a, b) => b.label.length - a.label.length);
  if (waitId !== undefined) return named.find((wait) => wait.waitId === waitId)?.label ?? null;
  const body = text.slice(0, SECOND_START.exec(text)?.index ?? text.length).trim();
  const said = (wait: KnownWait) => `${PREFIX}${wait.label}] ${wait.followUp}`;
  const whole = named.filter((wait) => body === said(wait).trim());
  if (new Set(whole.map((wait) => wait.label)).size > 1) return null;
  return (whole[0] ?? named.find((wait) => body.startsWith(said(wait))) ?? named[0])?.label ?? null;
}

/** Only a line the server marked as started by an automation: the same words typed by a person stay theirs. */
export function automationNote(message: Pick<Message, "role" | "kind" | "text" | "automated" | "waitId">, waits: readonly KnownWait[] = []): AutomationNote | null {
  if (message.role !== "user" || message.automated !== true || (message.kind && message.kind !== "text")) return null;
  const text = message.text ?? "";
  const wait = waitLabel(text, message.waitId, waits);
  const second = SECOND_START.exec(text);
  if (wait === undefined && second?.index !== 0) return null;
  const resumed = second ? (second[1]!.includes("restarted") ? "restart" : "interrupted") : undefined;
  if (wait === null) return { unnamed: true, instructions: text.slice(0, second?.index ?? text.length).trim(), ...(resumed ? { resumed } : {}) };
  return {
    ...(wait === undefined ? {} : { wait }),
    instructions: text.slice(wait === undefined ? 0 : PREFIX.length + wait.length + 2, second?.index ?? text.length).trim(),
    ...(resumed ? { resumed } : {}),
  };
}

/** The line a reply answers, which Regenerate and Try again send again, and the last one the person typed, which they may edit. */
export function lastRequests<Line extends Pick<Message, "role" | "kind" | "text" | "automated" | "peerAsk" | "reaction">>(messages: readonly Line[]): { answered?: Line; typed?: Line } {
  const said = messages.filter((message) => message.role === "user" && message.kind === "text" && !peerLine(message));
  return { answered: said.at(-1), typed: said.findLast((message) => !message.reaction && !automationNote(message)) };
}

const RESUMED = { restart: "chat.automationNote.resumedAfterRestart", interrupted: "chat.automationNote.resumed" } as const;

export const resumedText = (note: AutomationNote): string | null => (note.resumed ? t(RESUMED[note.resumed]) : null);

/** The note's one line: the wait it follows, or on a second start with nothing else to name, why it started again. */
export const automationNoteTitle = (note: AutomationNote): string =>
  note.unnamed ? t("chat.automationNote.followUpUnnamed")
    : note.wait === undefined ? resumedText(note) ?? "" : t("chat.automationNote.followUp", { label: note.wait });
