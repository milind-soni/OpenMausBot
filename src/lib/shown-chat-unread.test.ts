import { describe, expect, it } from "vitest";
import { initialState, type AppState, type Bot, type Group } from "@/state/store";
import { shownChatIsUnread } from "./shown-chat-unread";

const bot: Bot = {
  id: "reviewer", threadId: "shown", name: "Reviewer", title: "", description: "", notifications: true,
  color: "green", unread: true, messages: [], modelSelection: { instanceId: "fake", model: "test" },
  tasks: [
    { threadId: "shown", title: "Shown", createdAt: 1, unread: false },
    { threadId: "other", title: "Other", createdAt: 2, unread: true },
  ],
};
const group = { id: "room", threadId: "room-thread", unread: true } as Group;
const state = (patch: Partial<AppState>): AppState => ({ ...initialState, activeView: "chat", bots: [bot], groups: [group], ...patch });

describe("shownChatIsUnread", () => {
  it("follows the shown thread, not the bot's other threads", () => {
    expect(shownChatIsUnread(state({ selectedId: bot.id }))).toBe(false);
    expect(shownChatIsUnread(state({ selectedId: bot.id, bots: [{ ...bot, switchingTo: "other" }] }))).toBe(true);
  });

  it("uses the bot flag for a bot without threads, and the group flag for a room", () => {
    expect(shownChatIsUnread(state({ selectedId: bot.id, bots: [{ ...bot, tasks: undefined }] }))).toBe(true);
    expect(shownChatIsUnread(state({ selectedId: group.id }))).toBe(true);
  });

  it("is false away from the chat view or with nothing selected", () => {
    expect(shownChatIsUnread(state({ selectedId: group.id, activeView: "routines" }))).toBe(false);
    expect(shownChatIsUnread(state({ selectedId: "" }))).toBe(false);
  });
});
