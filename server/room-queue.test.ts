import { describe, expect, it } from "vitest";

import { queuedJobDetail, roomQueue, sequentialRoomNotice, type RoomLineItem } from "./room-queue.ts";

const names: Record<string, string> = { lead: "Lead", scout: "Scout", e1: "Editor 1", e2: "Editor 2", e3: "Editor 3", e4: "Editor 4" };
const nameOf = (id: string) => names[id] ?? id;
const job = (botId: string, state: RoomLineItem["state"], threadId = "room"): RoomLineItem => ({ botId, threadId, state, assignmentId: `a-${botId}` });

describe("room queue", () => {
  it("numbers five same-room jobs with one running: the rest wait on it, 2 of 5 onward", () => {
    // Created in this order; the one running moves to the front.
    const line = roomQueue([job("e1", "queued"), job("scout", "running"), job("e3", "queued"), job("e4", "queued"), job("e2", "queued")]);
    expect(line.map(e => [e.botId, e.state, e.position, e.of, e.waitingForBotId])).toEqual([
      ["scout", "running", 1, 5, undefined],
      ["e1", "queued", 2, 5, "scout"],
      ["e3", "queued", 3, 5, "scout"],
      ["e4", "queued", 4, 5, "scout"],
      ["e2", "queued", 5, 5, "scout"],
    ]);
  });

  it("with nothing running yet, the first waits on the speaking requester and each after it on the one ahead", () => {
    const line = roomQueue([job("e1", "queued"), job("e2", "queued")], new Map([["room", "lead"]]));
    expect(line.map(e => [e.botId, e.position, e.waitingForBotId])).toEqual([["e1", 1, "lead"], ["e2", 2, "e1"]]);
  });

  it("leaves out a line nobody waits in, keeps threads apart, and gives a member one place per line", () => {
    expect(roomQueue([job("scout", "running")])).toEqual([]);
    const line = roomQueue([
      { botId: "e1", threadId: "a", state: "running" }, { botId: "e2", threadId: "a", state: "queued" },
      job("e2", "queued", "a"), job("e3", "running", "b"),
    ]);
    expect(line.map(e => [e.threadId, e.botId, e.position, e.of])).toEqual([["a", "e1", 1, 2], ["a", "e2", 2, 2]]);
    // The job's assignment id survives the merge with the same member's mention.
    expect(line[1]!.assignmentId).toBe("a-e2");
  });

  it("tells the requester its room jobs run in turn, not in parallel", () => {
    const line = roomQueue([job("scout", "running"), job("e1", "queued"), job("e2", "queued")]);
    expect(queuedJobDetail(line[1]!, nameOf)).toBe("queued 2 of 3 in this room: room jobs run one at a time, so it starts in turn, after Scout");
    const notice = sequentialRoomNotice(line, new Set(["a-e1", "a-e2"]), nameOf);
    expect(notice).toContain("one at a time in this room, not in parallel: Scout (1 of 3, running), Editor 1 (2 of 3), Editor 2 (3 of 3)");
    expect(notice).toContain("do not say they are all under way");
    // Nothing this call sent waits: no notice.
    expect(sequentialRoomNotice(line, new Set(["a-scout"]), nameOf)).toBeUndefined();
    // One job queued behind the requester's own turn is the ordinary case.
    expect(sequentialRoomNotice(roomQueue([job("e1", "queued")], new Map([["room", "lead"]])), new Set(["a-e1"]), nameOf)).toBeUndefined();
  });
});

describe("room queue merging", () => {
  it("keeps a job's assignment id when the same member is also in the round, so its receipt still finds it", () => {
    const line = roomQueue([
      { botId: "e1", threadId: "room", state: "queued" },
      job("e1", "queued"),
      job("scout", "running"),
    ]);
    expect(line.map(e => [e.botId, e.state, e.assignmentId])).toEqual([["scout", "running", "a-scout"], ["e1", "queued", "a-e1"]]);
    expect(sequentialRoomNotice(line, new Set(["a-e1"]), nameOf)).toContain("Editor 1 (2 of 2)");
    // Running in either place is running.
    expect(roomQueue([{ botId: "e1", threadId: "room", state: "queued" }, job("e1", "running"), job("e2", "queued")])[0])
      .toMatchObject({ botId: "e1", state: "running", assignmentId: "a-e1" });
  });
});
