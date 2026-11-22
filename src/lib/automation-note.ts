// A wait's follow-up starts its turn with a user-role line the app wrote; keyed on role alone it would read as the person's own.
import { t } from "@/lib/i18n";
import { peerLine } from "@/lib/peer-message";
import type { WireMessage as Message } from "../../shared/wire.ts";

export interface AutomationNote {
  /** The person's words for what the wait was for. Absent on a second start that only carries the app's own line. */
  wait?: string;
  /** What the bot was asked to do then. Empty when the line holds none. */
  instructions: string;
  /** The run's second start: what cut the first one off. */
  resumed?: "restart" | "interrupted";
}

const PREFIX = "[Wait finished: ";
const WAIT_FINISHED = /^\[Wait finished: ([^\n]*?)\] /;
const SECOND_START = /(?:^|\n\n)\[OpenMausBot: this run's first start ([^\]]*?) before it finished\. [^\]]*\]$/;

/** The waits a transcript's own cards record: what each was called and what it was to do afterwards. */
export type KnownWait = { label: string; followUp: string };
const known = new WeakMap<object, KnownWait[]>();
export function knownWaits(messages: readonly Pick<Message, "card">[]): KnownWait[] {
  let waits = known.get(messages);
  if (!waits) known.set(messages, (waits = messages.flatMap((message) => (message.card?.waitRequest ? [message.card.waitRequest] : []))));
  return waits;
}

// A label may itself hold "] ", where the text alone cannot tell it from the instructions: the wait's card can.
function waitLabel(text: string, waits: readonly KnownWait[]): string | undefined {
  if (!text.startsWith(PREFIX)) return undefined;
  const named = waits.filter((wait) => text.startsWith(`${PREFIX}${wait.label}] `)).sort((a, b) => b.label.length - a.label.length);
  return (named.find((wait) => text.startsWith(`${PREFIX}${wait.label}] ${wait.followUp}`)) ?? named[0])?.label ?? WAIT_FINISHED.exec(text)?.[1];
}

/** Only a line the server marked as started by an automation: the same words typed by a person stay theirs. */
export function automationNote(message: Pick<Message, "role" | "kind" | "text" | "automated">, waits: readonly KnownWait[] = []): AutomationNote | null {
  if (message.role !== "user" || message.automated !== true || (message.kind && message.kind !== "text")) return null;
  const text = message.text ?? "";
  const wait = waitLabel(text, waits);
  const second = SECOND_START.exec(text);
  if (wait === undefined && second?.index !== 0) return null;
  const resumed = second ? (second[1]!.includes("restarted") ? "restart" : "interrupted") : undefined;
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
  note.wait === undefined ? resumedText(note) ?? "" : t("chat.automationNote.followUp", { label: note.wait });
