import { beforeEach, describe, expect, it } from "vitest";

import { briefCrossingTool, claimRecallCrossings, forgetRecallCrossings, recallCrossingTool } from "./recall-disclosure.ts";

beforeEach(() => forgetRecallCrossings());

describe("claimRecallCrossings", () => {
  it("claims a crossing the first time a source is recalled into a room", () => {
    expect(claimRecallCrossings("room-1", ["dm-1", "dm-1", "task-2"])).toEqual({
      threadIds: ["dm-1", "task-2"],
      count: 3,
    });
  });

  it("stays quiet when the room has already been told about that thread", () => {
    claimRecallCrossings("room-1", ["dm-1"]);
    expect(claimRecallCrossings("room-1", ["dm-1", "dm-1"])).toEqual({ threadIds: [], count: 0 });
  });

  it("announces a source the room has not seen, even alongside one it has", () => {
    claimRecallCrossings("room-1", ["dm-1"]);
    expect(claimRecallCrossings("room-1", ["dm-1", "task-2"])).toEqual({ threadIds: ["task-2"], count: 1 });
  });

  it("keeps rooms apart: telling one room discloses nothing in another", () => {
    claimRecallCrossings("room-1", ["dm-1"]);
    expect(claimRecallCrossings("room-2", ["dm-1"])).toEqual({ threadIds: ["dm-1"], count: 1 });
  });

  it("claims nothing when nothing crossed", () => {
    expect(claimRecallCrossings("room-1", [])).toEqual({ threadIds: [], count: 0 });
  });

  it("re-announces after the ledger is forgotten, because silence is the worse failure", () => {
    claimRecallCrossings("room-1", ["dm-1"]);
    forgetRecallCrossings("room-1");
    expect(claimRecallCrossings("room-1", ["dm-1"])).toEqual({ threadIds: ["dm-1"], count: 1 });
  });
});

describe("the crossing notices", () => {
  it("say what crossed, count in plain words, and carry a code per count", () => {
    expect(recallCrossingTool("Cia", 1)).toEqual({ ok: true, name: "Cia recalled 1 message from its private chat with you", nameCode: "chat.notice.recallCrossingOne", nameParams: { name: "Cia", count: 1 } });
    expect(recallCrossingTool("Cia", 3).name).toBe("Cia recalled 3 messages from its private chat with you");
    expect(briefCrossingTool("Cia", 1)).toEqual({ ok: true, name: "Cia's recent-work brief covers 1 private chat with you", nameCode: "chat.notice.briefCrossingOne", nameParams: { name: "Cia", count: 1 } });
    expect(briefCrossingTool("Cia", 2)).toMatchObject({ name: "Cia's recent-work brief covers 2 private chats with you", nameCode: "chat.notice.briefCrossingMany" });
  });
});
