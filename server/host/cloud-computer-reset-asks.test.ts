import { describe, expect, it, vi } from "vitest";

import { createCloudComputerResetAsks, RESET_CLOUD_COMPUTER_TOOL, RESET_RETRIES, RESET_RETRY_MS } from "./cloud-computer-reset-asks.ts";
import type { BotRecord } from "../store.ts";

type Line = { id: string; role: string; kind: string; card?: Record<string, any>; from?: unknown };

const bot = (id: string, name: string) => ({ id, name, color: "blue" }) as unknown as BotRecord;
const ada = bot("bot-a", "Ada"), chief = bot("chief", "Chief"), bea = bot("bot-b", "Bea");

function setup(options: { refusal?: (from: BotRecord, target: BotRecord) => string | null; reset?: () => Promise<any> } = {}) {
  const lines = new Map<string, Line[]>();
  const store = {
    bot: (id: string) => [ada, chief, bea].find((candidate) => candidate.id === id),
    groupByThread: () => undefined,
    messagesFor: (threadId: string) => lines.get(threadId) ?? [],
    appendMessage: (threadId: string, message: Omit<Line, "id">) => {
      const line = { ...message, id: `m${(lines.get(threadId)?.length ?? 0) + 1}` };
      lines.set(threadId, [...(lines.get(threadId) ?? []), line]);
      return line;
    },
    patchMessage: (threadId: string, id: string, patch: Partial<Line>) => {
      const line = lines.get(threadId)?.find((candidate) => candidate.id === id);
      if (line) Object.assign(line, patch);
      return Boolean(line);
    },
  };
  const timers: Array<() => void> = [];
  const reset = vi.fn(options.reset ?? (async () => ({ ok: true })));
  const asks = createCloudComputerResetAsks({
    store: store as never,
    refusal: options.refusal ?? (() => null),
    reset,
    setTimer: (run, ms) => { expect(ms).toBe(RESET_RETRY_MS); timers.push(run); },
    openCards: () => [...lines.entries()].flatMap(([threadId, list]) => list.filter((line) => line.card?.tool === RESET_CLOUD_COMPUTER_TOOL).map((line) => ({ threadId, messageId: line.id }))),
  });
  const call = async (sender: BotRecord, body: Record<string, unknown>) => {
    const res = { status: 0, body: {} as Record<string, any> };
    await asks.internal({
      method: "POST", path: "/api/internal/cloud-computer/reset", res: {} as never, sender, threadId: "t1", readBody: async () => body,
      json: ((_res: unknown, status: number, sent: Record<string, unknown>) => { res.status = status; res.body = sent; }) as never,
    });
    return res;
  };
  const card = () => lines.get("t1")?.at(-1)?.card;
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { asks, call, card, reset, timers, flush, lines };
}

