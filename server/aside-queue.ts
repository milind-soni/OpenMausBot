// The aside lane: peer context handed to a busy thread's RUNNING turn.
//
// A peer send that arrives mid-turn used to degrade straight to the
// delegation queue — full work, later turn, no reply until then. When the
// engine running that turn has a mid-turn seam (Adapter.steer), the same
// words can instead be folded into the live turn at its next step boundary
// as an ASIDE: context the model reads and usually ignores. The person's
// lane keeps real steering (parent authority changes the turn's course);
// an aside never claims that authority, and the envelope says so.
//
// Durability follows steer-queue's shape (chat_followups rows, restore
// only what never dispatched) with one aside-specific rule: the row id is
// the messageId dedupe key, it is written BEFORE the seam call, and the
// injected line lands on the transcript with queueId = row id BEFORE the
// row is deleted. A crash in either window is then self-healing: restore
// skips any row whose transcript already shows its marker (the words ran;
// never replay them) and requeues only the rest. "indeterminate" seam
// outcomes count as injected for the same reason — the words may already
// be running, and running them twice is the one mistake this lane must
// never make.

import type { SteerOutcome } from "./contracts.ts";
import { newId } from "./contracts.ts";
import { chatFollowups, saveChatFollowup, settleChatFollowups } from "./message-db.ts";
import { peerName } from "./peer-roster.ts";
import type { BotRecord, Message } from "./store.ts";
import type { UsageTrigger } from "./usage-ledger.ts";

/** The slice of Store this module needs — narrow so tests can fake it. */
export interface AsideStore {
  bot(id: string): BotRecord | null;
  projectBotForTask?(botId: string, threadId: string): BotRecord | null;
  messagesFor(threadId: string): Message[];
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
}

export interface AsideItem {
  /** Row id: the persisted messageId dedupe key. */
  messageId: string;
  /** The peer's raw words. */
  text: string;
  /** The enveloped line exactly as injected — also what the transcript
   * records, so a replayed session reads the sender and the framing. */
  prompt: string;
  aside: {
    fromBotId: string;
    fromBotName: string;
    unattended?: boolean;
    commsDepth: number;
  };
  /** Who the usage ledger books a degraded follow-up turn to. */
  trigger?: UsageTrigger;
}

interface AsideEntry {
  /** Keep ownership pinned even when the selected task changes. */
  botId: string;
  items: AsideItem[];
}

/** The first waiting aside of a degraded batch: books the follow-up turn. */
export type AsideHead = Pick<AsideItem, "trigger" | "aside">;

const asides = new Map<string, AsideEntry>(); // threadId → waiting asides

/** Threads with an injection or drain in flight: seam calls are awaited
 * work, so two boundaries firing close together must not double-process
 * the same words. */
const inFlight = new Set<string>();

/** The mandatory non-steering envelope (audit §5.2). Every mid-turn channel
 * OMB can ride is steering-branded, so the words themselves must say what
 * they are: peer context from a named sender, not a course change. */
export function asideEnvelope(fromName: string, text: string): string {
  // Peer words sit between fixed markers, and a peer cannot be allowed to
  // forge the closing marker inside its own text: that would end the aside
  // early and make the batched context ambiguous downstream.
  const body = text.replace(/\[\s*end\s+aside\s*\]/gi, "(end aside)");
  return [
    `[aside from @${peerName(fromName)} — peer context, not steering; continue your current plan unless this directly changes a fact you are using]`,
    body,
    "[end aside]",
  ].join("\n");
}

/** Rebuild the in-memory lane after a restart. Only rows whose dispatch
 * never began come back; a row whose transcript already shows its queueId
 * marker was injected before the process died, and those words must never
 * run twice, so the row is retired instead of requeued. */
export function restoreAsideMessages(store: AsideStore): void {
  asides.clear();
  for (const row of chatFollowups("aside")) {
    if (row.status !== "pending") continue;
    if (store.messagesFor(row.threadId).some((message) => message.queueId === row.id)) {
      settleChatFollowups([row.id], null);
      continue;
    }
    const entry = asides.get(row.threadId) ?? { botId: row.ownerId, items: [] };
    if (entry.botId !== row.ownerId) throw new Error("queued aside belongs to another bot");
    entry.items.push({
      messageId: row.id,
      text: row.payload.text,
      prompt: row.payload.prompt ?? row.payload.text,
      aside: row.payload.aside ?? { fromBotId: row.ownerId, fromBotName: "teammate", commsDepth: 0 },
      trigger: row.payload.trigger,
    });
    asides.set(row.threadId, entry);
  }
}

export interface QueuedAside {
  id: string;
}

/** Persist one aside and park it for injection. The row exists before any
 * seam call so a crash can only ever re-queue words that never ran. */
