// Start fresh: the next turn of a conversation opens a new engine session, with no earlier message. The messages stay on
// screen; a provider reads only what comes after the newest divider row, which lives on the active path so it survives a
// restart and an engine switch. The bot's instructions, skills, memory and settings are not touched.
import type { Message, Store } from "./store.ts";

export function isFreshStart(message: Pick<Message, "kind" | "compaction">): boolean {
  return message.kind === "compaction" && message.compaction?.fresh === true;
}

/** The part of a conversation path a provider may read: everything after the newest divider. */
export function sinceFreshStart<T extends Pick<Message, "kind" | "compaction">>(path: readonly T[]): T[] {
  return path.slice(path.findLastIndex(isFreshStart) + 1);
}

type FreshStartStore = Pick<Store, "activePath" | "appendMessage" | "patchTask" | "taskByThread">;

/** Writes the session state first: a divider with the old session still resumable would look fresh and not be. `rewound`
 * makes the next turn send sessionReset, so a process kept warm for this thread is closed rather than reused. */
export function startFresh(store: FreshStartStore, botId: string, threadId: string): Message | null {
  const task = store.taskByThread(botId, threadId);
  if (!task) return null;
  store.patchTask(botId, threadId, {
    rewound: true, resumeCursors: {}, appliedCompactionId: undefined, contextFloor: undefined, lastContextModel: undefined,
    ...(task.usage ? { usage: { ...task.usage, context: undefined } } : {}),
  });
  const path = store.activePath(threadId);
  const newest = path.at(-1);
  if (!newest || isFreshStart(newest)) return null;
  return store.appendMessage(threadId, {
    role: "bot", kind: "compaction",
    compaction: { summary: "", firstKeptId: "", foldedThroughId: newest.id, tokensBefore: 0, by: "person", fresh: true },
  });
}
