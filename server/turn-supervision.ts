/** Owns one provider turn's process lifetime across interrupt and terminal races. */
export type TurnStopIntent = "cancel" | "timeout" | "restart" | "provider-exit";

export interface UnknownTurn {
  botId: string;
  threadId: string;
  turnId?: string;
  intent: TurnStopIntent;
  eventId: string;
  reason: string;
}

export interface TerminalObservation {
  accepted: boolean;
  intent?: TurnStopIntent;
  turnId?: string;
}

interface ActiveTurn {
  key: string;
  botId: string;
  threadId: string;
  generation: number;
  providerTurnId?: string;
  intent?: TurnStopIntent;
  graceMs: number;
  stopTimer?: ReturnType<typeof setTimeout>;
  interruptIssued: boolean;
}

interface TurnSupervisionOptions {
  graceMs: number;
  onUnknown: (turn: UnknownTurn) => void;
}

const keyFor = (botId: string, threadId: string): string => `${botId}\u0000${threadId}`;

export class TurnSupervision {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly remembered = new Map<string, Set<string>>();
  private readonly justAccepted = new Map<string, string>();
  private generation = 0;
  private readonly graceMs: number;
  private readonly onUnknown: (turn: UnknownTurn) => void;

  constructor(options: TurnSupervisionOptions) {
    this.graceMs = Math.max(1, Math.trunc(options.graceMs));
    this.onUnknown = options.onUnknown;
  }

  begin(botId: string, threadId: string, graceMs = this.graceMs): boolean {
    const key = keyFor(botId, threadId);
    if (this.active.has(key)) return false;
    this.justAccepted.delete(key);
    this.active.set(key, {
      key,
      botId,
      threadId,
      generation: ++this.generation,
      graceMs: Math.max(1, Math.trunc(graceMs)),
      interruptIssued: false,
    });
    return true;
  }

  bind(botId: string, threadId: string, turnId: string): boolean {
    const normalized = turnId.trim();
    if (!normalized) return false;
    const entry = this.active.get(keyFor(botId, threadId));
    if (!entry || this.wasRemembered(entry.key, normalized)) return false;
    if (entry.providerTurnId && entry.providerTurnId !== normalized) return false;
    entry.providerTurnId = normalized;
    return true;
  }

  isCurrent(botId: string, threadId: string, turnId?: string): boolean {
    const entry = this.active.get(keyFor(botId, threadId));
    if (!entry) return false;
    if (turnId && this.wasRemembered(entry.key, turnId)) return false;
    if (!turnId || !entry.providerTurnId) return true;
    return entry.providerTurnId === turnId;
  }

  isLate(botId: string, threadId: string, turnId?: string): boolean {
    if (!turnId) return false;
    const key = keyFor(botId, threadId);
    return !this.active.has(key) && this.wasRemembered(key, turnId);
  }

  wasJustAccepted(botId: string, threadId: string, turnId?: string): boolean {
    return Boolean(turnId && this.justAccepted.get(keyFor(botId, threadId)) === turnId);
  }

  async requestStop(
    botId: string,
    threadId: string,
    intent: Exclude<TurnStopIntent, "restart">,
    interrupt: () => Promise<void> | void,
  ): Promise<boolean> {
    const entry = this.active.get(keyFor(botId, threadId));
    if (!entry) return false;
    if (!entry.intent || intent === "cancel") entry.intent = intent;
    if (!entry.interruptIssued) {
      entry.interruptIssued = true;
      try { void Promise.resolve(interrupt()).catch(() => {}); } catch { /* grace timer remains authoritative */ }
    }
    if (!entry.stopTimer && this.active.get(entry.key) === entry) {
      entry.stopTimer = setTimeout(() => {
        this.expire(entry, entry.intent ?? intent, this.defaultUnknownReason(entry.intent ?? intent));
      }, entry.graceMs);
      entry.stopTimer.unref?.();
    }
    return true;
  }

  observeTerminal(botId: string, threadId: string, turnId?: string): TerminalObservation {
    const entry = this.active.get(keyFor(botId, threadId));
    if (!entry || !this.matches(entry, turnId)) return { accepted: false, turnId };
    const settledTurnId = turnId ?? entry.providerTurnId;
    this.remove(entry, settledTurnId);
    if (settledTurnId) {
      const key = entry.key;
      this.justAccepted.set(key, settledTurnId);
      queueMicrotask(() => {
        if (this.justAccepted.get(key) === settledTurnId) this.justAccepted.delete(key);
      });
    }
    return { accepted: true, intent: entry.intent, turnId: settledTurnId };
  }

  finishWithoutProvider(botId: string, threadId: string): boolean {
    const entry = this.active.get(keyFor(botId, threadId));
    if (!entry) return false;
    this.remove(entry, entry.providerTurnId);
    return true;
  }

  forceUnknown(botId: string, threadId: string, reason: string, intent: TurnStopIntent = "restart"): boolean {
    const entry = this.active.get(keyFor(botId, threadId));
    if (!entry) return false;
    this.expire(entry, intent, reason);
    return true;
  }

  resetProviderLifecycle(): void {
    this.remembered.clear();
    this.justAccepted.clear();
  }

  has(botId: string, threadId: string): boolean { return this.active.has(keyFor(botId, threadId)); }

  private matches(entry: ActiveTurn, turnId?: string): boolean {
    if (!turnId) return true;
    if (this.wasRemembered(entry.key, turnId)) return false;
    return !entry.providerTurnId || entry.providerTurnId === turnId;
  }

  private expire(entry: ActiveTurn, intent: TurnStopIntent, reason: string): void {
    if (this.active.get(entry.key) !== entry) return;
    const turnId = entry.providerTurnId;
    this.remove(entry, turnId);
    this.onUnknown({ botId: entry.botId, threadId: entry.threadId, ...(turnId ? { turnId } : {}), intent, eventId: `supervision:${entry.generation}:${intent}`, reason });
  }

  private remove(entry: ActiveTurn, turnId?: string): void {
    if (entry.stopTimer) clearTimeout(entry.stopTimer);
    entry.stopTimer = undefined;
    this.active.delete(entry.key);
    if (turnId) {
      const ids = this.remembered.get(entry.key) ?? new Set<string>();
      ids.add(turnId);
      this.remembered.set(entry.key, ids);
    }
  }

  private wasRemembered(key: string, turnId: string): boolean { return this.remembered.get(key)?.has(turnId) ?? false; }

  private defaultUnknownReason(intent: TurnStopIntent): string {
    if (intent === "timeout") return "provider did not confirm timeout cancellation before supervision grace expired";
    if (intent === "cancel") return "provider did not confirm explicit cancellation before supervision grace expired";
    if (intent === "provider-exit") return "provider process exited before a terminal completion was observed";
    return "provider supervision ended during server restart before a terminal event was observed";
  }
}
