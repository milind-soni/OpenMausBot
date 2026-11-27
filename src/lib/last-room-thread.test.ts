// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { initialState, type AppState, type Group } from "@/state/store";
import { openThreadBeside } from "./room-feed";
import { openRoomRow, rememberRoomThread } from "./last-room-thread";

const state = { ...initialState, config: { features: { roomFeed: true } } as AppState["config"] };
const room = (id: string): Group => ({ id, threadId: `${id}-main`, name: id, memberIds: [], messages: [], bulletin: "", createdAt: 1,
  unread: false, defaultResponder: { kind: "mentions" }, tasks: ["main", "side"].map((suffix) => ({ threadId: `${id}-${suffix}`, title: suffix, createdAt: 1 })) });
const a = room("a"), b = room("b");
const visit = (group: Group, viewer: string | null | undefined = null, place = state) => {
  const dispatch = vi.fn();
  openRoomRow(dispatch, group, place, viewer);
  return dispatch.mock.calls.flat();
};
const select = (id: string) => ({ type: "select", id });
const opened = (ownerId: string, threadId: string) => ({ type: "openForkPanel", kind: "group", ownerId, threadId });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it("resumes each room's own last viewed thread, not its shared current thread or another viewer's choice", () => {
  expect(visit(a)).toEqual([select("a")]);
  rememberRoomThread(null, "a", "a-side");
  rememberRoomThread(null, "b", "b-main");
  rememberRoomThread("teammate@example.test", "a", "a-main");
  expect(visit(a)).toEqual([select("a"), opened("a", "a-side")]);
  expect(visit(b)).toEqual([select("b"), opened("b", "b-main")]);
  expect(visit(a, "teammate@example.test")).toEqual([select("a"), opened("a", "a-main")]);
  rememberRoomThread(null, "a", null);
  expect(visit(a)).toEqual([select("a")]);
  expect(visit(b)).toEqual([select("b"), opened("b", "b-main")]);
});

it("keeps the already open panel, without reloading it or resetting its composer", () => {
  const panel: AppState["forkPanel"] = { kind: "group", ownerId: "a", threadId: "a-side", messages: [], loading: false, loadId: "load", activeLeafId: null, loadFailed: false };
  expect(visit(a, null, { ...state, selectedId: "a", activeView: "chat", forkPanel: panel })).toEqual([]);
});

it.each(["archived", "deleted", "owned by another room"])("keeps the feed when the remembered thread is %s", (why) => {
  rememberRoomThread(null, "a", why === "owned by another room" ? "b-side" : "a-side");
  const tasks = why === "deleted" ? a.tasks!.slice(0, 1) : a.tasks!.map((t) => t.threadId === "a-side" && why === "archived" ? { ...t, archivedAt: 2 } : t);
  expect(visit({ ...a, tasks })).toEqual([select("a")]);
  expect(visit(a)).toEqual([select("a")]);
});

it("keeps normal selection for old homes, bot-to-bot rooms and phones without forgetting the desktop choice", () => {
  rememberRoomThread(null, "a", "a-side");
  expect(visit(a, null, { ...state, config: null })).toEqual([select("a")]);
  expect(visit({ ...a, dm: true })).toEqual([select("a")]);
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
  expect(visit(a)).toEqual([select("a")]);
  vi.restoreAllMocks();
  expect(visit(a)).toEqual([select("a"), opened("a", "a-side")]);
});

it("opens only the thread named by an Inbox entry", () => {
  rememberRoomThread(null, "a", "a-side");
  const dispatch = vi.fn();
  expect(openThreadBeside(dispatch, "a-main", { ...state, groups: [a], selectedId: "b" })).toBe(true);
  expect(dispatch.mock.calls.flat()).toEqual([select("a"), opened("a", "a-main")]);
});

it("does not borrow the local person's selection while the viewer is still unknown", () => {
  rememberRoomThread(null, "a", "a-main");
  rememberRoomThread(undefined, "a", "a-side");
  const dispatch = vi.fn();
  openRoomRow(dispatch, a, state, undefined);
  expect(dispatch.mock.calls.flat()).toEqual([select("a")]);
  expect(visit(a)).toEqual([select("a"), opened("a", "a-main")]);
});

it("still opens the room if browser storage is unavailable", () => {
  vi.stubGlobal("localStorage", { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } });
  rememberRoomThread(null, "a", "a-side");
  expect(visit(a)).toEqual([select("a")]);
});
