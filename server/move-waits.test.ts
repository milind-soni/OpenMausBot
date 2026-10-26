import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createCoordinator, type Coordinator, type CoordinatorHost, type HandoffView } from "./coordinator.ts";
import { createMoveFreeze } from "./move-freeze.ts";
import { createMoveWaits, WAIT_CEILING_MS } from "./move-waits.ts";
import { createMoveFreezeRoutes } from "./routes/move-freeze.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

function fakeHost(): CoordinatorHost {
  return {
    validate: vi.fn(() => undefined),
    busy: vi.fn(() => false),
    run: vi.fn(async (node: HandoffView) => ({ ok: true, text: `${node.botId} done` })),
    report: vi.fn(),
    changed: vi.fn(),
    names: vi.fn((node: HandoffView) => ({ requester: "Chief", assignee: node.botId })),
    park: vi.fn(),
    levelOf: vi.fn(() => ({ level: "ask" as const })),
    chiefOf: vi.fn(() => false),
  };
}

const handoff = (fields: Partial<HandoffView> & Pick<HandoffView, "id" | "botId" | "status">): HandoffView => ({
  rootId: fields.id, threadId: `${fields.botId}-chat`, key: fields.botId, text: "Do it", createdAt: 0, result: "", reported: false, executions: 1,
  approvalGranted: false, kind: "work", restarts: 0, mode: "work", reply: "resume", ...fields,
});

/** This computer as the move sees it: two bots, a room, and whatever each test puts under way. */
function world(handoffs: () => readonly HandoffView[] = () => []) {
  const state = {
    now: 0,
    bots: [{ id: "scout", name: "Scout" }, { id: "jev", name: "Jev" }],
    rooms: [{ id: "launch", name: "Launch room" }],
    answering: new Set<string>(),
    turn: new Set<string>(),
    runs: [] as Array<{ id: string; botId: string; groupId?: string; status: string }>,
    roomWorking: new Set<string>(),
    goneThreads: new Set<string>(),
    signingIn: false,
  };
  const busy = createMoveWaits({
    bots: () => state.bots,
    rooms: () => state.rooms,
    answering: (id) => state.answering.has(id),
    turn: (id) => state.turn.has(id) || state.answering.has(id),
    runs: () => state.runs,
    roomWorking: (id) => state.roomWorking.has(id),
    handoffs,
    exists: (node) => state.bots.some((bot) => bot.id === node.botId) && !state.goneThreads.has(node.threadId),
    signingIn: () => state.signingIn,
    now: () => state.now,
  });
  return { state, busy };
}

function parkedOnCards(dataDir: string, now: () => number): Coordinator {
  const coordinator = createCoordinator({ dataDir, host: fakeHost(), log: () => {}, now });
  coordinator.beginTurn({ id: "gen-1", address: { botId: "scout", threadId: "scout-chat" }, brief: "Connect GitHub and ship", level: "auto",
    origin: { kind: "user", request: "Connect GitHub and ship" } });
  coordinator.endTurn("gen-1", { ok: true, text: "", cards: { question: "Waiting on the person: connect GitHub", ids: ["msg-1"] } });
  return coordinator;
}

