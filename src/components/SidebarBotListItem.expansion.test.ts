import { type EffectCallback } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

// Preserve only the owner's hook state across prop updates. Descendants still
// render with React's real hooks; no DOM or live workspace is needed here.
const fixture = vi.hoisted(() => ({
  capturing: false, cursor: 0, slots: [] as unknown[], effects: [] as EffectCallback[],
  state: { activeView: "chat", selectedId: "atlas", deletingBots: {}, pendingQueued: {}, revealThread: null as null | { threadId: string } },
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => {
      if (!fixture.capturing) return actual.useState(initial);
      const index = fixture.cursor++;
      if (!(index in fixture.slots)) fixture.slots[index] = typeof initial === "function" ? initial() : initial;
      return [fixture.slots[index], (next: unknown) => {
        fixture.slots[index] = typeof next === "function" ? next(fixture.slots[index]) : next;
      }];
    },
    useEffect: (effect: EffectCallback, dependencies?: unknown[]) => {
      if (fixture.capturing) fixture.effects.push(effect);
      else actual.useEffect(effect, dependencies);
    },
  };
});
vi.mock("@/state/store", async (original) => ({ ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: vi.fn() }),
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("@/lib/thread-preferences", async (original) => ({ ...await original<typeof import("@/lib/thread-preferences")>(),
  useShowThreads: () => true,
}));
import { BotListItem } from "./Sidebar";

const bot: Bot = {
  id: "atlas", threadId: "current", name: "Atlas", title: "", description: "",
  notifications: true, color: "green", unread: false, modelSelection: { instanceId: "claude", model: "test" },
  messages: [{ id: "reply", role: "bot", kind: "text", text: "The latest reply", at: 1 }],
  tasks: [{ threadId: "current", title: "Current", createdAt: 1 }],
};
function render(candidate = bot, query = "") {
  fixture.cursor = 0; fixture.effects = []; fixture.capturing = true;
  let row;
  try { row = BotListItem({ bot: candidate, query, density: "comfortable", onMenu: vi.fn() }); }
  finally { fixture.capturing = false; }
  return renderToStaticMarkup(row);
}
const ownerTag = (markup: string) => markup.match(/<div[^>]*data-sidebar-bot-row="atlas"[^>]*>/)?.[0];
function expectSoleRow(markup: string) {
  expect(ownerTag(markup)).toContain('aria-current="page"');
  expect(markup).not.toContain('data-sidebar-thread-row=');
  expect(markup).not.toContain("Collapse Atlas threads");
}
beforeEach(() => { fixture.slots = []; fixture.state.revealThread = null; });

describe("bot row expansion follows the visible thread tree", () => {
  it("restores the sole conversation preview after clearing a thread search", () => {
    expect(render(bot, "Current")).toContain('data-sidebar-thread-row="current"');
    const markup = render();
    expectSoleRow(markup);
    expect(markup).toContain("The latest reply");
  });

  it("restores the owner row when an expanded list loses its second thread", () => {
    const multiple = { ...bot, tasks: [...bot.tasks!, { threadId: "older", title: "Earlier", createdAt: 0 }] };
    render(multiple, "Current");
    const expanded = render(multiple);
    expect(expanded).toContain('data-sidebar-thread-row="older"');
    expect(ownerTag(expanded)).not.toContain('aria-current="page"');
    const sole = render();
    expectSoleRow(sole);
    expect(sole).toContain("The latest reply");
  });

  it.each([
    [{ busy: true }, 'class="sr-only">Working…'],
    [{ activity: "waiting-on-you" }, '<span class="truncate">Waiting for you…'],
    [{ waitingForTeammates: true }, '<span class="truncate">Waiting on a teammate…'],
  ] as const)("keeps sole-thread activity visible after a reveal (%j)", (status, label) => {
    fixture.state.revealThread = { threadId: "current" };
    render({ ...bot, ...status });
    fixture.effects.forEach(effect => effect());
    const markup = render({ ...bot, ...status });
    expectSoleRow(markup);
    expect(markup).toContain(label);
  });
});
