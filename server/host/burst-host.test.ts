import { afterEach, describe, expect, it } from "vitest";

import type { BurstCardData } from "../../shared/burst.ts";
import type { Notification } from "../../shared/notification.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import type { ModelCatalog } from "../contracts.ts";
import { burstDefaultModel, burstProposalRefusal, createBurstHost, BURST_OUTSIDE_REFUSAL, BURST_ROOM_REFUSAL, type BurstHost, type BurstHostDeps } from "./burst-host.ts";

const hosts: BurstHost[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.close(); });

function host(over: Partial<BurstHostDeps> = {}) {
  const messages = new Map<string, Record<string, unknown>>();
  const routed: Notification[] = [];
  const announced: Notification[] = [];
  const bot = { id: "bot", name: "Researcher", color: "blue", notifications: true, modelSelection: { instanceId: "i", model: "big" } };
  const made = createBurstHost({
    dataDir: ":memory:", cloudHome: true, tier: () => "starter", maxParallel: () => undefined, hasRoom: () => true,
    store: {
      bot: () => bot, taskByThread: () => undefined,
      createTask: () => ({ threadId: `t-${messages.size}` }) as never,
      appendMessage: (_threadId: string, message: Record<string, unknown>) => { const id = `m-${messages.size}`; messages.set(id, message); return { id, ...message }; },
      patchMessage: (_threadId: string, id: string, patch: Record<string, unknown>) => { messages.set(id, { ...messages.get(id), ...patch }); return null; },
    } as unknown as BurstHostDeps["store"],
    language: () => "en", startTurn: async () => undefined, stop: () => {}, threadBusy: () => false, opened: () => {}, origin: () => ({ kind: "user", request: "x" }),
    approval: () => undefined, defaultModel: () => ({ instanceId: "i", model: "fast" }), modelName: (selection) => selection.model,
    route: (notification) => { routed.push(notification); return notification; }, announce: (notification) => { announced.push(notification); }, log: () => {},
    ...over,
  });
  hosts.push(made);
  return { made, messages, routed, announced };
}

const propose = (made: BurstHost, items: readonly string[]) => made.propose({ botId: "bot", threadId: "parent", task: "Research", instructions: "Do it.", items, model: { instanceId: "i", model: "fast" }, modelName: "fast" });

describe("burst host", () => {
  it("cuts the list to the Starter limit on the server and draws one card", () => {
    const { made, messages } = host();
    const card = propose(made, Array.from({ length: 20 }, (_, i) => `Item ${i}`)) as BurstCardData;
    expect(card).toMatchObject({ total: 10, requested: 20, parallel: 2, taskLimit: 10, smallPlan: true });
    expect([...messages.values()]).toHaveLength(1);
    expect(messages.get("m-0")).toMatchObject({ kind: "burst", role: "bot", burst: { total: 10 }, text: "Burst ready: 10 tasks. Press Run on its card to start." });
    made.cancel(card.burstId);
    expect([...messages.values()]).toHaveLength(1);
    expect(messages.get("m-0")).toMatchObject({ burst: { phase: "cancelled" }, text: "Burst cancelled." });
  });

  it("gives an open-source install its own number with no plan check", () => {
    const { made } = host({ cloudHome: false, tier: () => undefined, maxParallel: () => 7 });
    expect(propose(made, ["a", "b"])).toMatchObject({ parallel: 2, total: 2 });
    const big = propose(made, Array.from({ length: 30 }, (_, i) => `Item ${i}`)) as BurstCardData;
    expect(big).toMatchObject({ parallel: 7, total: 30, requested: 30 });
    expect(big.smallPlan).toBeUndefined();
  });

  it("puts the whole result in the Inbox line and a short one in the notification", async () => {
    const parts: Array<(text: string) => void> = [];
    let finishMerge = (_ok: string) => {};
    const { made, routed, announced } = host({
      startTurn: async (_bot, _text, opts) => {
        if (opts.cardContinuation) finishMerge = (text) => opts.onSettled({ ok: true, text });
        else parts.push((text) => opts.onSettled({ ok: true, text }));
      },
    });
    const card = propose(made, ["a", "b"]) as BurstCardData;
    made.run(card.burstId);
    parts[0]!("part one");
    parts[1]!("part two");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const merged = "x".repeat(3_000);
    finishMerge(merged);
    expect(routed[0]!.body).toHaveLength(2_000);
    expect(announced[0]!.body.length).toBeLessThanOrEqual(140);
  });
});

describe("burstDefaultModel", () => {
  const catalog: ModelCatalog = { default: "big", options: [{ id: "big", label: "Big" }, { id: "small-mini", label: "Small" }] };
  const own: ModelSelection = { instanceId: "i", model: "big" };

  it("takes the engine's fast model when there is one this bot may use", () => {
    expect(burstDefaultModel({ own, catalog: () => catalog, refused: () => new Set(), usable: () => true })).toEqual({ instanceId: "i", model: "small-mini" });
  });

  it("stays on the bot's own model otherwise", () => {
    expect(burstDefaultModel({ own, catalog: () => catalog, refused: () => new Set(["small-mini"]), usable: () => true })).toEqual(own);
    expect(burstDefaultModel({ own, catalog: () => catalog, refused: () => new Set(), usable: () => false })).toEqual(own);
    expect(burstDefaultModel({ own, catalog: () => undefined, refused: () => new Set(), usable: () => true })).toEqual(own);
  });
});

describe("who may open a burst", () => {
  it("is a person's own request in a bot's own chat", () => {
    expect(burstProposalRefusal({ owner: { group: undefined }, outside: false, self: undefined })).toBeNull();
    expect(burstProposalRefusal({ owner: null, outside: false, self: undefined })).toContain("does not belong");
    expect(burstProposalRefusal({ owner: { group: { id: "room" } }, outside: false, self: undefined })).toBe(BURST_ROOM_REFUSAL);
    expect(burstProposalRefusal({ owner: { group: undefined }, outside: true, self: undefined })).toBe(BURST_OUTSIDE_REFUSAL);
    expect(burstProposalRefusal({ owner: { group: undefined }, outside: false, self: "Only a person's own request" })).toBe("Only a person's own request");
  });
});
