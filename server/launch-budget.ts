// Global launch budget — one fuse across every bot for the turns the harness
// starts (docs/plans/2026-09-14-phase-0-foundation.md, item 0.4).
//
// The harness runs many engine processes on one person's account. A bug in
// a wake, a routine or a delegation loop can fan out into thousands of
// launches before anyone notices; other harnesses have burned a machine
// that way. This budget sits at turn admission (before any driver, so it is
// the same for every engine) and answers one question: may another launch
// start now? Three caps and a pause:
//
//   maxConcurrent — launches in flight, across all bots
//   maxPerHour / maxPerDay — unattended launches (routines, wakes, peers)
//   pause — after a provider quota error, unattended launches hold
//
// A person's own turn is never held by this budget at all: the caps exist
// to stop autonomous fan-out (routines, wakes, peers, benches), not to get
// in the way of someone typing, and a person can legitimately have many
// turns parked on approval cards at once. The process fuse in procs.ts is
// the hard stop that still applies to everyone.
//
// State is tiny and durable (DATA_DIR/launch-budget.json): the launch
// timestamps of the last day and the pause. The active count is in memory,
// because a restart ends every in-flight turn.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import { writeFileAtomic } from "./atomic.ts";

export type LaunchKind = "turn" | "routine" | "wake" | "peer" | "bench" | "helper";

export interface LaunchRequest {
  kind: LaunchKind;
  /** True when a person at the keyboard asked for this launch. */
  attended?: boolean;
  botId?: string;
  /** The thread the launch runs on, so a terminal event can release it. */
  threadId?: string;
}

export interface LaunchLimits {
  maxConcurrent: number;
  maxPerHour: number;
  maxPerDay: number;
  /** How long unattended launches hold after a quota error. */
  pauseMs: number;
  /** A ticket nobody released stops counting after this long: no turn runs
   * that long (the stall watchdog stops it at 20 minutes), so a leaked
   * ticket from a dispatch that died mid-setup cannot starve the cap. */
  ticketTtlMs: number;
}

export const DEFAULT_LAUNCH_LIMITS: LaunchLimits = { maxConcurrent: 12, maxPerHour: 120, maxPerDay: 800, pauseMs: 15 * 60_000, ticketTtlMs: 30 * 60_000 };

export interface LaunchState {
  active: number;
  /** Launch timestamps (ms), oldest first, within the last day. */
  launches: number[];
  pausedUntil: number;
}

export type LaunchDecision =
  | { ok: true }
  | { ok: false; reason: "concurrent" | "hourly" | "daily" | "paused"; retryAfterMs: number };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const CONCURRENT_RETRY_MS = 5_000;

/** Pure: may this launch start now? */
export function decideLaunch(state: LaunchState, limits: LaunchLimits, request: LaunchRequest, now: number): LaunchDecision {
  const attended = request.kind === "turn" && request.attended === true;
  if (attended) return { ok: true };
  // `active` counts unattended launches only: callers never acquire for a
  // person's own turn, so a chat full of parked approvals costs nothing here
  if (state.active >= limits.maxConcurrent) return { ok: false, reason: "concurrent", retryAfterMs: CONCURRENT_RETRY_MS };
  if (state.pausedUntil > now) return { ok: false, reason: "paused", retryAfterMs: state.pausedUntil - now };
  const lastHour = state.launches.filter((at) => at > now - HOUR_MS);
  if (lastHour.length >= limits.maxPerHour) {
    return { ok: false, reason: "hourly", retryAfterMs: Math.max(1, lastHour[0]! + HOUR_MS - now) };
  }
  const lastDay = state.launches.filter((at) => at > now - DAY_MS);
  if (lastDay.length >= limits.maxPerDay) {
    return { ok: false, reason: "daily", retryAfterMs: Math.max(1, lastDay[0]! + DAY_MS - now) };
  }
  return { ok: true };
}

export interface LaunchTicket {
  id: string;
  kind: LaunchKind;
  botId?: string;
  threadId?: string;
  at: number;
}

