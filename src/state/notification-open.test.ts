// @vitest-environment happy-dom
// The real provider, its live stream and display preference, and a fake server answering in the real one's order.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerFrame } from "../../shared/wire";
import type { Action, AppState, BotAnnouncement } from "./store";
import { LAST_CONVERSATION_KEY } from "@/lib/last-conversation";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object, id?: string) { this.onmessage?.({ data: JSON.stringify(frame), lastEventId: id }); }
}
class FixtureNotification {
  static permission = "granted";
  static shown: FixtureNotification[] = [];
  onclick: (() => void) | null = null;
  constructor(readonly title: string) { FixtureNotification.shown.push(this); }
}

// Scout was left on "left-behind" (an unread routine reply); the person last wrote in "main-chat"; "finished" is the notification's.
const elsewhere: BotAnnouncement = {
  id: "other", threadId: "other-chat", name: "Other", title: "", description: "", notifications: true, unread: false,
  color: "blue", modelSelection: { instanceId: "fake", model: "m" }, tasks: [{ threadId: "other-chat", title: "Chat", createdAt: 1 }],
};
const scout: BotAnnouncement = {
  id: "scout", threadId: "left-behind", mainThreadId: "main-chat", name: "Scout", title: "", description: "",
  notifications: true, unread: true, color: "green", modelSelection: { instanceId: "fake", model: "m" },
  tasks: [
    { threadId: "left-behind", title: "Routine report", createdAt: 1, unread: true },
    { threadId: "main-chat", title: "Main chat", createdAt: 2 },
    { threadId: "finished", title: "Side job", createdAt: 3, unread: true },
  ],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const requests: Array<{ path: string; body?: string }> = [];
let server: BotAnnouncement;
let firstBot = "other";
let state: AppState;
let dispatch: (action: Action) => void;

const { StoreProvider, useStore, openBot } = await import("./store");
const { landOnSearchHit } = await import("@/lib/focus-message");
const { threadsWhenTreeHidden } = await import("@/components/SidebarBotActivity");
const { setAdvancedMode } = await import("@/lib/interface-mode");
const { setShowThreads } = await import("@/lib/thread-preferences");

let root: Root;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const stream = () => FixtureEventSource.opened.at(-1)!;
const announcedThen = (body: unknown) => new Promise<Response>((resolve) => setTimeout(() => {
  stream().send({ kind: "bot", bot: structuredClone(server) });
  setTimeout(() => resolve(json(body)), 0);
}, 0));

function Probe() {
  ({ state, dispatch } = useStore());
  return null;
}

beforeAll(() => {
  // Use persistent browser-like storage even on Node versions without it.
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("Notification", FixtureNotification);
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
    requests.push({ path, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (path.startsWith("/api/bots?")) {
      const bots = [elsewhere, server].sort((bot) => bot.id === firstBot ? -1 : 0);
      return Promise.resolve(json({ bots: bots.map((bot) => ({ ...bot, messages: [] })), groups: [] }));
    }
    const switched = path.match(/^\/api\/bots\/scout\/tasks\/([\w-]+)/);
    if (switched && init?.method === "POST") {
      if (!server.tasks!.some((task) => task.threadId === switched[1])) return Promise.resolve(json({ error: "no such task" }, 404));
      // Like store.switchTask: announce the switch, then answer with the snapshot taken then.
      server = { ...server, threadId: switched[1]! };
      return announcedThen({ bot: { ...structuredClone(server), messages: [] } });
    }
    if (path === "/api/bots/scout/read" && init?.method === "POST") {
      const { threadId } = JSON.parse(String(init.body));
      const tasks = server.tasks!.map((task) => task.threadId === threadId ? { ...task, unread: false } : task);
      server = { ...server, tasks, unread: tasks.some((task) => task.unread) };
      return announcedThen({ bot: structuredClone(server) });
    }
    if (path === "/api/routines") return Promise.resolve(json({ routines: [], runs: [] }));
    if (path === "/api/webhooks") return Promise.resolve(json({ webhooks: [], attempts: [] }));
    if (path === "/api/instances") return Promise.resolve(json({ instances: [] }));
    return Promise.resolve(json({}));
  });
});
afterAll(() => vi.unstubAllGlobals());
async function launch() {
  server = structuredClone(scout);
  // A previous scenario must not decide which bot this launch restores.
  localStorage.setItem(LAST_CONVERSATION_KEY, firstBot);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await settle();
  stream().send({ kind: "hello", resumed: false, cursor: "run:0" });
  await settle();
}
beforeEach(async () => {
  firstBot = "other";
  await launch();
  expect(state.selectedId).toBe("other");
  expect(server.threadId).toBe("left-behind");
  requests.length = 0;
  FixtureNotification.shown.length = 0;
});
afterEach(() => flushSync(() => root.unmount()));

const threadsShown = async (shown: boolean) => {
  flushSync(() => { setAdvancedMode(true); setShowThreads(shown); });
  await settle();
};
const sent = () => requests.map((request) => request.body ? `${request.path} ${request.body}` : request.path);
const reads = () => requests.filter((request) => request.path === "/api/bots/scout/read").map((request) => JSON.parse(request.body!).threadId);
const scoutNow = () => state.bots.find((bot) => bot.id === "scout")!;
const unread = (threadId: string) => scoutNow().tasks!.find((task) => task.threadId === threadId)!.unread;

async function followNotification() {
  const frame: ServerFrame = { kind: "notify", notification: { id: "n1", at: 1, read: false, kind: "done", botId: "scout", botName: "Scout", threadId: "finished", title: "Scout finished", body: "Side job done." } };
  stream().send(frame, "run:1");
  await settle();
  expect(FixtureNotification.shown).toHaveLength(1);
  FixtureNotification.shown[0]!.onclick!();
  await settle();
}

describe("following a notification", () => {
  it("opens its thread by the switch alone while threads are hidden, leaving the reply the bot was left on unread", async () => {
    await threadsShown(false);
    await followNotification();
    expect(sent().filter((request) => request.startsWith("/api/bots/scout/tasks/finished"))).toHaveLength(1);
    expect(reads()).toEqual(["finished"]);
    expect(scoutNow().threadId).toBe("finished");
    expect(unread("finished")).toBe(false);
    expect(unread("left-behind")).toBe(true);
    expect(server.tasks!.find((task) => task.threadId === "left-behind")!.unread).toBe(true);
  });

  it("selects the bot first while threads are shown, as it always has", async () => {
    await threadsShown(true);
    await followNotification();
    expect(reads()).toEqual(["left-behind", "finished"]);
    expect(sent().filter((request) => request.startsWith("/api/bots/scout/tasks/finished"))).toHaveLength(1);
    expect(scoutNow().threadId).toBe("finished");
    expect(unread("finished")).toBe(false);
  });

  it("opens the brief in MausBot's chat while MausBot is hidden from the sidebar", async () => {
    await threadsShown(true);
    server = { ...server, defaultBot: {}, sidebarHidden: true };
    stream().send({ kind: "bot", bot: structuredClone(server) });
    await settle();
    expect(scoutNow().sidebarHidden).toBe(true);
    stream().send({ kind: "notify", notification: { id: "n2", at: 2, read: false, kind: "brief", botId: "scout", botName: "Scout", threadId: "main-chat", title: "Scout", body: "Your brief" } }, "run:2");
    await settle();
    FixtureNotification.shown.at(-1)!.onclick!();
    await settle();
    expect(state.selectedId).toBe("scout");
    expect(scoutNow().threadId).toBe("main-chat");
  });

  it("leaves the thread a failed switch stayed on as the one on screen", async () => {
    await threadsShown(false);
    server = { ...server, tasks: server.tasks!.filter((task) => task.threadId !== "finished") };
    await followNotification();
    expect(scoutNow().threadId).toBe("left-behind");
    expect(reads()).toEqual([]);
    stream().send({ kind: "bot", bot: structuredClone(server) });
    await settle();
    expect(reads()).toEqual(["left-behind"]);
  });
});

describe("opening a bot with threads hidden", () => {
  it("opens its main thread from its row and leaves the thread it was left on unread, with an activity row", async () => {
    await threadsShown(false);
    flushSync(() => openBot(dispatch, scoutNow(), false));
    await settle();
    expect(sent().filter((request) => request.startsWith("/api/bots/scout/tasks/main-chat"))).toHaveLength(1);
    expect(reads()).toEqual([]);
    expect(scoutNow().threadId).toBe("main-chat");
    expect(unread("left-behind")).toBe(true);
    expect(threadsWhenTreeHidden(scoutNow(), {}).map((task) => task.threadId).filter((id) => id !== scoutNow().threadId))
      .toEqual(expect.arrayContaining(["left-behind", "finished"]));
  });

  it("lands on a search hit in another thread by the switch alone, with the whole thread", async () => {
    await threadsShown(false);
    await landOnSearchHit({
      botId: "scout", name: "Scout", threadId: "finished", messageId: "hit", role: "bot", kind: "text", at: 3,
      snippet: "the side job is done", matchStart: 4, matchLength: 8, onActivePath: true,
    }, state, dispatch, false);
    await settle();
    expect(sent().filter((request) => request.startsWith("/api/bots/scout/tasks/"))).toEqual(["/api/bots/scout/tasks/finished {}"]);
    expect(reads()).toEqual(["finished"]);
    expect(unread("left-behind")).toBe(true);
    expect(state.focusMessage).toMatchObject({ threadId: "finished", messageId: "hit" });
  });
});

describe("launching the app on a bot", () => {
  async function relaunch(shown: boolean) {
    flushSync(() => root.unmount());
    flushSync(() => { setAdvancedMode(true); setShowThreads(shown); });
    firstBot = "scout";
    requests.length = 0;
    await launch();
  }

  it("opens its main thread while threads are hidden, leaving the reply the bot was left on unread", async () => {
    await relaunch(false);
    expect(state.selectedId).toBe("scout");
    const switches = sent().filter((request) => request.startsWith("/api/bots/scout/tasks/"));
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatch(/^\/api\/bots\/scout\/tasks\/main-chat\b/);
    expect(reads()).toEqual([]);
    expect(scoutNow().threadId).toBe("main-chat");
    expect(unread("left-behind")).toBe(true);
    expect(threadsWhenTreeHidden(scoutNow(), {}).map((task) => task.threadId)).toContain("left-behind");
  });

  it("keeps the bot where it was while threads are shown, as it always has", async () => {
    await relaunch(true);
    expect(state.selectedId).toBe("scout");
    expect(sent().some((request) => request.startsWith("/api/bots/scout/tasks/"))).toBe(false);
    expect(scoutNow().threadId).toBe("left-behind");
  });
});