export function queueAsideMessage(
  botId: string,
  threadId: string,
  text: string,
  options: {
    fromBotId: string;
    fromBotName: string;
    unattended?: boolean;
    commsDepth: number;
    trigger?: UsageTrigger;
  },
): QueuedAside {
  const id = newId();
  const item: AsideItem = {
    messageId: id,
    text,
    prompt: asideEnvelope(options.fromBotName, text),
    aside: {
      fromBotId: options.fromBotId,
      fromBotName: options.fromBotName,
      ...(options.unattended ? { unattended: true } : {}),
      commsDepth: options.commsDepth,
    },
    trigger: options.trigger,
  };
  const entry = asides.get(threadId) ?? { botId, items: [] };
  if (entry.botId !== botId) throw new Error("queued aside belongs to another bot");
  saveChatFollowup({
    id,
    kind: "aside",
    ownerId: botId,
    threadId,
    payload: { text: item.text, prompt: item.prompt, aside: item.aside, ...(item.trigger ? { trigger: item.trigger } : {}) },
  });
  entry.items.push(item);
  asides.set(threadId, entry);
  return { id };
}

/** Everything waiting for this thread, in arrival order. */
export function pendingAsides(botId: string, threadId: string): AsideItem[] {
  const entry = asides.get(threadId);
  return entry?.botId === botId ? [...entry.items] : [];
}

/** Record delivered asides: one transcript line per item (enveloped text,
 * queueId marker, peer provenance), then the durable rows are deleted. The
 * marker write precedes the delete, so the crash window between them heals
 * as "already injected" on restore rather than as a replay. */
export function recordInjectedAsides(store: AsideStore, threadId: string, items: AsideItem[]): Message[] {
  const appended: Message[] = [];
  for (const item of items) {
    appended.push(store.appendMessage(threadId, {
      role: "user",
      kind: "text",
      text: item.prompt,
      queueId: item.messageId,
      aside: true,
      peerAsk: {
        botId: item.aside.fromBotId,
        name: item.aside.fromBotName,
        ...(item.aside.unattended ? { unattended: true } : {}),
      },
    }));
  }
  settleChatFollowups(items.map((item) => item.messageId), null);
  // The words are delivered and their rows retired; the in-memory lane must
  // agree, or a later boundary would batch them into another injection.
  const entry = asides.get(threadId);
  if (entry) {
    const delivered = new Set(items.map((item) => item.messageId));
    const remaining = entry.items.filter((item) => !delivered.has(item.messageId));
    if (remaining.length) asides.set(threadId, { botId: entry.botId, items: remaining });
    else asides.delete(threadId);
  }
  return appended;
}

/** Drop a thread's waiting asides: the bot or task is gone, so no turn will
 * ever read them. Tombstoned like a cancelled follow-up. */
export function cancelAsides(threadId: string): void {
  const entry = asides.get(threadId);
  if (!entry) return;
  settleChatFollowups(entry.items.map((item) => item.messageId), "cancelled");
  asides.delete(threadId);
}

/** Fold everything waiting on this thread into its running turn.
 *
 * The rows are marked "dispatching" BEFORE the seam call: a crash at any
 * point then leaves words the restart recovery path treats as may-have-run
 * (recovered to the transcript with a review notice, never re-executed as
 * a turn). "refused" — provably not delivered — returns them to "pending"
 * so the next boundary can try again. "steered" and "indeterminate" both
 * record delivery: the words may already be running, and running them
 * twice is the one mistake this lane must never make.
 *
 * The batch leaves the shared queue BEFORE the seam call and stays out
 * for the whole await: while the words may already be running inside the
 * turn, no later boundary may be able to see them again, and a cancel
 * landing mid-seam must not resurrect them. Only a "refused" outcome on a
 * lane that is still ours puts the words back — ahead of anything that
 * arrived during the call.
 *
 * Returns null when nothing is waiting or the thread is not this bot's;
 * otherwise whether the batch was delivered and how many items it held. */
export async function attemptAsideInjection(
  store: AsideStore,
  botId: string,
  threadId: string,
  inject: (botId: string, threadId: string, prompt: string) => Promise<SteerOutcome>,
): Promise<{ delivered: boolean; count: number } | null> {
  const entry = asides.get(threadId);
  if (!entry || entry.botId !== botId || entry.items.length === 0) return null;
  if (inFlight.has(threadId)) return { delivered: false, count: entry.items.length };
  const batch = entry.items;
  entry.items = [];
  const ids = batch.map((item) => item.messageId);
  settleChatFollowups(ids, "dispatching");
  inFlight.add(threadId);
  let outcome: SteerOutcome;
  try {
    outcome = await inject(botId, threadId, batch.map((item) => item.prompt).join("\n\n"));
  } catch {
    outcome = "indeterminate";
  } finally {
    inFlight.delete(threadId);
  }
  if (outcome === "refused") {
    if (asides.get(threadId) === entry) {
      // Still our lane: back on the queue, ahead of anything that
      // arrived during the seam call.
      entry.items = [...batch, ...entry.items];
      settleChatFollowups(ids, "pending");
    } else {
      // cancelAsides took the lane while the seam call was awaited: the
      // words never ran, but their lane is gone, so they retire with it
      // instead of coming back as phantom rows after a restart.
      settleChatFollowups(ids, "cancelled");
    }
    return { delivered: false, count: batch.length };
  }
  try {
    recordInjectedAsides(store, threadId, batch);
  } catch (error) {
    // The seam says the words may already be running; a failed transcript
    // write must never hand them to a later boundary. Retire the rows
    // loudly instead of replaying them.
    console.error("aside-queue: could not record injected asides", error);
    settleChatFollowups(ids, null);
    if (asides.get(threadId) === entry && entry.items.length === 0) asides.delete(threadId);
  }
  return { delivered: true, count: batch.length };
}

