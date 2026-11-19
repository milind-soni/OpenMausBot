import { describe, expect, it } from "vitest";
import { DEFAULT_STUCK_AFTER_MS, teamMapSessions, type TeamMapBotInput, type TeamMapSessionsDeps } from "./team-map-sessions.ts";
import type { ModelSelection } from "../shared/wire.ts";

const NOW = 1_700_000_000_000;
const SELECTION: ModelSelection = { instanceId: "inst-1", model: "claude-opus-5-5", effort: "high" };

function deps(overrides: Partial<TeamMapSessionsDeps> & { bots: readonly TeamMapBotInput[] }): TeamMapSessionsDeps {
  return {
    queued: [], roomBusy: [], lastOutputAt: () => undefined, groupIdOf: () => undefined, visibleGroup: () => true,
    createdAt: () => undefined, onPlan: () => false, doneLast24h: 0, now: NOW, ...overrides,
  };
}

describe("teamMapSessions", () => {
  it("reports a working task as running when it produced output recently", () => {
    const bots: TeamMapBotInput[] = [{ id: "bot-1", modelSelection: SELECTION, tasks: [
      { threadId: "t1", title: "Ship it", busy: true, activity: "working", turnStartedAt: NOW - 5_000, modelSelection: SELECTION },
    ] }];
    const snapshot = teamMapSessions(deps({ bots, lastOutputAt: () => NOW - 1_000 }));
    expect(snapshot.sessions).toEqual([{
      botId: "bot-1", threadId: "t1", title: "Ship it", state: "running", startedAt: NOW - 5_000,
      model: "claude-opus-5-5", effort: "high", lastOutputAt: NOW - 1_000,
    }]);
    expect(snapshot.stuckAfterMs).toBe(DEFAULT_STUCK_AFTER_MS);
  });

  it("flips a working task to stuck once its last output is older than stuckAfterMs, and leaves a fresher one running", () => {
    const bots: TeamMapBotInput[] = [{ id: "bot-1", modelSelection: SELECTION, tasks: [
      { threadId: "stale", title: "Stuck one", busy: true, activity: "working", turnStartedAt: NOW - 1_000_000 },
      { threadId: "fresh", title: "Fine one", busy: true, activity: "working", turnStartedAt: NOW - 1_000_000 },
    ] }];
    const lastOutputAt = (threadId: string) => (threadId === "stale" ? NOW - DEFAULT_STUCK_AFTER_MS - 1 : NOW - 1_000);
    const snapshot = teamMapSessions(deps({ bots, lastOutputAt, stuckAfterMs: DEFAULT_STUCK_AFTER_MS }));
    expect(snapshot.sessions.find((session) => session.threadId === "stale")?.state).toBe("stuck");
    expect(snapshot.sessions.find((session) => session.threadId === "fresh")?.state).toBe("running");
  });

  it("maps waiting-on-you to waiting and no-signal to stuck, and drops idle/dead tasks even when busy", () => {
    const bots: TeamMapBotInput[] = [{ id: "bot-1", modelSelection: SELECTION, tasks: [
      { threadId: "waiting", title: "Asked a question", busy: true, activity: "waiting-on-you" },
      { threadId: "no-signal", title: "No signal", busy: true, activity: "no-signal" },
      { threadId: "idle", title: "Idle", busy: true, activity: "idle" },
      { threadId: "not-busy", title: "Not busy", busy: false, activity: "working" },
    ] }];
    const snapshot = teamMapSessions(deps({ bots }));
    expect(snapshot.sessions.map((session) => [session.threadId, session.state])).toEqual([
      ["waiting", "waiting"], ["no-signal", "stuck"],
    ]);
  });

  it("drops a session whose thread lives in a group the viewer cannot see", () => {
    const bots: TeamMapBotInput[] = [{ id: "bot-1", modelSelection: SELECTION, tasks: [
      { threadId: "t1", title: "Room work", busy: true, activity: "working" },
    ] }];
    const hidden = teamMapSessions(deps({ bots, groupIdOf: () => "room-1", visibleGroup: () => false }));
    expect(hidden.sessions).toEqual([]);
    const shown = teamMapSessions(deps({ bots, groupIdOf: () => "room-1", visibleGroup: () => true }));
    expect(shown.sessions).toEqual([{
      botId: "bot-1", threadId: "t1", title: "Room work", state: "running", startedAt: NOW, groupId: "room-1",
      model: "claude-opus-5-5", effort: "high",
    }]);
  });

  it("reports usd from the task's own usage and marks it estimated only when the engine is on a subscription", () => {
    const bots: TeamMapBotInput[] = [{ id: "bot-1", modelSelection: SELECTION, tasks: [
      { threadId: "metered", title: "Metered", busy: true, activity: "working", modelSelection: { ...SELECTION, instanceId: "metered-instance" }, usage: { costUsd: 1.5 } },
      { threadId: "plan", title: "On a plan", busy: true, activity: "working", modelSelection: { ...SELECTION, instanceId: "plan-instance" }, usage: { costUsd: 0.2 } },
      { threadId: "unknown", title: "Unknown cost", busy: true, activity: "working", usage: { costUsd: null } },
    ] }];
    const snapshot = teamMapSessions(deps({ bots, onPlan: (instanceId) => instanceId === "plan-instance" }));
    const byThread = Object.fromEntries(snapshot.sessions.map((session) => [session.threadId, session]));
    expect(byThread.metered).toMatchObject({ usd: 1.5, usdEstimated: false });
    expect(byThread.plan).toMatchObject({ usd: 0.2, usdEstimated: true });
    expect(byThread.unknown.usd).toBeUndefined();
  });

  it("adds a queued session from a handoff not yet reflected as a busy task, using the thread's createdAt", () => {
    const bots: TeamMapBotInput[] = [{ id: "bot-2", modelSelection: SELECTION, tasks: [{ threadId: "t2", title: "Picked up later", busy: false }] }];
    const snapshot = teamMapSessions(deps({
      bots, queued: [{ targetBotId: "bot-2", threadId: "t2", groupId: "room-9" }],
      createdAt: (threadId) => (threadId === "t2" ? NOW - 60_000 : undefined),
    }));
    expect(snapshot.sessions).toEqual([{ botId: "bot-2", threadId: "t2", title: "Picked up later", state: "queued", startedAt: NOW - 60_000, groupId: "room-9" }]);
  });

  it("skips a queued handoff whose thread is already a busy session, to avoid showing it twice", () => {
    const bots: TeamMapBotInput[] = [{ id: "bot-2", modelSelection: SELECTION, tasks: [{ threadId: "t2", title: "Already running", busy: true, activity: "working" }] }];
    const snapshot = teamMapSessions(deps({ bots, queued: [{ targetBotId: "bot-2", threadId: "t2" }] }));
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]?.state).toBe("running");
  });

  it("dates a queued card from when the hand-off was queued, not from when its thread was made", () => {
    const bots: TeamMapBotInput[] = [{ id: "bot-2", modelSelection: SELECTION, tasks: [{ threadId: "t2", title: "Old thread", busy: false }] }];
    const snapshot = teamMapSessions(deps({
      bots, queued: [{ targetBotId: "bot-2", threadId: "t2", createdAt: NOW - 5_000 }],
      createdAt: () => NOW - 86_400_000,
    }));
    expect(snapshot.sessions[0]?.startedAt).toBe(NOW - 5_000);
  });

  it("keeps a queued hand-off to one bot on a room thread another bot is running", () => {
    const bots: TeamMapBotInput[] = [
      { id: "chief", modelSelection: SELECTION, tasks: [] },
      { id: "dev", modelSelection: SELECTION, tasks: [] },
    ];
    const snapshot = teamMapSessions(deps({
      bots, roomBusy: [{ botId: "chief", threadId: "room-thread", title: "Room", groupId: "room-1", startedAt: NOW - 1_000 }],
      queued: [{ targetBotId: "dev", threadId: "room-thread", groupId: "room-1" }],
    }));
    expect(snapshot.sessions.map((session) => [session.botId, session.state])).toEqual([["chief", "running"], ["dev", "queued"]]);
  });

  it("counts silence from the turn's start when the conversation has no line yet, and ignores lines from before the turn", () => {
    const old = NOW - DEFAULT_STUCK_AFTER_MS - 60_000;
    const bots: TeamMapBotInput[] = [{ id: "bot-1", modelSelection: SELECTION, tasks: [
      { threadId: "silent", title: "No line yet", busy: true, activity: "working", turnStartedAt: old },
      { threadId: "new-turn", title: "Just started", busy: true, activity: "working", turnStartedAt: NOW - 1_000 },
    ] }];
    const lastOutputAt = (threadId: string) => (threadId === "new-turn" ? old : undefined);
    const snapshot = teamMapSessions(deps({ bots, lastOutputAt }));
    expect(snapshot.sessions.map((session) => [session.threadId, session.state])).toEqual([["silent", "stuck"], ["new-turn", "running"]]);
  });

  it("shows a card for a bot running straight in a room's own thread, with no task of its own", () => {
    const bots: TeamMapBotInput[] = [{ id: "bot-1", modelSelection: SELECTION, tasks: [] }];
    const snapshot = teamMapSessions(deps({
      bots, roomBusy: [{ botId: "bot-1", threadId: "room-thread", title: "Engineering Room", groupId: "room-1", startedAt: NOW - 2_000 }],
      lastOutputAt: (threadId) => (threadId === "room-thread" ? NOW - 500 : undefined),
    }));
    expect(snapshot.sessions).toEqual([{
      botId: "bot-1", threadId: "room-thread", title: "Engineering Room", state: "running", startedAt: NOW - 2_000,
      groupId: "room-1", model: "claude-opus-5-5", effort: "high", lastOutputAt: NOW - 500,
    }]);
  });

  it("skips a room-busy entry whose thread already has a session from the bot's own tasks", () => {
    const bots: TeamMapBotInput[] = [{ id: "bot-1", modelSelection: SELECTION, tasks: [
      { threadId: "room-thread", title: "Already there", busy: true, activity: "working" },
    ] }];
    const snapshot = teamMapSessions(deps({
      bots, roomBusy: [{ botId: "bot-1", threadId: "room-thread", title: "Engineering Room", groupId: "room-1" }],
    }));
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({ title: "Already there" });
  });

  it("passes doneLast24h through untouched", () => {
    const snapshot = teamMapSessions(deps({ bots: [], doneLast24h: 7 }));
    expect(snapshot.doneLast24h).toBe(7);
  });
});
