import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createComputerAsksHost } from "./computer-asks-host.ts";
import type { Message } from "../store.ts";

const turn = { botId: "scout", threadId: "t1", generation: "g1" };

function fixture({ computer = "on" as string, refusal = null as string | null, active = true, room = null as { id: string; name: string; memberIds: string[] } | null } = {}) {
  const lines: Message[] = [{ id: "u1", at: 1, role: "user", kind: "text", text: "Open the invoice in Excel on my PC." } as Message];
  const store = {
    appendMessage: (_threadId: string, message: Partial<Message>) => { const added = { id: `m${lines.length + 1}`, at: Date.now(), ...message } as Message; lines.push(added); return added; },
    patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => Object.assign(lines.find((line) => line.id === id) ?? {}, patch),
    messagesFor: () => lines,
    activePath: () => lines,
    taskByThread: () => room ? undefined : { id: "scout", threadId: "t1" },
    projectBotForTask: () => room ? null : { id: "scout", name: "Scout", color: "blue", computer, busy: true, activity: "working" },
    bot: (id: string) => id === "scout" ? { id: "scout", name: "Scout", color: "blue", computer } : undefined,
    setTaskActivity: () => {},
    groupByThread: () => room,
  };
  const lending = { lendingNow: vi.fn(() => [] as Array<{ id: string; name: string; computer: boolean; terminal: boolean }>), known: () => [{ platform: "win32" as const }], changed: () => {}, askTool: null as string | null };
  const continued: unknown[] = [];
  const state = { busy: false };
  const host = createComputerAsksHost({
    store: store as never, notify: () => {}, lending: lending as never, principal: "cloud-home",
    threadBusy: () => state.busy, queued: () => false,
    continueRequest: async (...args) => { continued.push(args); },
    refusal: () => refusal, request: () => ({ messageId: "u1", generations: new Set(["g1"]) }), active: () => active,
  });
  return { host, lines, lending, continued, state };
}

describe("ask_for_computer on the person's own Cloud", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("refuses an ended turn, a need it doesn't know, a bot with no computer, and a conversation that can't use the computer", async () => {
    expect(await fixture({ active: false }).host.call(turn, { need: "screen" })).toMatchObject({ status: 401 });
    expect(await fixture().host.call(turn, { need: "printer" })).toMatchObject({ status: 400 });
    expect(await fixture({ computer: "off" }).host.call(turn, { need: "screen" })).toMatchObject({ status: 403, body: { error: expect.stringContaining("This bot has no computer") } });
    const files = fixture({ computer: "off" });
    files.lending.lendingNow.mockReturnValue([{ id: "pc-1", name: "PC", computer: false, terminal: false }]);
    expect(await files.host.call(turn, { need: "folders" }), "files need no computer setting").toMatchObject({ status: 200, body: { state: "ready" } });
    expect(await fixture({ refusal: "Someone else wrote in this conversation, so it can't use your PC." }).host.call(turn, { need: "screen" }))
      .toEqual({ status: 403, body: { error: "Someone else wrote in this conversation, so it can't use your PC." } });
  });

  it("raises the card for a bot in a room, whose turn runs on the room's thread, and refuses a bot that isn't in it", async () => {
    const room = { id: "brand", name: "Brand", memberIds: ["scout", "writer"] };
    const f = fixture({ room });
    f.lending.lendingNow.mockReturnValue([{ id: "mac-1", name: "Mac", computer: false, terminal: true }]);
    expect(await f.host.call(turn, { need: "terminal", why: "Run the scan" })).toEqual({ status: 200, body: { state: "ready", text: expect.stringContaining("computer_id mac-1") } });
    expect(await fixture({ room: { ...room, memberIds: ["writer"] } }).host.call(turn, { need: "terminal" })).toMatchObject({ status: 404 });
  });

  it("tells the shared computer texts to point at the ask, and answers ready at once when the computer lends what's needed", async () => {
    const f = fixture();
    expect(f.lending.askTool).toBe("ask_for_computer");
    f.lending.lendingNow.mockReturnValue([{ id: "pc-1", name: "PC", computer: true, terminal: false }]);
    expect(await f.host.call(turn, { need: "screen", why: "Open Excel" })).toEqual({ status: 200, body: { state: "ready", text: expect.stringContaining("computer_id pc-1") } });
  });

  it("carries the request on once the computer is on, only when the conversation is free and nobody wrote since", async () => {
    const f = fixture();
    const call = f.host.call(turn, { need: "screen", why: "Open Excel" });
    await vi.advanceTimersByTimeAsync(40_000);
    expect((await call).body).toMatchObject({ state: "waiting" });
    expect(f.lines.find((line) => line.card?.computerAsk)?.card?.computerAsk, "the app isn't open there: the card says to open it").toMatchObject({ reason: "closed" });
    f.state.busy = true;
    f.lending.lendingNow.mockReturnValue([{ id: "pc-1", name: "PC", computer: true, terminal: false }]);
    f.host.asks.lendingChanged();
    expect(f.continued).toEqual([]);
    f.state.busy = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.continued).toEqual([["scout", expect.stringContaining("Carry on with their request"), { threadId: "t1", cardContinuation: true, requestMessageId: "u1" }]]);
  });

  it("leaves the request alone when the person wrote since", async () => {
    const f = fixture();
    const call = f.host.call(turn, { need: "screen" });
    await vi.advanceTimersByTimeAsync(40_000);
    await call;
    f.lines.push({ id: "u2", at: 2, role: "user", kind: "text", text: "Never mind, do it in the browser." } as Message);
    f.lending.lendingNow.mockReturnValue([{ id: "pc-1", name: "PC", computer: true, terminal: false }]);
    f.host.asks.lendingChanged();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.continued).toEqual([]);
  });
});