export interface AsideDrainOptions {
  store: AsideStore;
  /** Fold the joined envelopes into the running turn. Returns the seam's
   * tri-state; "refused" means provably not delivered, so the asides stay
   * queued for the next boundary. */
  inject: (botId: string, threadId: string, prompt: string) => Promise<SteerOutcome>;
  /** Start the degraded follow-up turn (the seam is gone or the running
   * turn settled first). Mirrors the steer-queue drain contract. */
  run: (
    botId: string,
    threadId: string,
    prompt: string,
    userMessage: Message,
    excludeIds: string[],
    head: AsideHead,
  ) => void | Promise<void>;
  /** Busy-elsewhere tests from the caller's admission module. */
  isBlocked?: (botId: string, threadId: string) => boolean;
}

/**
 * One boundary pass over the aside lane.
 *
 * Injection first: a thread already running a seam-capable turn gets every
 * waiting aside folded in as ONE steer call (envelopes joined by a blank
 * line — one boundary, one batch). Otherwise, when the thread is idle and
 * unblocked, the asides degrade to a single enveloped follow-up turn, the
 * same shape the steer-queue gives queued person messages. Callers run the
 * steer drain before this one, so at a shared boundary the person's queued
 * correction lands ahead of peer context.
 */
export async function drainAsideMessages(options: AsideDrainOptions): Promise<void> {
  const { store, inject, run, isBlocked } = options;
  for (const [threadId, entry] of asides) {
    if (inFlight.has(threadId)) continue;
    const bot = store.projectBotForTask
      ? store.projectBotForTask(entry.botId, threadId)
      : store.bot(entry.botId);
    if (!bot) {
      // the bot or task was deleted while the aside waited
      cancelAsides(threadId);
      continue;
    }
    if (bot.busy) {
      // Seam attempt: one batched call for everything waiting here.
      await attemptAsideInjection(store, entry.botId, threadId, inject);
      continue;
    }
    if (isBlocked?.(entry.botId, threadId)) continue;
    // Degrade to one follow-up turn. The entry leaves the map before
    // anything runs, so a settle racing another settle can never fire the
    // same asides twice.
    const items = entry.items;
    const ids = items.map((item) => item.messageId);
    settleChatFollowups(ids, "dispatching");
    asides.delete(threadId);
    const appended = recordDegradedAsides(store, threadId, items);
    const last = appended.at(-1);
    if (!last) {
      settleChatFollowups(ids, null);
      continue;
    }
    const running = run(
      entry.botId,
      threadId,
      items.map((item) => item.prompt).join("\n\n"),
      last,
      appended.map((message) => message.id),
      { trigger: items[0]!.trigger, aside: items[0]!.aside },
    );
    void Promise.resolve(running).then(
      () => settleChatFollowups(ids, null),
      () => settleChatFollowups(ids, "interrupted"),
    ).catch((error) => console.warn("aside-queue: could not settle degraded aside", error));
  }
}

/** Append the waiting asides as transcript lines for the degraded turn.
 * Same record shape as injection — enveloped text, queueId marker, peer
 * provenance — so both deliveries read identically downstream. */
function recordDegradedAsides(store: AsideStore, threadId: string, items: AsideItem[]): Message[] {
  const appended: Message[] = [];
  for (const item of items) {
    appended.push(store.appendMessage(threadId, {
      role: "user",
      kind: "text",
      text: item.prompt,
      queueId: item.messageId,
      aside: true,
      peerAsk: {
        botId: item.aside.fromBotId,
        name: item.aside.fromBotName,
        ...(item.aside.unattended ? { unattended: true } : {}),
      },
    }));
  }
  return appended;
}

/** Whether a thread currently has an injection or drain in flight. The
 * arrival path uses this to stay honest ("queued") instead of racing a
 * boundary pass that may be folding the same lane right now. */
export function asideAttemptInFlight(threadId: string): boolean {
  return inFlight.has(threadId);
}

/** Test helper: how many asides remain queued for a thread. */
export function _asideCount(threadId: string): number {
  return asides.get(threadId)?.items.length ?? 0;
}
