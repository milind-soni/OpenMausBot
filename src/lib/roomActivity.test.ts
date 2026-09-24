import { describe, expect, it } from "vitest";
import { clearRoomActivity, foldRoomActivity, type RoomActivityState } from "./roomActivity";

const frame = (botId: string | undefined, event: Record<string, unknown>) => ({
  botId,
  event: { threadId: "room-1", createdAt: "2026-08-13T18:00:00.000Z", ...event } as any,
});

describe("foldRoomActivity", () => {
  it("tracks a tool from turn start through completion", () => {
    let state: RoomActivityState = {};
    state = foldRoomActivity(state, frame("bot-1", { type: "turn.started", turnId: "turn-1" }));
    state = foldRoomActivity(state, frame("bot-1", { type: "item.started", itemType: "tool", itemId: "tool-1", title: "pnpm test" }));
    expect(state["room-1"]["bot-1"]).toMatchObject({ status: "running", turnId: "turn-1" });
    expect(state["room-1"]["bot-1"].entries[0]).toMatchObject({ title: "pnpm test", status: "running" });

    state = foldRoomActivity(state, frame("bot-1", { type: "item.completed", itemType: "tool", itemId: "tool-1", ok: true }));
    expect(state["room-1"]["bot-1"].entries[0].status).toBe("completed");
    state = foldRoomActivity(state, frame("bot-1", { type: "turn.completed", turnId: "turn-1", ok: true }));
    expect(state["room-1"]["bot-1"].status).toBe("completed");
  });

  it("shows approval waits and resumes after resolution", () => {
    let state = foldRoomActivity({}, frame("bot-1", { type: "request.opened", requestId: "ask-1", summary: "Run deployment?" }));
    expect(state["room-1"]["bot-1"]).toMatchObject({ status: "approval" });
    expect(state["room-1"]["bot-1"].entries[0]).toMatchObject({ status: "waiting", title: "Run deployment?" });
    state = foldRoomActivity(state, frame("bot-1", { type: "request.resolved", requestId: "ask-1" }));
    expect(state["room-1"]["bot-1"].status).toBe("running");
  });

  it("labels automatic approval in room activity", () => {
    let state = foldRoomActivity({}, frame("bot-1", { type: "request.opened", requestId: "ask-1", summary: "Run deployment?" }));
    state = foldRoomActivity(state, frame("bot-1", { type: "request.resolved", requestId: "ask-1", source: "auto" }));
    expect(state["room-1"]["bot-1"].entries[0]).toMatchObject({ title: "Run deployment? — Auto-approved", status: "completed" });
  });

  it("settles a waiting approval when its turn is cancelled", () => {
    let state = foldRoomActivity({}, frame("bot-1", { type: "request.opened", requestId: "ask-1", summary: "Run deployment?" }));

    state = foldRoomActivity(state, frame("bot-1", { type: "turn.completed", ok: true, stopReason: "cancelled" }));

    expect(state["room-1"]["bot-1"].status).toBe("cancelled");
    expect(state["room-1"]["bot-1"].entries[0].status).toBe("cancelled");
  });

  it("isolates agents and ignores unattributed events", () => {
    const first = foldRoomActivity({}, frame("bot-1", { type: "turn.started", turnId: "one" }));
    const second = foldRoomActivity(first, frame("bot-2", { type: "turn.started", turnId: "two" }));
    expect(Object.keys(second["room-1"])).toEqual(["bot-1", "bot-2"]);
    expect(foldRoomActivity(second, frame(undefined, { type: "runtime.error" }))).toBe(second);
  });

  it("marks open work failed when a turn fails", () => {
    let state = foldRoomActivity({}, frame("bot-1", { type: "item.started", itemType: "tool", itemId: "tool-1", title: "build" }));
    state = foldRoomActivity(state, frame("bot-1", { type: "turn.completed", ok: false }));
    expect(state["room-1"]["bot-1"].status).toBe("failed");
    expect(state["room-1"]["bot-1"].entries[0].status).toBe("failed");
  });

  it("preserves runtime error details", () => {
    const state = foldRoomActivity({}, frame("bot-1", { type: "runtime.error", eventId: "error-1", message: "command exited 2" }));
    expect(state["room-1"]["bot-1"].entries[0]).toMatchObject({ status: "failed", title: "command exited 2" });
  });

  it("bounds per-agent history", () => {
    let state: RoomActivityState = {};
    for (let index = 0; index < 20; index += 1) {
      state = foldRoomActivity(state, frame("bot-1", {
        type: "item.started",
        itemType: "tool",
        itemId: `tool-${index}`,
        title: `tool ${index}`,
        createdAt: new Date(Date.UTC(2026, 7, 13, 18, 0, index)).toISOString(),
      }));
    }
    expect(state["room-1"]["bot-1"].entries).toHaveLength(12);
    expect(state["room-1"]["bot-1"].entries[0].title).toBe("tool 19");
  });

  it("clears only the selected room's activity", () => {
    const first = foldRoomActivity({}, frame("bot-1", { type: "turn.started", turnId: "one" }));
    const state = foldRoomActivity(first, {
      botId: "bot-2",
      event: { threadId: "room-2", type: "turn.started", turnId: "two" },
    });

    const cleared = clearRoomActivity(state, "room-1");
    expect(cleared["room-1"]).toBeUndefined();
    expect(cleared["room-2"]).toBe(state["room-2"]);
    expect(clearRoomActivity(cleared, "missing")).toBe(cleared);
  });
});
