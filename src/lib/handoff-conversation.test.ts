import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { conversationRows, handoffTranscript, LOADING_TRANSCRIPT, type HandoffTranscript } from "./handoff-conversation";

const asker = { botId: "maestro", name: "Maestro", color: "blue" };
const helper = { botId: "tool", name: "Ferramenteiro", color: "green" };
const line = (id: string, role: Message["role"], text: string, extra: Partial<Message> = {}): Message =>
  ({ id, role, kind: "text", text, at: Number(id.replace(/\D/g, "")) || 1, ...extra });
const loaded = (messages: Message[], activeLeafId: string | null = null): HandoffTranscript =>
  handoffTranscript(LOADING_TRANSCRIPT, { type: "loaded", messages, activeLeafId });

describe("conversationRows", () => {
  it("names the asking bot, the helper and a person, and leaves out tool steps and empty lines", () => {
    const rows = conversationRows(loaded([
      line("m1", "user", "Please check the build", { peerAsk: { botId: "maestro", name: "Maestro" } }),
      { id: "m2", role: "bot", kind: "activity", at: 2, tool: { name: "Ran tests" } },
      line("m3", "bot", "Build is green"),
      line("m4", "bot", "  "),
      line("m5", "user", "Thanks, also run lint"),
    ]), asker, helper, "You");
    expect(rows.map((row) => [row.id, row.side, row.speaker.name, row.text])).toEqual([
      ["m1", "asker", "Maestro", "Please check the build"],
      ["m3", "helper", "Ferramenteiro", "Build is green"],
      ["m5", "person", "You", "Thanks, also run lint"],
    ]);
  });

  it("shows only the branch the thread is on", () => {
    const rows = conversationRows(loaded([
      line("m1", "user", "Ask", { peerAsk: { botId: "maestro", name: "Maestro" }, parentId: null }),
      line("m2", "bot", "Old answer", { parentId: "m1" }),
      line("m3", "bot", "New answer", { parentId: "m1" }),
    ], "m3"), asker, helper, "You");
    expect(rows.map((row) => row.text)).toEqual(["Ask", "New answer"]);
  });

  it("names a third bot that joined the helper's thread", () => {
    const rows = conversationRows(loaded([line("m1", "user", "Me too", { peerAsk: { botId: "other", name: "Other" } })]), asker, helper, "You");
    expect(rows[0]).toMatchObject({ side: "asker", speaker: { botId: "other", name: "Other" } });
  });
});

describe("handoffTranscript", () => {
  it("keeps lines that arrived live while the thread was loading", () => {
    const live = handoffTranscript(LOADING_TRANSCRIPT, { type: "message", message: line("m2", "bot", "Live, edited") });
    const state = handoffTranscript(live, { type: "loaded", messages: [line("m1", "user", "Ask"), line("m2", "bot", "Live")], activeLeafId: "m2" });
    expect(state.loading).toBe(false);
    expect(state.messages.map((message) => message.text)).toEqual(["Ask", "Live, edited"]);
  });

  it("moves the branch on to a line that arrived while loading and continues it", () => {
    const live = handoffTranscript(LOADING_TRANSCRIPT, { type: "message", message: line("m3", "bot", "Next", { parentId: "m2" }) });
    const state = handoffTranscript(live, { type: "loaded", messages: [line("m1", "user", "Ask", { parentId: null }), line("m2", "bot", "First", { parentId: "m1" })], activeLeafId: "m2" });
    expect(state.activeLeafId).toBe("m3");
    expect(conversationRows(state, asker, helper, "You").map((row) => row.text)).toEqual(["Ask", "First", "Next"]);
  });

  it("moves the branch on to a live line that the loaded copy also holds", () => {
    let state = handoffTranscript(LOADING_TRANSCRIPT, { type: "active", activeLeafId: "m1" });
    state = handoffTranscript(state, { type: "message", message: line("m2", "bot", "Reply", { parentId: "m1" }) });
    state = handoffTranscript(state, { type: "loaded", messages: [line("m1", "user", "Ask", { parentId: null }), line("m2", "bot", "Reply", { parentId: "m1" })], activeLeafId: "m2" });
    expect(state.activeLeafId).toBe("m2");
    expect(conversationRows(state, asker, helper, "You").map((row) => row.text)).toEqual(["Ask", "Reply"]);
  });

  it("follows the branch with each new line and patches lines it holds", () => {
    let state = loaded([line("m1", "user", "Ask", { parentId: null })], "m1");
    state = handoffTranscript(state, { type: "message", message: line("m2", "bot", "Working", { parentId: "m1" }) });
    expect(state.activeLeafId).toBe("m2");
    state = handoffTranscript(state, { type: "message", message: line("m2", "bot", "Done", { parentId: "m1" }), patch: true });
    expect(state.messages.map((message) => message.text)).toEqual(["Ask", "Done"]);
    expect(handoffTranscript(state, { type: "message", message: line("m9", "bot", "Unknown"), patch: true })).toBe(state);
  });

  it("loads again from the start after missed live updates, so the loaded copy replaces stale lines", () => {
    const stale = handoffTranscript(loaded([line("m1", "user", "Ask"), line("m2", "bot", "Working")], "m2"), { type: "reload" });
    expect(stale).toMatchObject({ messages: [], loading: true, failed: false, activeLeafId: null });
    const state = handoffTranscript(stale, { type: "loaded", messages: [line("m1", "user", "Ask"), line("m2", "bot", "Done")], activeLeafId: "m2" });
    expect(state.messages.map((message) => message.text)).toEqual(["Ask", "Done"]);
  });

  it("keeps a change to a line that arrives before the thread has loaded", () => {
    const live = handoffTranscript(LOADING_TRANSCRIPT, { type: "message", message: line("m2", "bot", "Checked, all green"), patch: true });
    const state = handoffTranscript(live, { type: "loaded", messages: [line("m1", "user", "Ask"), line("m2", "bot", "Chec")], activeLeafId: "m2" });
    expect(state.messages.map((message) => message.text)).toEqual(["Ask", "Checked, all green"]);
  });
});
