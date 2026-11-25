import { describe, expect, it } from "vitest";
import type { RoomThreadSummary } from "../../../shared/room-threads";
import type { GroupTask } from "@/state/store";
import { feedThreads } from "./use-room-threads";

const task = (threadId: string, extra: Partial<GroupTask> = {}): GroupTask => ({ threadId, title: threadId, createdAt: 1, ...extra });
const summary = (threadId: string, at: number): RoomThreadSummary =>
  ({ threadId, first: { text: threadId, speaker: { person: {} }, at }, replies: 0, lastReplyAt: null, repliers: [] });

describe("the feed's threads", () => {
  it("leaves archived threads out unless asked for them, oldest first either way", () => {
    const tasks = [task("old"), task("put-away", { archivedAt: 0 }), task("new")];
    const summaries = [summary("new", 30), summary("put-away", 20), summary("old", 10)];
    expect(feedThreads(tasks, summaries).map((thread) => thread.task.threadId)).toEqual(["old", "new"]);
    expect(feedThreads(tasks, summaries, true).map((thread) => thread.task.threadId)).toEqual(["old", "put-away", "new"]);
  });
});
