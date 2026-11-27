import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CHECK_EVERY_MS, CHECK_JITTER, FIRST_CHECK_MS, createBackgroundCheck, jitteredWait } from "./connection-health-check.ts";
import { accountHealth, createConnectionHealth, UNREACHABLE_AFTER } from "./connection-health.ts";
import { appCallOutcome, probeOutcome } from "./connection-outcome.ts";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "omb-health-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("a connection's health", () => {
  it("moves with each outcome: refused and signed out at once, unreachable only once it repeats, working on any success", () => {
    let at = 1_000;
    const file = join(temp(), "health.json");
    const health = createConnectionHealth({ file, now: () => at });
    const ref = { kind: "mcp" as const, id: "tracker" };
    expect(health.observe(ref, { ok: true }, { use: true })).toBe("working");
    at = 2_000;
    expect(health.observe(ref, { ok: false, error: "cant-connect" }, { use: true })).toBe("working");
    expect(health.get(ref)).toEqual({ health: "working", checkedAt: 1_000, lastUsedAt: 2_000 });
    at = 3_000;
    for (let miss = 1; miss < UNREACHABLE_AFTER; miss += 1) health.observe(ref, { ok: false, error: "timeout" });
    expect(health.get(ref)).toMatchObject({ health: "unreachable", checkedAt: 3_000, lastError: "timeout" });
    at = 4_000;
    expect(health.observe(ref, { ok: true })).toBe("working");
    expect(health.get(ref)).toEqual({ health: "working", checkedAt: 4_000, lastUsedAt: 2_000 });
    expect(health.observe(ref, { ok: false, error: "sign-in" })).toBe("needs-sign-in");
    expect(health.observe(ref, { ok: false, error: "refused" })).toBe("refused");
    expect(health.get(ref).lastError).toBe("refused");
    // One miss after a refusal leaves it refused; a reconnect clears what was known.
    expect(health.observe(ref, { ok: false, error: "cant-connect" })).toBe("refused");
    health.reset(ref);
    expect(health.get(ref)).toEqual({ lastUsedAt: 2_000 });
    health.flush();
    expect(JSON.parse(readFileSync(file, "utf8")).connections["mcp:tracker"]).toMatchObject({ usedAt: 2_000 });
  });

  it("keeps each member's own apart from the team's, forgets a removed connection and a member who left", () => {
    const file = join(temp(), "health.json");
    const health = createConnectionHealth({ file, now: () => 5 });
    health.observe({ kind: "app", id: "gmail" }, { ok: true });
    health.observe({ kind: "app", id: "gmail", person: "p_ada" }, { ok: false, error: "sign-in" });
    health.added("app", "gmail", "Olive@Acme.test");
    expect(health.get({ kind: "app", id: "gmail" }).health).toBe("working");
    expect(health.get({ kind: "app", id: "gmail", person: "p_ada" }).health).toBe("needs-sign-in");
    expect(health.addedBy("app", "gmail")).toEqual({ email: "olive@acme.test", at: 5 });
    health.forgetPerson("p_ada");
    expect(health.get({ kind: "app", id: "gmail", person: "p_ada" })).toEqual({});
    health.forget("app", "gmail");
    expect([health.get({ kind: "app", id: "gmail" }), health.addedBy("app", "gmail"), health.known("app")]).toEqual([{}, undefined, []]);
  });

  it("reads a connected-apps account's status word as one of the four", () => {
    expect(["ACTIVE", "EXPIRED", "INITIATED", "FAILED", "SOMETHING"].map((word) => accountHealth(word)?.health ?? null))
      .toEqual(["working", "needs-sign-in", "needs-sign-in", "refused", null]);
  });
});

