import { afterEach, describe, expect, it, vi } from "vitest";

import { forgetPresence, personAsks, sawThread, seenWithin } from "../thread-presence.ts";
import {
  armedIdleCount, armIdleClose, engineIdleMs, idleEngineCap, idleEnginesAllowed, keepWarm, PRESTART_IDLE_MS, PRESTART_MOST, prestartAllowed, sessionIdlePolicy, SMALL_BOX_BYTES,
  SMALL_BOX_IDLE_ENGINES, SMALL_BOX_IDLE_MS, stopIdleClose, sweepIdleEngines,
  UNWATCHED_IDLE_MS, warmEngineKeys, type WarmEngine,
} from "./session-idle.ts";

const GB = 1024 ** 3;
const DESKTOP = 16 * GB;

describe("sessionIdlePolicy", () => {
  it("defaults to ten minutes with a ten-second floor", () => {
    expect(sessionIdlePolicy("CLAUDE", {}, DESKTOP)).toEqual({ idleMs: 10 * 60_000, minimumMs: 10_000 });
    expect(sessionIdlePolicy("ACP", {}, DESKTOP)).toEqual({ idleMs: 10 * 60_000, minimumMs: 10_000 });
  });

  it("keeps an idle engine two and a half minutes on a box of 1.5 GB or less, unless configured", () => {
    expect(sessionIdlePolicy("CLAUDE", {}, 1.5 * GB).idleMs).toBe(SMALL_BOX_IDLE_MS);
    expect(sessionIdlePolicy("ACP", {}, 512 * 1024 ** 2).idleMs).toBe(SMALL_BOX_IDLE_MS);
    expect(sessionIdlePolicy("ACP", {}, 2 * GB).idleMs).toBe(10 * 60_000);
    expect(sessionIdlePolicy("CLAUDE", { OMB_SESSION_IDLE_MS: "600000" }, GB).idleMs).toBe(600_000);
    expect(sessionIdlePolicy("ACP", { OMB_ACP_SESSION_IDLE_MIN_MS: "200000" }, GB)).toEqual({ idleMs: 200_000, minimumMs: 200_000 });
  });

  it("honors each harness's own legacy names", () => {
    expect(sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MS: "120000" }).idleMs).toBe(120_000);
    expect(sessionIdlePolicy("ACP", { OMB_ACP_SESSION_IDLE_MS: "120000" }).idleMs).toBe(120_000);
    expect(sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MIN_MS: "30000" }).minimumMs).toBe(30_000);
    expect(sessionIdlePolicy("ACP", { OMB_ACP_SESSION_IDLE_MIN_MS: "30000" }).minimumMs).toBe(30_000);
  });

  it("lets the unified names set every harness at once, below a per-harness override", () => {
    expect(sessionIdlePolicy("CLAUDE", { OMB_SESSION_IDLE_MS: "90000" }).idleMs).toBe(90_000);
    expect(sessionIdlePolicy("ACP", { OMB_SESSION_IDLE_MS: "90000", OMB_ACP_SESSION_IDLE_MS: "120000" }).idleMs).toBe(120_000);
    expect(sessionIdlePolicy("ACP", { OMB_SESSION_IDLE_MIN_MS: "4000", OMB_ACP_SESSION_IDLE_MIN_MS: "30000" }).minimumMs).toBe(30_000);
    expect(sessionIdlePolicy("CLAUDE", { OMB_SESSION_IDLE_MIN_MS: "4000" }).minimumMs).toBe(10_000);
  });

  it("never floors below ten seconds, however low the configured minimum", () => {
    expect(sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MIN_MS: "2000" }).minimumMs).toBe(10_000);
    expect(
      sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MS: "15000", OMB_CLAUDE_SESSION_IDLE_MIN_MS: "2000" }).idleMs,
    ).toBe(15_000);
    expect(
      sessionIdlePolicy("ACP", { OMB_ACP_SESSION_IDLE_MS: "1", OMB_ACP_SESSION_IDLE_MIN_MS: "2000" }).idleMs,
    ).toBe(10_000);
    expect(sessionIdlePolicy("ACP", { OMB_SESSION_IDLE_MIN_MS: "-5" }).minimumMs).toBe(10_000);
  });

  it("rejects unusable delays before the floor instead of coercing them to a 1 ms timer", () => {
    for (const raw of ["not-a-number", "0", "-5", "", "Infinity", "1e309", "2147483648"]) {
      expect(sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MS: raw }, DESKTOP).idleMs).toBe(10 * 60_000);
      expect(sessionIdlePolicy("ACP", { OMB_SESSION_IDLE_MS: raw }, DESKTOP).idleMs).toBe(10 * 60_000);
    }
    expect(sessionIdlePolicy("CLAUDE", { OMB_CLAUDE_SESSION_IDLE_MS: "2147483647" }).idleMs).toBe(2_147_483_647);
    expect(sessionIdlePolicy("ACP", { OMB_ACP_SESSION_IDLE_MIN_MS: "Infinity" }).minimumMs).toBe(10_000);
  });
});

