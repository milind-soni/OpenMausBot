import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { agree, CLOCK_FD_ENV, CLOCK_MAX_STEP_MS, CLOCK_STEP_MS, clockKicker, clockSources, createCloudClock, readClock, type ClockClocks } from "./cloud-clock.ts";
import { clockFacts, createClockKeeper, hasEffectiveCapability } from "./cloud-clock-keeper.ts";
import { CLOUD_PAIRING_SKEW_S, cloudRequestSignature, createCloudRequestVerifier } from "./cloud-home.ts";
import { createCloudPower } from "./cloud-power.ts";
import { planOccurrence } from "./routine-catch-up.ts";

const SIX_HOURS = 6 * 3_600_000;
const START = Date.parse("2026-11-25T08:00:00Z");
const ADMIN = "https://admin.example", ACCOUNTS = "https://accounts.example", RELAY = "https://relay.example";
const secret = "S".repeat(43);

/**
 * A home and the world around it. `wall` and `mono` are the home's own clocks; `truth` is the world's. A suspend moves
 * only `truth`: the home's wall and monotonic clocks both stop, which is the case a clock-jump detector can't see.
 */
function world() {
  const state = { truth: START, wall: START, mono: 1_000, skew: {} as Record<string, number>, cached: new Set<string>(), down: new Set<string>(), asked: [] as string[] };
  const clocks: ClockClocks = { wall: () => state.wall, mono: () => state.mono };
  const fetcher = (async (input: string | URL | Request) => {
    const origin = new URL(String(input)).origin;
    state.asked.push(origin);
    if (state.down.has(origin)) throw new Error("unreachable");
    const date = new Date(state.truth + (state.skew[origin] ?? 0)).toUTCString();
    return new Response(null, { status: 200, headers: { date, ...(state.cached.has(origin) ? { age: "120" } : {}) } });
  }) as typeof fetch;
  /** Time passes for everyone. */
  const pass = (ms: number) => { state.truth += ms; state.wall += ms; state.mono += ms; };
  /** Suspended for `ms`: the world moves on, the home's clocks don't. */
  const suspend = (ms: number) => { state.truth += ms; };
  let counter = 0;
  /** The Admin signs with its own (true) clock, or with `at` (a request captured then). */
  const sign = (target = "/api/cloud/health?after=0", at = state.truth) => {
    const timestamp = String(Math.floor(at / 1000)), nonce = `nonce-${String(++counter).padStart(12, "0")}`;
    return { timestamp, nonce, signature: `v1=${cloudRequestSignature(secret, timestamp, nonce, "GET", target, "")}`, method: "GET", target, body: "" };
  };
  return { state, clocks, fetcher, pass, suspend, sign };
}

function homeClock(w: ReturnType<typeof world>) {
  const kicks: number[] = [], lines: string[] = [];
  const clock = createCloudClock({ origins: [ADMIN, ACCOUNTS, RELAY], fetch: w.fetcher, clocks: w.clocks, kick: () => kicks.push(w.state.truth), log: (line) => lines.push(line), skewS: CLOUD_PAIRING_SKEW_S });
  const verifier = (tolerant: boolean) => createCloudRequestVerifier({ secret, now: w.clocks.wall, mono: w.clocks.mono, clock, tolerant });
  return { clock, kicks, lines, health: verifier(true), pairing: verifier(false) };
}

