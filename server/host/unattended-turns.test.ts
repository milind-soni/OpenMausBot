import { describe, expect, it } from "vitest";

import { failedTurnCause } from "../../shared/failed-turn.ts";
import { parseConfigPatch } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { loopGuardSettings } from "./loop-guard.ts";
import { createUnattendedTurns, personDriven, unattendedLimits, UNATTENDED_DEFAULTS, type UnattendedLimits } from "./unattended-turns.ts";

const T = "thread-1";
const SAME = "fatal: not a git repository";

function rig(options: { unattended?: boolean; limits?: Partial<UnattendedLimits>; env?: NodeJS.ProcessEnv } = {}) {
  const rows: Array<{ name: string; nameCode?: string; nameParams?: unknown }> = [];
  const interrupts: string[] = [];
  const state = { unattended: options.unattended ?? true, live: true, waiting: false, now: 1_000_000 };
  let seq = 0;
  const base = () => ({ eventId: `e${++seq}`, provider: "fake", threadId: T, createdAt: "2026-11-16T00:00:00.000Z", turnId: "turn-1" });
  const turns = createUnattendedTurns({
    settings: (unattended) => loopGuardSettings({}, options.env ?? {}, unattended),
    unattended: () => state.unattended,
    limits: () => ({ ...UNATTENDED_DEFAULTS, ...options.limits }),
    now: () => state.now,
    timer: false,
    append: (_threadId, tool) => { rows.push(tool); },
    live: () => state.live,
    waiting: () => state.waiting,
    canSteer: () => false,
    steer: () => Promise.resolve("refused"),
    interrupt: (_threadId, cause) => { interrupts.push(cause); state.live = false; return Promise.resolve(); },
    log: () => {},
  });
  const emit = (event: RuntimeEvent) => turns.onEvent(event);
  /** One request to the AI that runs one shell command; how many of them the turn got to make is what the tests count. */
  let requests = 0;
  const request = (command: string, ok: boolean) => {
    if (!state.live) return false;
    requests += 1;
    const itemId = `item-${requests}`;
    emit({ ...base(), type: "thread.token-usage.updated", itemId: `msg-${requests}`, input: 10, output: 5 });
    emit({ ...base(), type: "item.started", itemType: "tool", itemId, title: "Bash", summary: command, input: JSON.stringify({ command }) });
    emit({ ...base(), type: "item.completed", itemType: "tool", itemId, ok, output: ok ? "ok" : SAME });
    return true;
  };
  emit({ ...base(), type: "turn.started" });
  return {
    turns, state, rows, interrupts, emit, base, request,
    requests: () => requests,
    /** Plays requests until the turn is stopped or `most` were made. */
    loop(most: number, command: (index: number) => string, ok = false) { for (let i = 0; i < most && request(command(i), ok); i++); },
    advance(ms: number) { state.now += ms; turns.sweep(); },
    stops: () => rows.flatMap((row) => failedTurnCause(row.name) ?? []),
  };
}