describe("an idle engine's keep-alive", () => {
  const policy = { idleMs: 10 * 60_000, minimumMs: 10_000 };
  const now = 1_800_000_000_000;
  const cloud = (headroom: number) => ({ enabled: true, headroom: () => headroom });
  afterEach(forgetPresence);

  it("keeps the configured time where the memory gate is off", () => {
    expect(engineIdleMs("unseen", policy, { enabled: false, headroom: () => 0.1 }, now)).toBe(10 * 60_000);
  });

  it("closes soon a thread nobody has had in front of them: a teammate's delegated work or a routine", () => {
    expect(engineIdleMs("delegated", policy, cloud(1), now)).toBe(UNWATCHED_IDLE_MS);
    sawThread("stale", now - 31 * 60_000);
    expect(engineIdleMs("stale", policy, cloud(1), now)).toBe(UNWATCHED_IDLE_MS);
    expect(engineIdleMs("delegated", { idleMs: 15_000, minimumMs: 10_000 }, cloud(1), now)).toBe(15_000);
    expect(engineIdleMs("delegated", { idleMs: 10 * 60_000, minimumMs: 45_000 }, cloud(1), now)).toBe(45_000);
  });

  it("keeps the conversation a person has open, wrote in from any channel, or read, for as long as memory allows", () => {
    sawThread("open", now - 5 * 60_000);
    personAsks.set("telegram", now - 60_000);
    expect(engineIdleMs("open", policy, cloud(1), now)).toBe(10 * 60_000);
    expect(engineIdleMs("telegram", policy, cloud(1), now)).toBe(10 * 60_000);
    expect(engineIdleMs("open", policy, cloud(0.5), now)).toBe(5 * 60_000);
    expect(engineIdleMs("open", policy, cloud(0.1), now)).toBe(60_000);
    // A teammate's report resuming the conversation clears "person asked"; the person was still there a minute ago.
    personAsks.delete("telegram");
    expect(engineIdleMs("telegram", policy, cloud(1), now)).toBe(10 * 60_000);
    expect(engineIdleMs("open", { idleMs: 60_000, minimumMs: 10_000 }, cloud(0.1), now)).toBe(10_000);
  });

  it("remembers the latest sighting of each thread, and only so many threads", () => {
    sawThread("a", now - 40 * 60_000);
    sawThread("a", now);
    expect(seenWithin("a", 60_000, now)).toBe(true);
    for (let i = 0; i < 2_001; i++) sawThread(`t${i}`, now);
    expect(seenWithin("a", 60_000, now)).toBe(false);
    expect(seenWithin("t2000", 60_000, now)).toBe(true);
  });
});

