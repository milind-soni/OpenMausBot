import { type EffectCallback, type MemoExoticComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type Bot } from "@/state/store";

// Preserves only the owner's hook state across prop updates; descendants render with React's real hooks.
const fixture = vi.hoisted(() => ({
  capturing: false, cursor: 0, slots: [] as unknown[], effects: [] as EffectCallback[],
  state: { activeView: "chat" as const, selectedId: "atlas", revealThread: null as null | { threadId: string; nonce: number } },
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
    useMemo: <T,>(factory: () => T, dependencies: unknown[]) => fixture.capturing ? factory() : actual.useMemo(factory, dependencies),
  };
});
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
// Thread trees are an Advanced surface: Simple mode lists bots only.
vi.mock("@/lib/thread-preferences", async (original) => ({ ...await original<typeof import("@/lib/thread-preferences")>(),
  useShowThreads: () => true,
}));
vi.mock("@/lib/live-call-media", async (original) => {
  const actual = await original<typeof import("@/lib/live-call-media")>();
  return { ...actual, useLiveMedia: actual.liveMedia };
});
import { BotListItem, botRowProps, type BotRowProps } from "./Sidebar";
import { forgetThreadDisclosuresForTests } from "@/lib/thread-disclosure";

const bot: Bot = {
  id: "atlas", threadId: "current", name: "Atlas", title: "", description: "",
  notifications: true, color: "green", unread: false, modelSelection: { instanceId: "claude", model: "test" },
  messages: [{ id: "reply", role: "bot", kind: "text", text: "The latest reply", at: 1 }],
  tasks: [{ threadId: "current", title: "Current", createdAt: 1 }],
};
function render(candidate = bot) {
  fixture.cursor = 0; fixture.effects = []; fixture.capturing = true;
  let row;
  try { row = (BotListItem as MemoExoticComponent<(props: BotRowProps) => ReactNode>).type(botRowProps({ ...initialState, ...fixture.state }, vi.fn(), candidate, { density: "comfortable", onMenu: vi.fn() })); }
  finally { fixture.capturing = false; }
  return renderToStaticMarkup(row);
}
const ownerTag = (markup: string) => markup.match(/<div[^>]*data-sidebar-bot-row="atlas"[^>]*>/)?.[0];
function expectSoleRow(markup: string) {
  expect(ownerTag(markup)).toContain('aria-current="page"');
  expect(markup).not.toContain('data-sidebar-thread-row=');
  expect(markup).not.toContain("Collapse Atlas threads");
}
beforeEach(() => { fixture.slots = []; fixture.state.revealThread = null; forgetThreadDisclosuresForTests(); });

describe("bot row expansion follows the visible thread tree", () => {
  it("keeps a single bot row when a background thread requests focus", () => {
    const candidate = { ...bot, tasks: [...bot.tasks!, { threadId: "older", title: "Older conversation", createdAt: 0 }] };
    expect(render(candidate)).not.toContain('data-sidebar-thread-row=');
    fixture.state.revealThread = { threadId: "older", nonce: 1 };
    render(candidate);
    fixture.effects.forEach(effect => effect());
    const markup = render(candidate);
    expectSoleRow(markup);
  });

  it.each([
    [{ busy: true }, '<span dir="auto" data-sidebar-working-phrase="" class="truncate">Thinking</span>'],
    [{ activity: "waiting-on-you" }, '<span dir="auto" class="min-w-0 overflow-hidden whitespace-nowrap">Waiting for you…'],
    [{ waitingForTeammates: true }, '<span dir="auto" class="min-w-0 overflow-hidden whitespace-nowrap">Waiting on a teammate…'],
  ] as const)("keeps sole-thread activity visible after a reveal (%j)", (status, label) => {
    fixture.state.revealThread = { threadId: "current", nonce: 1 };
    render({ ...bot, ...status });
    fixture.effects.forEach(effect => effect());
    const markup = render({ ...bot, ...status });
    expectSoleRow(markup);
    expect(markup).toContain(label);
  });
});