describe("a turn nobody is watching", () => {
  it("that repeats one failing command is stopped at the twentieth in a row, with the loop guard off in config: 20 requests, not 500", () => {
    const attended = rig({ unattended: false });
    attended.loop(500, () => "git status");
    expect(attended.requests()).toBe(500);
    expect(attended.interrupts).toEqual([]);

    const r = rig();
    r.loop(500, () => "git status");
    expect(r.requests()).toBe(20);
    expect(r.interrupts).toEqual(["the same call failed the same way 20 times in a row: “Bash: git status” — the turn was stopped"]);
    expect(r.stops()).toEqual(r.interrupts);
  });

  it("that keeps going with calls that differ is stopped at its request limit, once", () => {
    const attended = rig({ unattended: false });
    attended.loop(1_000, (index) => `ls ${index}`, true);
    expect(attended.requests()).toBe(1_000);
    expect(attended.rows).toEqual([]);

    const r = rig();
    r.loop(1_000, (index) => `ls ${index}`, true);
    expect(r.requests()).toBe(400);
    expect(r.stops()).toEqual(["this turn had nobody waiting on it and made 400 requests to its AI, its limit — the turn was stopped"]);
    expect(r.rows[0]).toMatchObject({ nameCode: "chat.notice.unattendedRequests", nameParams: { count: 400 } });
    expect(r.interrupts).toHaveLength(1);
  });

  it("counts a model call once however many usage frames it sends, and tool calls for an engine that reports no usage", () => {
    const r = rig({ limits: { maxRequests: 3 } });
    for (let i = 0; i < 10; i++) r.emit({ ...r.base(), type: "thread.token-usage.updated", itemId: "msg-1", input: 10, output: i });
    expect(r.interrupts).toEqual([]);
    r.emit({ ...r.base(), type: "thread.token-usage.updated", itemId: "msg-2", input: 10, output: 1 });
    r.emit({ ...r.base(), type: "thread.token-usage.updated", itemId: "msg-3", input: 10, output: 1 });
    expect(r.interrupts).toHaveLength(1);

    const tools = rig({ limits: { maxRequests: 3 } });
    for (let i = 0; i < 3; i++) tools.emit({ ...tools.base(), type: "item.started", itemType: "tool", itemId: `t${i}`, title: `read file ${i}` });
    expect(tools.interrupts).toHaveLength(1);
  });

  it("counts usage reports without an id as one call per step between tool calls, as Codex, ACP and the chat-completions drivers send several per call", () => {
    const r = rig({ limits: { maxRequests: 3 } });
    const call = (step: number) => {
      for (let i = 0; i < 10; i++) r.emit({ ...r.base(), type: "thread.token-usage.updated", input: 10, output: i });
      r.emit({ ...r.base(), type: "item.started", itemType: "tool", itemId: `t${step}`, title: `step ${step}` });
    };
    call(0);
    call(1);
    expect(r.interrupts).toEqual([]);
    call(2);
    expect(r.interrupts).toHaveLength(1);
  });

  it("is stopped after working for its time limit; time spent waiting is not work", () => {
    const r = rig({ limits: { maxMs: 60 * 60_000 } });
    r.request("ls", true);
    r.advance(50 * 60_000);
    r.state.waiting = true;
    r.advance(5 * 60 * 60_000);
    expect(r.interrupts).toEqual([]);
    r.state.waiting = false;
    r.advance(9 * 60_000);
    expect(r.interrupts).toEqual([]);
    r.advance(60_000);
    expect(r.stops()).toEqual(["this turn had nobody waiting on it and worked for 60 minutes, its limit — the turn was stopped"]);
    r.advance(60 * 60_000);
    expect(r.interrupts).toHaveLength(1);
  });

  it("is stopped at the fifth permission request denied or left unanswered, not those a person answered or the turn's end closed", () => {
    const r = rig();
    const resolve = (source: "timeout" | "auto" | "user" | "system", behavior: "deny" | "allow" = "deny") =>
      r.emit({ ...r.base(), type: "request.resolved", requestId: "r", behavior, source });
    resolve("user"); resolve("system"); resolve("timeout", "allow");
    for (let i = 0; i < 4; i++) resolve("timeout");
    expect(r.interrupts).toEqual([]);
    resolve("auto");
    expect(r.stops()).toEqual(["this turn had nobody waiting on it and 5 of its permission requests were denied or went unanswered — the turn was stopped"]);
  });

  it("starts each turn's counts afresh, and never counts a turn a person is waiting on", () => {
    const r = rig({ limits: { maxRequests: 5 } });
    r.loop(4, (index) => `ls ${index}`, true);
    r.emit({ ...r.base(), type: "turn.completed", ok: true });
    r.emit({ ...r.base(), type: "turn.started" });
    r.loop(4, (index) => `ls ${index}`, true);
    expect(r.interrupts).toEqual([]);

    const attended = rig({ unattended: false, limits: { maxRequests: 5, maxMs: 60_000, maxDenials: 1 } });
    attended.loop(50, (index) => `ls ${index}`, true);
    attended.emit({ ...attended.base(), type: "request.resolved", requestId: "r", behavior: "deny", source: "timeout" });
    attended.advance(24 * 60 * 60_000);
    expect(attended.interrupts).toEqual([]);
  });
});

