import { newId } from "./contracts.ts";

/** Admission lanes shared by human messages and unattended work. */
export type TurnLane = "user" | "urgent-peer" | "peer" | "background";

const LANE_PRIORITY: readonly TurnLane[] = ["user", "urgent-peer", "peer", "background"];

export type SchedulerRejection = "capacity" | "duplicate" | "cancelled";

export interface TurnAdmission {
  id: string;
  botId: string;
  lane: TurnLane;
  /** Number of queued entries ahead of this entry. Active work is not counted. */
  position: number;
  queued: boolean;
}

export interface TurnSchedulerOptions {
  /** Maximum active + pending work admitted for one bot. */
  maxPendingPerBot?: number;
  /** Slots kept free for human work when the queue is under pressure. */
  reservedUserSlots?: number;
  onChange?: (botId: string) => void;
}

interface Entry {
  id: string;
  botId: string;
  lane: TurnLane;
  dedupeKey?: string;
  run: () => void | Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  promise: Promise<void>;
  cancelled: boolean;
}

interface Active {
  id: string;
  generation: number;
  lane: TurnLane;
}

export interface TurnQueueDiagnostics {
  botId: string;
  active: Active | null;
  pending: number;
  byLane: Record<TurnLane, number>;
  capacity: number;
}

/**
 * Per-bot, priority/FIFO admission for provider turns.
 *
 * The scheduler deliberately owns no provider state. A run is considered
 * active until its callback's promise settles, which makes late callbacks
 * harmless: only the matching id/generation may release the lane. Different
 * bots have independent queues and therefore run concurrently.
 */
export class TurnScheduler {
  private readonly maxPendingPerBot: number;
  private readonly reservedUserSlots: number;
  private readonly onChange?: (botId: string) => void;
  private readonly queues = new Map<string, Map<TurnLane, Entry[]>>();
  private readonly active = new Map<string, Active>();
  private readonly generations = new Map<string, number>();

  constructor(options: TurnSchedulerOptions = {}) {
    this.maxPendingPerBot = Math.max(1, Math.trunc(options.maxPendingPerBot ?? 32));
    this.reservedUserSlots = Math.max(0, Math.min(this.maxPendingPerBot - 1, Math.trunc(options.reservedUserSlots ?? 4)));
    this.onChange = options.onChange;
  }

  admit(input: {
    botId: string;
    lane: TurnLane;
    dedupeKey?: string;
    run: () => void | Promise<void>;
  }): { accepted: true; admission: TurnAdmission; completion: Promise<void> } | { accepted: false; reason: SchedulerRejection } {
    const queue = this.queueFor(input.botId);
    const existing = this.findEntry(input.botId, input.dedupeKey);
    if (existing) return { accepted: false, reason: "duplicate" };

    const pending = this.pendingCount(input.botId);
    if (pending >= this.maxPendingPerBot || (input.lane !== "user" && pending >= this.maxPendingPerBot - this.reservedUserSlots)) {
      return { accepted: false, reason: "capacity" };
    }

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: Entry = {
      id: newId(),
      botId: input.botId,
      lane: input.lane,
      dedupeKey: input.dedupeKey,
      run: input.run,
      resolve,
      reject,
      promise: completion,
      cancelled: false,
    };

    const current = this.active.get(input.botId);
    if (!current) {
      this.start(entry);
      return { accepted: true, admission: { id: entry.id, botId: entry.botId, lane: entry.lane, position: 0, queued: false }, completion };
    }

    queue.get(input.lane)!.push(entry);
    const position = this.positionOf(input.botId, entry.id);
    this.changed(input.botId);
    return { accepted: true, admission: { id: entry.id, botId: entry.botId, lane: entry.lane, position, queued: true }, completion };
  }

  /** Cancel a pending entry. Active provider turns are never preempted. */
  cancel(botId: string, id: string): boolean {
    const lanes = this.queues.get(botId);
    if (!lanes) return false;
    for (const lane of LANE_PRIORITY) {
      const items = lanes.get(lane)!;
      const index = items.findIndex((entry) => entry.id === id);
      if (index < 0) continue;
      const [entry] = items.splice(index, 1);
      entry.cancelled = true;
      entry.reject(Object.assign(new Error("queued turn cancelled"), { code: "TURN_CANCELLED" }));
      this.changed(botId);
      return true;
    }
    return false;
  }

