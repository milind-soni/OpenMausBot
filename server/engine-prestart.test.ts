import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SendTurnInput } from "./contracts.ts";
import { PRESTART_IDLE_MS, PRESTART_MOST } from "./drivers/session-idle.ts";
import { createEnginePrestart, type EnginePrestartDeps, type SessionCredentials } from "./engine-prestart.ts";

const FIRST = "11111111-aaaa-4aaa-8aaa-111111111111";
const NEXT = "22222222-bbbb-4bbb-8bbb-222222222222";

/** What index.ts keeps for a conversation's bearer, as its sessionBearer writes it. */
const grantsOf = (threadId: string, kind: string, approval: unknown) => JSON.stringify({ botId: "bot", threadId, kind, createdBots: 0, openedThreads: 0, approval });

function host(overrides: Partial<EnginePrestartDeps> = {}) {
  const credentials: SessionCredentials = new Map([[FIRST, new Map([
    ["bot agents", { grants: grantsOf(FIRST, "agents", "full"), token: "a".repeat(48) }],
    ["bot data", { grants: grantsOf(FIRST, "data", "full"), token: "d".repeat(48) }],
  ])]]);
  const started: SendTurnInput[] = [], dropped: string[] = [];
  const held = new Set<string>();
  const state = { allowed: true, blank: true, busy: false, refused: false, shape: "sonnet/full" as string | null, up: true, folder: `/work/bot/${NEXT}` as string | null };
  const prestart = createEnginePrestart({
    adapter: (id) => (id === "claude" ? { prestart: {
      start: async (input) => { started.push(input); if (state.up) held.add(input.threadId); return state.up; },
      held: (threadId) => held.has(threadId), ready: (threadId) => held.has(threadId),
      drop: (threadId) => { dropped.push(threadId); held.delete(threadId); },
    } } : undefined),
    credentials,
    allowed: () => state.allowed, blank: () => state.blank, busy: () => state.busy, refused: () => state.refused,
    shape: () => state.shape, approval: () => "full", folder: () => state.folder,
    ...overrides,
  });
  return { prestart, credentials, started, dropped, held, state };
}

const firstTurn = (extra: Partial<SendTurnInput> = {}): SendTurnInput => ({
  threadId: FIRST, botId: "bot", text: "the first message", model: "claude-sonnet-5", approvalMode: "full", cwd: `/work/bot/${FIRST}`,
  resumeCursor: "session-1", systemStable: "You are Testy.", systemVolatile: "Busy: no", system: "You are Testy.\n\nBusy: no",
  integrations: {
    agents: { command: "node", args: ["agents.js"], env: { OMB_THREAD_ID: FIRST, OMB_COMMS_TOKEN: "a".repeat(48) } },
    data: { command: "node", args: ["proxy.js", "data"], env: { OMB_MCP_TOKEN_DATA: "d".repeat(48) } },
  },
  ...extra,
});

