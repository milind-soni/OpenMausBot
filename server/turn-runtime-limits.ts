import type { BotRuntimePolicy } from "./bot-runtime-policy.ts";

export type TurnRuntimeLimitEvent = {
  threadId: string;
  kind: "wall-clock" | "tool-steps" | "cumulative-tokens";
  limit: number;
  observed: number;
};

type ActiveTurn = {
  policy: BotRuntimePolicy;
  toolIds: Set<string>;
  tokenTotal: number;
  softWarned: boolean;
  hardStopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
  onHardStop: (event: TurnRuntimeLimitEvent) => void;
  onSoftTokenWarning: (event: TurnRuntimeLimitEvent) => void;
};

/** Runtime-owned enforcement for the limits that can be observed at the
 * harness boundary. Each entry retains the immutable admission snapshot used
 * by the turn; later bot policy edits cannot change an active turn. */
export class TurnRuntimeLimits {
  private readonly active = new Map<string, ActiveTurn>();

  /** Admit a turn with a detached policy snapshot and arm its wall-clock limit. */
  begin(
    threadId: string,
    policy: BotRuntimePolicy,
    callbacks: Pick<ActiveTurn, "onHardStop" | "onSoftTokenWarning">,
  ): boolean {
    if (this.active.has(threadId)) return false;
    const entry: ActiveTurn = {
      policy: { ...policy, cumulativeTokenPolicy: { ...policy.cumulativeTokenPolicy } },
      toolIds: new Set(),
      tokenTotal: 0,
      softWarned: false,
      hardStopped: false,
      ...callbacks,
    };
    if (entry.policy.wallClockTimeoutMinutes > 0) {
      entry.timer = setTimeout(() => {
        const current = this.active.get(threadId);
        if (!current || current.hardStopped) return;
        this.stop(current, {
          threadId,
          kind: "wall-clock",
          limit: current.policy.wallClockTimeoutMinutes * 60_000,
          observed: current.policy.wallClockTimeoutMinutes * 60_000,
        });
      }, entry.policy.wallClockTimeoutMinutes * 60_000);
      entry.timer.unref?.();
    }
    this.active.set(threadId, entry);
    return true;
  }

  /** Record a distinct tool step and stop the turn when its step cap is exceeded. */
  recordToolStarted(threadId: string, itemId: string): void {
    const entry = this.active.get(threadId);
    if (!entry || entry.hardStopped || entry.policy.maxToolAgentSteps <= 0) return;
    entry.toolIds.add(itemId);
    if (entry.toolIds.size > entry.policy.maxToolAgentSteps) {
      this.stop(entry, {
        threadId,
        kind: "tool-steps",
        limit: entry.policy.maxToolAgentSteps,
        observed: entry.toolIds.size,
      });
    }
  }

  /** Update cumulative token usage and emit the configured soft or hard limit event. */
  recordTokenSample(threadId: string, input: number, output: number): void {
    const entry = this.active.get(threadId);
    if (!entry || entry.hardStopped) return;
    const inputTokens = Number.isFinite(input) && input >= 0 ? input : 0;
    const outputTokens = Number.isFinite(output) && output >= 0 ? output : 0;
    entry.tokenTotal = Math.max(entry.tokenTotal, inputTokens + outputTokens);
    const tokenPolicy = entry.policy.cumulativeTokenPolicy;
    if (tokenPolicy.mode === "soft" && !entry.softWarned && entry.tokenTotal >= tokenPolicy.limit) {
      entry.softWarned = true;
      entry.onSoftTokenWarning({
        threadId,
        kind: "cumulative-tokens",
        limit: tokenPolicy.limit,
        observed: entry.tokenTotal,
      });
    }
    if (tokenPolicy.mode === "hard" && entry.tokenTotal >= tokenPolicy.limit) {
      this.stop(entry, { threadId, kind: "cumulative-tokens", limit: tokenPolicy.limit, observed: entry.tokenTotal });
    }
  }

  /** Settle a turn and release its active state and wall-clock timer. */
  settle(threadId: string): void {
    const entry = this.active.get(threadId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.active.delete(threadId);
  }

  /** Return a detached copy of the active turn's admitted policy, if present. */
  snapshot(threadId: string): BotRuntimePolicy | null {
    const entry = this.active.get(threadId);
    return entry ? { ...entry.policy, cumulativeTokenPolicy: { ...entry.policy.cumulativeTokenPolicy } } : null;
  }

  /** Mark an active turn stopped once and notify its hard-limit consumer. */
  private stop(entry: ActiveTurn, event: TurnRuntimeLimitEvent): void {
    if (entry.hardStopped) return;
    entry.hardStopped = true;
    entry.onHardStop(event);
  }
}