  /** Current state used by bounded queue diagnostics and tests. */
  diagnostics(botId: string): TurnQueueDiagnostics {
    const byLane = Object.fromEntries(LANE_PRIORITY.map((lane) => [lane, this.queues.get(botId)?.get(lane)?.length ?? 0])) as Record<TurnLane, number>;
    return {
      botId,
      active: this.active.get(botId) ?? null,
      pending: Object.values(byLane).reduce((sum, count) => sum + count, 0),
      byLane,
      capacity: this.maxPendingPerBot,
    };
  }

  /** Used when a legacy path owns a turn that was not admitted here. */
  occupy(botId: string, id = newId(), lane: TurnLane = "user"): string | null {
    if (this.active.has(botId)) return null;
    const generation = (this.generations.get(botId) ?? 0) + 1;
    this.generations.set(botId, generation);
    this.active.set(botId, { id, generation, lane });
    this.changed(botId);
    return id;
  }

  /** Release only the current generation; a late settlement cannot free a newer run. */
  release(botId: string, id?: string): boolean {
    const current = this.active.get(botId);
    if (!current || (id && current.id !== id)) return false;
    this.active.delete(botId);
    this.pump(botId);
    return true;
  }

  hasActive(botId: string): boolean {
    return this.active.has(botId);
  }

  private queueFor(botId: string): Map<TurnLane, Entry[]> {
    let queue = this.queues.get(botId);
    if (queue) return queue;
    queue = new Map(LANE_PRIORITY.map((lane) => [lane, []] as const));
    this.queues.set(botId, queue);
    return queue;
  }

  private pendingCount(botId: string): number {
    return LANE_PRIORITY.reduce((sum, lane) => sum + (this.queues.get(botId)?.get(lane)?.length ?? 0), 0);
  }

  private findEntry(botId: string, dedupeKey?: string): Entry | null {
    if (!dedupeKey) return null;
    const current = this.active.get(botId);
    // Active deduplication prevents a webhook/continuation from creating a
    // second copy while the first one is already inside the provider.
    if (current) {
      const activeEntry = this.findActiveEntry(botId, current.id);
      if (activeEntry?.dedupeKey === dedupeKey) return activeEntry;
    }
    for (const lane of LANE_PRIORITY) {
      const found = this.queues.get(botId)?.get(lane)?.find((entry) => entry.dedupeKey === dedupeKey);
      if (found) return found;
    }
    return null;
  }

  // Active entries are only needed for dedupe while their promise is running.
  // Keeping this tiny map avoids exposing mutable internals in diagnostics.
  private readonly activeEntries = new Map<string, Entry>();

  private findActiveEntry(botId: string, id: string): Entry | null {
    const entry = this.activeEntries.get(botId);
    return entry?.id === id ? entry : null;
  }

  private start(entry: Entry): void {
    const generation = (this.generations.get(entry.botId) ?? 0) + 1;
    this.generations.set(entry.botId, generation);
    this.active.set(entry.botId, { id: entry.id, generation, lane: entry.lane });
    this.activeEntries.set(entry.botId, entry);
    this.changed(entry.botId);
    Promise.resolve()
      .then(() => entry.run())
      .then(() => entry.resolve(), (error) => entry.reject(error))
      .finally(() => {
        if (this.active.get(entry.botId)?.id !== entry.id) return;
        this.activeEntries.delete(entry.botId);
        this.active.delete(entry.botId);
        this.pump(entry.botId);
      });
  }

  private pump(botId: string): void {
    if (this.active.has(botId)) return;
    const queue = this.queues.get(botId);
    if (!queue) {
      this.changed(botId);
      return;
    }
    let next: Entry | undefined;
    for (const lane of LANE_PRIORITY) {
      const items = queue.get(lane)!;
      while (items.length && items[0]!.cancelled) items.shift();
      next = items.shift();
      if (next) break;
    }
    if (next) this.start(next);
    else {
      this.queues.delete(botId);
      this.changed(botId);
    }
  }

  private positionOf(botId: string, id: string): number {
    let position = 0;
    for (const lane of LANE_PRIORITY) {
      for (const entry of this.queues.get(botId)?.get(lane) ?? []) {
        if (entry.id === id) return position;
        position += 1;
      }
    }
    return position;
  }

  private changed(botId: string): void {
    this.onChange?.(botId);
  }
}

export { LANE_PRIORITY };
