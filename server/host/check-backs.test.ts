import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CHECK_BACK_LIMITS, type CheckBackLine } from "../../shared/check-back.ts";
import { BUSY_RETRY_MS, CHECK_BACK_FILE, START_RETRY_MS, START_TRIES, checkBackPrompt, createCheckBacks, type CheckBackDeps, type NewCheckBack } from "./check-backs.ts";

const T0 = Date.UTC(2026, 10, 19, 14, 0);
const MIN = 60_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(over: Partial<CheckBackDeps> = {}, dir = mkdtempSync(join(tmpdir(), "omb-check-backs-"))) {
  if (!dirs.includes(dir)) dirs.push(dir);
  const h = {
    dir,
    clock: T0,
    alive: new Set(["scout:t1", "scout:t2", "ada:t9"]),
    busy: new Set<string>(),
    lines: new Map<string, CheckBackLine>(),
    started: [] as Array<{ id: string; threadId: string; prompt: string; origin: unknown }>,
    refuseStart: null as string | null,
  };
  let lineId = 0;
  const manager = createCheckBacks({
    dataDir: dir,
    now: () => h.clock,
    alive: (botId, threadId) => h.alive.has(`${botId}:${threadId}`),
    busy: (botId, threadId) => h.busy.has(`${botId}:${threadId}`),
    line: (_record, line, messageId) => { const id = messageId ?? `m${++lineId}`; h.lines.set(id, line); return id; },
    start: async (record, prompt) => {
      if (h.refuseStart) throw new Error(h.refuseStart);
      h.started.push({ id: record.id, threadId: record.threadId, prompt, origin: record.origin });
    },
    log: () => {},
    ...over,
  });
  return { h, manager };
}

/** A due check-back as a server finds it on disk after `tries` refused starts, so a test near the limit does not spend them one save at a time. */
function storedWithTries(tries: number, over: Partial<CheckBackDeps> = {}) {
  const first = harness();
  first.manager.create(asked());
  const file = join(first.h.dir, CHECK_BACK_FILE);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  saved.checkBacks[0].tries = tries;
  writeFileSync(file, JSON.stringify(saved));
  const again = harness(over, first.h.dir);
  again.h.clock = T0 + 5 * MIN;
  return again;
}

const asked = (over: Partial<NewCheckBack> = {}): NewCheckBack => ({
  botId: "scout", threadId: "t1", note: "see if CI passed", dueAt: T0 + 5 * MIN, zone: "Europe/Berlin",
  origin: { kind: "user", request: "fix the build and tell me when CI is green", person: "p_aaaaaaaaaaaaaaaaaaaaaa" }, ...over,
});

