// The person's own message in their one-to-one chat goes first. Sent while the bot works, it is steered into the running
// turn or waits in the queue, and the engine reads a steered message only once the tool call it is in returns: a command
// that polls CI can keep it unread for ten minutes. So once a tool call has run PERSON_FIRST_MS while the person's message
// waits unanswered, the turn is stopped and the message runs next, ahead of anything else queued in that chat. Only a
// person's own message does this: rooms, routines, teammates and apps wait their turn. A turn waiting on the person (a
// question, a sign-in) or on a computer is never stopped this way.
import type { RuntimeEvent } from "../contracts.ts";

export const PERSON_FIRST_MS = 60_000;
/** How soon a turn that was waiting on the person or a computer when its time came is looked at again. */
const RECHECK_MS = 10_000;

/** A message from the person that waits on the running turn. */
export interface PersonWait {
  /** Steered into the turn, so stopping the turn would drop it: this queues it again, ahead of the queue, with `note`
   * (what was stopped, for the model; on the newest one only) after the person's words. Absent when it already waits in
   * the queue. */
  requeue?(note?: string): void;
}

export interface PersonFirstDeps {
  waiting(threadId: string): boolean;
  /** Stops the thread's running turn; `line` is the plain sentence the person sees for it. */
  stop(threadId: string, line: string): Promise<unknown>;
  firstMs?: number;
  now?(): number;
  /** Runs `run` after `ms`; the returned function cancels it. */
  schedule?(run: () => void, ms: number): () => void;
}

interface RunningTool {
  at: number;
  /** The tool and, for a shell call, its command, as the engine described it. */
  label: string;
}

interface Watch {
  tools: Map<string, RunningTool>;
  waits: PersonWait[];
  /** A tool call returned since the newest waiting message, so the engine's next step has read it. */
  read: boolean;
  cancel: (() => void) | null;
  acted: boolean;
}

/** "45 s", "9 min". */
export function ranFor(ms: number): string {
  return ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`;
}

export function stoppedLine(ms: number): string {
  return `Stopped a step that had run for ${ranFor(ms)}, to answer you first`;
}

/** What the model is told after the person's words, in the turn that answers them. */
export function stoppedNote(label: string, ms: number): string {
  return `[OpenMausBot: your step ${JSON.stringify(label)} had run for ${ranFor(ms)} with this message unread, so it was stopped for you to answer first. Answer this now. If that step still matters, do not wait inside a command again: check it once, then use wait_until or a one-time trigger to check back.]`;
}

function toolLabel(event: Extract<RuntimeEvent, { type: "item.started" }>): string {
  const title = (event.title ?? "tool").trim() || "tool";
  const summary = event.summary?.replace(/\s+/g, " ").trim();
  return summary ? `${title}: ${summary}` : title;
}

export function createPersonFirst(deps: PersonFirstDeps) {
  const firstMs = Math.max(500, deps.firstMs ?? PERSON_FIRST_MS);
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((run: () => void, ms: number) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  });
  const watches = new Map<string, Watch>();

  const watchOf = (threadId: string): Watch => {
    let watch = watches.get(threadId);
    if (!watch) watches.set(threadId, (watch = { tools: new Map(), waits: [], read: false, cancel: null, acted: false }));
    return watch;
  };

  const disarm = (watch: Watch) => {
    watch.cancel?.();
    watch.cancel = null;
  };

  const forget = (threadId: string) => {
    const watch = watches.get(threadId);
    if (watch) disarm(watch);
    watches.delete(threadId);
  };

  const act = (threadId: string, watch: Watch, tool: RunningTool) => {
    watch.acted = true;
    const ran = now() - tool.at;
    const waits = watch.waits.splice(0);
    const noted = waits.findLast((wait) => wait.requeue);
    for (const wait of waits) wait.requeue?.(wait === noted ? stoppedNote(tool.label, ran) : undefined);
    void Promise.resolve().then(() => deps.stop(threadId, stoppedLine(ran))).catch(() => {});
  };

  /** Acts once the oldest running tool call has held a waiting message for `firstMs`, else looks again then. */
  const check = (threadId: string) => {
    const watch = watches.get(threadId);
    if (!watch) return;
    disarm(watch);
    if (watch.acted || watch.waits.length === 0) return;
    let oldest: RunningTool | null = null;
    for (const tool of watch.tools.values()) if (!oldest || tool.at < oldest.at) oldest = tool;
    if (!oldest) return;
    const due = oldest.at + firstMs - now();
    if (due > 0) {
      watch.cancel = schedule(() => check(threadId), due);
      return;
    }
    if (deps.waiting(threadId)) {
      watch.cancel = schedule(() => check(threadId), RECHECK_MS);
      return;
    }
    act(threadId, watch, oldest);
  };

  const answered = (threadId: string) => {
    const watch = watches.get(threadId);
    if (!watch || !watch.read || watch.waits.length === 0) return;
    watch.waits = [];
    disarm(watch);
  };

  return {
    /** The person's own message is waiting on this thread's running turn. */
    wait(threadId: string, wait: PersonWait): void {
      const watch = watchOf(threadId);
      watch.waits.push(wait);
      watch.read = false;
      check(threadId);
    },

    onEvent(event: RuntimeEvent): void {
      const { threadId } = event;
      switch (event.type) {
        case "turn.started":
        case "turn.completed":
          forget(threadId);
          return;
        case "item.started":
          if (event.itemType !== "tool" || !event.itemId) return;
          watchOf(threadId).tools.set(event.itemId, { at: now(), label: toolLabel(event) });
          check(threadId);
          return;
        case "item.completed": {
          if (event.itemType === "assistant_text") {
            if (!event.synthetic) answered(threadId);
            return;
          }
          const watch = watches.get(threadId);
          if (event.itemType !== "tool" || !watch) return;
          if (event.itemId) watch.tools.delete(event.itemId);
          watch.read = true;
          check(threadId);
          return;
        }
        case "content.delta":
          if (event.streamKind === "assistant_text" && !event.synthetic && event.delta.trim()) answered(threadId);
          return;
      }
    },

    forget,
  };
}

export type PersonFirst = ReturnType<typeof createPersonFirst>;
