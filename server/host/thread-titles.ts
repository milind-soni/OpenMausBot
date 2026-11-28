import { generateThreadTitle } from "../thread-title-generate.ts";
import { titleTurnExcerpt, type ThreadTitleSource } from "../thread-title.ts";

export const TITLE_REPLY_WAIT_MS = 30_000;
type TitleModel = Parameters<typeof generateThreadTitle>[0];
export type ThreadTitleGate = { ok: true; instance: TitleModel } | { ok: false; refusal: string };

export interface AutomaticTitle {
  request: string;
  currentTitle?: string;
  stillCurrent(): boolean;
  model(): ThreadTitleGate;
  apply(title: string): void;
}

export function createAutomaticThreadTitles(generate = generateThreadTitle) {
  const pending = new Map<string, {
    attempt: AutomaticTitle;
    timer: ReturnType<typeof setTimeout> | undefined;
    turnId?: string;
    generating?: true;
  }>();

  function drop(threadId: string) {
    const current = pending.get(threadId);
    if (current) clearTimeout(current.timer);
    pending.delete(threadId);
  }

  async function finish(threadId: string, turnId?: string, reply?: string) {
    const current = pending.get(threadId);
    if (!current || current.generating || (turnId !== undefined && current.turnId !== undefined && current.turnId !== turnId)) return;
    clearTimeout(current.timer);
    current.generating = true;
    try {
      const { attempt } = current;
      if (!attempt.stillCurrent() || (attempt.currentTitle && !reply)) return;
      const excerpt = titleTurnExcerpt(attempt.request, reply, attempt.currentTitle);
      if (!excerpt) return;
      const gate = attempt.model();
      if (!gate.ok) {
        console.warn("title generation: model-unavailable");
        return;
      }
      const source: ThreadTitleSource = attempt.currentTitle ? "follow-up" : reply ? "first-reply" : "first-message";
      const title = await generate(gate.instance, excerpt, source);
      if (title && pending.get(threadId) === current && attempt.stillCurrent()) attempt.apply(title);
    } catch (error) {
      console.warn(`title generation: ${error instanceof Error ? error.name : "error"}`);
    } finally {
      if (pending.get(threadId) === current) drop(threadId);
    }
  }

  return {
    start(threadId: string, attempt: AutomaticTitle) {
      if (pending.has(threadId)) return;
      const timer = attempt.currentTitle ? undefined : setTimeout(() => void finish(threadId), TITLE_REPLY_WAIT_MS);
      timer?.unref();
      pending.set(threadId, { attempt, timer });
    },
    generating: (threadId: string) => pending.get(threadId)?.generating === true,
    turnStarted(threadId: string, turnId?: string, room = false) {
      const current = pending.get(threadId);
      if (current && turnId && (room || current.turnId === undefined)) current.turnId = turnId;
    },
    replyReceived(threadId: string, turnId: string | undefined, text: string) {
      if (text.trim()) void finish(threadId, turnId, text.trim());
    },
    turnEnded: (threadId: string, turnId?: string, reply?: string) => void finish(threadId, turnId, reply?.trim() || undefined),
    drop,
  };
}
