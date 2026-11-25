// A bot a teammate hands work to does it in a thread of its own, which closes once the result is back. So that opening
// the bot shows the work happened, its main chat gets one quiet line per hand-off ("Mochi asked me: Octopus facts"),
// which opens that thread, and the main chat is marked unread like any other news. The line is an activity row with no
// tool item: it is never context for the bot's model (delta-context.ts isContextMessage, context-rebuild.ts
// replayToolCalls) and it starts no turn. Nothing else is sent: no notification, no card, nothing to answer.
import { serverLine } from "../server-lines.ts";
import type { Message, Store } from "../store.ts";

/** The words the app shows in the viewer's language; `tool.name` keeps them in the main chat's language. */
export const HANDED_LINE_CODE = "chat.notice.askedMe";
const SUMMARY_MAX = 60;

/** What was asked, as the line says it: the title the sender gave, else the start of its message on one line. */
export function handedSummary(text: string, title?: string): string {
  const named = title?.replace(/\s+/g, " ").trim();
  if (named) return named;
  const words = text.replace(/\s+/g, " ").trim();
  const characters = [...words];
  return characters.length <= SUMMARY_MAX ? words : `${characters.slice(0, SUMMARY_MAX - 1).join("").trimEnd()}…`;
}

export function handedLine(input: { from: string; summary: string; botId: string; threadId: string; threadTitle: string; language?: string }): Omit<Message, "id" | "at"> {
  const params = { bot: input.from, title: input.summary };
  return {
    role: "bot", kind: "activity",
    tool: { name: serverLine(input.language, "server.teammates.askedMe", params), ok: true, nameCode: HANDED_LINE_CODE, nameParams: params },
    threadRef: { botId: input.botId, threadId: input.threadId, title: input.threadTitle },
  };
}

export type HandedLineDeps = {
  store: Pick<Store, "appendMessage" | "patchTask" | "taskByThread">;
  /** The bot's main chat with the person. */
  mainThread(botId: string): string | undefined;
  language(threadId: string): string | undefined;
};

/** Leaves the line for one hand-off to `botId`, worked in `threadId`, in the bot's main chat, and marks that chat unread.
 * Nothing when the work runs in the main chat itself. Returns the line's id. */
export function postHandedLine(deps: HandedLineDeps, input: { botId: string; threadId: string; from: string; text: string; title?: string }): string | undefined {
  const main = deps.mainThread(input.botId);
  if (!main || main === input.threadId) return undefined;
  const work = deps.store.taskByThread(input.botId, input.threadId);
  if (!work || !deps.store.taskByThread(input.botId, main)) return undefined;
  const line = handedLine({ from: input.from, summary: handedSummary(input.text, input.title), botId: input.botId, threadId: input.threadId,
    threadTitle: work.title, language: deps.language(main) });
  const { id } = deps.store.appendMessage(main, line);
  deps.store.patchTask(input.botId, main, { unread: true });
  return id;
}
