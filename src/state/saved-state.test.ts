// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { savedStateAction, type SavedSnapshot } from "./saved-state";
import { initialState, reducer, type AppState, type Bot, type Group, type Message } from "./store";

const said = { id: "m1", at: 1, role: "user", kind: "text", text: "Keep this" } as Message;
const bot = {
  id: "bot-1", threadId: "first", name: "Maus", messages: [said], activeLeafId: "m1",
  tasks: [{ threadId: "first", title: "First", createdAt: 1 }],
} as unknown as Bot;
const room = {
  id: "room-1", threadId: "talk", name: "Launch", memberIds: [], messages: [said], hasMore: true,
  tasks: [{ threadId: "talk", title: "Talk", createdAt: 1, turnTimeoutMinutes: 10 }],
} as unknown as Group;
const start: AppState = { ...initialState, bots: [bot], groups: [room] };

function reread(state: AppState, owner: Parameters<typeof savedStateAction>[0], snapshot: SavedSnapshot) {
  const saved = savedStateAction(owner, snapshot);
  return saved ? reducer(state, saved) : state;
}

describe("savedStateAction", () => {
  it("shows what the server saved after a failed edit and keeps the loaded transcript", () => {
    const edited = reducer(start, { type: "renameGroupTask", groupId: "room-1", threadId: "talk", title: "Renamed" });
    const shown = reread(edited, { groupId: "room-1" }, { bots: [], groups: [{ ...room, messages: [], hasMore: false }] });

    expect(shown.groups[0]!.tasks![0]!.title).toBe("Talk");
    expect(shown.groups[0]!.messages).toEqual([said]);
    expect(shown.groups[0]!.hasMore).toBe(true);
  });

  it("keeps an edit the server saved even though its response was lost", () => {
    const edited = reducer(start, { type: "renameTask", botId: "bot-1", threadId: "first", title: "Renamed" });
    const savedBot = { ...bot, messages: [], tasks: [{ threadId: "first", title: "Renamed", createdAt: 1 }] };
    const shown = reread(edited, { botId: "bot-1" }, { bots: [savedBot] });

    expect(shown.bots[0]!.tasks![0]!.title).toBe("Renamed");
    expect(shown.bots[0]!.messages).toEqual([said]);
  });

  it("restores a direct chat's turn limit from the server", () => {
    const chat = { ...room, id: "chat-1", dm: true, tasks: undefined, turnTimeoutMinutes: 10 } as unknown as Group;
    const edited = reducer({ ...start, groups: [chat] }, { type: "setConversationTurnLimit", groupId: "chat-1", threadId: "talk", minutes: 30, dm: true });
    const shown = reread(edited, { groupId: "chat-1" }, { bots: [], groups: [{ ...chat, messages: [] }] });

    expect(shown.groups[0]!.turnTimeoutMinutes).toBe(10);
  });
});
