// A wait's follow-up starts its turn with a user-role line the app wrote; keyed on role alone it would read as the person's own.
import { t } from "@/lib/i18n";
import type { WireMessage as Message } from "../../shared/wire.ts";

export interface AutomationNote {
  /** The person's words for what the wait was for. Absent on a second start that only carries the app's own line. */
  wait?: string;
  /** What the bot was asked to do then. Empty when the line holds none. */
  instructions: string;
  /** The run's second start: what cut the first one off. */
  resumed?: "restart" | "interrupted";
}

const WAIT_FINISHED = /^\[Wait finished: ([^\n]*?)\] /;
const SECOND_START = /(?:^|\n\n)\[OpenMausBot: this run's first start ([^\]]*?) before it finished\. [^\]]*\]$/;

export function automationNote(message: Pick<Message, "role" | "kind" | "text">): AutomationNote | null {
  if (message.role !== "user" || (message.kind && message.kind !== "text")) return null;
  const text = message.text ?? "";
  const wait = WAIT_FINISHED.exec(text);
  const second = SECOND_START.exec(text);
  if (!wait && second?.index !== 0) return null;
  const resumed = second ? (second[1]!.includes("restarted") ? "restart" : "interrupted") : undefined;
  return {
    ...(wait ? { wait: wait[1]! } : {}),
    instructions: text.slice(wait?.[0].length ?? 0, second?.index ?? text.length).trim(),
    ...(resumed ? { resumed } : {}),
  };
}

const RESUMED = { restart: "chat.automationNote.resumedAfterRestart", interrupted: "chat.automationNote.resumed" } as const;

export const resumedText = (note: AutomationNote): string | null => (note.resumed ? t(RESUMED[note.resumed]) : null);

/** The note's one line: the wait it follows, or on a second start with nothing else to name, why it started again. */
export const automationNoteTitle = (note: AutomationNote): string =>
  note.wait === undefined ? resumedText(note) ?? "" : t("chat.automationNote.waitOver", { label: note.wait });