describe("what a call shows", () => {
  const answer = (text: string, isError = false) => new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError, content: [{ type: "text", text }] } }));
  it("reads only a failed app call's own error, never what the tool returned", () => {
    expect(appCallOutcome(200, answer(JSON.stringify({ successful: true, data: { body: "Unauthorized access to the vault, 401" } })), "application/json")).toEqual({ ok: true });
    expect(appCallOutcome(200, answer(JSON.stringify({ successful: false, error: "Connected account is not active" })), "application/json")).toEqual({ ok: false, error: "sign-in" });
    expect(appCallOutcome(200, answer(JSON.stringify({ data: { results: [{ response: { successful: false, error: "403 Forbidden: insufficient scope" } }] } })), "application/json")).toEqual({ ok: false, error: "refused" });
    expect(appCallOutcome(200, answer(JSON.stringify({ successful: false, error: "Message not found" })), "application/json")).toEqual({ ok: true });
    const sse = `event: message\ndata: ${new TextDecoder().decode(answer("Token has expired, reconnect", true))}\n\n`;
    expect(appCallOutcome(200, new TextEncoder().encode(sse), "text/event-stream")).toEqual({ ok: false, error: "sign-in" });
    expect(appCallOutcome(502, new Uint8Array(), "application/json")).toEqual({ ok: false, error: "cant-connect" });
    expect(appCallOutcome(403, new Uint8Array(), "application/json")).toBeNull();
  });
  it("reads Test's answer", () => {
    expect([
      probeOutcome({ ok: true, tools: [] }), probeOutcome({ ok: false, error: "x", auth: "required" }), probeOutcome({ ok: false, error: "x", reason: "keys" }),
      probeOutcome({ ok: false, error: "x", reason: "unreachable" }), probeOutcome({ ok: false, error: "x" }),
    ]).toEqual([{ ok: true }, { ok: false, error: "sign-in" }, { ok: false, error: "refused" }, { ok: false, error: "cant-connect" }, { ok: false, error: "bad-answer" }]);
  });
});

describe("the background check", () => {
  const setup = (overrides: { due?: string[]; asleep?: () => boolean; wokeAt?: () => number | null; check?: () => Promise<string | null> } = {}) => {
    let at = 0;
    const checked: string[] = [], recorded: Array<[string, string]> = [], timers: number[] = [];
    let pending: (() => void) | null = null;
    const check = createBackgroundCheck<string, string>({
      due: () => overrides.due ?? ["tracker", "notion"],
      check: async (ref) => { checked.push(ref); return overrides.check ? overrides.check() : "ok"; },
      record: (ref, outcome) => recorded.push([ref, outcome]),
      asleep: overrides.asleep ?? (() => false),
      wokeAt: overrides.wokeAt ?? (() => null),
      now: () => at,
      random: () => 1,
      setTimer: (run, ms) => { timers.push(ms); pending = run; return { cancel: () => { pending = null; } }; },
    });
    return { check, checked, recorded, timers, advance: (ms: number) => { at += ms; }, fire: () => pending?.() };
  };

  it("waits at least a quarter hour after start, jittered, and checks one connection a time", async () => {
    const run = setup();
    run.check.start();
    expect(run.timers[0]).toBe(FIRST_CHECK_MS + CHECK_EVERY_MS * (1 + CHECK_JITTER));
    for (const random of [0, 0.5, 1]) {
      const wait = jitteredWait(CHECK_EVERY_MS, () => random);
      expect(wait).toBeGreaterThanOrEqual(CHECK_EVERY_MS * (1 - CHECK_JITTER));
      expect(wait).toBeLessThanOrEqual(CHECK_EVERY_MS * (1 + CHECK_JITTER));
    }
    await run.check.tick();
    expect([run.checked, run.recorded]).toEqual([["tracker"], [["tracker", "ok"]]]);
    run.check.stop();
  });

  it("never checks while asleep, nor with nothing due, and drops a check the machine slept through", async () => {
    const asleep = setup({ asleep: () => true });
    expect(await asleep.check.tick()).toBeNull();
    expect(asleep.checked).toEqual([]);
    const nothing = setup({ due: [] });
    expect(await nothing.check.tick()).toBeNull();
    let woke: number | null = null;
    const slept = setup({ wokeAt: () => woke, check: async () => { woke = 0; return "unreachable"; } });
    expect(await slept.check.tick()).toBeNull();
    expect([slept.checked, slept.recorded]).toEqual([["tracker"], []]);
  });

  it("starts no second check while one runs", async () => {
    let release!: () => void;
    const run = setup({ check: () => new Promise((resolve) => { release = () => resolve("ok"); }) });
    const first = run.check.tick();
    expect(await run.check.tick()).toBeNull();
    release();
    expect(await first).toBe("tracker");
    expect(run.checked).toEqual(["tracker"]);
  });
});
