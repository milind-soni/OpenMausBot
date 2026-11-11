import type { ModelCatalog } from "./contracts.ts";
import { contextWindowFor } from "./context-budget.ts";
import { sessionIdlePolicy } from "./drivers/session-idle.ts";
import { serverLine } from "./server-lines.ts";

export const DEFAULT_ROOM_COMPACT_AT = 0.9;

export type RoomMemberContext = { tokens: number; window: number; compactRequested?: true };

export function roomCompactTokens(window: number, settings: { autoCompact?: boolean; roomCompactAt?: number } | undefined): number | null {
  if (settings?.autoCompact === false) return null;
  const at = settings?.roomCompactAt;
  const value = typeof at === "number" && Number.isFinite(at) && at > 0 ? at : DEFAULT_ROOM_COMPACT_AT;
  return value < 1 ? Math.floor(window * value) : Math.floor(value);
}

type Measured = RoomMemberContext & { instanceId?: string; at: number };

export type RoomContextClock = {
  idleMs?: number;
  heldUntil?: (threadId: string) => number | undefined;
  now?: () => number;
  expired?: (threadId: string) => void;
};

type RoomReset = { reason: "requested" | "threshold"; percent: number };

export function roomResetNote(name: string, reset: RoomReset, language?: string): string {
  return serverLine(language, reset.reason === "requested" ? "server.rooms.compactedRequested" : "server.rooms.compactedThreshold", { bot: name, percent: reset.percent });
}

export class RoomContextTracker {
  private threads = new Map<string, Map<string, Measured>>();
  private dispatchedOn = new Map<string, Map<string, string>>();
  private readonly clock: RoomContextClock;
  private readonly idleMs: number;

  constructor(clock: RoomContextClock = {}) {
    this.clock = clock;
    this.idleMs = clock.idleMs ?? Math.max(sessionIdlePolicy("CLAUDE").idleMs, sessionIdlePolicy("ACP").idleMs);
  }

  record(threadId: string, botId: string, reading: { tokens?: number; window?: number } | undefined, model: string | undefined, catalog?: ModelCatalog): void {
    const tokens = reading?.tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return;
    const members = this.threads.get(threadId) ?? new Map<string, Measured>();
    const previous = this.live(threadId, botId);
    const instanceId = this.dispatchedOn.get(threadId)?.get(botId);
    const measured: Measured = {
      tokens: Math.trunc(tokens),
      window: contextWindowFor(model, catalog, reading?.window),
      ...(previous?.compactRequested ? { compactRequested: true as const } : {}),
      ...(instanceId ? { instanceId } : {}),
      at: this.now(),
    };
    members.set(botId, measured);
    this.threads.set(threadId, members);
    this.watch(threadId, botId, measured);
  }

  request(threadId: string, botId: string): boolean {
    const current = this.live(threadId, botId);
    if (!current) return false;
    current.compactRequested = true;
    return true;
  }

  forThread(threadId: string): Record<string, RoomMemberContext> | undefined {
    const members = this.threads.get(threadId);
    if (!members) return undefined;
    for (const botId of members.keys()) this.live(threadId, botId);
    if (!members.size) return undefined;
    return Object.fromEntries([...members].map(([botId, { tokens, window, compactRequested }]) =>
      [botId, { tokens, window, ...(compactRequested ? { compactRequested } : {}) }]));
  }

  dispatch(threadId: string, botId: string, instanceId: string, settings: { autoCompact?: boolean; roomCompactAt?: number } | undefined):
    { reset: RoomReset | null; displaced: boolean } {
    const reset = this.takeReset(threadId, botId, settings);
    return { reset, displaced: this.dispatched(threadId, botId, instanceId) };
  }

  /** Each engine keeps one warm process per thread, so this turn closes the other members' processes on its engine. */
  dispatched(threadId: string, botId: string, instanceId: string): boolean {
    const engines = this.dispatchedOn.get(threadId) ?? new Map<string, string>();
    engines.set(botId, instanceId);
    this.dispatchedOn.set(threadId, engines);
    const members = this.threads.get(threadId);
    if (!members) return false;
    let dropped = false;
    for (const [other, reading] of members) {
      // A reading from before its engine was known is assumed to share it.
      if (other === botId || (reading.instanceId && reading.instanceId !== instanceId)) continue;
      members.delete(other);
      dropped = true;
    }
    if (!members.size) this.threads.delete(threadId);
    return dropped;
  }

  takeReset(threadId: string, botId: string, settings: { autoCompact?: boolean; roomCompactAt?: number } | undefined): RoomReset | null {
    const current = this.live(threadId, botId);
    const members = this.threads.get(threadId);
    if (!members || !current) return null;
    const percent = Math.round((current.tokens / current.window) * 100);
    const limit = roomCompactTokens(current.window, settings);
    const reason = current.compactRequested ? "requested" : limit !== null && current.tokens >= limit ? "threshold" : null;
    if (!reason) return null;
    members.delete(botId);
    if (!members.size) this.threads.delete(threadId);
    return { reason, percent };
  }

  forget(threadId: string): void {
    this.threads.delete(threadId);
    this.dispatchedOn.delete(threadId);
  }

  private now(): number {
    return this.clock.now?.() ?? Date.now();
  }

  private warmUntil(threadId: string, reading: Measured): number {
    return Math.max(reading.at + this.idleMs, this.clock.heldUntil?.(threadId) ?? 0);
  }

  private watch(threadId: string, botId: string, reading: Measured): void {
    const expired = this.clock.expired;
    if (!expired) return;
    const check = () => {
      if (this.threads.get(threadId)?.get(botId) !== reading) return;
      if (this.live(threadId, botId)) return arm(this.warmUntil(threadId, reading) - this.now());
      expired(threadId);
    };
    const arm = (ms: number) => {
      const timer = setTimeout(check, Math.min(2_147_483_647, Math.max(0, ms)));
      timer.unref?.();
    };
    arm(this.warmUntil(threadId, reading) - this.now());
  }

  private live(threadId: string, botId: string): Measured | undefined {
    const members = this.threads.get(threadId);
    const current = members?.get(botId);
    if (!members || !current) return undefined;
    if (this.now() < this.warmUntil(threadId, current)) return current;
    members.delete(botId);
    if (!members.size) this.threads.delete(threadId);
    return undefined;
  }
}
