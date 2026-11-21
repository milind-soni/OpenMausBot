import { expect, it } from "vitest";
import { addForkOptimistic, reduceForkPanel, removeForkOptimistic, type ForkPanelState } from "./fork-panel";
import { initialState, reducer, type AppState, type Message } from "./store";

const source: Message = { id: "source", role: "user", kind: "text", text: "Start", at: 1, parentId: null };
const panel = (): ForkPanelState => ({
  kind: "bot", ownerId: "bot", threadId: "fork", messages: [source], activeLeafId: source.id,
  loading: false, loadId: "load-1", loadFailed: false,
});
const state = (forkPanel = panel()): AppState => ({
  forkPanel, bots: [{ id: "bot", threadId: "main" }], groups: [],
}) as unknown as AppState;

it("reconciles a send in the fork panel and keeps an off-leaf insertion off the visible path", () => {
  const sent = addForkOptimistic(state(), { type: "send", botId: "bot", threadId: "fork", text: "Continue", sendId: "send-1" });
  expect(sent.forkPanel?.messages.at(-1)?.id).toBe("optimistic-send-1");
  const confirmed: Message = { id: "confirmed", role: "user", kind: "text", text: "Continue", at: 2, parentId: source.id, sendId: "send-1" };
  const arrived = reduceForkPanel(sent, { type: "forkPanelMessage", threadId: "fork", message: confirmed });
  expect(arrived.forkPanel?.messages.map((message) => message.id)).toEqual(["source", "confirmed"]);
  expect(arrived.forkPanel?.activeLeafId).toBe("confirmed");
  const offLeaf: Message = { id: "artifact", role: "bot", kind: "text", text: "Late", at: 3, parentId: source.id };
  const late = reduceForkPanel(arrived, { type: "forkPanelMessage", threadId: "fork", message: offLeaf });
  expect(late.forkPanel?.activeLeafId).toBe("confirmed");
});

it("restores the fork leaf after a failed optimistic send", () => {
  const sent = addForkOptimistic(state(), { type: "send", botId: "bot", threadId: "fork", text: "Continue", sendId: "send-1" });
  const removed = removeForkOptimistic(sent, { type: "optimisticMessageRemoved", threadId: "fork", sendId: "send-1" });
  expect(removed.forkPanel?.messages).toEqual([source]);
  expect(removed.forkPanel?.activeLeafId).toBe(source.id);
});

it("removes a failed bot fork send before buffering background thread events", () => {
  const start = {
    ...initialState,
    bots: [{ id: "bot", threadId: "main", messages: [], tasks: [{ threadId: "fork" }] }],
    forkPanel: panel(),
  } as unknown as AppState;
  const sent = addForkOptimistic(start, { type: "send", botId: "bot", threadId: "fork", text: "Continue", sendId: "send-1" });
  const removed = reducer(sent, { type: "optimisticMessageRemoved", threadId: "fork", sendId: "send-1" });
  expect(removed.forkPanel?.messages).toEqual([source]);
  expect(removed.forkPanel?.activeLeafId).toBe(source.id);
});

it("ignores a stale load failure after retrying the same fork", () => {
  const retry = reduceForkPanel(state(), { type: "openForkPanel", kind: "bot", ownerId: "bot", threadId: "fork", loadId: "load-2" });
  expect(reduceForkPanel(retry, { type: "forkPanelLoadFailed", threadId: "fork", loadId: "load-1" })).toBe(retry);
  const failed = reduceForkPanel(retry, { type: "forkPanelLoadFailed", threadId: "fork", loadId: "load-2" });
  expect(failed.forkPanel).toMatchObject({ loading: false, loadFailed: true });
});

it("prefers a live patch over an older fetched copy while loading", () => {
  const loading = reduceForkPanel(state(), { type: "openForkPanel", kind: "bot", ownerId: "bot", threadId: "fork", loadId: "load-2" });
  const live: Message = { ...source, text: "Updated" };
  const updated = reduceForkPanel(loading, { type: "forkPanelMessage", threadId: "fork", message: live, patch: true });
  const loaded = reduceForkPanel(updated, { type: "forkPanelLoaded", threadId: "fork", loadId: "load-2", messages: [source], activeLeafId: source.id });
  expect(loaded.forkPanel).toMatchObject({ loading: false, activeLeafId: source.id });
  expect(loaded.forkPanel?.messages[0]?.text).toBe("Updated");
});
