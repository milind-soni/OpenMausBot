import { afterEach, beforeEach, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ calls: [] as Array<[string, RequestInit | undefined]>, answer: null as unknown, fail: null as Error | null }));
vi.mock("./api", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    server.calls.push([path, init]);
    if (server.fail) throw server.fail;
    return server.answer;
  }),
}));

import { openBot } from "./thread-navigation";
import { openOwnTeamChat, ownChatOf, setTeamChats } from "./team-chats";

const MEMBER = { teamId: "team-acme", member: true }, ADMIN = { teamId: "team-acme", member: false };
const scout = (tasks: Array<Record<string, unknown>>) => ({ id: "scout", threadId: "scout-main", mainThreadId: "scout-main", tasks: [{ threadId: "scout-main", createdAt: 1 }, ...tasks] as never });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const stored = new Map<string, string>();
const localStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };
beforeEach(() => { vi.stubGlobal("localStorage", localStorage); stored.clear(); server.calls.length = 0; server.answer = null; server.fail = null; });
afterEach(() => { setTeamChats(null); vi.unstubAllGlobals(); });

it("a Member's click opens their own newest conversation with the bot, never the team's main chat, a routine's report, a bot's thread or a closed one", () => {
  const bot = scout([
    { threadId: "ada-old", private: true, createdAt: 2 }, { threadId: "ada-new", private: true, createdAt: 3, updatedAt: 9 },
    { threadId: "report", private: true, createdAt: 20, routineRunId: "r1" }, { threadId: "bot-opened", private: true, createdAt: 21, openedBy: { botId: "x" } },
    { threadId: "closed", private: true, createdAt: 22, closedBy: { botId: "x" } }, { threadId: "archived", private: true, createdAt: 23, archivedAt: 5 },
  ]);
  expect(ownChatOf(bot, MEMBER)).toBe("ada-new");
  expect(ownChatOf(scout([]), MEMBER), "none yet: one is made").toBeNull();
});

it("an Admin, who also sees members' private chats, gets only one the server says they opened, on any device, or a new one", () => {
  const bot = scout([{ threadId: "ada-chat", private: true, createdAt: 5 }, { threadId: "ben-old", private: true, createdAt: 2 }, { threadId: "ben-new", private: true, createdAt: 3 }]);
  expect(ownChatOf(bot, ADMIN), "never a member's chat").toBeNull();
  expect(ownChatOf(bot, { ...ADMIN, opened: ["ben-old", "ben-new", "ben-gone"] }), "their newest the server names").toBe("ben-new");
  expect(ownChatOf(bot, { ...ADMIN, opened: ["ben-gone"] }), "named, but no longer listed").toBeNull();
  expect(ownChatOf(bot, MEMBER), "a Member sees only their own: their newest").toBe("ada-chat");
});

it("opens the person's inbox, their chat with their Chief where everything for them arrives, before a newer chat", () => {
  const bot = scout([{ threadId: "inbox", private: true, inbox: true, createdAt: 2 }, { threadId: "newer", private: true, createdAt: 3, updatedAt: 9 }]);
  expect(ownChatOf(bot, MEMBER)).toBe("inbox");
  expect(ownChatOf(bot, { ...ADMIN, opened: ["newer"] }), "made after the session was read").toBe("inbox");
  expect(ownChatOf(scout([{ threadId: "inbox", private: true, inbox: true, archivedAt: 4 }, { threadId: "newer", private: true, createdAt: 3 }]), MEMBER)).toBe("newer");
});

it("with none yet, a click makes one through the server's new-conversation route, opens it and keeps it; a second click while it is made makes no second", async () => {
  setTeamChats({ teamId: "team-gamma", member: false });
  const dispatch = vi.fn();
  server.answer = { bot: { id: "scout", threadId: "ben-chat" }, task: { threadId: "ben-chat", private: true } };
  const bot = scout([{ threadId: "ada-chat", private: true, createdAt: 5 }]);
  openBot(dispatch, bot, false);
  openBot(dispatch, bot, false);
  await settle();
  expect(server.calls).toEqual([["/api/bots/scout/tasks", { method: "POST", body: "{}" }]]);
  expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "taskSwitched", bot: server.answer && (server.answer as { bot: unknown }).bot }, { type: "select", id: "scout" }]);
  expect(stored.size, "nothing kept in this device's storage: the server says whose it is").toBe(0);
  dispatch.mockClear();
  openBot(dispatch, scout([{ threadId: "ada-chat", private: true, createdAt: 5 }, { threadId: "ben-chat", private: true, createdAt: 6 }]), false);
  expect(dispatch.mock.calls.map(([action]) => action), "next time it opens, nothing is made").toEqual([{ type: "switchTask", botId: "scout", threadId: "ben-chat" }]);
  expect(server.calls.length).toBe(1);
});

it("a Member's existing conversation opens with no request; a refusal shows as an error; off a team the bot opens as it always has", async () => {
  setTeamChats(MEMBER);
  const dispatch = vi.fn();
  openBot(dispatch, scout([{ threadId: "ada-chat", private: true, createdAt: 5 }]), true);
  expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "scout" }, { type: "switchTask", botId: "scout", threadId: "ada-chat" }]);
  expect(server.calls).toEqual([]);
  dispatch.mockClear();
  server.fail = new Error("Members can't start a conversation here.");
  expect(openOwnTeamChat(dispatch, scout([]), () => {})).toBe(true);
  await settle();
  expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "error", message: "Members can't start a conversation here." }]);
  setTeamChats(null);
  dispatch.mockClear();
  openBot(dispatch, scout([{ threadId: "ada-chat", private: true, createdAt: 5 }]), false);
  expect(dispatch.mock.calls.map(([action]) => action), "the bot's main chat, as before").toEqual([{ type: "select", id: "scout" }]);
  expect(openOwnTeamChat(dispatch, scout([]), () => {})).toBe(false);
});