describe("reading a clock from the outside", () => {
  it("asks the Admin first, then its own hosts, each host once", () => {
    expect(clockSources("https://admin.example/")).toEqual(["https://admin.example", "https://accounts.openmausbot.com", "https://relay1.openmausbot.com"]);
    expect(clockSources("https://accounts.openmausbot.com")).toEqual(["https://accounts.openmausbot.com", "https://relay1.openmausbot.com"]);
  });

  it("takes an answer's Date, and refuses a cached one, a slow one and one without a Date", async () => {
    const w = world();
    w.state.skew[ADMIN] = SIX_HOURS;
    expect(Math.abs((await readClock(ADMIN, w.fetcher, w.clocks))!.offsetMs - SIX_HOURS)).toBeLessThanOrEqual(500);
    w.state.cached.add(ADMIN);
    expect(await readClock(ADMIN, w.fetcher, w.clocks)).toBeNull();
    const slow = (async () => { w.state.mono += 10_000; return new Response(null, { headers: { date: new Date(w.state.truth).toUTCString() } }); }) as typeof fetch;
    expect(await readClock(ADMIN, slow, w.clocks)).toBeNull();
    expect(await readClock(ADMIN, (async () => new Response(null)) as typeof fetch, w.clocks)).toBeNull();
    expect(await readClock(ADMIN, (async () => { throw new Error("down"); }) as typeof fetch, w.clocks)).toBeNull();
  });

  it("agrees on the largest group of two or more answers within a few seconds of each other, which must hold the Admin's", () => {
    const at = (origin: string, offsetMs: number) => ({ origin, offsetMs, tripMs: 50 });
    expect(agree([at(ADMIN, SIX_HOURS)]).state).toBe("too-few");
    expect(agree([at(ADMIN, SIX_HOURS), at(ACCOUNTS, 0)]).state).toBe("disagree");
    expect(agree([at(ADMIN, SIX_HOURS), at(ACCOUNTS, SIX_HOURS + 2_000)])).toMatchObject({ state: "agreed", offsetMs: SIX_HOURS + 1_000 });
    // One host with a wrong clock is outvoted, not a veto.
    expect(agree([at(ADMIN, SIX_HOURS), at(ACCOUNTS, SIX_HOURS), at(RELAY, 0)], ADMIN)).toMatchObject({ state: "agreed", offsetMs: SIX_HOURS, readings: [at(ADMIN, SIX_HOURS), at(ACCOUNTS, SIX_HOURS)] });
    // Two hosts that are not the Admin never move the clock away from the Admin's time.
    expect(agree([at(ADMIN, 0), at(ACCOUNTS, SIX_HOURS), at(RELAY, SIX_HOURS)], ADMIN).state).toBe("disagree");
    // Two groups as large, each with the Admin's answer, saying different times: nothing.
    expect(agree([at(ACCOUNTS, -2_500), at(ADMIN, 0), at(RELAY, 2_500)], ADMIN).state).toBe("disagree");
  });
});