describe("a bot asking for its cloud computer to be reset", () => {
  it("shows the person a card and tells the bot to end its turn, resetting nothing yet", async () => {
    const { call, card, reset } = setup();
    const res = await call(ada, { why: "It has been starting for 20 minutes." });
    expect(res.status).toBe(200);
    expect(res.body.text).toContain("End this turn");
    expect(card()).toMatchObject({ title: "Reset Ada's cloud desktop?", options: ["Allow", "Deny"], requestType: "permission", tool: RESET_CLOUD_COMPUTER_TOOL });
    expect(card()?.subtitle).toContain("It has been starting for 20 minutes.");
    expect(card()?.subtitle).toContain("files and browser sign-ins");
    expect(reset).not.toHaveBeenCalled();
  });

  it("does nothing on Deny", async () => {
    const { asks, call, card, reset, flush } = setup();
    await call(ada, {});
    expect(asks.answer(card()!.requestId, "deny")).toBe(true);
    await flush();
    expect(reset).not.toHaveBeenCalled();
    expect(card()?.answered).toBe("deny");
  });

  it("resets on Allow and says so on the card", async () => {
    const { asks, call, card, reset, flush } = setup();
    await call(ada, {});
    expect(asks.answer(card()!.requestId, "allow")).toBe(true);
    await flush();
    expect(reset).toHaveBeenCalledWith("bot-a");
    expect(card()).toMatchObject({ answered: "allow" });
    expect(card()?.subtitle).toContain("Reset: a fresh cloud desktop starts with Ada's next message.");
  });

  it("waits for the asking turn to end: a computer in use is retried, then reset", async () => {
    let busy = true;
    const { asks, call, card, reset, timers, flush } = setup({
      reset: async () => {
        if (busy) throw Object.assign(new Error("this cloud computer is in use — stop its bot's work first"), { status: 409 });
        return { ok: true };
      },
    });
    await call(ada, {});
    asks.answer(card()!.requestId, "allow");
    await flush();
    expect(card()?.subtitle).toContain("Waiting for Ada to finish its work");
    expect(timers).toHaveLength(1);
    busy = false;
    timers.shift()!();
    await flush();
    expect(reset).toHaveBeenCalledTimes(2);
    expect(card()?.subtitle).toContain("Reset: a fresh cloud desktop");
  });

  it("gives up on a computer that stays in use, and resets nothing", async () => {
    const { asks, call, card, timers, flush } = setup({
      reset: async () => { throw Object.assign(new Error("this cloud computer is in use — stop its bot's work first"), { status: 409 }); },
    });
    await call(ada, {});
    asks.answer(card()!.requestId, "allow");
    await flush();
    for (let i = 0; i < RESET_RETRIES; i += 1) { timers.shift()!(); await flush(); }
    expect(timers).toHaveLength(0);
    expect(card()?.subtitle).toContain("Not reset: this cloud computer is in use");
  });

  it("reports any other failure without retrying", async () => {
    const { asks, call, card, timers, flush } = setup({ reset: async () => { throw Object.assign(new Error("Could not reach boat.dev"), { status: 503 }); } });
    await call(ada, {});
    asks.answer(card()!.requestId, "allow");
    await flush();
    expect(timers).toHaveLength(0);
    expect(card()?.subtitle).toContain("Not reset: Could not reach boat.dev");
  });

  it("lets a Chief ask for a bot it manages and refuses what the rule refuses", async () => {
    const refusal = (from: BotRecord, target: BotRecord) => from.id === target.id || (from.id === "chief" && target.id === "bot-a") ? null : "not yours";
    const { asks, call, card, reset, flush } = setup({ refusal });
    expect(await call(ada, { targetBotId: "bot-b" })).toMatchObject({ status: 403, body: { error: "not yours" } });
    expect(card()).toBeUndefined();
    const asked = await call(chief, { targetBotId: "bot-a" });
    expect(asked.status).toBe(200);
    expect(asked.body.text).toContain("reset Ada's cloud computer");
    asks.answer(card()!.requestId, "allow");
    await flush();
    expect(reset).toHaveBeenCalledWith("bot-a");
    expect((await call(chief, { targetBotId: "nobody" })).status).toBe(404);
  });

  it("keeps one open card per computer", async () => {
    const { call } = setup();
    await call(ada, {});
    expect((await call(ada, {})).status).toBe(409);
  });

  it("is not one of its cards for an unknown request", () => {
    expect(setup().asks.answer("other", "allow")).toBe(false);
  });

  it("closes a card left open by a previous run", async () => {
    const first = setup();
    await first.call(ada, {});
    const fresh = createCloudComputerResetAsks({
      store: { messagesFor: (id: string) => first.lines.get(id) ?? [], patchMessage: (threadId: string, id: string, patch: Partial<Line>) => Object.assign(first.lines.get(threadId)!.find((line) => line.id === id)!, patch) } as never,
      refusal: () => null, reset: vi.fn(),
      openCards: () => [{ threadId: "t1", messageId: "m1" }],
    });
    expect(fresh.dismissStale()).toBe(1);
    expect(first.card()).toMatchObject({ expired: true, options: [] });
    expect(fresh.answer(first.card()!.requestId, "allow")).toBe(false);
  });
});
