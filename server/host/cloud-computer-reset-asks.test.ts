import { describe, expect, it, vi } from "vitest";

import { createCloudComputerResetAsks, noOwnCloudComputer, RESET_RETRIES, RESET_RETRY_MS } from "./cloud-computer-reset-asks.ts";
import type { BotRecord } from "../store.ts";

type Line = { id: string; role: string; kind: string; text?: string; from?: unknown };

const bot = (id: string, name: string) => ({ id, name, color: "blue" }) as unknown as BotRecord;
const ada = bot("bot-a", "Ada"), chief = bot("chief", "Chief"), bea = bot("bot-b", "Bea");
const IN_USE = () => Object.assign(new Error("this cloud computer is in use — stop its bot's work first"), { status: 409 });

function setup(options: { refusal?: (from: BotRecord, target: BotRecord) => string | null; reset?: () => Promise<any>; computer?: () => Promise<string | null> } = {}) {
  const lines = new Map<string, Line[]>();
  const roster = [ada, chief, bea];
  const store = {
    bot: (id: string) => roster.find((candidate) => candidate.id === id),
    groupByThread: () => undefined,
    appendMessage: (threadId: string, message: Omit<Line, "id">) => {
      const line = { ...message, id: `m${(lines.get(threadId)?.length ?? 0) + 1}` };
      lines.set(threadId, [...(lines.get(threadId) ?? []), line]);
      return line;
    },
    patchMessage: (threadId: string, id: string, patch: Partial<Line>) => {
      const line = lines.get(threadId)?.find((candidate) => candidate.id === id);
      if (line) Object.assign(line, patch);
      return line ?? null;
    },
  };
  const timers: Array<() => void> = [];
  const reset = vi.fn(options.reset ?? (async () => ({ ok: true })));
  const computer = vi.fn(options.computer ?? (async () => "bx_1"));
  const resets = createCloudComputerResetAsks({
    store: store as never,
    refusal: options.refusal ?? (() => null),
    computer,
    reset,
    setTimer: (run, ms) => { expect(ms).toBe(RESET_RETRY_MS); timers.push(run); },
  });
  const call = async (sender: BotRecord, body: Record<string, unknown>) => {
    const res = { status: 0, body: {} as Record<string, any> };
    await resets.internal({
      method: "POST", path: "/api/internal/cloud-computer/reset", res: {} as never, sender, threadId: "t1", readBody: async () => ({ why: "Stuck starting.", ...body }),
      json: ((_res: unknown, status: number, sent: Record<string, unknown>) => { res.status = status; res.body = sent; }) as never,
    });
    return res;
  };
  const line = () => lines.get("t1")?.at(-1);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { call, line, reset, computer, timers, flush, lines, roster };
}