describe("what the move waits for: work that only waits on the person never holds it", () => {
  it("a conversation parked on the person's card holds nothing, though it stays parked for days and across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "move-waits-"));
    let now = Date.now();
    try {
      const first = parkedOnCards(dir, () => now);
      first.close();
      // Restarted, and then nobody answers for 30 days: the coordinator never lets go of a root parked on cards.
      const coordinator = createCoordinator({ dataDir: dir, host: fakeHost(), log: () => {}, now: () => now });
      for (let day = 0; day < 30; day++) { now += DAY; coordinator.tick(); }
      expect(coordinator.active().map((node) => [node.id, node.status, node.cards])).toEqual([["gen-1", "waiting", ["msg-1"]]]);
      const { busy } = world(() => coordinator.active());
      expect(busy(), "the move goes: the card goes with the chat").toBeNull();
      coordinator.close();
    } finally {
      removeTempDir(dir);
    }
  });

  it("a teammate's question for the person holds nothing", () => {
    const { busy } = world(() => [handoff({ id: "gen-1", botId: "scout", status: "waiting" }), handoff({ id: "ask", rootId: "gen-1", parentId: "gen-1", botId: "jev", status: "waiting", question: "Which repo?" })]);
    expect(busy()).toBeNull();
  });

  it("a conversation waiting on a teammate waits for that teammate's work, named by the teammate", () => {
    const nodes = [handoff({ id: "gen-1", botId: "scout", status: "waiting" }), handoff({ id: "child", rootId: "gen-1", parentId: "gen-1", botId: "jev", status: "queued" })];
    const { busy } = world(() => nodes);
    expect(busy()).toEqual({ name: "Jev", what: "bot" });
    nodes[1] = { ...nodes[1]!, status: "waiting", cards: ["msg-2"] };
    expect(busy(), "the teammate itself waits on the person now").toBeNull();
  });

  it("a routine run waiting on the person's answer holds nothing; one running does, by its bot's or room's name", () => {
    const { state, busy } = world();
    state.runs = [{ id: "run-1", botId: "scout", status: "waiting" }];
    expect(busy()).toBeNull();
    state.runs = [{ id: "run-1", botId: "scout", status: "waiting" }, { id: "run-2", botId: "scout", status: "running" }];
    expect(busy()).toEqual({ name: "Scout", what: "bot" });
    state.runs = [{ id: "run-3", botId: "lead", groupId: "launch", status: "running" }];
    expect(busy(), "a room goal's run, its lead not a bot here").toEqual({ name: "Launch room", what: "room" });
    state.runs = [{ id: "run-4", botId: "gone", groupId: "gone-room", status: "running" }];
    expect(busy(), "a run whose bot and room are gone can't finish here").toBeNull();
  });
});

describe("what the move waits for: real work under way, always by name", () => {
  it("a hand-off on its way holds the move, named by its bot: starting, queued, running or resuming", () => {
    for (const status of ["source", "queued", "running", "resume"] as const) {
      const { busy } = world(() => [handoff({ id: "n", botId: "scout", status })]);
      expect(busy(), status).toEqual({ name: "Scout", what: "bot" });
    }
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const { busy } = world(() => [handoff({ id: "n", botId: "scout", status })]);
      expect(busy(), status).toBeNull();
    }
  });

  it("a hand-off whose bot or conversation is gone counts as ended", () => {
    const nodes = [handoff({ id: "n", botId: "scout", status: "queued" })];
    const { state, busy } = world(() => nodes);
    state.goneThreads.add("scout-chat");
    expect(busy()).toBeNull();
    state.goneThreads.clear();
    state.bots = state.bots.filter((bot) => bot.id !== "scout");
    expect(busy()).toBeNull();
  });

  it("a room running a turn holds it by the room's name, a sign-in by what it is", () => {
    const { state, busy } = world();
    state.roomWorking.add("launch");
    expect(busy()).toEqual({ name: "Launch room", what: "room" });
    state.roomWorking.clear();
    state.signingIn = true;
    expect(busy()).toEqual({ name: "", what: "sign-in" });
  });

  it("names the bot answering now before anything else under way", () => {
    const { state, busy } = world(() => [handoff({ id: "n", botId: "scout", status: "queued" })]);
    state.turn.add("scout");
    state.answering.add("jev");
    expect(busy(), "Scout comes first, paused; Jev answers").toEqual({ name: "Jev", what: "bot" });
  });
});