describe("the limits' settings", () => {
  it("default to 4 hours, 400 requests and 5 denials; take whole numbers or off; leave the default for anything else", () => {
    expect(unattendedLimits({})).toEqual({ maxMs: 4 * 60 * 60_000, maxRequests: 400, maxDenials: 5 });
    expect(unattendedLimits({ OMB_UNATTENDED_TURN_MAX_MS: "600000", OMB_UNATTENDED_TURN_MAX_REQUESTS: "50", OMB_UNATTENDED_TURN_MAX_DENIALS: "2" }))
      .toEqual({ maxMs: 600_000, maxRequests: 50, maxDenials: 2 });
    expect(unattendedLimits({ OMB_UNATTENDED_TURN_MAX_MS: "off", OMB_UNATTENDED_TURN_MAX_REQUESTS: "OFF", OMB_UNATTENDED_TURN_MAX_DENIALS: " off " }))
      .toEqual({ maxMs: Infinity, maxRequests: Infinity, maxDenials: Infinity });
    expect(unattendedLimits({ OMB_UNATTENDED_TURN_MAX_MS: "59999", OMB_UNATTENDED_TURN_MAX_REQUESTS: "0", OMB_UNATTENDED_TURN_MAX_DENIALS: "2.5" })).toEqual(UNATTENDED_DEFAULTS);
  });

  it("the loop guard is on with a stop at 20 for a turn nobody is watching, and as configured for any other", () => {
    expect(loopGuardSettings({}, {})).toEqual({ enabled: false, steerAt: 5 });
    expect(loopGuardSettings({}, {}, true)).toEqual({ enabled: true, steerAt: 5, stopAt: 20 });
    expect(loopGuardSettings({ loopGuard: { unattendedStopAt: 8, steerAt: 3 } }, {}, true)).toEqual({ enabled: true, steerAt: 3, stopAt: 8 });
    expect(loopGuardSettings({ loopGuard: { unattendedStopAt: 8 } }, { OMB_LOOP_GUARD_UNATTENDED_STOP_AT: "30" }, true)).toMatchObject({ stopAt: 30 });
    expect(loopGuardSettings({ loopGuard: { enabled: true, stopAt: 10 } }, {}, true)).toMatchObject({ enabled: true, stopAt: 10 });
    expect(loopGuardSettings({ loopGuard: { unattended: false } }, {}, true)).toEqual({ enabled: false, steerAt: 5 });
    expect(loopGuardSettings({ loopGuard: { enabled: true } }, { OMB_LOOP_GUARD_UNATTENDED_STOP_AT: "off" }, true)).toEqual({ enabled: true, steerAt: 5 });
    expect(parseConfigPatch({ loopGuard: { unattendedStopAt: 12 } })).toEqual({ loopGuard: { unattendedStopAt: 12 } });
    expect(parseConfigPatch({ loopGuard: { unattended: false } })).toEqual({ loopGuard: { unattended: false } });
    expect(() => parseConfigPatch({ loopGuard: { unattendedStopAt: 1 } })).toThrow();
  });
});

describe("a turn a person's own message started", () => {
  it("is attended, and so is a continuation of it; a routine's or a webhook's is not", () => {
    expect(personDriven({ origin: { kind: "user" } })).toBe(true);
    expect(personDriven({ personLine: true, origin: { kind: "outside" } })).toBe(true);
    expect(personDriven({ origin: { kind: "outside" } })).toBe(false);
    expect(personDriven(undefined)).toBe(false);
  });
});
