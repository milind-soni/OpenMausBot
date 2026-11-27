import { useEffect, useState } from "react";

import { fetchMemoryDoc, fetchMemoryOverview, fetchThreadNotes, MEMORY_INDEX, type MemoryDoc, type ThreadNotesDoc } from "@/lib/memory";
import type { Bot } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";

export interface MemoryNotesState {
  /** MEMORY.md first; on a Team Cloud also the person's topic files. Null until read. */
  docs: MemoryDoc[] | null;
  error: boolean;
  /** On a Team Cloud the notes are the signed-in person's own layer. */
  mine: boolean;
  /** The open conversation's own notes; null until read, where they cannot be read, and on a Team Cloud. */
  thread: ThreadNotesDoc | null;
  setDoc: (doc: MemoryDoc) => void;
  reload: () => Promise<void>;
}

async function readDocs(botId: string, mine: boolean): Promise<MemoryDoc[]> {
  if (!mine) return [await fetchMemoryDoc(botId, MEMORY_INDEX)];
  const overview = await fetchMemoryOverview(botId, true);
  return Promise.all([MEMORY_INDEX, ...overview.topics.map((topic) => topic.path)].map((path) => fetchMemoryDoc(botId, path, true)));
}

/** The notes the bot panel shows for a bot whose memory is on. They are read again as a turn starts and ends, so a note
 * the bot just saved shows. */
export function useMemoryDoc(bot: Pick<Bot, "id" | "memoryEnabled" | "busy" | "threadId">): MemoryNotesState {
  const mine = useStoreSelector((state) => Boolean(state.config?.team));
  const [state, setState] = useState<{ botId: string; threadId: string; docs: MemoryDoc[] | null; thread: ThreadNotesDoc | null; error: boolean }>({ botId: bot.id, threadId: bot.threadId, docs: null, thread: null, error: false });
  const memoryOn = bot.memoryEnabled !== false;

  const read = async (botId: string, threadId: string, cancelled?: () => boolean) => {
    try {
      const [docs, thread] = await Promise.all([readDocs(botId, mine), mine ? null : fetchThreadNotes(botId, threadId).then((doc) => typeof doc?.text === "string" ? doc : null, () => null)]);
      if (!cancelled?.()) setState({ botId, threadId, docs, thread, error: false });
    } catch {
      if (!cancelled?.()) setState({ botId, threadId, docs: null, thread: null, error: true });
    }
  };

  const busy = Boolean(bot.busy);
  useEffect(() => {
    if (!memoryOn) return;
    let cancelled = false;
    void read(bot.id, bot.threadId, () => cancelled);
    return () => { cancelled = true; };
  }, [bot.id, bot.threadId, memoryOn, busy, mine]);

  const own = state.botId === bot.id;
  return {
    docs: own ? state.docs : null,
    thread: own && state.threadId === bot.threadId ? state.thread : null,
    error: own && state.error,
    mine,
    setDoc: (doc) => setState((current) => ({
      ...current,
      botId: bot.id,
      docs: (current.botId === bot.id ? current.docs ?? [] : []).map((existing) => existing.path === doc.path ? doc : existing),
      error: false,
    })),
    reload: () => read(bot.id, bot.threadId),
  };
}
