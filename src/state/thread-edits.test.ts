// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { initialState, reducer, type Action, type AppState, type Bot, type Group } from "./store";
import { undoThreadEdit, type ThreadEdit } from "./thread-edits";

const bot = {
  id: "bot-1", threadId: "first", name: "Maus", messages: [], activeLeafId: null,
  tasks: [{ threadId: "first", title: "First", createdAt: 1 }],
} as unknown as Bot;
const room = {
  id: "room-1", threadId: "talk", name: "Launch", memberIds: [], messages: [],
  tasks: [{ threadId: "talk", title: "Talk", createdAt: 1, turnTimeoutMinutes: 10 }],
} as unknown as Group;
const start: AppState = { ...initialState, bots: [bot], groups: [room] };

function failedSave(edit: ThreadEdit, between?: Action) {
  const undo = undoThreadEdit(start, edit);
  let now = reducer(start, edit);
  if (between) now = reducer(now, between);
  const revert = undo(now);
  return revert ? reducer(now, revert) : now;
}

describe("undoThreadEdit", () => {
  it("shows a thread as it was when its edit could not be saved", () => {
    expect(failedSave({ type: "renameTask", botId: "bot-1", threadId: "first", title: "Renamed" }).bots[0]!.tasks![0]!.title).toBe("First");
    const roomTask = (state: AppState) => state.groups[0]!.tasks![0]!;
    expect(roomTask(failedSave({ type: "renameGroupTask", groupId: "room-1", threadId: "talk", title: "Renamed" })).title).toBe("Talk");
    expect(roomTask(failedSave({ type: "pinGroupTask", groupId: "room-1", threadId: "talk", pinned: true, title: "Talk" })).pinned).toBeUndefined();
    expect(roomTask(failedSave({ type: "setConversationTurnLimit", groupId: "room-1", threadId: "talk", minutes: 30, dm: false })).turnTimeoutMinutes).toBe(10);
  });

  it("leaves a newer edit in place", () => {
    const later: Action = { type: "renameGroupTask", groupId: "room-1", threadId: "talk", title: "Later" };
    expect(failedSave({ type: "renameGroupTask", groupId: "room-1", threadId: "talk", title: "Renamed" }, later).groups[0]!.tasks![0]!.title).toBe("Later");
  });
});
