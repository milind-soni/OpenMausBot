// @vitest-environment happy-dom
// The real provider and its live stream on a team's Cloud, with a fake server whose config answers after its bot list.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppState, BotAnnouncement } from "./store";
import { LAST_CONVERSATION_KEY } from "@/lib/last-conversation";

class FixtureEventSource {
  static opened: FixtureEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  constructor(readonly url: string) { FixtureEventSource.opened.push(this); }
  close() {}
  send(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

// Ada was last in her own chat with Scout; with threads hidden a bot opens to its main chat, which on a team is everyone's.
const scout: BotAnnouncement = {
  id: "scout", threadId: "ada-own", mainThreadId: "team-chat", name: "Scout", title: "", description: "", notifications: true, unread: false,
  color: "green", modelSelection: { instanceId: "fake", model: "m" }, visibility: "everyone", yourAccess: "chat",
  tasks: [{ threadId: "ada-own", title: "Mine", createdAt: 2, private: true }, { threadId: "team-chat", title: "Team", createdAt: 1, sharedChat: true }],
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const later = (body: unknown, ms: number) => new Promise<Response>((resolve) => setTimeout(() => resolve(json(body)), ms));
const switches: string[] = [];
let server: BotAnnouncement;
let configAfter = 0;
let state: AppState;

const { StoreProvider, useStore } = await import("./store");
const { useTeamChats, setTeamChats } = await import("./team-chats");

let root: Root;
const stream = () => FixtureEventSource.opened.at(-1)!;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function Probe() {
  ({ state } = useStore());
  useTeamChats(state.config);
  return null;
}

beforeAll(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/bots?")) return Promise.resolve(json({ bots: [{ ...server, messages: [] }], groups: [] }));
    if (path === "/api/config") return later({ team: { id: "team-acme", name: "Acme" } }, configAfter);
    if (path === "/api/auth/session") return Promise.resolve(json({ kind: "session", id: "s1", scopes: ["client"], email: "ada@acme.test", team: { id: "team-acme", name: "Acme", role: "member" }, openedThreads: ["ada-own"] }));
    const switched = path.match(/^\/api\/bots\/scout\/tasks\/([\w-]+)/);
    if (switched && init?.method === "POST") {
      switches.push(switched[1]!);
      server = { ...server, threadId: switched[1]! };
      return Promise.resolve(json({ bot: { ...structuredClone(server), messages: [] } }));
    }
    if (path.startsWith("/api/routines?since=")) return Promise.resolve(json({ routines: [], runs: [] }));
    if (path === "/api/webhooks") return Promise.resolve(json({ webhooks: [], attempts: [] }));
    if (path === "/api/instances") return Promise.resolve(json({ instances: [] }));
    return Promise.resolve(json({}));
  });
});
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  flushSync(() => root.unmount());
  setTeamChats(null);
});

async function launch(configDelay: number) {
  server = structuredClone(scout);
  configAfter = configDelay;
  switches.length = 0;
  localStorage.setItem(LAST_CONVERSATION_KEY, "scout");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(createElement(StoreProvider, null, createElement(Probe))));
  await wait(0);
  stream().send({ kind: "hello", resumed: false, cursor: "run:0" });
  await wait(configDelay + 60);
}

it.each([["after", 40], ["with", 0]] as const)("never opens a team bot's shared chat as it starts when the config answers %s the bot list", async (_order, delay) => {
  await launch(delay);
  expect(state.config?.team?.id).toBe("team-acme");
  expect(state.selectedId).toBe("scout");
  expect(switches, "no conversation but her own was asked for").not.toContain("team-chat");
  expect(state.bots.find((bot) => bot.id === "scout")!.threadId).toBe("ada-own");
});