describe("a home a resume left behind, with no jump to notice", () => {
  it("is measured from the Admin's first signed read, keeps answering its health reads, and asks the supervisor to set the clock", async () => {
    const w = world(), home = homeClock(w);
    expect(home.health.verify(w.sign())).toEqual({ ok: true });
    w.suspend(SIX_HOURS + 60_000);
    w.pass(5_000);
    // The first read after the resume is still refused (nothing measured yet), and starts the measurement.
    expect(home.health.verify(w.sign())).toMatchObject({ ok: false, error: "stale_request" });
    await home.clock.check();
    expect(home.kicks).toHaveLength(1);
    expect(Math.abs(home.clock.report().errorMs! - (SIX_HOURS + 60_000))).toBeLessThanOrEqual(1_000);
    expect(home.clock.report().measuredAt).toBeGreaterThan(START + SIX_HOURS);
    // Then the Admin's reads pass while the clock is wrong; pairing never does.
    w.pass(60_000);
    expect(home.health.verify(w.sign())).toEqual({ ok: true });
    expect(home.pairing.verify(w.sign())).toMatchObject({ ok: false, error: "stale_request" });
    // A request signed six hours ago fits the wrong clock, and is refused now that the true time is known, by every route.
    expect(home.health.verify(w.sign(undefined, START + 60_000))).toMatchObject({ ok: false, error: "stale_request" });
    expect(home.pairing.verify(w.sign(undefined, START + 60_000))).toMatchObject({ ok: false, error: "stale_request" });
  });

  it("is set forward by the supervisor, which measures for itself, and the server then sees a wake and a right clock", async () => {
    const w = world(), home = homeClock(w), set: number[] = [], lines: string[] = [];
    const keeper = createClockKeeper({ origins: [ADMIN, ACCOUNTS, RELAY], canSet: true, fetch: w.fetcher, clocks: w.clocks, log: (line) => lines.push(line),
      set: (wallMs) => { set.push(wallMs); w.state.wall = wallMs; return { ok: true }; } });
    const pipe = new PassThrough();
    keeper.listen(pipe);
    let woke = 0;
    const dir = mkdtempSync(join(tmpdir(), "omb-cloud-clock-"));
    const power = createCloudPower({ dataDir: dir, now: w.clocks.wall, broadcast: () => {}, onWoke: () => { woke += 1; }, probes: {
      turn: () => false, run: () => false, handoff: () => false, liveCall: () => false, computer: () => false, maintenance: () => false, nextDueAt: () => null } });
    try {
      w.suspend(SIX_HOURS);
      power.tick();
      expect(woke).toBe(0);
      home.health.verify(w.sign());
      await home.clock.check();
      expect(home.kicks).toHaveLength(1);
      // The server's line is only a reason to look: the supervisor measures again and sets the true time.
      pipe.write("check\n");
      await new Promise((resolve) => setImmediate(resolve));
      await keeper.check();
      expect(set).toHaveLength(1);
      expect(Math.abs(set[0]! - w.state.truth)).toBeLessThanOrEqual(1_000);
      expect(lines.at(-1)).toMatch(/360 min behind \(3 hosts agree\); set forward/);
      // A step bigger than the resume jump: cloud-power's tick calls it a wake, so the server's wake handling runs.
      expect(CLOCK_STEP_MS).toBeGreaterThan(20_000);
      power.tick();
      expect(woke).toBe(1);
      home.clock.woke();
      await home.clock.check();
      expect(Math.abs(home.clock.report().errorMs!)).toBeLessThanOrEqual(1_000);
      expect(home.health.verify(w.sign())).toEqual({ ok: true });
    } finally {
      power.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forgets no nonce when the clock is set forward: a read let through just before can't be replayed just after", async () => {
    const w = world(), home = homeClock(w);
    w.suspend(SIX_HOURS);
    home.health.verify(w.sign());
    await home.clock.check();
    const read = w.sign();
    expect(home.health.verify(read)).toEqual({ ok: true });
    w.state.wall += SIX_HOURS;
    w.pass(1_000);
    expect(home.health.verify(read)).toMatchObject({ ok: false, error: "replayed_request" });
  });
});

describe("what can't move the clock", () => {
  it("an old signed request replayed: it starts a measurement, which finds the clock right", async () => {
    const w = world(), home = homeClock(w);
    w.pass(SIX_HOURS);
    expect(home.health.verify(w.sign(undefined, START))).toMatchObject({ ok: false, error: "stale_request" });
    await home.clock.check();
    expect(home.kicks).toEqual([]);
    expect(Math.abs(home.clock.report().errorMs!)).toBeLessThanOrEqual(1_000);
    expect(home.health.verify(w.sign(undefined, START))).toMatchObject({ ok: false, error: "stale_request" });
    // And the supervisor, asked as often as anyone likes, sets nothing.
    const set: number[] = [];
    const keeper = createClockKeeper({ origins: [ADMIN, ACCOUNTS, RELAY], canSet: true, fetch: w.fetcher, clocks: w.clocks, log: () => {}, set: (ms) => { set.push(ms); return { ok: true }; } });
    await keeper.check();
    expect(set).toEqual([]);
  });

  it("hosts that disagree: nothing is measured, set or let through", async () => {
    const w = world(), home = homeClock(w);
    w.state.skew[ADMIN] = SIX_HOURS;
    w.state.skew[RELAY] = -SIX_HOURS;
    home.health.verify(w.sign(undefined, w.state.truth + SIX_HOURS));
    await home.clock.check();
    expect(home.kicks).toEqual([]);
    expect(home.clock.report().errorMs).toBeNull();
    expect(home.health.verify(w.sign(undefined, w.state.truth + SIX_HOURS))).toMatchObject({ ok: false, error: "stale_request" });
    expect(home.lines.at(-1)).toMatch(/hosts disagree/);
    const set: number[] = [];
    await createClockKeeper({ origins: [ADMIN, ACCOUNTS, RELAY], canSet: true, fetch: w.fetcher, clocks: w.clocks, log: () => {}, set: (ms) => { set.push(ms); return { ok: true }; } }).check();
    expect(set).toEqual([]);
  });

  it("the two other hosts agreeing without the Admin: nothing is set", async () => {
    const w = world(), set: number[] = [], lines: string[] = [];
    w.state.skew[ACCOUNTS] = SIX_HOURS;
    w.state.skew[RELAY] = SIX_HOURS;
    await createClockKeeper({ origins: [ADMIN, ACCOUNTS, RELAY], canSet: true, fetch: w.fetcher, clocks: w.clocks, log: (line) => lines.push(line), set: (ms) => { set.push(ms); return { ok: true }; } }).check();
    expect(set).toEqual([]);
    expect(lines).toEqual(["cloud home: clock not checked (the hosts disagree); left as it is"]);
  });

  it("one host alone, or cached answers: too few to agree", async () => {
    const w = world(), set: number[] = [];
    w.suspend(SIX_HOURS);
    w.state.down.add(ACCOUNTS);
    w.state.cached.add(RELAY);
    const lines: string[] = [];
    await createClockKeeper({ origins: [ADMIN, ACCOUNTS, RELAY], canSet: true, fetch: w.fetcher, clocks: w.clocks, log: (line) => lines.push(line), set: (ms) => { set.push(ms); return { ok: true }; } }).check();
    expect(set).toEqual([]);
    expect(lines).toEqual(["cloud home: clock not checked (too few hosts answered); left as it is"]);
  });

  it("a clock ahead is reported and never set back; the Admin's reads are judged by the measured time", async () => {
    const w = world(), home = homeClock(w), set: number[] = [], lines: string[] = [];
    w.state.wall += SIX_HOURS;
    home.health.verify(w.sign());
    await home.clock.check();
    expect(home.kicks).toEqual([]);
    expect(home.clock.report().errorMs).toBeLessThan(-SIX_HOURS + 1_000);
    expect(home.health.verify(w.sign())).toEqual({ ok: true });
    expect(home.pairing.verify(w.sign())).toMatchObject({ ok: false, error: "stale_request" });
    // Signed to fit the clock that is ahead: refused, since no such time has come yet.
    expect(home.health.verify(w.sign(undefined, w.state.wall))).toMatchObject({ ok: false, error: "stale_request" });
    await createClockKeeper({ origins: [ADMIN, ACCOUNTS, RELAY], canSet: true, fetch: w.fetcher, clocks: w.clocks, log: (line) => lines.push(line), set: (ms) => { set.push(ms); return { ok: true }; } }).check();
    expect(set).toEqual([]);
    expect(lines).toEqual(["cloud home: the clock is 360 min ahead; only a clock behind is set, so it is left as it is"]);
  });

  it("one host with a wrong clock: the Admin and the other host agree, and the clock is set", async () => {
    const w = world(), set: number[] = [], lines: string[] = [];
    w.suspend(SIX_HOURS);
    w.state.skew[RELAY] = -SIX_HOURS;
    await createClockKeeper({ origins: [ADMIN, ACCOUNTS, RELAY], canSet: true, fetch: w.fetcher, clocks: w.clocks, log: (line) => lines.push(line), set: (ms) => { set.push(ms); return { ok: true }; } }).check();
    expect(set).toHaveLength(1);
    expect(Math.abs(set[0]! - w.state.truth)).toBeLessThanOrEqual(1_000);
    expect(lines.at(-1)).toMatch(/360 min behind \(2 hosts agree\); set forward/);
  });

  it("a clock the platform sets right during the measurement is not stepped again (no overshoot), and a partial one gets the true time", async () => {
    // Six hours behind; the platform puts the wall clock right while the hosts are being asked.
    const w = world(), set: number[] = [], lines: string[] = [];
    w.suspend(SIX_HOURS);
    let corrected = false;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      // After every request went out, before the answers are read.
      const answer = await w.fetcher(input, init);
      await Promise.resolve();
      if (!corrected) { corrected = true; w.state.wall = w.state.truth; }
      return answer;
    }) as typeof fetch;
    await createClockKeeper({ origins: [ADMIN, ACCOUNTS, RELAY], canSet: true, fetch: fetcher, clocks: w.clocks, log: (line) => lines.push(line), set: (ms) => { set.push(ms); return { ok: true }; } }).check();
    expect(set).toEqual([]);
    expect(lines.at(-1)).toMatch(/set right meanwhile/);
    // Corrected only part of the way (to an hour behind) meanwhile: stepped to the true time, not six hours past it.
    const p = world(), partial: number[] = [];
    p.suspend(SIX_HOURS);
    let once = false;
    const halfway = (async (input: string | URL | Request, init?: RequestInit) => {
      const answer = await p.fetcher(input, init);
      await Promise.resolve();
      if (!once) { once = true; p.state.wall = p.state.truth - 3_600_000; }
      return answer;
    }) as typeof fetch;
    await createClockKeeper({ origins: [ADMIN, ACCOUNTS, RELAY], canSet: true, fetch: halfway, clocks: p.clocks, log: () => {}, set: (ms) => { partial.push(ms); return { ok: true }; } }).check();
    expect(partial).toHaveLength(1);
    expect(Math.abs(partial[0]! - p.state.truth)).toBeLessThanOrEqual(1_000);
  });

  it("an error larger than any suspend (two weeks) is not believed: nothing set, nothing let through on it", async () => {
    const w = world(), home = homeClock(w), set: number[] = [], lines: string[] = [];
    w.suspend(CLOCK_MAX_STEP_MS + 86_400_000);
    home.health.verify(w.sign());
    await home.clock.check();
    expect(home.kicks).toEqual([]);
    expect(home.clock.report().errorMs).toBeNull();
    expect(home.health.verify(w.sign())).toMatchObject({ ok: false, error: "stale_request" });
    expect(home.lines.at(-1)).toMatch(/more than any suspend; not believed/);
    await createClockKeeper({ origins: [ADMIN, ACCOUNTS, RELAY], canSet: true, fetch: w.fetcher, clocks: w.clocks, log: (line) => lines.push(line), set: (ms) => { set.push(ms); return { ok: true }; } }).check();
    expect(set).toEqual([]);
    expect(lines.at(-1)).toMatch(/more than any suspend; not believed/);
    // Just under it: set.
    const near = world(), nearSet: number[] = [];
    near.suspend(CLOCK_MAX_STEP_MS - 3_600_000);
    await createClockKeeper({ origins: [ADMIN, ACCOUNTS, RELAY], canSet: true, fetch: near.fetcher, clocks: near.clocks, log: () => {}, set: (ms) => { nearSet.push(ms); return { ok: true }; } }).check();
    expect(nearSet).toHaveLength(1);
  });

  it("a machine that may not set its clock: told once, the measurement still reported", async () => {
    const w = world(), lines: string[] = [], set: number[] = [];
    w.suspend(SIX_HOURS);
    const keeper = createClockKeeper({ origins: [ADMIN, ACCOUNTS, RELAY], canSet: false, fetch: w.fetcher, clocks: w.clocks, log: (line) => lines.push(line), set: (ms) => { set.push(ms); return { ok: true }; } });
    await keeper.check();
    w.pass(120_000);
    await keeper.check();
    expect(set).toEqual([]);
    expect(lines).toEqual(["cloud home: the clock is 360 min behind and this machine can't set it (no CAP_SYS_TIME); a restart sets it"]);
  });

  it("measures at most once a minute, however often it is asked", async () => {
    const w = world(), home = homeClock(w);
    w.suspend(SIX_HOURS);
    for (let i = 0; i < 5; i += 1) home.health.verify(w.sign());
    await home.clock.check();
    for (let i = 0; i < 5; i += 1) home.health.verify(w.sign(undefined, START));
    await home.clock.check();
    expect(w.state.asked).toHaveLength(3);
    const keeper = createClockKeeper({ origins: [ADMIN, ACCOUNTS, RELAY], canSet: false, fetch: w.fetcher, clocks: w.clocks, log: () => {} });
    const pipe = new PassThrough();
    keeper.listen(pipe);
    pipe.write("check\ncheck\nsomething else\n2026-01-01\ncheck\n");
    await new Promise((resolve) => setImmediate(resolve));
    await keeper.check();
    expect(w.state.asked).toHaveLength(6);
  });
});