export interface LaunchSnapshot {
  active: number;
  lastHour: number;
  lastDay: number;
  limits: LaunchLimits;
  pausedUntil: number;
}

export class LaunchBudget {
  private launches: number[] = [];
  private pausedUntil = 0;
  private readonly tickets = new Map<string, LaunchTicket>();
  private seq = 0;
  private readonly file: string;
  private limits: LaunchLimits;
  private readonly now: () => number;

  // No TypeScript parameter properties: the server runs under Node's
  // strip-only type stripping, which rejects them at load time.
  constructor(file: string, limits: LaunchLimits = DEFAULT_LAUNCH_LIMITS, now: () => number = Date.now) {
    this.file = file;
    this.limits = limits;
    this.now = now;
    this.load();
  }

  setLimits(limits: LaunchLimits): void {
    this.limits = limits;
  }

  /** The decision without taking a slot — for admission checks that will
   * acquire a moment later, or for a UI that wants to explain a refusal. */
  peek(request: LaunchRequest): LaunchDecision {
    this.prune();
    return decideLaunch(this.state(), this.limits, request, this.now());
  }

  acquire(request: LaunchRequest): { ok: true; ticket: LaunchTicket } | Exclude<LaunchDecision, { ok: true }> {
    const decision = this.peek(request);
    if (!decision.ok) return decision;
    const at = this.now();
    const ticket: LaunchTicket = {
      id: `${at}-${++this.seq}`,
      kind: request.kind,
      ...(request.botId ? { botId: request.botId } : {}),
      ...(request.threadId ? { threadId: request.threadId } : {}),
      at,
    };
    this.tickets.set(ticket.id, ticket);
    this.launches.push(at);
    this.save();
    return { ok: true, ticket };
  }

  release(ticket: LaunchTicket): void {
    this.tickets.delete(ticket.id);
  }

  /** A thread reached a terminal event (settled, exited, errored): whatever
   * launch it held is over, whichever generation acquired it. */
  releaseThread(threadId: string): void {
    for (const [id, ticket] of this.tickets) if (ticket.threadId === threadId) this.tickets.delete(id);
  }

  /** A provider said the account is out of quota: hold unattended launches. */
  noteQuotaError(): void {
    this.pausedUntil = this.now() + this.limits.pauseMs;
    this.save();
  }

  snapshot(): LaunchSnapshot {
    this.prune();
    const now = this.now();
    return {
      active: this.tickets.size,
      lastHour: this.launches.filter((at) => at > now - HOUR_MS).length,
      lastDay: this.launches.length,
      limits: this.limits,
      pausedUntil: this.pausedUntil,
    };
  }

  private state(): LaunchState {
    return { active: this.tickets.size, launches: this.launches, pausedUntil: this.pausedUntil };
  }

  private prune(): void {
    const now = this.now();
    const cutoff = now - DAY_MS;
    if (this.launches.length && this.launches[0]! <= cutoff) this.launches = this.launches.filter((at) => at > cutoff);
    for (const [id, ticket] of this.tickets) if (ticket.at <= now - this.limits.ticketTtlMs) this.tickets.delete(id);
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { launches?: unknown; pausedUntil?: unknown };
      const launches = Array.isArray(parsed.launches) ? parsed.launches.filter((v): v is number => typeof v === "number" && Number.isFinite(v)) : [];
      this.launches = launches.sort((a, b) => a - b);
      this.pausedUntil = typeof parsed.pausedUntil === "number" ? parsed.pausedUntil : 0;
      this.prune();
    } catch {
      this.launches = [];
      this.pausedUntil = 0;
    }
  }

  private save(): void {
    this.prune();
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.file, JSON.stringify({ launches: this.launches, pausedUntil: this.pausedUntil }), { mode: 0o600 });
    } catch (error) {
      console.error("launch-budget: could not save:", error instanceof Error ? error.message : error);
    }
  }
}
