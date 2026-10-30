import type { OptionCardData } from "./wire.ts";

/** On a Team Cloud, a line in a person's inbox: their own conversation with their own Chief of Staff (their own MausBot
 * when they crowned none), where everything addressed to them arrives. It says who it is from and where it came from,
 * so clients can label it and open that conversation. Replying to the line answers it: the answer goes back where it
 * came from. */
export interface InboxItem {
  /** "message": a teammate's or a bot's message, or an @mention; "ask": a question or approval card, copied here
   * and answered here as there; "result": a routine's report; "notice": a failure or a sign-in it needs. */
  kind: "message" | "ask" | "result" | "notice";
  /** Who it is from: a teammate (their address) or a bot (its id). */
  from: { name: string; email?: string; botId?: string };
  /** The bot that passed a teammate's message on. */
  via?: { botId: string; name: string };
  /** The conversation it came from, when the person may open it. */
  origin?: { botId: string; threadId: string; title: string; groupId?: string; messageId?: string };
  /** It waits on the person's answer. */
  replies?: true;
  /** The sender's assistant wrote it for them, from what they share with the team. */
  assistant?: true;
  /** How it was answered: the person's own words, or their assistant's, which answers facts only. */
  answers?: Array<{ by: "person" | "assistant"; text: string; at: number }>;
}

/** A task's fields on a team's server when it is a person's inbox, sent to that person alone. */
export interface InboxTask {
  /** This person's inbox, the conversation with their Chief where everything for them arrives. */
  inbox?: true;
  /** The asks waiting on them there (questions, approvals, work handed on), each open where it was asked; absent when
   * none. */
  openAsks?: number;
  /** When what the inbox lists last changed; a client that shows the list reads it again when this moves. */
  inboxChangedAt?: number;
}

/** Where a line of the inbox is listed: "needs-you" while it waits on the person (an ask whose card is open where it was
 * asked), "info" for news until they answer it or mark it done, "done" once it is settled or marked done. */
export type InboxTab = "needs-you" | "info" | "done";

/** One line of a person's inbox as their inbox lists it, newest first. `kind` names its source; a new source adds a kind
 * of its own with what its row needs. */
export interface InboxRow {
  /** The line's id in the inbox conversation. */
  id: string;
  kind: InboxItem["kind"];
  tab: InboxTab;
  from: InboxItem["from"];
  via?: InboxItem["via"];
  origin?: InboxItem["origin"];
  text: string;
  at: number;
  unread: boolean;
  replies?: true;
  answers?: InboxItem["answers"];
  /** An ask's card as the inbox holds it: answering it answers the card where it was asked. */
  card?: OptionCardData;
}

/** A person's inbox: where its lines live (none yet before the first arrives), and the line the inbox's card in that
 * conversation sits under (the newest that needed them, else the newest). */
export interface InboxView {
  botId: string;
  threadId: string | null;
  rows: InboxRow[];
  anchor: string | null;
}
