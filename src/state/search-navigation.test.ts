// @vitest-environment happy-dom
import { act, createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatFindBar } from "@/components/ChatFindBar";
import { landOnSearchHit } from "@/lib/focus-message";
import { t } from "@/lib/i18n";
import type { SearchHit } from "@/lib/search-hit";
import { initialState, StoreProvider, useStore, type Action, type AppState, type Bot, type Group, type Message } from "./store";

const line = (id: string): Message => ({ id, role: "bot", kind: "text", text: id, at: 1 });
const bot: Bot = {
  id: "scout", name: "Scout", threadId: "one", title: "", description: "", color: "green", unread: false, notifications: true,
  messages: [line("first"), line("second")], activeLeafId: "initial", modelSelection: { instanceId: "fake", model: "test" },
  tasks: ["one", "two", "three"].map((threadId) => ({ threadId, title: threadId, createdAt: 1 })),
};
const room: Group = {
  id: "room", name: "Room", threadId: "room-one", memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "",
  unread: false, createdAt: 1, messages: [line("first")],
  tasks: ["room-one", "room-two"].map((threadId) => ({ threadId, title: threadId, createdAt: 1 })),
};
const hit: SearchHit = {
  botId: "scout", name: "Scout", threadId: "one", messageId: "first", role: "bot", kind: "text", at: 1,
  snippet: "first", matchStart: 0, matchLength: 5, onActivePath: true,
};
class OfflineEvents {
  onopen = null;
  onerror = null;
  onmessage = null;
  close() {}
}