describe("idle engines on a small box", () => {
  const small = { bytes: GB };
  const engine = (busy = false) => {
    const state = { busy, closed: 0 };
    return { state, warm: { idle: () => !state.busy, close: () => { state.closed += 1; } } };
  };
  afterEach(() => { for (const key of warmEngineKeys()) stopIdleClose(key, null); });

  it("allows one idle engine once less than half of a small box is free, and any number otherwise", () => {
    expect(idleEnginesAllowed(small, 0.4 * GB)).toBe(1);
    expect(idleEnginesAllowed(small, 0.6 * GB)).toBe(Infinity);
    expect(idleEnginesAllowed({ bytes: DESKTOP }, 0)).toBe(Infinity);
  });

  it("keeps no more idle engines than a self-hosted server's limits fit, on a box of any size, the longest idle closing first", () => {
    expect(idleEnginesAllowed({ bytes: DESKTOP }, 0, 2)).toBe(2);
    expect(idleEnginesAllowed(small, 0.4 * GB, 5)).toBe(1);
    const [a, b, d] = [engine(), engine(), engine()];
    const fits = () => 2;
    keepWarm("a", a.warm, { bytes: DESKTOP }, () => 8 * GB, fits);
    keepWarm("b", b.warm, { bytes: DESKTOP }, () => 8 * GB, fits);
    expect([a.state.closed, b.state.closed]).toEqual([0, 0]);
    keepWarm("d", d.warm, { bytes: DESKTOP }, () => 8 * GB, fits);
    expect([a.state.closed, b.state.closed, d.state.closed]).toEqual([1, 0, 0]);
    expect(warmEngineKeys()).toEqual(["b", "d"]);
  });

  it("closes the engine idle longest when another goes idle and memory is tight, never a busy one", () => {
    const [a, b, c] = [engine(), engine(true), engine()];
    keepWarm("a", a.warm, small, () => 0.6 * GB);
    keepWarm("b", b.warm, small, () => 0.6 * GB);
    expect(a.state.closed).toBe(0);
    keepWarm("c", c.warm, small, () => 0.3 * GB);
    expect([a.state.closed, b.state.closed, c.state.closed]).toEqual([1, 0, 0]);
    expect(warmEngineKeys()).toEqual(["c"]);
  });

  it("keeps every idle engine on a large box up to the cap, and forgets one once it closes or works again", () => {
    const [a, b] = [engine(), engine()];
    keepWarm("a", a.warm, { bytes: DESKTOP }, () => 0, () => Infinity, () => 8);
    keepWarm("b", b.warm, { bytes: DESKTOP }, () => 0, () => Infinity, () => 8);
    expect([a.state.closed, b.state.closed, warmEngineKeys()]).toEqual([0, 0, ["a", "b"]]);
    keepWarm("a", a.warm, small, () => 0.6 * GB);
    stopIdleClose("a", null);
    keepWarm("b", b.warm, small, () => 0.1 * GB);
    expect(a.state.closed).toBe(0);
  });

  it("closes on its timer like any idle engine", () => {
    vi.useFakeTimers();
    try {
      const a = engine();
      const timer = armIdleClose("a", 150_000, a.warm);
      vi.advanceTimersByTime(149_999);
      expect(a.state.closed).toBe(0);
      vi.advanceTimersByTime(1);
      expect(a.state.closed).toBe(1);
      stopIdleClose("a", timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never closes an engine a turn took again or one still held when its idle timer runs out", () => {
    vi.useFakeTimers();
    const before = armedIdleCount();
    try {
      const working = engine();
      const held = engine();
      const warmHeld: WarmEngine = { ...held.warm, held: () => true };
      const quiet = engine();
      const timers = [
        armIdleClose("working", 150_000, working.warm),
        armIdleClose("held", 150_000, warmHeld),
        armIdleClose("quiet", 150_000, quiet.warm),
      ];
      working.state.busy = true;
      vi.advanceTimersByTime(150_000);
      expect([working.state.closed, held.state.closed, quiet.state.closed]).toEqual([0, 0, 1]);
      expect(armedIdleCount()).toBe(before);
      working.state.busy = false;
      const again = armIdleClose("working", 150_000, working.warm);
      vi.advanceTimersByTime(150_000);
      expect(working.state.closed).toBe(1);
      stopIdleClose("working", again);
      stopIdleClose("held", timers[1]);
      stopIdleClose("quiet", timers[2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a later arm's entry and engine alone when an old timer still fires", () => {
    vi.useFakeTimers();
    const before = armedIdleCount();
    try {
      const old = engine();
      const fresh = engine();
      armIdleClose("g", 150_000, old.warm);
      const freshTimer = armIdleClose("g", 300_000, fresh.warm);
      vi.advanceTimersByTime(150_000);
      expect(old.state.closed).toBe(0);
      expect(armedIdleCount()).toBe(before + 1);
      vi.advanceTimersByTime(150_000);
      expect(fresh.state.closed).toBe(1);
      stopIdleClose("g", freshTimer);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the cap on idle engines", () => {
  const engine = (threadId: string, busy = false) => {
    const state = { busy, closed: 0 };
    return { state, warm: { threadId, idle: () => !state.busy, close: () => { state.closed += 1; } } as WarmEngine };
  };
  const capped = (most: number) => (key: string, warm: WarmEngine) => keepWarm(key, warm, { bytes: DESKTOP }, () => 8 * GB, () => Infinity, () => most);
  afterEach(() => {
    for (const key of warmEngineKeys()) stopIdleClose(key, null);
    forgetPresence();
  });

  it("is one idle engine per 2 GB between four and eight, two on a small box, or OMB_IDLE_ENGINES_MAX", () => {
    expect(idleEngineCap({}, 4 * GB)).toBe(4);
    expect(idleEngineCap({}, 8 * GB)).toBe(4);
    expect(idleEngineCap({}, 12 * GB)).toBe(6);
    expect(idleEngineCap({}, DESKTOP)).toBe(8);
    expect(idleEngineCap({}, 64 * GB)).toBe(8);
    expect(idleEngineCap({}, SMALL_BOX_BYTES)).toBe(SMALL_BOX_IDLE_ENGINES);
    expect(idleEngineCap({ OMB_IDLE_ENGINES_MAX: "12" }, DESKTOP)).toBe(12);
    expect(idleEngineCap({ OMB_IDLE_ENGINES_MAX: "1" }, GB)).toBe(1);
    for (const unusable of ["0", "-2", "2.5", "many", ""]) expect(idleEngineCap({ OMB_IDLE_ENGINES_MAX: unusable }, DESKTOP)).toBe(8);
  });

  it("closes the least recently used idle engines past the cap, on a box with room to spare", () => {
    const engines = ["a", "b", "c", "d", "e", "f"].map((id) => [id, engine(id)] as const);
    for (const [id, { warm }] of engines) capped(3)(id, warm);
    expect(engines.map(([, { state }]) => state.closed)).toEqual([1, 1, 1, 0, 0, 0]);
    expect(warmEngineKeys()).toEqual(["d", "e", "f"]);
  });

  it("never closes or counts an engine with a turn running", () => {
    const [busy, b, c, d] = [engine("busy"), engine("b"), engine("c"), engine("d")];
    capped(2)("busy", busy.warm);
    busy.state.busy = true;
    capped(2)("b", b.warm);
    capped(2)("c", c.warm);
    expect([busy.state.closed, b.state.closed, c.state.closed]).toEqual([0, 0, 0]);
    capped(2)("d", d.warm);
    expect([busy.state.closed, b.state.closed, c.state.closed, d.state.closed]).toEqual([0, 1, 0, 0]);
  });

  it("counts an engine as used again when it goes idle after a turn or a person opens its conversation", () => {
    const [a, b, c, d, e] = [engine("a"), engine("b"), engine("c"), engine("d"), engine("e")];
    for (const id of ["a", "b", "c", "d", "e"]) sawThread(id);
    capped(3)("a", a.warm);
    capped(3)("b", b.warm);
    capped(3)("c", c.warm);
    sawThread("a");
    capped(3)("d", d.warm);
    expect([a.state.closed, b.state.closed]).toEqual([0, 1]);
    capped(3)("c", c.warm);
    capped(3)("e", e.warm);
    expect([a.state.closed, c.state.closed, d.state.closed]).toEqual([1, 0, 0]);
    expect(warmEngineKeys()).toEqual(["d", "c", "e"]);
  });

  it("closes an engine no person has had in front of them before one they have", () => {
    const [mine, routine, next] = [engine("mine"), engine("routine"), engine("next")];
    sawThread("mine");
    capped(2)("mine", mine.warm);
    capped(2)("routine", routine.warm);
    capped(2)("next", next.warm);
    expect([mine.state.closed, routine.state.closed, next.state.closed]).toEqual([0, 1, 0]);
  });

  it("never closes the engine that is going idle, even one no person has in front of them", () => {
    const [mine, theirs, routine] = [engine("mine"), engine("theirs"), engine("routine")];
    sawThread("mine");
    sawThread("theirs");
    capped(2)("mine", mine.warm);
    capped(2)("theirs", theirs.warm);
    capped(2)("routine", routine.warm);
    expect([mine.state.closed, theirs.state.closed, routine.state.closed]).toEqual([1, 0, 0]);
    expect(warmEngineKeys()).toEqual(["theirs", "routine"]);
  });

  it("keeps an engine started ahead of a first message as the most recent, and never closes a held one", () => {
    const [used, held, spare] = [engine("used"), engine("held"), engine("spare")];
    capped(1)("held", { ...held.warm, held: () => true });
    capped(1)("used", used.warm);
    capped(1)("spare", { ...spare.warm, spare: () => true });
    expect([used.state.closed, held.state.closed, spare.state.closed]).toEqual([1, 0, 0]);
  });
});

describe("engines started before a first message", () => {
  const engine = (spare: boolean) => {
    const state = { closed: 0 };
    return { state, warm: { idle: () => true, close: () => { state.closed += 1; }, spare: () => spare, threadId: "t", policy: sessionIdlePolicy("CLAUDE", {}, DESKTOP) } };
  };
  afterEach(() => { for (const key of warmEngineKeys()) stopIdleClose(key, null); });

  it("are for hosts where memory is not rationed: none on a small box, none where turns wait for room", () => {
    expect(prestartAllowed({ bytes: DESKTOP }, { enabled: false })).toBe(true);
    expect(prestartAllowed({ bytes: SMALL_BOX_BYTES }, { enabled: false })).toBe(false);
    expect(prestartAllowed({ bytes: GB }, { enabled: false })).toBe(false);
    expect(prestartAllowed({ bytes: DESKTOP }, { enabled: true })).toBe(false);
  });

  it("wait no longer than an engine nobody is looking at is kept, and only a couple at once", () => {
    expect(PRESTART_IDLE_MS).toBe(UNWATCHED_IDLE_MS);
    expect(PRESTART_MOST).toBe(2);
  });

  it("close before any engine a turn has used when the box allows fewer idle engines", () => {
    const [used, spare, later] = [engine(false), engine(true), engine(false)];
    const fits = () => 2;
    keepWarm("used", used.warm, { bytes: DESKTOP }, () => 8 * GB, fits);
    keepWarm("spare", spare.warm, { bytes: DESKTOP }, () => 8 * GB, fits);
    keepWarm("later", later.warm, { bytes: DESKTOP }, () => 8 * GB, fits);
    expect([used.state.closed, spare.state.closed, later.state.closed]).toEqual([0, 1, 0]);
    expect(warmEngineKeys()).toEqual(["used", "later"]);
  });

  it("close at once when room runs short, while a used engine keeps the time the room still allows", () => {
    vi.useFakeTimers();
    try {
      const [used, spare] = [engine(false), engine(true)];
      const timers = [armIdleClose("used", 600_000, used.warm, 1_000), armIdleClose("spare", PRESTART_IDLE_MS, spare.warm, 1_000)];
      const roomy = { enabled: true, headroom: () => 1, roomFactor: () => 1, shortOfRoom: () => false };
      expect(sweepIdleEngines(roomy, 2_000)).toBe(0);
      const tight = { enabled: true, headroom: () => 0.9, roomFactor: () => 0.9, shortOfRoom: () => false };
      sawThread("t", 2_000);
      expect(sweepIdleEngines(tight, 2_000)).toBe(1);
      expect([used.state.closed, spare.state.closed]).toEqual([0, 1]);
      stopIdleClose("used", timers[0]!);
      stopIdleClose("spare", timers[1]!);
    } finally {
      vi.useRealTimers();
      forgetPresence();
    }
  });
});
