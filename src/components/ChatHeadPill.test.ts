import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { ChatHeadPill, type ChatHeadPrivacy } from "./ChatHeadPill";

const bot = (threadId: string, title = "New thread"): Bot => ({
  id: "rooms", threadId, mainThreadId: "main", name: "Rooms", title: "", description: "", notifications: true, color: "green", unread: false,
  modelSelection: { instanceId: "claude", model: "test" }, messages: [],
  tasks: [{ threadId: "main", title: "Shared chat", createdAt: 1 }, { threadId: "own", title, createdAt: 2 }],
} as unknown as Bot);
const pill = (of: Bot, privacy: ChatHeadPrivacy) => renderToStaticMarkup(createElement(StoreContext.Provider,
  { value: { state: { ...initialState } as AppState, dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as never },
  createElement(ChatHeadPill, { bot: of, avatar: { state: "idle", motion: "none", motionKey: 0, animated: false } as never, privacy, onToggle: vi.fn() })));

it("names the shared chat beside the bot, so the person knows where they are", () => {
  expect(pill(bot("main"), { kind: "shared", team: "Acme" })).toContain("Shared chat");
});

it("says nothing extra off a team, and a private chat keeps its own name", () => {
  expect(pill(bot("main"), null)).not.toContain("Shared chat");
  expect(pill(bot("own"), { kind: "private" })).toContain("Untitled chat");
  expect(pill(bot("own", "Quarter numbers"), { kind: "private" })).toContain("Quarter numbers");
});

it("names it too from another conversation's list, in the person's language", () => {
  const away = { ...bot("main"), mainThreadId: "elsewhere", tasks: [...bot("main").tasks!, { threadId: "elsewhere", title: "Other", createdAt: 3 }] } as Bot;
  expect(pill(away, { kind: "shared", team: "Acme" })).toContain("Shared chat");
});