describe("check-backs", () => {
  it("fires once at its time in the same conversation, with nobody asked, and keeps the asker's origin", async () => {
    const { h, manager } = harness();
    const made = manager.create(asked());
    expect(made.ok).toBe(true);
    const [lineId] = [...h.lines.keys()];
    expect(h.lines.get(lineId!)).toMatchObject({ status: "pending", dueAt: T0 + 5 * MIN, note: "see if CI passed" });
    await manager.tick();
    expect(h.started).toEqual([]);
    h.clock = T0 + 5 * MIN;
    await manager.tick();
    await manager.tick();
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toMatchObject({ threadId: "t1", origin: { kind: "user", person: "p_aaaaaaaaaaaaaaaaaaaaaa" } });
    expect(h.started[0]!.prompt).toContain("What to check: see if CI passed");
    expect(h.started[0]!.prompt).not.toContain("runs now, once, late");
    expect(h.lines.get(lineId!)).toMatchObject({ status: "started", startedAt: T0 + 5 * MIN });
    expect(manager.list("scout", "t1")).toEqual([]);
  });

  it("never lends a computer on a later turn", () => {
    const { manager } = harness();
    const made = manager.create(asked({ origin: { kind: "user", request: "x", lends: true } }));
    expect(made.ok && made.record.origin).toEqual({ kind: "user", request: "x" });
  });

  it("carries the condition into the turn", async () => {
    const { h, manager } = harness();
    manager.create(asked({ note: "chase the client", condition: "they have not replied" }));
    h.clock += 5 * MIN;
    await manager.tick();
    expect(h.started[0]!.prompt).toContain("Only if this holds: they have not replied.");
  });

  it("refuses times under a minute or past 90 days, and over the limits", () => {
    const { manager } = harness();
    expect(manager.create(asked({ dueAt: T0 + 30_000 }))).toMatchObject({ ok: false, error: expect.stringContaining("less than a minute") });
    expect(manager.create(asked({ dueAt: T0 + CHECK_BACK_LIMITS.maxMs + MIN }))).toMatchObject({ ok: false, error: expect.stringContaining("90 days") });
    expect(manager.create(asked({ dueAt: T0 + CHECK_BACK_LIMITS.maxMs })).ok).toBe(true);
    for (let i = 1; i < CHECK_BACK_LIMITS.perConversation; i++) expect(manager.create(asked()).ok).toBe(true);
    expect(manager.create(asked())).toMatchObject({ ok: false, error: expect.stringContaining("already has 10") });
    expect(manager.create(asked({ threadId: "t2" })).ok).toBe(true);
  });

  it("holds a bot to its limit across conversations", () => {
    const { h, manager } = harness();
    for (let i = 0; i < CHECK_BACK_LIMITS.perBot; i++) {
      h.alive.add(`scout:c${i}`);
      expect(manager.create(asked({ threadId: `c${i}` })).ok).toBe(true);
    }
    h.alive.add("scout:c-more");
    expect(manager.create(asked({ threadId: "c-more" }))).toMatchObject({ ok: false, error: expect.stringContaining("50") });
    expect(manager.create(asked({ botId: "ada", threadId: "t9" })).ok).toBe(true);
  });

  it("survives a restart and catches up once, late, after the computer slept", async () => {
    const first = harness();
    first.manager.create(asked());
    first.manager.create(asked({ dueAt: T0 + 60 * MIN, note: "second" }));
    expect(JSON.parse(readFileSync(join(first.h.dir, CHECK_BACK_FILE), "utf8")).checkBacks).toHaveLength(2);
    const again = harness({}, first.h.dir);
    again.h.clock = T0 + 3 * 24 * 60 * MIN;
    await again.manager.tick();
    expect(again.h.started.map((one) => one.prompt.includes("runs now, once, late"))).toEqual([true, true]);
    expect(again.h.started).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(first.h.dir, CHECK_BACK_FILE), "utf8")).checkBacks).toEqual([]);
  });

  it("does not start again one that was mid-start when the server stopped", async () => {
    const first = harness();
    first.manager.create(asked());
    const file = join(first.h.dir, CHECK_BACK_FILE);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.checkBacks[0].startingAt = T0 + 5 * MIN;
    writeFileSync(file, JSON.stringify(saved));
    const again = harness({}, first.h.dir);
    again.h.clock = T0 + 10 * MIN;
    again.manager.start();
    again.manager.stop();
    await again.manager.tick();
    expect(again.h.started).toEqual([]);
    expect([...again.h.lines.values()][0]).toMatchObject({ status: "failed" });
  });

  it("cancels: the line says so and nothing runs", async () => {
    const { h, manager } = harness();
    const made = manager.create(asked());
    if (!made.ok) throw new Error(made.error);
    expect(manager.cancel(made.record.id)).not.toBeNull();
    expect([...h.lines.values()][0]).toMatchObject({ status: "cancelled" });
    h.clock += 10 * MIN;
    await manager.tick();
    expect(h.started).toEqual([]);
    expect(manager.cancel(made.record.id)).toBeNull();
  });

  it("drops one whose conversation or bot is gone, or whose person left", async () => {
    const { h, manager } = harness();
    manager.create(asked());
    manager.create(asked({ botId: "ada", threadId: "t9" }));
    h.alive.delete("scout:t1");
    h.alive.delete("ada:t9");
    h.clock += 10 * MIN;
    await manager.tick();
    expect(h.started).toEqual([]);
    expect(JSON.parse(readFileSync(join(h.dir, CHECK_BACK_FILE), "utf8")).checkBacks).toEqual([]);
    expect(manager.nextDueAt()).toBeNull();
  });

  it("waits for a busy conversation, then starts", async () => {
    const { h, manager } = harness();
    manager.create(asked());
    h.busy.add("scout:t1");
    h.clock += 5 * MIN;
    await manager.tick();
    expect(h.started).toEqual([]);
    h.busy.clear();
    await manager.tick();
    expect(h.started).toEqual([]);
    h.clock += BUSY_RETRY_MS;
    await manager.tick();
    expect(h.started).toHaveLength(1);
  });

  it("tries a refused start again, and gives up with a line after many", async () => {
    const { h, manager } = harness();
    manager.create(asked());
    h.refuseStart = "This bot is paused.";
    h.clock += 5 * MIN;
    await manager.tick();
    expect([...h.lines.values()][0]).toMatchObject({ status: "pending" });
    h.refuseStart = null;
    h.clock += START_RETRY_MS;
    await manager.tick();
    expect(h.started).toHaveLength(1);

    // The count of refusals is stored, so a restart two short of giving up needs two more, not all of them.
    const stored = storedWithTries(START_TRIES - 2);
    stored.h.refuseStart = "This bot is paused.";
    stored.h.clock += START_RETRY_MS;
    await stored.manager.tick();
    expect(stored.manager.nextDueAt()).not.toBeNull();
    expect([...stored.h.lines.values()]).toEqual([]);
    stored.h.clock += START_RETRY_MS;
    await stored.manager.tick();
    expect([...stored.h.lines.values()].at(-1)).toMatchObject({ status: "failed", why: "This bot is paused." });
    expect(stored.manager.nextDueAt()).toBeNull();
  });

  it("waits out a paused bot without using up its tries", async () => {
    let refusal: Error = Object.assign(new Error("Scout is paused."), { code: "bot_paused" });
    // One refusal short of giving up: a pause that counted as a try would end it at the first tick.
    const held = storedWithTries(START_TRIES - 1, { paused: (error) => (error as { code?: string }).code === "bot_paused", start: async () => { throw refusal; } });
    for (let i = 0; i < 5; i++) {
      held.h.clock += START_RETRY_MS;
      await held.manager.tick();
    }
    expect(held.manager.nextDueAt()).not.toBeNull();
    expect([...held.h.lines.values()]).toEqual([]);
    // The count stood one short all along: the next refusal that is no pause is the last.
    refusal = new Error("Under maintenance.");
    held.h.clock += START_RETRY_MS;
    await held.manager.tick();
    expect([...held.h.lines.values()].at(-1)).toMatchObject({ status: "failed", why: "Under maintenance." });
  });

  it("names the soonest one to wake a sleeping Cloud", () => {
    const { manager } = harness();
    expect(manager.nextDueAt()).toBeNull();
    manager.create(asked({ dueAt: T0 + 90 * MIN }));
    manager.create(asked({ dueAt: T0 + 7 * MIN }));
    expect(manager.nextDueAt()).toBe(T0 + 7 * MIN);
  });

  it("writes the prompt in plain words with the zone", () => {
    const prompt = checkBackPrompt({ ...asked(), id: "c1", createdAt: T0, zone: "Europe/Berlin" }, T0 + 5 * MIN);
    expect(prompt).toContain("(Thu 19 Nov 15:05, Europe/Berlin)");
  });
});