const original = { bots: initialState.bots, groups: initialState.groups, selectedId: initialState.selectedId, activeView: initialState.activeView };
let host: HTMLDivElement;
let root: Root;
let seen: AppState;
let dispatch: Dispatch<Action>;
let navigationRevision: Readonly<{ current: number }>;
let held: Array<{ path: string; body?: string; resolve: (response: Response) => void }>;
function Probe() {
  ({ state: seen, dispatch, navigationRevision } = useStore());
  return null;
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const answer = async (path: string, body: unknown, messageId?: string) => {
  const matches = (request: typeof held[number]) => request.path === path && (!messageId || JSON.parse(request.body!).messageId === messageId);
  await vi.waitFor(() => expect(held.some(matches)).toBe(true));
  const request = held.splice(held.findIndex(matches), 1)[0]!;
  request.resolve(new Response(JSON.stringify(body)));
  await settle();
};
const shownBot = () => seen.bots.find((candidate) => candidate.id === "scout")!;
const shownRoom = () => seen.groups.find((candidate) => candidate.id === "room")!;
const findPath = "/api/search?q=first&limit=100&threadId=one";
const typeFind = (query: string) => {
  flushSync(() => root.render(createElement(StoreProvider, null,
    createElement(Probe), createElement(ChatFindBar, { threadId: "one", onClose: () => {} }))));
  const input = host.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
  flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
};
const startFind = async () => {
  typeFind("first");
  await vi.waitFor(() => expect(held.some((request) => request.path === findPath)).toBe(true));
};

beforeEach(() => {
  Object.assign(initialState, { bots: [structuredClone(bot)], groups: [structuredClone(room)], selectedId: "scout", activeView: "chat" });
  held = [];
  vi.stubGlobal("EventSource", OfflineEvents);
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) => new Promise<Response>((resolve) => {
    held.push({ path, body: typeof init?.body === "string" ? init.body : undefined, resolve });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  Object.assign(initialState, original);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("search-hit navigation replies", () => {
  it("keeps a manual bot switch made during the Find debounce", async () => {
    vi.useFakeTimers();
    typeFind("first");
    expect(held.some((request) => request.path === findPath)).toBe(false);
    flushSync(() => dispatch({ type: "switchTask", botId: "scout", threadId: "two" }));
    flushSync(() => vi.advanceTimersByTime(180));
    vi.useRealTimers();
    await answer(findPath, { hits: [hit] });

    const switchingAfterFind = shownBot().switchingTo;
    await answer("/api/bots/scout/tasks/two?messages=200", { bot: { ...bot, threadId: "two", messages: [line("manual-choice")], activeLeafId: "manual-choice" } });
    expect(shownBot().threadId).toBe("two");
    expect(shownBot().messages.map((message) => message.id)).toEqual(["manual-choice"]);
    expect(shownBot().activeLeafId).toBe("manual-choice");
    expect(switchingAfterFind).toBe("two");
    expect(seen.focusMessage).toBeNull();
  });

  it.each([false, true])("keeps a manual bot switch made during Find before its automatic landing (switch settled: %s)", async (settled) => {
    await startFind();
    flushSync(() => dispatch({ type: "switchTask", botId: "scout", threadId: "two" }));
    const switched = { bot: { ...bot, threadId: "two", messages: [line("manual-choice")], activeLeafId: "manual-choice" } };
    if (settled) await answer("/api/bots/scout/tasks/two?messages=200", switched);
    await answer(findPath, { hits: [hit] });

    const switchingAfterFind = shownBot().switchingTo;
    if (!settled) await answer("/api/bots/scout/tasks/two?messages=200", switched);
    expect(shownBot().threadId).toBe("two");
    expect(shownBot().messages.map((message) => message.id)).toEqual(["manual-choice"]);
    expect(shownBot().activeLeafId).toBe("manual-choice");
    expect(switchingAfterFind).toBe(settled ? undefined : "two");
    expect(held.some((request) => request.path.startsWith("/api/bots/scout/tasks/one"))).toBe(false);
  });

  it("lets an explicit Find result click supersede a pending ordinary bot switch", async () => {
    await startFind();
    await answer(findPath, { hits: [hit] });
    flushSync(() => dispatch({ type: "switchTask", botId: "scout", threadId: "two" }));
    const next = host.querySelector<HTMLButtonElement>(`button[aria-label="${t("chat.find.next")}"]`)!;
    flushSync(() => next.click());
    await settle();
    expect(shownBot().switchingTo).toBeUndefined();

    await answer("/api/bots/scout/tasks/two?messages=200", { bot: { ...bot, threadId: "two", messages: [line("stale")] } });
    expect(shownBot().threadId).toBe("one");
    expect(shownBot().messages.map((message) => message.id)).toEqual(["first", "second"]);
    expect(seen.focusMessage).toMatchObject({ threadId: "one", messageId: "first" });
  });

  it("keeps a newer explicit search choice with threads hidden when Find automatically lands", async () => {
    await startFind();
    const landing = landOnSearchHit({ ...hit, threadId: "two", messageId: "explicit-choice", onActivePath: false }, seen, dispatch, false, navigationRevision);
    await vi.waitFor(() => expect(held.some((request) => request.path === "/api/bots/scout/active-branch")).toBe(true));
    await answer(findPath, { hits: [hit] });
    await answer("/api/bots/scout/active-branch", { activeLeafId: "explicit-choice" }, "explicit-choice");
    await landing;
    await answer("/api/bots/scout/tasks/two", { bot: { ...bot, threadId: "two", messages: [line("explicit-choice")], activeLeafId: "explicit-choice" } });
    expect(shownBot().threadId).toBe("two");
    expect(shownBot().messages.map((message) => message.id)).toEqual(["explicit-choice"]);
    expect(seen.focusMessage).toMatchObject({ threadId: "two", messageId: "explicit-choice" });
  });

  it("automatically lands the first Find hit without intervening navigation", async () => {
    await startFind();
    await answer(findPath, { hits: [{ ...hit, messageId: "second" }] });
    expect(shownBot().threadId).toBe("one");
    expect(seen.focusMessage).toMatchObject({ threadId: "one", messageId: "second" });
  });

  it("keeps the newer Find result when an earlier query answers last", async () => {
    await startFind();
    typeFind("second");
    await answer("/api/search?q=second&limit=100&threadId=one", { hits: [{ ...hit, messageId: "second" }] });
    await answer(findPath, { hits: [hit] });
    expect(shownBot().threadId).toBe("one");
    expect(seen.focusMessage).toMatchObject({ threadId: "one", messageId: "second" });
  });

  it("automatically lands the newer query when earlier Find hits are queued for rendering", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    try {
      const queued = Promise.withResolvers<void>();
      const firstHits = [hit];
      const response = new Response();
      vi.spyOn(response, "json").mockResolvedValue({ get hits() { queued.resolve(); return firstHits; } });
      let revisionBeforeRender = -1;
      await act(async () => {
        typeFind("first");
        vi.advanceTimersByTime(180);
        const request = held.splice(held.findIndex((candidate) => candidate.path === findPath), 1)[0]!;
        expect(request.path).toBe(findPath);
        request.resolve(response);
        await queued.promise;
        expect(seen.focusMessage).toBeNull();

        const input = host.querySelector("input")!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "second");
        flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
        revisionBeforeRender = navigationRevision.current;
      });
      const revisionAfterRender = navigationRevision.current;
      await act(async () => {
        vi.advanceTimersByTime(180);
        const path = "/api/search?q=second&limit=100&threadId=one";
        const request = held.splice(held.findIndex((candidate) => candidate.path === path), 1)[0]!;
        expect(request.path).toBe(path);
        request.resolve(new Response(JSON.stringify({ hits: [{ ...hit, messageId: "second" }] })));
      });

      expect(seen.focusMessage).toMatchObject({ threadId: "one", messageId: "second" });
      expect(revisionBeforeRender).toBe(0);
      expect(revisionAfterRender).toBe(0);
    } finally {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    }
  });

  it("automatically lands a new Find query typed after a manual switch", async () => {
    await startFind();
    flushSync(() => dispatch({ type: "switchTask", botId: "scout", threadId: "two" }));
    typeFind("second");
    await answer("/api/search?q=second&limit=100&threadId=one", { hits: [{ ...hit, messageId: "second" }] });
    await answer("/api/bots/scout/tasks/two?messages=200", { bot: { ...bot, threadId: "two", messages: [line("manual-choice")] } });
    expect(shownBot().threadId).toBe("one");
    expect(shownBot().messages.map((message) => message.id)).toEqual(["first", "second"]);
    expect(shownBot().switchingTo).toBeUndefined();
    expect(seen.focusMessage).toMatchObject({ threadId: "one", messageId: "second" });
  });

  it("keeps a newer bot search hit when an older ordinary switch replies last", async () => {
    flushSync(() => dispatch({ type: "switchTask", botId: "scout", threadId: "two" }));
    await vi.waitFor(() => expect(held.some((request) => request.path === "/api/bots/scout/tasks/two?messages=200")).toBe(true));
    const landing = landOnSearchHit({ ...hit, threadId: "three", messageId: "third" }, seen, dispatch, true, navigationRevision);
    await answer("/api/bots/scout/tasks/three", { bot: { ...bot, threadId: "three", messages: [line("third")], activeLeafId: "third" } });
    await landing;
    expect(shownBot().threadId).toBe("three");
    expect(seen.focusMessage).toMatchObject({ threadId: "three", messageId: "third" });

    await answer("/api/bots/scout/tasks/two?messages=200", { bot: { ...bot, threadId: "two", messages: [line("stale")], activeLeafId: "stale" } });
    expect(shownBot().threadId).toBe("three");
    expect(shownBot().messages.map((message) => message.id)).toEqual(["third"]);
    expect(shownBot().activeLeafId).toBe("third");
    expect(shownBot().switchingTo).toBeUndefined();
    expect(seen.focusMessage).toMatchObject({ threadId: "three", messageId: "third" });
  });

  it.each([false, true])("keeps a newer hit in the shown bot thread when an older switch replies last (threads shown: %s)", async (threadsShown) => {
    flushSync(() => dispatch({ type: "switchTask", botId: "scout", threadId: "two" }));
    await vi.waitFor(() => expect(held.some((request) => request.path === "/api/bots/scout/tasks/two?messages=200")).toBe(true));
    await landOnSearchHit(hit, seen, dispatch, threadsShown, navigationRevision);
    await settle();
    const switchingAfterHit = shownBot().switchingTo;

    await answer("/api/bots/scout/tasks/two?messages=200", { bot: { ...bot, threadId: "two", messages: [line("stale")] } });
    expect(shownBot().threadId).toBe("one");
    expect(shownBot().messages.map((message) => message.id)).toEqual(["first", "second"]);
    expect(switchingAfterHit).toBeUndefined();
    expect(shownBot().switchingTo).toBeUndefined();
    expect(seen.focusMessage).toMatchObject({ threadId: "one", messageId: "first" });
    expect(held.some((request) => request.path.startsWith("/api/bots/scout/tasks/one"))).toBe(false);
  });

  it("applies an ordinary bot switch when no newer navigation overtakes it", async () => {
    await landOnSearchHit(hit, seen, dispatch, true, navigationRevision);
    flushSync(() => dispatch({ type: "switchTask", botId: "scout", threadId: "two" }));
    await answer("/api/bots/scout/tasks/two?messages=200", { bot: { ...bot, threadId: "two", messages: [line("second-thread")], activeLeafId: "second-thread" } });
    expect(shownBot().threadId).toBe("two");
    expect(shownBot().messages.map((message) => message.id)).toEqual(["second-thread"]);
    expect(shownBot().activeLeafId).toBe("second-thread");
    expect(shownBot().switchingTo).toBeUndefined();
  });

  it.each([false, true])("does not replace a newer ordinary bot switch (newer reply settled: %s)", async (settled) => {
    const landing = landOnSearchHit({ ...hit, threadId: "two" }, seen, dispatch, true, navigationRevision);
    flushSync(() => dispatch({ type: "switchTask", botId: "scout", threadId: "three" }));
    if (settled) await answer("/api/bots/scout/tasks/three?messages=200", { bot: { ...bot, threadId: "three", messages: [line("newer")] } });
    await answer("/api/bots/scout/tasks/two", { bot: { ...bot, threadId: "two", messages: [line("stale")] } });
    await landing;
    expect(shownBot().threadId).toBe(settled ? "three" : "one");
    expect(seen.focusMessage).toBeNull();
    if (!settled) await answer("/api/bots/scout/tasks/three?messages=200", { bot: { ...bot, threadId: "three", messages: [line("newer")] } });
    expect(shownBot().threadId).toBe("three");
    expect(shownBot().messages.map((message) => message.id)).toEqual(["newer"]);
  });

  it("invalidates a pending room switch when the newer hit is in the shown thread", async () => {
    const roomHit = { ...hit, botId: undefined, groupId: "room", threadId: "room-two" };
    await landOnSearchHit(roomHit, seen, dispatch, true, navigationRevision);
    await landOnSearchHit({ ...roomHit, threadId: "room-one" }, seen, dispatch, true, navigationRevision);
    await answer("/api/groups/room/tasks/room-two", { group: { ...room, threadId: "room-two", messages: [line("stale")] } });
    expect(shownRoom().threadId).toBe("room-one");
    expect(shownRoom().messages.map((message) => message.id)).toEqual(["first"]);
    expect(seen.focusMessage).toMatchObject({ threadId: "room-one", messageId: "first" });
    expect(held.some((request) => request.path === "/api/groups/room/tasks/room-one")).toBe(false);
  });

  it("keeps the loaded room page and hit index when the hit is already there", async () => {
    const history = Array.from({ length: 1000 }, (_, index) => line(`r${index}`));
    flushSync(() => dispatch({ type: "groupPatched", group: { ...room, messages: history.slice(800), hasMore: true } }));
    await landOnSearchHit({ ...hit, botId: undefined, groupId: "room", threadId: "room-one", messageId: "r950" }, seen, dispatch, true, navigationRevision);
    const path = "/api/groups/room/tasks/room-one";
    if (held.some((request) => request.path === path)) await answer(path, { group: { ...room, messages: history, hasMore: false } });
    await settle();
    expect(shownRoom().messages).toHaveLength(200);
    expect(shownRoom().messages.findIndex((message) => message.id === "r950")).toBe(150);
    expect(shownRoom().hasMore).toBe(true);
    expect(seen.focusMessage).toMatchObject({ threadId: "room-one", messageId: "r950" });
  });

  it("focuses a bot-to-bot room hit without trying to switch its canonical task", async () => {
    flushSync(() => dispatch({ type: "groupPatched", group: { ...room, dm: true } }));
    await landOnSearchHit({ ...hit, botId: undefined, groupId: "room", threadId: "room-one" }, seen, dispatch, true, navigationRevision);
    const request = held.find((candidate) => candidate.path.startsWith("/api/groups/room/tasks/"));
    request?.resolve(new Response(JSON.stringify({ error: "bot-to-bot channels keep one canonical conversation" }), { status: 400 }));
    await settle();
    expect(seen.error).toBeNull();
    expect(request).toBeUndefined();
    expect(seen.focusMessage).toMatchObject({ threadId: "room-one", messageId: "first" });
  });

  it.each([false, true])("keeps a manual branch choice after a delayed search reply (manual reply settled: %s)", async (settled) => {
    const landing = landOnSearchHit({ ...hit, onActivePath: false }, seen, dispatch, true, navigationRevision);
    await vi.waitFor(() => expect(held.some((request) => request.path === "/api/bots/scout/active-branch")).toBe(true));
    flushSync(() => dispatch({ type: "switchBranch", botId: "scout", messageId: "second" }));
    if (settled) await answer("/api/bots/scout/active-branch", { activeLeafId: "second" }, "second");
    await answer("/api/bots/scout/active-branch", { activeLeafId: "first" }, "first");
    await landing;
    expect(shownBot().activeLeafId).toBe("second");
    expect(seen.focusMessage).toBeNull();
    if (!settled) await answer("/api/bots/scout/active-branch", { activeLeafId: "second" }, "second");
    expect(shownBot().activeLeafId).toBe("second");
  });

  it.each([
    { type: "toggleComputer", botId: "scribe", open: true },
    { type: "toggleSettings", botId: "scribe", open: true },
    { type: "openDataResult", botId: "scribe", cardId: "result" },
    { type: "openSignIn", botId: "scribe", messageId: "sign-in", url: "https://fixture.test", site: "Fixture", place: "browser" },
  ] satisfies Action[])("keeps newer $type navigation while a search jump with threads hidden is pending", async (action) => {
    flushSync(() => dispatch({ type: "botPatched", bot: { ...bot, id: "scribe", name: "Scribe", threadId: "scribe-one" } }));
    const landing = landOnSearchHit({ ...hit, threadId: "two", onActivePath: false }, seen, dispatch, false, navigationRevision);
    await vi.waitFor(() => expect(held.some((request) => request.path === "/api/bots/scout/active-branch")).toBe(true));
    flushSync(() => dispatch(action));
    expect(seen.selectedId).toBe("scribe");
    await answer("/api/bots/scout/active-branch", { activeLeafId: "first" }, "first");
    await landing;
    expect(seen.selectedId).toBe("scribe");
    expect(seen.focusMessage).toBeNull();
    expect(held.some((request) => request.path.startsWith("/api/bots/scout/tasks/"))).toBe(false);
  });

  it.each([
    { type: "toggleActivity", open: true },
    { type: "toggleInspector", open: true },
    { type: "toggleAppSettings", open: true },
    { type: "togglePlugins", open: true },
    { type: "newBot" },
    { type: "toggleShortcuts", open: true },
    { type: "toggleNotifications", open: true },
    { type: "toggleWelcome", open: true },
    { type: "toggleTour", open: true },
    { type: "openCloudAdd", source: "app_settings" },
    { type: "closeCloudAdd" },
    { type: "cloudHowTo", open: true },
    { type: "createGroup", memberIds: ["scout"], name: "New room" },
  ] satisfies Action[])("cancels a pending search jump after explicit $type navigation", async (action) => {
    const landing = landOnSearchHit({ ...hit, onActivePath: false }, seen, dispatch, true, navigationRevision);
    await vi.waitFor(() => expect(held.some((request) => request.path === "/api/bots/scout/active-branch")).toBe(true));
    flushSync(() => dispatch(action));
    await answer("/api/bots/scout/active-branch", { activeLeafId: "first" }, "first");
    await landing;
    expect(seen.focusMessage).toBeNull();
  });

  it.each([
    { type: "hydrate", bots: [bot], groups: [room], computerControl: {} },
    { type: "botPatched", bot: { ...bot, title: "Updated" } },
    { type: "groupPatched", group: { id: "room", name: "Updated room" } },
    { type: "messageAdded", threadId: "one", message: line("incoming") },
    { type: "threadActive", threadId: "one", activeLeafId: "incoming" },
    { type: "connected", value: true },
  ] satisfies Action[])("continues a pending search jump after a background $type update", async (action) => {
    const landing = landOnSearchHit({ ...hit, onActivePath: false }, seen, dispatch, true, navigationRevision);
    await vi.waitFor(() => expect(held.some((request) => request.path === "/api/bots/scout/active-branch")).toBe(true));
    flushSync(() => dispatch(action));
    await answer("/api/bots/scout/active-branch", { activeLeafId: "first" }, "first");
    await landing;
    await settle();
    expect(shownBot().activeLeafId).toBe("first");
    expect(seen.focusMessage).toMatchObject({ threadId: "one", messageId: "first" });
  });

  it("keeps the newer hit's active leaf when an earlier branch reply arrives last", async () => {
    const earlier = landOnSearchHit({ ...hit, onActivePath: false }, seen, dispatch, true, navigationRevision);
    await vi.waitFor(() => expect(held.some((request) => request.path === "/api/bots/scout/active-branch")).toBe(true));
    const newer = landOnSearchHit({ ...hit, messageId: "second", onActivePath: false }, seen, dispatch, true, navigationRevision);
    await answer("/api/bots/scout/active-branch", { activeLeafId: "second" }, "second");
    await newer;
    await answer("/api/bots/scout/active-branch", { activeLeafId: "first" }, "first");
    await earlier;
    expect(shownBot().activeLeafId).toBe("second");
    expect(seen.focusMessage).toMatchObject({ threadId: "one", messageId: "second" });
  });
});
