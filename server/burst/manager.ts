// A burst from proposal to one merged result. Every step costs what its own child costs, never what the burst has queued:
// counts live on the burst row, children are taken from an index, and a full read happens once, when the burst settles.
import { randomUUID } from "node:crypto";

import type { BurstCardData, BurstChildRow, BurstView } from "../../shared/burst.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import { BurstLane } from "./lane.ts";
import type { BurstLimits } from "./limits.ts";
import { burstRow, type BurstChild, type BurstRecord, type BurstStore } from "./store.ts";

const MINUTES_PER_TASK = 3;
const TICK_MS = 3_000;
const START_ATTEMPTS = 5;
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60_000;
const REASON_MAX = 200;
const RESULT_MAX = 20_000;
const FAILURES_SHOWN = 10;
/** What one merge turn reads of all the parts together: a burst of any size fits one engine's context. */
const MERGE_BUDGET = 150_000;
export const ITEM_MAX = 2_000;
export const INSTRUCTIONS_MAX = 12_000;

/** How a child's turn or a merge turn ended. */
export interface BurstTurnOutcome {
  ok: boolean;
  text: string;
  /** It stopped to ask the person something. */
  asked?: boolean;
}

/** The server's refusal to start a turn now, for a reason that passes (the thread is busy, the account is settling). */
export const startsLater = (error: unknown): boolean => (error as { status?: number })?.status === 409
  && ["thread_busy", "settling", "thread_limit"].includes((error as { code?: string }).code ?? "");

export interface BurstManagerDeps {
  store: BurstStore;
  limits(): BurstLimits;
  /** Whether one more burst thread may start now: the person's own work goes first. */
  hasRoom(): boolean;
  /** The bot's name and the thread a child runs in. Null when the bot is gone. */
  openThread(burst: BurstRecord, child: BurstChild): string | null;
  startChild(burst: BurstRecord, child: BurstChild & { threadId: string }, text: string, done: (outcome: BurstTurnOutcome) => void): Promise<void>;
  stopChild(burst: BurstRecord, child: BurstChild): void;
  /** Starts the merge turn in the parent thread on the bot's own model; `text` is read only then, so a busy parent costs no read of the parts. False when that thread is busy. */
  startMerge(burst: BurstRecord, text: () => string, done: (outcome: BurstTurnOutcome) => void): Promise<boolean>;
  /** Draws the card, or redraws it in place; returns its message id. */
  draw(burst: BurstRecord, card: BurstCardData): string | undefined;
  /** The merge turn could not write a result: post the parts as they came. */
  postParts(burst: BurstRecord, parts: BurstChild[]): string;
  /** The merged result reached the chat: put it in the person's Inbox too. */
  deliver(burst: BurstRecord, text: string): void;
  now?: () => number;
  log?: (line: string) => void;
}

export interface BurstProposal {
  botId: string;
  threadId: string;
  task: string;
  instructions: string;
  items: readonly string[];
  model: ModelSelection;
  modelName: string;
}

export type BurstRefusal = { refused: string };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const reasonOf = (text: string, fallback: string) => clip(oneLine(text) || fallback, REASON_MAX);

export function childOpening(burst: Pick<BurstRecord, "instructions" | "task">, child: Pick<BurstChild, "seq" | "item">, total: number): string {
  return `[Part ${child.seq + 1} of ${total} of a burst you run for this request: ${oneLine(burst.task)}. It is your own words, not the person's. Work on this part only and end with a clear result, since it will be merged with the others. Do not ask questions: if something is unclear, make a sensible choice and say so. Do not open other threads.]\n\n${burst.instructions}\n\nThis part: ${child.item}`;
}

export function mergePrompt(burst: Pick<BurstRecord, "task">, done: readonly BurstChild[], failed: readonly BurstChild[], cancelled: number): string {
  const each = Math.min(RESULT_MAX, Math.floor(MERGE_BUDGET / Math.max(1, done.length)));
  const parts = done.map((child) => `## ${child.title}\n${clip(child.result ?? "", each)}`);
  const failures = failed.map((child) => `- ${child.title}: ${child.error ?? "it did not finish"}`);
  const left = cancelled > 0 ? ` ${cancelled} more were cancelled.` : "";
  return `[The burst you ran for this request has finished: ${oneLine(burst.task)}. ${done.length} parts are done and ${failed.length} failed.${left} Write one merged result for the person here, in your own words, from the parts below: do not repeat the work or open threads. Then name every part that failed, and say why. Keep it as short as the result allows.]\n\n${parts.join("\n\n")}${failures.length ? `\n\nParts that failed:\n${failures.join("\n")}` : ""}`;
}

