// A bot a teammate hands work to does it in a thread of its own, which closes once the result is back. So that opening
// the bot shows the work happened, its main chat keeps one quiet line for it ("Mochi asked me: Octopus facts"), which
// opens that thread. The line is a record, not an announcement: it marks nothing unread, buzzes nothing and puts nothing
// in the Inbox. It is an activity row with no tool item, so it is never context for the bot's model
// (delta-context.ts isContextMessage, context-rebuild.ts replayToolCalls, skill-review.ts), and it starts no turn.
// It stays bounded: one line per hand-off thread, and fresh hand-offs from the same bot with nothing from the person in
// between fold into the line already there, with a count.
import { noticeTool } from "../chat-notices.ts";
import type { Message, Store } from "../store.ts";

const SUMMARY_MAX = 60;
/** How many hand-off threads one folded line remembers, so a follow-up into any of them adds nothing. */
const THREADS_KEPT = 50;

type AskedBy = NonNullable<Message["askedBy"]>;

function clipped(text: string): string {
  const characters = [...text];
  return characters.length <= SUMMARY_MAX ? text : `${characters.slice(0, SUMMARY_MAX - 1).join("").trimEnd()}…`;
}

/** What was asked, as the line says it: the title the sender gave, else the start of its message, on one line and short. */
export function handedSummary(text: string, title?: string): string {
  const named = title?.replace(/\s+/g, " ").trim();
  return clipped(named || text.replace(/\s+/g, " ").trim());
}

/** The app shows it in the viewer's language from `nameCode`; `tool.name` keeps the English for phones and exports. */
export function handedLine(input: { from: { botId: string; name: string }; summary: string; botId: string; threadId: string; threadTitle: string; count?: number; threadIds?: string[] }): Omit<Message, "id" | "at"> {
  const count = input.count ?? 1;
  return {
    role: "bot", kind: "activity",
    tool: count > 1
      ? noticeTool("chat.notice.askedMeTimes", { bot: input.from.name, count, title: input.summary }, { ok: true })
      : noticeTool("chat.notice.askedMe", { bot: input.from.name, title: input.summary }, { ok: true }),
    threadRef: { botId: input.botId, threadId: input.threadId, title: input.threadTitle },
    askedBy: { botId: input.from.botId, name: input.from.name, ...(count > 1 ? { count } : {}), threadIds: input.threadIds ?? [input.threadId] },
  };
}

/** A line the person wrote, not one a bot, routine or app sent in. */
const fromThePerson = (message: Message) => message.role === "user" && !message.automated && !message.peerAsk && !message.aside;

export type HandedLineDeps = {
  store: Pick<Store, "appendMessage" | "patchMessage" | "taskByThread" | "activePath">;
  /** The bot's main chat with the person, or undefined when it has none open to write in. */
  mainThread(botId: string): string | undefined;
};

/** Records one hand-off to `botId`, worked in `threadId`, in the bot's main chat. Nothing when the work runs in the main
 * chat itself, the main chat is archived, or a line there already opens this thread. Returns the line's id. */
export function postHandedLine(deps: HandedLineDeps, input: { botId: string; threadId: string; from: { botId: string; name: string }; text: string; title?: string }): string | undefined {
  const main = deps.mainThread(input.botId);
  if (!main || main === input.threadId) return undefined;
  const work = deps.store.taskByThread(input.botId, input.threadId), home = deps.store.taskByThread(input.botId, main);
  if (!work || !home || home.archivedAt !== undefined) return undefined;
  const path = deps.store.activePath(main);
  const lines = path.filter((message) => message.askedBy !== undefined);
  if (lines.some((message) => message.askedBy!.threadIds?.includes(input.threadId) || message.threadRef?.threadId === input.threadId)) return undefined;
  const summary = handedSummary(input.text, input.title);
  const last = lines.at(-1);
  const lastAt = last ? path.lastIndexOf(last) : -1;
  if (last && last.askedBy!.botId === input.from.botId && !path.slice(lastAt + 1).some(fromThePerson)) {
    const was: AskedBy = last.askedBy!;
    const threadIds = [...(was.threadIds ?? []), input.threadId].slice(-THREADS_KEPT);
    const line = handedLine({ from: input.from, summary, botId: input.botId, threadId: input.threadId, threadTitle: work.title, count: (was.count ?? 1) + 1, threadIds });
    return deps.store.patchMessage(main, last.id, line)?.id;
  }
  return deps.store.appendMessage(main, handedLine({ from: input.from, summary, botId: input.botId, threadId: input.threadId, threadTitle: work.title })).id;
}

/** The main chat a hand-off line goes to: none while the main chat the person chose is archived, rather than another one. */
export function handedMainThread(bot: { mainThreadChoice?: string; mainThreadKept?: { id: string; under?: string } } | null | undefined,
  archived: (threadId: string) => boolean, main: () => string | undefined): string | undefined {
  const chosen = bot?.mainThreadKept && bot.mainThreadKept.under === bot.mainThreadChoice ? bot.mainThreadKept.id : bot?.mainThreadChoice;
  if (chosen && archived(chosen)) return undefined;
  return main();
}

/** Runs `post` so that a failure in the line never stops the hand-off it records: the work goes on, the error is logged. */
export function writeHandedLine(post: () => unknown, log: (line: string) => void): void {
  try { post(); } catch (error) { log(`hand-off line not written: ${error instanceof Error ? error.message : String(error)}`); }
}