describe("after the clock is set forward six hours", () => {
  it("each routine runs once, its newest occurrence, and the ones before close on one counted row", () => {
    const hourly = { type: "interval" as const, everyMinutes: 60, anchorAt: START };
    const plan = planOccurrence({ schedule: hourly, nextRunAt: START + 60 * 60_000 }, START + SIX_HOURS + 30_000, true);
    expect(plan).toMatchObject({ scheduledFor: START + SIX_HOURS, count: 6, late: true });
    expect(plan.older).toMatchObject({ count: 5, scheduledFor: START + 60 * 60_000, fields: { status: "missed" } });
    const daily = planOccurrence({ schedule: { type: "cron", expression: "0 9 * * *", timeZone: "UTC" }, nextRunAt: Date.parse("2026-11-25T09:00:00Z") }, Date.parse("2026-11-25T14:00:00Z"), true);
    expect(daily).toMatchObject({ scheduledFor: Date.parse("2026-11-25T09:00:00Z"), count: 1, late: true });
    expect(daily.older).toBeUndefined();
  });
});

describe("the supervisor's side of the machine", () => {
  it("reads CAP_SYS_TIME from the effective set, and what the machine offers for time", () => {
    expect(hasEffectiveCapability("CapInh:\t0000000000000000\nCapEff:\t000001ffffffffff\n", 25)).toBe(true);
    expect(hasEffectiveCapability("CapEff:\t00000000a80425fb\n", 25)).toBe(false);
    const files: Record<string, string> = { "/sys/devices/system/clocksource/clocksource0/current_clocksource": "kvm-clock\n", "/proc/self/status": "CapEff:\t000001ffffffffff\n" };
    expect(clockFacts((path) => files[path] ?? "", (path) => path === "/dev/ptp0")).toEqual({ source: "kvm-clock", ptp: true, canSet: true });
    expect(clockFacts(() => "", () => false)).toEqual({ source: "unknown", ptp: false, canSet: false });
  });

  it("hands the server a pipe only through its own variable, taken out of the environment, and never a stray descriptor", () => {
    const env: NodeJS.ProcessEnv = { [CLOCK_FD_ENV]: "2" };
    expect(clockKicker(env)).toBeNull();
    expect(env[CLOCK_FD_ENV]).toBeUndefined();
    expect(clockKicker({})).toBeNull();
  });
});