describe("what the move waits for: a ceiling on everything but a turn answering now", () => {
  it("waits for a turn answering now as long as it answers, by name", () => {
    const { state, busy } = world();
    state.answering.add("scout");
    for (let i = 0; i < 10; i++) { state.now += HOUR; expect(busy()).toEqual({ name: "Scout", what: "bot" }); }
  });

  it("waits on one thing that is not answering for at most the ceiling, then goes ahead", () => {
    const { state, busy } = world(() => [handoff({ id: "n", botId: "jev", status: "queued" })]);
    expect(busy()).toEqual({ name: "Jev", what: "bot" });
    state.now += WAIT_CEILING_MS - 1;
    expect(busy()).toEqual({ name: "Jev", what: "bot" });
    state.now += 1;
    expect(busy(), "a hand-off queued on a bot that never frees up").toBeNull();
  });

  it("times each thing on its own: a new one gets its own wait, one that ended and came back starts again", () => {
    const { state, busy } = world();
    state.turn.add("scout");
    expect(busy()).toEqual({ name: "Scout", what: "bot" });
    state.now += WAIT_CEILING_MS;
    expect(busy(), "Scout's turn paused on the person for the whole ceiling").toBeNull();
    state.roomWorking.add("launch");
    expect(busy(), "the room just started").toEqual({ name: "Launch room", what: "room" });
    state.turn.delete("scout");
    state.roomWorking.delete("launch");
    expect(busy()).toBeNull();
    state.turn.add("scout");
    expect(busy(), "a new pause of Scout's").toEqual({ name: "Scout", what: "bot" });
  });

  it("times a turn from when it stopped answering, not from when it began", () => {
    const { state, busy } = world();
    state.answering.add("scout");
    expect(busy()).toEqual({ name: "Scout", what: "bot" });
    state.now += 2 * HOUR;
    expect(busy()).toEqual({ name: "Scout", what: "bot" });
    state.answering.delete("scout");
    state.turn.add("scout");
    expect(busy(), "paused on an approval just now").toEqual({ name: "Scout", what: "bot" });
    state.now += WAIT_CEILING_MS;
    expect(busy()).toBeNull();
  });

  it("a sign-in counts for at most the ceiling too", () => {
    const { state, busy } = world();
    state.signingIn = true;
    expect(busy()).toEqual({ name: "", what: "sign-in" });
    state.now += WAIT_CEILING_MS;
    expect(busy()).toBeNull();
  });
});

describe("POST /api/move/freeze with the move's own rule", () => {
  const post = async (route: ReturnType<typeof createMoveFreezeRoutes>) => {
    let answered: { status: number; body: unknown } | undefined;
    await route({ path: "/api/move/freeze", method: "POST", url: new URL("http://127.0.0.1/api/move/freeze"), req: {} as never, res: {} as never,
      auth: { kind: "loopback", scopes: ["admin"] } as never, json: (_res: unknown, status: number, value: unknown) => { answered = { status, body: value }; },
      readBody: async () => ({ cloud: "https://omb-t-1.fly.dev" }) } as never);
    return answered!;
  };

  it("freezes past a conversation parked on the person's card, and names a teammate's work it waits for", async () => {
    const dir = mkdtempSync(join(tmpdir(), "move-waits-route-"));
    try {
      const coordinator = parkedOnCards(join(dir, "runtime"), Date.now);
      const queued = [handoff({ id: "child", botId: "jev", status: "queued" })];
      let extra: HandoffView[] = queued;
      const { state, busy } = world(() => [...coordinator.active(), ...extra]);
      const freeze = createMoveFreeze({ dataDir: dir });
      const route = createMoveFreezeRoutes({ freeze, busy, restart() {} });
      expect(await post(route)).toEqual({ status: 409, body: { error: "A bot is still working.", busy: "Jev", what: "bot" } });
      extra = [];
      state.signingIn = true;
      expect(await post(route)).toEqual({ status: 409, body: { error: "A bot is still working.", busy: "", what: "sign-in" } });
      state.signingIn = false;
      expect(await post(route)).toEqual({ status: 200, body: { frozen: true } });
      expect(freeze.frozen()).toBe(true);
      coordinator.close();
    } finally {
      removeTempDir(dir);
    }
  });
});
