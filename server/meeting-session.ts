import { meetingBudgetSnapshot, meetingBudgetText, usageTokens, type MeetingLimits, type MeetingBudgetState, type MeetingUsage } from "../shared/meeting-limits.ts";
import { meetingUsageCost, type MeetingPrice } from "./meeting-pricing.ts";

/** One allowance since the latest human message. Provider usage is cumulative
 * within a turn; private controller turns consume tokens/cost, not replies. */
export class MeetingSession {
  readonly state: MeetingBudgetState;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private closed = false;
  private turns = new Map<string, { tokens: number; cost: number; startedAt: number; hasUsage: boolean }>();

  readonly limits: MeetingLimits;
  private hooks: {
    replies: () => number;
    persist: (state: MeetingBudgetState) => void;
    notice: (text: string, stopped: boolean, count: number) => void;
    stop: (text: string) => void;
    now?: () => number;
  };
  constructor(limits: MeetingLimits, hooks: MeetingSession["hooks"], state?: MeetingBudgetState) {
    this.limits = limits;
    this.hooks = hooks;
    this.state = { ...state, startedAt: state?.startedAt ?? this.now(), tokens: state?.tokens ?? 0, costUsd: state?.costUsd ?? 0 };
  }

  private now() { return this.hooks.now?.() ?? Date.now(); }
  snapshot() { return meetingBudgetSnapshot(this.limits, { ...this.state, replies: this.hooks.replies(), now: this.now() }); }
  start() {
    if (this.closed || this.timer) return;
    this.check();
    if (this.limits.time && !this.stopped) this.timer = setInterval(() => this.check(), 200);
  }
  check(): boolean {
    if (this.closed) return false;
    const budget = this.snapshot();
    this.state.replies = this.hooks.replies();
    if (budget.wrapUp || budget.exhausted) this.hooks.notice(meetingBudgetText(budget), budget.exhausted, this.state.replies);
    if (budget.exhausted && !this.stopped) {
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      this.hooks.persist({ ...this.state });
      this.hooks.stop(meetingBudgetText(budget));
    }
    return !this.stopped;
  }
  beginTurn(id: string) { this.turns.set(id, { tokens: 0, cost: 0, startedAt: this.now(), hasUsage: false }); }
  usage(id: string, usage: MeetingUsage, price?: MeetingPrice) {
    const turn = this.turns.get(id);
    if (!turn || this.closed) return;
    if (this.limits.cost && !price) throw new Error("Missing meeting pricing snapshot");
    turn.hasUsage ||= Number.isFinite(usage.input) && Number.isFinite(usage.output);
    const tokens = Math.max(turn.tokens, usageTokens(usage));
    const cost = Math.max(turn.cost, price ? meetingUsageCost(usage, price) : 0);
    this.state.tokens = (this.state.tokens ?? 0) + tokens - turn.tokens;
    this.state.costUsd = (this.state.costUsd ?? 0) + cost - turn.cost;
    turn.tokens = tokens; turn.cost = cost;
    this.hooks.persist({ ...this.state });
    this.check();
  }
  endTurn(id: string, completed = true) {
    const turn = this.turns.get(id);
    if (!turn) return;
    this.state.turnTokens = Math.max(this.state.turnTokens ?? 0, turn.tokens);
    this.state.turnCostUsd = Math.max(this.state.turnCostUsd ?? 0, turn.cost);
    this.state.turnMilliseconds = Math.max(this.state.turnMilliseconds ?? 0, this.now() - turn.startedAt);
    this.turns.delete(id);
    if (completed && !turn.hasUsage && (this.limits.tokens || this.limits.cost) && !this.stopped && !this.closed) {
      this.stopped = true;
      if (this.timer) clearInterval(this.timer);
      const text = "Meeting stopped: the provider did not report complete token usage, so its remaining allowance cannot be verified.";
      this.hooks.notice(text, true, this.hooks.replies());
      this.hooks.stop(text);
    }
    this.hooks.persist({ ...this.state });
    this.check();
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.closed = true;
    this.hooks.persist({ ...this.state });
  }
}