type Slot = { burst: BurstRecord; child: BurstChild };

export function createBurstManager(deps: BurstManagerDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.error(`burst: ${line}`));
  /** Bursts with children still queued, in the order they started: one is dropped when it runs dry, so a step never rescans it. */
  const queued: string[] = [];
  const ownThreads = new Set<string>();
  const merging = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const lane = new BurstLane<Slot>({
    parallel: () => deps.limits().parallel,
    hasRoom: deps.hasRoom,
    next() {
      while (queued.length > 0) {
        const burst = store.get(queued[0]!);
        if (burst?.phase === "running") {
          const child = store.takeQueued(burst.id);
          if (child) return { burst, child };
        }
        queued.shift();
      }
      return undefined;
    },
    begin: ({ burst, child }) => { begin(burst, child); },
  });

  function card(burst: BurstRecord, failures?: BurstChild[]): BurstCardData {
    const limits = deps.limits();
    const total = burst.counts.queued + burst.counts.running + burst.counts.done + burst.counts.failed + burst.counts.cancelled;
    const parallel = Math.min(limits.parallel, Math.max(total, 1));
    const shown = failures?.slice(0, FAILURES_SHOWN).map((child) => ({ title: child.title, reason: child.error ?? "" }));
    return {
      version: 1, burstId: burst.id, botId: burst.botId, task: burst.task, phase: burst.phase, total, requested: burst.requested, parallel,
      ...(burst.requested > total ? { taskLimit: limits.maxTasks } : {}), ...(limits.smallPlan ? { smallPlan: true as const } : {}),
      modelName: burst.modelName, estimateMinutes: Math.max(1, Math.ceil(total / Math.max(1, limits.parallel)) * MINUTES_PER_TASK), counts: burst.counts, sample: burst.sample,
      ...(shown?.length ? { failed: shown, ...(failures!.length > shown.length ? { failedMore: failures!.length - shown.length } : {}) } : {}),
    };
  }

  function draw(burst: BurstRecord, failures?: BurstChild[]): BurstRecord {
    const messageId = deps.draw(burst, card(burst, failures));
    return messageId && messageId !== burst.cardMessageId ? store.update(burst.id, { cardMessageId: messageId }) ?? burst : burst;
  }

  function begin(burst: BurstRecord, child: BurstChild): void {
    let threadId = child.threadId;
    if (!threadId) {
      const opened = deps.openThread(burst, child);
      if (!opened) { failStart(burst, child, "The bot is no longer here."); return; }
      threadId = opened;
      store.setThread(burst.id, child.seq, threadId);
    }
    ownThreads.add(threadId);
    const running = { ...child, threadId };
    let ended = false;
    const end = (outcome: BurstTurnOutcome) => { if (!ended) { ended = true; settle(burst.id, running, outcome); } };
    deps.startChild(burst, running, childOpening(burst, child, burst.counts.queued + burst.counts.running + burst.counts.done + burst.counts.failed + burst.counts.cancelled), end).catch((error: unknown) => {
      if (ended) return;
      ended = true;
      ownThreads.delete(threadId);
      if (startsLater(error) && child.attempts < START_ATTEMPTS) { store.requeue(burst.id, child.seq); enlist(burst.id); lane.release(); return; }
      failStart(burst, child, error instanceof Error ? error.message : String(error));
    });
  }

  function failStart(burst: BurstRecord, child: BurstChild, reason: string): void {
    store.settle(burst.id, child.seq, "failed", { error: reasonOf(reason, "It could not start.") });
    childEnded(burst.id);
  }

  function settle(burstId: string, child: BurstChild & { threadId: string }, outcome: BurstTurnOutcome): void {
    ownThreads.delete(child.threadId);
    const cancelled = store.get(burstId)?.phase === "cancelled";
    const fields = cancelled ? {} : outcome.asked
      ? { error: "It stopped to ask a question. Open its thread to answer." }
      : outcome.ok && outcome.text.trim()
        ? { result: clip(outcome.text.trim(), RESULT_MAX) }
        : { error: reasonOf(outcome.text, "It ended without a result.") };
    store.settle(burstId, child.seq, cancelled ? "cancelled" : "result" in fields ? "done" : "failed", fields);
    childEnded(burstId);
  }

  function childEnded(burstId: string): void {
    lane.release();
    const burst = store.get(burstId);
    if (!burst) return;
    if (burst.phase !== "running") { draw(burst); return; }
    if (burst.counts.queued > 0 || burst.counts.running > 0) { draw(burst); return; }
    settled(burst);
  }

  /** Every child has ended. The one full read of a burst. */
  function settled(burst: BurstRecord): void {
    if (burst.counts.done === 0 && burst.counts.failed === 0) {
      draw(store.update(burst.id, { phase: "cancelled" }) ?? burst);
      stopIfIdle();
      return;
    }
    const failures = store.childrenIn(burst.id, "failed");
    draw(store.update(burst.id, { phase: "merging" }) ?? burst, failures);
    merge(burst.id);
  }

  function merge(burstId: string): void {
    const burst = store.get(burstId);
    if (!burst || burst.phase !== "merging" || merging.has(burstId)) return;
    merging.add(burstId);
    let done: BurstChild[] = [], failed: BurstChild[] = [];
    const read = () => {
      done = store.childrenIn(burstId, "done");
      failed = store.childrenIn(burstId, "failed");
      return mergePrompt(burst, done, failed, burst.counts.cancelled);
    };
    let ended = false;
    const end = (outcome: BurstTurnOutcome) => {
      if (ended) return;
      ended = true;
      merging.delete(burstId);
      finish(burst, done, failed, outcome);
    };
    deps.startMerge(burst, read, end).then((started) => {
      if (!started && !ended) { ended = true; merging.delete(burstId); }
    }, (error: unknown) => {
      if (ended) return;
      ended = true;
      merging.delete(burstId);
      log(`${burstId} merge could not start: ${error instanceof Error ? error.message : String(error)}`);
      if (done.length === 0 && failed.length === 0) read();
      finish(burst, done, failed, { ok: false, text: "" });
    });
  }

  function finish(burst: BurstRecord, done: BurstChild[], failed: BurstChild[], outcome: BurstTurnOutcome): void {
    // Settled whatever happens to the chat around it: a burst must never sit in "merging" and keep the timer alive.
    const current = store.update(burst.id, { phase: "done" }) ?? burst;
    try {
      const text = outcome.ok && outcome.text.trim() ? outcome.text.trim() : deps.postParts(burst, [...done, ...failed]);
      draw(current, failed);
      deps.deliver(current, text);
    } catch (error) {
      log(`${burst.id} could not post its result: ${error instanceof Error ? error.message : String(error)}`);
    }
    stopIfIdle();
  }

  function enlist(burstId: string): void {
    if (!queued.includes(burstId)) queued.push(burstId);
  }

  function ensureTimer(): void {
    timer ??= setInterval(tick, TICK_MS);
    timer.unref?.();
  }

  function stopIfIdle(): void {
    if (timer && store.active().length === 0) { clearInterval(timer); timer = null; }
  }

  /** Children whose turn could not start get another chance here, and merges waiting for a free parent thread. */
  function tick(): void {
    lane.pump();
    for (const burst of store.active()) if (burst.phase === "merging") merge(burst.id);
    stopIfIdle();
  }

  /** The list the plan allows, cut to its limit. */
  function allowed(items: readonly string[]): string[] {
    return items.slice(0, deps.limits().maxTasks);
  }

  return {
    /** The server's rule for what a bot may propose, whatever its tool call says. */
    propose(input: BurstProposal): BurstCardData | BurstRefusal {
      const task = clip(oneLine(input.task), 500);
      const items = input.items.map((item) => clip(item.trim(), ITEM_MAX)).filter(Boolean);
      if (!task) return { refused: "A burst needs a task." };
      if (items.length < 2) return { refused: "A burst needs at least two items. One item runs fine in this chat." };
      const kept = allowed(items);
      const burst = store.create({ id: randomUUID(), botId: input.botId, threadId: input.threadId, task, instructions: input.instructions.trim().slice(0, INSTRUCTIONS_MAX),
        model: input.model, modelName: input.modelName, requested: items.length, createdAt: now(), items: kept });
      return card(draw(burst));
    },
    /** Saves a change to a preview. Only a preview changes. */
    edit(id: string, plan: { instructions?: string; items?: readonly string[] }): BurstCardData | BurstRefusal {
      const burst = store.get(id);
      if (!burst) return { refused: "That burst is gone." };
      if (burst.phase !== "preview") return { refused: "This burst already ran." };
      const items = plan.items?.map((item) => clip(item.trim(), ITEM_MAX)).filter(Boolean);
      if (items && items.length < 2) return { refused: "A burst needs at least two items." };
      const instructions = plan.instructions?.trim().slice(0, INSTRUCTIONS_MAX);
      const next = store.replacePlan(id, { ...(instructions !== undefined ? { instructions } : {}), ...(items ? { items: allowed(items), requested: items.length } : {}) }) ?? burst;
      return card(draw(next));
    },
    /** Only a person's press reaches this. The plan is read again here, not taken from the preview. */
    run(id: string): BurstCardData | BurstRefusal {
      let burst = store.get(id);
      if (!burst) return { refused: "That burst is gone." };
      if (burst.phase !== "preview") return { refused: "This burst has already started." };
      const limit = deps.limits().maxTasks;
      if (burst.counts.queued > limit) burst = store.replacePlan(id, { items: store.childrenIn(id, "queued").slice(0, limit).map((child) => child.item) }) ?? burst;
      const running = store.update(id, { phase: "running" }) ?? burst;
      enlist(id);
      ensureTimer();
      const drawn = draw(running);
      lane.pump();
      return card(store.get(id) ?? drawn);
    },
    /** Cancel on the preview, or Cancel all once running. */
    cancel(id: string): BurstCardData | BurstRefusal {
      const burst = store.get(id);
      if (!burst) return { refused: "That burst is gone." };
      if (burst.phase === "done" || burst.phase === "cancelled") return card(burst);
      store.cancelQueued(id);
      const stopping = store.childrenIn(id, "running");
      const current = store.update(id, { phase: "cancelled" }) ?? burst;
      for (const child of stopping) deps.stopChild(current, child);
      stopIfIdle();
      return card(draw(store.get(id) ?? current));
    },
    /** Failed parts run again, and the result is merged again. */
    retryFailed(id: string): BurstCardData | BurstRefusal {
      const burst = store.get(id);
      if (!burst) return { refused: "That burst is gone." };
      if (burst.phase !== "running" && burst.phase !== "done") return { refused: "Nothing to retry right now." };
      if (store.requeueFailed(id).length === 0) return { refused: "Nothing failed." };
      const running = store.update(id, { phase: "running" }) ?? burst;
      enlist(id);
      ensureTimer();
      const drawn = draw(running);
      lane.pump();
      return card(store.get(id) ?? drawn);
    },
    /** The rows a card lists when opened. */
    view(id: string): BurstView | null {
      const burst = store.get(id);
      if (!burst) return null;
      const children = store.children(id);
      return { burstId: id, phase: burst.phase, instructions: burst.instructions, items: children.map((child) => child.item), children: children.map(burstRow) };
    },
    /** Who owns this burst, for the caller's access check. */
    owner(id: string): Pick<BurstRecord, "botId" | "threadId"> | null {
      const burst = store.get(id);
      return burst ? { botId: burst.botId, threadId: burst.threadId } : null;
    },
    /** Whether this thread is a burst thread running in the lane now, outside the plan's turn caps. */
    laneOwned(threadId: string): boolean {
      return ownThreads.has(threadId);
    },
    /** After a restart: a running turn is gone, so its part goes back in line, and a merge waiting on its turn tries again. */
    recover(): void {
      store.prune(now() - PRUNE_AFTER_MS);
      for (const burst of store.active()) {
        if (burst.phase === "running") { store.requeueRunning(burst.id); enlist(burst.id); }
        ensureTimer();
      }
      tick();
    },
    pump(): void {
      lane.pump();
    },
    /** How many burst threads are running in the lane. */
    runningCount(): number {
      return lane.runningCount();
    },
    prune(before: number): number {
      return store.prune(before);
    },
    close(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type BurstManager = ReturnType<typeof createBurstManager>;

export type { BurstChildRow };