describe("a bot resetting its stuck cloud computer", () => {
  it("says so in one plain line, starts the reset at once with no card, and tells the bot to end its turn", async () => {
    const { call, line, reset, flush } = setup();
    const res = await call(ada, { why: "It has been starting for 20 minutes." });
    expect(res.status).toBe(200);
    expect(res.body.text).toContain("End this turn");
    expect(line()).toMatchObject({ role: "bot", kind: "text" });
    expect(line()).not.toHaveProperty("card");
    expect(line()?.text).toMatch(/^Resetting Ada's cloud desktop: It has been starting for 20 minutes\./);
    await flush();
    expect(reset).toHaveBeenCalledWith("bot-a", "bx_1");
    expect(line()?.text).toContain("Reset: a fresh cloud desktop starts with Ada's next message.");
  });

  it("says when the old cloud desktop is still being deleted, or there was none", async () => {
    const pending = setup({ reset: async () => ({ ok: true, pending: true }) });
    await pending.call(ada, {});
    await pending.flush();
    expect(pending.line()?.text).toContain("still being deleted");
    const missing = setup({ reset: async () => ({ ok: true, missing: true }) });
    await missing.call(ada, {});
    await missing.flush();
    expect(missing.line()?.text).toContain("Nothing to reset");
  });

  it("waits for the calling turn to end: a computer in use is retried, then reset", async () => {
    let busy = true;
    const { call, line, reset, timers, flush } = setup({ reset: async () => { if (busy) throw IN_USE(); return { ok: true }; } });
    await call(ada, {});
    await flush();
    expect(line()?.text).toContain("Waiting for Ada to finish its work");
    expect(timers).toHaveLength(1);
    busy = false;
    timers.shift()!();
    await flush();
    expect(reset).toHaveBeenCalledTimes(2);
    expect(line()?.text).toContain("Reset: a fresh cloud desktop");
    expect(line()?.text).toMatch(/^Resetting Ada's cloud desktop: Stuck starting\.\n/);
  });

  it("gives up on a computer that stays in use, and resets nothing", async () => {
    const { call, line, timers, flush } = setup({ reset: async () => { throw IN_USE(); } });
    await call(ada, {});
    await flush();
    for (let i = 0; i < RESET_RETRIES; i += 1) { timers.shift()!(); await flush(); }
    expect(timers).toHaveLength(0);
    expect(line()?.text).toContain("Not reset: this cloud computer is in use");
  });

  it("reports any other failure without retrying", async () => {
    const { call, line, timers, flush } = setup({ reset: async () => { throw Object.assign(new Error("Could not reach boat.dev"), { status: 503 }); } });
    await call(ada, {});
    await flush();
    expect(timers).toHaveLength(0);
    expect(line()?.text).toContain("Not reset: Could not reach boat.dev");
  });

  it("lets a Chief reset a bot it manages and refuses what the rule refuses", async () => {
    const refusal = (from: BotRecord, target: BotRecord) => from.id === target.id || (from.id === "chief" && target.id === "bot-a") ? null : "not yours";
    const { call, line, reset, flush } = setup({ refusal });
    expect(await call(ada, { targetBotId: "bot-b" })).toMatchObject({ status: 403, body: { error: "not yours" } });
    expect(line()).toBeUndefined();
    expect(reset).not.toHaveBeenCalled();
    const asked = await call(chief, { targetBotId: "bot-a" });
    expect(asked.status).toBe(200);
    expect(asked.body.text).toContain("Ada's cloud computer is being reset");
    await flush();
    expect(reset).toHaveBeenCalledWith("bot-a", "bx_1");
    expect((await call(chief, { targetBotId: "nobody" })).status).toBe(404);
  });

  it("checks again on every retry whether the bot may still reset, and resets nothing once it may not", async () => {
    let allowed = true, busy = true;
    const { call, line, reset, timers, flush } = setup({
      refusal: () => allowed ? null : "not yours",
      reset: async () => { if (busy) throw IN_USE(); return { ok: true }; },
    });
    await call(chief, { targetBotId: "bot-a" });
    await flush();
    expect(reset).toHaveBeenCalledTimes(1);
    allowed = false;
    busy = false;
    timers.shift()!();
    await flush();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(0);
    expect(line()?.text).toContain("Not reset: not yours");
  });

  it("says nothing was reset when a bot is deleted while the reset waits", async () => {
    const { call, line, reset, timers, flush, roster } = setup({ reset: async () => { throw IN_USE(); } });
    await call(ada, {});
    await flush();
    roster.splice(roster.indexOf(ada), 1);
    timers.shift()!();
    await flush();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(line()?.text).toContain("Not reset: Ada or the bot that asked no longer exists.");
  });

  it("counts a bot on Auto as having a cloud computer of its own, unless it uses its department's", () => {
    const named = (computer: BotRecord["computer"], cloudBackend?: BotRecord["cloudBackend"]) => ({ name: "Ada", computer, cloudBackend }) as Pick<BotRecord, "name" | "computer" | "cloudBackend">;
    const none = "Ada has no cloud computer of its own to reset here.";
    expect(noOwnCloudComputer(named(undefined), true, false)).toBeNull();
    expect(noOwnCloudComputer(named("cloud"), true, false)).toBeNull();
    expect(noOwnCloudComputer(named(undefined), true, true)).toBe(none);
    expect(noOwnCloudComputer(named(undefined), false, false)).toBe(none);
    expect(noOwnCloudComputer(named("cloud", "vps"), true, false)).toBe(none);
    expect(noOwnCloudComputer(named("local"), true, false)).toBe(none);
  });

  it("needs a reason, and posts nothing without one", async () => {
    const { call, line, computer, reset } = setup();
    for (const why of [undefined, "", "   "]) {
      expect(await call(ada, { why })).toMatchObject({ status: 400 });
    }
    expect(line()).toBeUndefined();
    expect(computer).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("resets the computer there was when called, or none", async () => {
    const { call, reset, flush } = setup({ computer: async () => null });
    await call(ada, {});
    await flush();
    expect(reset).toHaveBeenCalledWith("bot-a", null);
  });

  it("posts nothing and resets nothing when it cannot tell which computer runs now", async () => {
    const { call, line, reset } = setup({ computer: async () => { throw new Error("Could not reach boat.dev"); } });
    expect(await call(ada, {})).toMatchObject({ status: 503 });
    expect(line()).toBeUndefined();
    expect(reset).not.toHaveBeenCalled();
  });

  it("does not retry when a different computer runs by the time it resets", async () => {
    const { call, line, timers, flush } = setup({
      reset: async () => { throw Object.assign(new Error("a different cloud desktop runs now than when this was asked, so nothing was reset"), { status: 409 }); },
    });
    await call(ada, {});
    await flush();
    expect(timers).toHaveLength(0);
    expect(line()?.text).toContain("nothing was reset");
  });

  it("keeps one reset in flight per computer, and takes another once it is done", async () => {
    const { call, timers, flush, lines } = setup({ reset: async () => { throw IN_USE(); } });
    await call(ada, {});
    await flush();
    expect((await call(ada, {})).status).toBe(409);
    expect((await call(bea, {})).status).toBe(200);
    expect(lines.get("t1")).toHaveLength(2);
    for (let i = 0; i < RESET_RETRIES; i += 1) { for (const run of timers.splice(0)) run(); await flush(); }
    expect((await call(ada, {})).status).toBe(200);
  });
});
