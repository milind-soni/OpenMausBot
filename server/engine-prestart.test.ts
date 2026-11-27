import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SendTurnInput } from "./contracts.ts";
import { OPENED_PRESTART_IDLE_MS, PRESTART_IDLE_MS, PRESTART_MOST } from "./drivers/session-idle.ts";
import { createEnginePrestart, OPENED_AGAIN_AFTER_MS, OPENED_SETTLE_MS, prestartClosed, type EnginePrestartDeps, type SessionCredentials } from "./engine-prestart.ts";

const FIRST = "11111111-aaaa-4aaa-8aaa-111111111111";
const NEXT = "22222222-bbbb-4bbb-8bbb-222222222222";

/** What index.ts keeps for a conversation's bearer, as its sessionBearer writes it. */
const grantsOf = (threadId: string, kind: string, approval: unknown) => JSON.stringify({ botId: "bot", threadId, kind, createdBots: 0, openedThreads: 0, approval });

function host(overrides: Partial<EnginePrestartDeps> = {}) {
  const credentials: SessionCredentials = new Map([[FIRST, new Map([
    ["bot agents", { grants: grantsOf(FIRST, "agents", "full"), token: "a".repeat(48) }],
    ["bot data", { grants: grantsOf(FIRST, "data", "full"), token: "d".repeat(48) }],
  ])]]);
  const started: SendTurnInput[] = [], dropped: string[] = [], waits: Array<number | undefined> = [];
  const held = new Set<string>();
  const state = { allowed: true, blank: true, busy: false, refused: false, shape: "sonnet/full" as string | null, up: true, folder: `/work/bot/${NEXT}` as string | null,
    bot: "bot" as string | null, desktop: true, running: new Set<string>(), folders: 0, cursors: { [FIRST]: "session-1", [NEXT]: "session-2" } as Record<string, string | undefined>, clock: 1_000_000 };
  const prestart = createEnginePrestart({
    adapter: (id) => (id === "claude" ? { prestart: {
      start: async (input, waitMs) => { started.push(input); waits.push(waitMs); if (state.up) held.add(input.threadId); return state.up; },
      held: (threadId) => held.has(threadId), ready: (threadId) => held.has(threadId), running: (threadId) => held.has(threadId) || state.running.has(threadId),
      drop: (threadId) => { dropped.push(threadId); held.delete(threadId); },
    } } : undefined),
    credentials,
    allowed: () => state.allowed, blank: () => state.blank, busy: () => state.busy, refused: () => state.refused,
    shape: () => state.shape, approval: () => "full", folder: () => { state.folders += 1; return state.folder; },
    desktop: () => state.desktop, botOf: () => state.bot, cursor: (_bot, threadId, instanceId) => (instanceId === "claude" ? state.cursors[threadId] : undefined), now: () => state.clock,
    ...overrides,
  });
  return { prestart, credentials, started, dropped, held, state, waits };
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
        held: () => true, ready: () => false, running: () => false, drop,
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

describe("starting the engine of a conversation a person opens or types in", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** The bot's last turn was in FIRST, and its engine has closed since. */
  const afterATurn = (overrides: Partial<EnginePrestartDeps> = {}) => {
    const setup = host(overrides);
    setup.state.blank = false;
    setup.prestart.note("claude", firstTurn(), true);
    return setup;
  };
  const opened = (setup: ReturnType<typeof host>, threadId: string) => {
    setup.prestart.threadSeen(threadId);
    vi.advanceTimersByTime(OPENED_SETTLE_MS);
  };

  it("starts it as its next turn would: its own bearers, resuming its session, never inline, and waiting a few minutes", () => {
    const setup = afterATurn({ folder: (_bot, threadId) => `/work/bot/${threadId}` });
    setup.prestart.threadSeen(FIRST);
    expect(setup.started).toEqual([]);
    vi.advanceTimersByTime(OPENED_SETTLE_MS);
    expect(setup.started).toHaveLength(1);
    const launch = setup.started[0]!;
    expect(launch).toMatchObject({ threadId: FIRST, text: "", resumeCursor: "session-1", cwd: `/work/bot/${FIRST}`, systemStable: "You are Testy." });
    expect(launch.sessionReset).toBeUndefined();
    expect(launch.integrations).toEqual(firstTurn().integrations);
    expect(setup.waits).toEqual([OPENED_PRESTART_IDLE_MS]);
    expect(setup.prestart.waiting()).toEqual([FIRST]);
  });

  it("starts another conversation of the bot for its own id, folder, bearers and session", () => {
    const setup = afterATurn();
    opened(setup, NEXT);
    const launch = setup.started[0]!;
    expect(launch).toMatchObject({ threadId: NEXT, resumeCursor: "session-2", cwd: `/work/bot/${NEXT}` });
    expect(JSON.stringify(launch)).not.toContain(FIRST);
    expect(launch.integrations!.agents!.env.OMB_COMMS_TOKEN).toBe(setup.credentials.get(NEXT)!.get("bot agents")!.token);
  });

  it("resumes nothing when the conversation has no session on that engine", () => {
    const setup = afterATurn();
    setup.state.cursors[NEXT] = undefined;
    opened(setup, NEXT);
    expect(setup.started[0]!.resumeCursor).toBeUndefined();
  });

  it("starts only the conversation the person settles on when they click through several", () => {
    const setup = afterATurn({ folder: (_bot, threadId) => `/work/bot/${threadId}` });
    for (const threadId of ["t-1", "t-2", NEXT]) {
      setup.prestart.threadSeen(threadId);
      vi.advanceTimersByTime(OPENED_SETTLE_MS / 2);
    }
    vi.advanceTimersByTime(OPENED_SETTLE_MS);
    expect(setup.started.map((launch) => launch.threadId)).toEqual([NEXT]);
    // Seen again while it settles or waits (the presence ping as they type): still one.
    setup.prestart.threadSeen(NEXT);
    vi.advanceTimersByTime(OPENED_SETTLE_MS);
    expect(setup.started).toHaveLength(1);
  });

  it.each([
    ["the host does not start engines ahead (memory short, a Cloud home)", { allowed: false }],
    ["a turn is already being set up or running there", { busy: true }],
    ["its next message would be refused (paused, archived, over a limit or budget, signed out)", { refused: true }],
    ["its model, approval level or folder rule differs from the last launch's", { shape: "opus/ask" }],
    ["it is not a bot's conversation", { bot: null }],
  ])("starts nothing when %s", (_why, change) => {
    const setup = afterATurn();
    Object.assign(setup.state, change);
    opened(setup, NEXT);
    expect(setup.started).toEqual([]);
    expect(setup.prestart.waiting()).toEqual([]);
  });

  it("starts nothing, and closes no other waiting engine, for a conversation whose engine is already up; again and again", () => {
    const setup = afterATurn({ folder: (_bot, threadId) => { setup.state.folders += 1; return `/work/bot/${threadId}`; } });
    opened(setup, "t-1");
    opened(setup, "t-2");
    setup.state.running.add("t-answered");
    const folders = setup.state.folders;
    for (let ping = 0; ping < 3; ping++) {
      setup.prestart.threadSeen("t-answered");
      vi.advanceTimersByTime(OPENED_SETTLE_MS);
      setup.prestart.threadSeen("t-1");
      vi.advanceTimersByTime(OPENED_SETTLE_MS);
    }
    expect(setup.started.map((launch) => launch.threadId)).toEqual(["t-1", "t-2"]);
    expect(setup.dropped).toEqual([]);
    expect(setup.state.folders, "no folder or skills work for it").toBe(folders);
    expect(setup.prestart.waiting()).toEqual(["t-1", "t-2"]);
  });

  it("closes no waiting engine for a conversation whose folder is not where the launch would be, and does not redo that work", () => {
    const setup = afterATurn({ folder: (_bot, threadId) => { setup.state.folders += 1; return threadId === "t-moved" ? "/elsewhere" : `/work/bot/${threadId}`; } });
    opened(setup, "t-1");
    opened(setup, "t-2");
    opened(setup, "t-moved");
    const folders = setup.state.folders;
    expect(setup.dropped).toEqual([]);
    expect(setup.prestart.waiting()).toEqual(["t-1", "t-2"]);
    opened(setup, "t-1");
    opened(setup, "t-moved");
    expect(setup.state.folders).toBe(folders);
  });

  it("starts nothing for an opened conversation unless this server runs under the desktop app, while a new one still starts", () => {
    const setup = afterATurn();
    setup.state.desktop = false;
    opened(setup, NEXT);
    expect(setup.started).toEqual([]);
    setup.state.blank = true;
    setup.prestart.threadMade("bot", NEXT);
    expect(setup.started.map((launch) => launch.threadId)).toEqual([NEXT]);
  });

  it("starts nothing for a bot with no launch to go by", () => {
    const setup = host();
    setup.state.blank = false;
    opened(setup, NEXT);
    expect(setup.started).toEqual([]);
  });

  it("stops an engine no message came for and keeps the conversation's bearers, then leaves it alone a while", () => {
    const setup = afterATurn();
    opened(setup, NEXT);
    const bearers = setup.credentials.get(NEXT);
    vi.advanceTimersByTime(OPENED_PRESTART_IDLE_MS + 5_000);
    expect(setup.dropped).toEqual([NEXT]);
    expect(setup.credentials.get(NEXT)).toBe(bearers);
    expect(setup.prestart.waiting()).toEqual([]);
    setup.held.clear();
    setup.state.clock += OPENED_AGAIN_AFTER_MS - 1;
    opened(setup, NEXT);
    expect(setup.started).toHaveLength(1);
    setup.state.clock += 1;
    opened(setup, NEXT);
    expect(setup.started).toHaveLength(2);
  });

  it("starts it again at once when the person types in its composer", () => {
    const setup = afterATurn();
    opened(setup, NEXT);
    vi.advanceTimersByTime(OPENED_PRESTART_IDLE_MS + 5_000);
    setup.held.clear();
    opened(setup, NEXT);
    expect(setup.started).toHaveLength(1);
    setup.prestart.typedIn(NEXT);
    opened(setup, NEXT);
    expect(setup.started.map((launch) => launch.threadId)).toEqual([NEXT, NEXT]);
  });

  it("starts it again at once after a message was sent there", () => {
    const setup = afterATurn();
    opened(setup, NEXT);
    vi.advanceTimersByTime(OPENED_PRESTART_IDLE_MS + 5_000);
    setup.held.clear();
    setup.prestart.note("claude", firstTurn({ threadId: NEXT, cwd: `/work/bot/${NEXT}` }), true);
    opened(setup, NEXT);
    expect(setup.started.map((launch) => launch.threadId)).toEqual([NEXT, NEXT]);
  });

  it("keeps the conversation's bearers when its engine could not start (one already runs there)", async () => {
    const setup = afterATurn();
    setup.state.up = false;
    opened(setup, FIRST);
    await vi.advanceTimersByTimeAsync(0);
    expect(setup.prestart.waiting()).toEqual([]);
    expect(setup.credentials.get(FIRST)!.get("bot agents")!.token).toBe("a".repeat(48));
  });

  it("keeps a couple at once: the conversation opened longest ago gives way to the one in front of the person", () => {
    const setup = afterATurn({ folder: (_bot, threadId) => `/work/bot/${threadId}` });
    for (const threadId of ["t-1", "t-2", "t-3"]) opened(setup, threadId);
    expect(setup.started.map((launch) => launch.threadId)).toEqual(["t-1", "t-2", "t-3"]);
    expect(setup.dropped).toEqual(["t-1"]);
    expect(setup.prestart.waiting()).toEqual(["t-2", "t-3"]);
    expect(setup.prestart.waiting().length).toBeLessThanOrEqual(PRESTART_MOST);
  });

  it("never pushes out an engine a turn is being set up on", () => {
    const busy = new Set<string>();
    const setup = afterATurn({ folder: (_bot, threadId) => `/work/bot/${threadId}`, busy: (_bot, threadId) => busy.has(threadId) });
    opened(setup, "t-1");
    opened(setup, "t-2");
    busy.add("t-1");
    opened(setup, "t-3");
    expect(setup.dropped).toEqual(["t-2"]);
    expect(setup.prestart.waiting()).toEqual(["t-1", "t-3"]);
  });

  it("frees the place of one that waited through a sleep: its timer stood still, the wall clock did not", () => {
    const setup = afterATurn({ folder: (_bot, threadId) => `/work/bot/${threadId}` });
    opened(setup, "t-1");
    opened(setup, "t-2");
    setup.state.clock += OPENED_PRESTART_IDLE_MS + 60 * 60_000;
    setup.state.blank = true;
    setup.prestart.threadMade("bot", "t-new");
    expect(setup.dropped).toEqual(["t-1", "t-2"]);
    expect(setup.prestart.waiting()).toEqual(["t-new"]);
    expect(setup.credentials.has("t-1")).toBe(true);
  });

  it("forgets a pending open on a drop", () => {
    const setup = afterATurn();
    setup.prestart.threadSeen(NEXT);
    setup.prestart.drop(NEXT);
    vi.advanceTimersByTime(OPENED_SETTLE_MS);
    expect(setup.started).toEqual([]);
  });
});

describe("what is never started ahead", () => {
  it("an archived bot or conversation, or an engine signed out or unavailable at its last status read", () => {
    const signedIn = { state: "available", authenticated: true };
    expect(prestartClosed({}, {}, signedIn)).toBe(false);
    expect(prestartClosed({}, null, undefined)).toBe(false);
    expect(prestartClosed({ hidden: true }, {}, signedIn)).toBe(true);
    expect(prestartClosed({}, { archivedAt: 1 }, signedIn)).toBe(true);
    expect(prestartClosed({}, {}, { state: "available", authenticated: false })).toBe(true);
    expect(prestartClosed({}, {}, { state: "unavailable" })).toBe(true);
  });
});