describe("starting a new conversation's engine from the bot's last launch", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts it as the last launch, for the new conversation's id, folder and bearers, with no message and no session to resume", () => {
    const { prestart, credentials, started } = host();
    const input = firstTurn();
    expect(prestart.note("claude", input, true)).toBe(input);
    prestart.threadMade("bot", NEXT);
    expect(started).toHaveLength(1);
    const launch = started[0]!;
    expect(launch).toMatchObject({ threadId: NEXT, botId: "bot", text: "", model: "claude-sonnet-5", approvalMode: "full", cwd: `/work/bot/${NEXT}`, systemStable: "You are Testy." });
    expect(launch.resumeCursor).toBeUndefined();
    const bearers = credentials.get(NEXT)!;
    expect(bearers.get("bot agents")!.grants).toBe(grantsOf(NEXT, "agents", "full"));
    expect(launch.integrations!.agents!.env).toEqual({ OMB_THREAD_ID: NEXT, OMB_COMMS_TOKEN: bearers.get("bot agents")!.token });
    expect(launch.integrations!.data!.env).toEqual({ OMB_MCP_TOKEN_DATA: bearers.get("bot data")!.token });
    expect(new Set([bearers.get("bot agents")!.token, bearers.get("bot data")!.token, "a".repeat(48), "d".repeat(48)]).size).toBe(4);
    expect(JSON.stringify(launch)).not.toContain(FIRST);
    expect(credentials.get(FIRST)!.get("bot agents")!.token).toBe("a".repeat(48));
  });

  it("keeps a bearer the conversation already holds for the same grants", () => {
    const { prestart, credentials, started } = host();
    credentials.set(NEXT, new Map([["bot agents", { grants: grantsOf(NEXT, "agents", "full"), token: "n".repeat(48) }]]));
    prestart.note("claude", firstTurn(), true);
    prestart.threadMade("bot", NEXT);
    expect(started[0]!.integrations!.agents!.env.OMB_COMMS_TOKEN).toBe("n".repeat(48));
  });

  it.each([
    ["the host does not start engines ahead (a small box, a Cloud home)", { allowed: false }],
    ["the conversation already has a message", { blank: false }],
    ["a turn is already being set up there", { busy: true }],
    ["a first message would be refused (paused, over a limit, signed out)", { refused: true }],
    ["its model, approval level or folder differs from the last launch's", { shape: "opus/ask" }],
    ["its folder is not where the last launch's would be", { folder: "/elsewhere" }],
    ["it has no folder of its own", { folder: null }],
  ])("starts nothing when %s", (_why, change) => {
    const { prestart, credentials, started, state } = host();
    prestart.note("claude", firstTurn(), true);
    Object.assign(state, change);
    prestart.threadMade("bot", NEXT);
    expect(started).toEqual([]);
    expect(prestart.waiting()).toEqual([]);
    expect(credentials.has(NEXT)).toBe(false);
  });

  it("starts nothing for a bot with no launch to go by, for the conversation the launch came from, or on another engine's adapter", () => {
    const { prestart, started } = host();
    prestart.threadMade("bot", NEXT);
    prestart.note("claude", firstTurn(), true);
    prestart.threadMade("other-bot", NEXT);
    prestart.threadMade("bot", FIRST);
    prestart.note("codex", firstTurn(), true);
    prestart.threadMade("bot", NEXT);
    expect(started).toEqual([]);
  });

  it.each([
    ["a turn no person sent", {}, false],
    ["a person's own MCP server", { integrations: { custom: { mine: { command: "x", args: [] } } } }, true],
    ["a browser", { integrations: { browser: { command: "node", args: [], env: {} } } }, true],
    ["a computer", { integrations: { localComputer: { command: "node", args: [], env: {} } } }, true],
    ["connected apps", { integrations: { composio: { command: "node", args: [], env: {} } } }, true],
    ["a guest's confinement", { guestConfined: true }, true],
    ["a tool selection", { toolScope: { servers: [] } }, true],
    ["the person's own Claude MCP configuration", { mcpFromUserConfig: true }, true],
  ])("does not go by a launch with %s, and forgets the one before it when a person sent it", (_what, extra, person) => {
    const { prestart, started } = host();
    prestart.note("claude", firstTurn(), true);
    prestart.note("claude", firstTurn(extra as Partial<SendTurnInput>), person);
    prestart.threadMade("bot", NEXT);
    expect(started).toHaveLength(person ? 0 : 1);
  });

  it("keeps only a couple waiting at once, and counts one again once it was taken or is gone", () => {
    const { prestart, started, held } = host({ folder: (_bot, threadId) => `/work/bot/${threadId}` });
    prestart.note("claude", firstTurn(), true);
    const made = ["t-1", "t-2", "t-3"];
    for (const threadId of made) prestart.threadMade("bot", threadId);
    expect(started.map((launch) => launch.threadId)).toEqual(made.slice(0, PRESTART_MOST));
    held.delete("t-1");
    prestart.threadMade("bot", "t-3");
    expect(started.map((launch) => launch.threadId)).toEqual(["t-1", "t-2", "t-3"]);
    prestart.threadMade("bot", "t-3");
    expect(started).toHaveLength(3);
  });

  it("leaves the bearers with the turn that takes the engine", () => {
    const { prestart, credentials, dropped } = host();
    prestart.note("claude", firstTurn(), true);
    prestart.threadMade("bot", NEXT);
    const token = credentials.get(NEXT)!.get("bot agents")!.token;
    prestart.note("claude", firstTurn({ threadId: NEXT }), true);
    vi.advanceTimersByTime(PRESTART_IDLE_MS + 60_000);
    expect(credentials.get(NEXT)!.get("bot agents")!.token).toBe(token);
    expect(dropped).toEqual([]);
    expect(prestart.waiting()).toEqual([]);
  });

  it("retires the bearers of an engine no message came for, a little after it closed", () => {
    const { prestart, credentials, dropped } = host();
    prestart.note("claude", firstTurn(), true);
    prestart.threadMade("bot", NEXT);
    vi.advanceTimersByTime(PRESTART_IDLE_MS);
    expect(credentials.has(NEXT)).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(credentials.has(NEXT)).toBe(false);
    expect(dropped).toEqual([NEXT]);
    expect(credentials.has(FIRST)).toBe(true);
  });

  it("leaves them alone when the timer comes due while a turn is being set up there", () => {
    const { prestart, credentials, dropped, state } = host();
    prestart.note("claude", firstTurn(), true);
    prestart.threadMade("bot", NEXT);
    state.busy = true;
    vi.advanceTimersByTime(PRESTART_IDLE_MS + 5_000);
    expect(credentials.has(NEXT)).toBe(true);
    expect(dropped).toEqual([]);
  });

  it("stops the engine and retires its bearers on a drop (a Stop, a deleted conversation or bot), and only then", () => {
    const { prestart, credentials, dropped } = host();
    prestart.note("claude", firstTurn(), true);
    prestart.drop(FIRST);
    expect(dropped).toEqual([]);
    expect(credentials.has(FIRST)).toBe(true);
    prestart.threadMade("bot", NEXT);
    prestart.drop(NEXT);
    expect(dropped).toEqual([NEXT]);
    expect(credentials.has(NEXT)).toBe(false);
    vi.advanceTimersByTime(PRESTART_IDLE_MS + 60_000);
    expect(dropped).toEqual([NEXT]);
  });

  it("retires the bearers at once when the engine could not start", async () => {
    const { prestart, credentials, state } = host();
    state.up = false;
    prestart.note("claude", firstTurn(), true);
    prestart.threadMade("bot", NEXT);
    await vi.advanceTimersByTimeAsync(0);
    expect(credentials.has(NEXT)).toBe(false);
    expect(prestart.waiting()).toEqual([]);
  });

  it.each(["refused", "rejected", "started"] as const)("keeps a replacement reservation when an obsolete start %s", async (outcome) => {
    const pending: Array<{ resolve: (up: boolean) => void; reject: (error: Error) => void }> = [];
    const drop = vi.fn();
    const { prestart, credentials } = host({
      adapter: () => ({ prestart: {
        start: () => new Promise<boolean>((resolve, reject) => pending.push({ resolve, reject })),
        held: () => true, ready: () => false, drop,
      } }),
    });
    prestart.note("claude", firstTurn(), true);
    prestart.threadMade("bot", NEXT);
    prestart.drop(NEXT);
    prestart.threadMade("bot", NEXT);
    const replacement = credentials.get(NEXT)!;
    expect(pending).toHaveLength(2);
    expect(drop).toHaveBeenCalledExactlyOnceWith(NEXT);

    if (outcome === "rejected") pending[0]!.reject(new Error("old launch failed"));
    else pending[0]!.resolve(outcome === "started");
    await vi.advanceTimersByTimeAsync(0);
    expect(prestart.waiting()).toEqual([NEXT]);
    expect(credentials.get(NEXT)).toBe(replacement);
    expect(drop).toHaveBeenCalledOnce();

    pending[1]!.resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(prestart.waiting()).toEqual([]);
    expect(credentials.has(NEXT)).toBe(false);
    expect(drop).toHaveBeenCalledTimes(2);
  });
});
