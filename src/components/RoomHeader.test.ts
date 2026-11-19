// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({ advanced: false, state: null as Partial<AppState> | null, dispatch: vi.fn(), chrome: undefined as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => {
  const original = await importOriginal<typeof import("./DesktopCapabilities")>();
  return {
    ...original,
    useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { platform: "darwin" } }, ready: true }),
    useCaptionChrome: () => fixture.chrome ?? original.captionChrome("native"),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { GroupView } = await import("./GroupView");

const NAMES = ["Desk Manager", "Vendor Bench", "Job Board Sourcer", "Paperwork", "Phone Screener", "Matcher", "Interview Coordinator", "Submission Writer", "Timesheets"];
const bots: Bot[] = NAMES.map((name, index) => ({
  id: `bot-${index}`, threadId: `thread-${index}`, name, title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [], modelSelection: { instanceId: "test", model: "m" },
}));
const room = (patch: Partial<Group> = {}): Group => ({
  id: "desk", threadId: "desk-thread", name: "Desk HQ", description: "The recruiting desk", memberIds: bots.map((bot) => bot.id),
  defaultResponder: { kind: "member", botId: "bot-0" }, bulletin: "Desk HQ: the recruiting desk's room.\nKeep it short.",
  unread: false, createdAt: 1, setupCompletedAt: 1, messages: [],
  usage: { input: 1200, output: 300, costUsd: 0.42, turns: 2 },
  tasks: [{ threadId: "desk-thread", title: "Desk HQ", createdAt: 1 }],
  ...patch,
});

const view = (group: Group, ogb?: unknown) => {
  vi.stubGlobal("window", { ...globalThis.window, ogb });
  try {
    return renderToStaticMarkup(createElement(GroupView, { group }));
  } finally {
    vi.unstubAllGlobals();
  }
};
const header = (markup: string) => /<div[^>]*data-roomhead-row[\s\S]*?(?=<div[^>]*role="log"|<form|$)/.exec(markup)?.[0] ?? "";

// Every control the header shows today, by what marks it in the markup.
const CONTROLS = {
  threads: 'aria-label="All threads"',
  find: 'aria-label="Find in conversation"',
  export: 'aria-label="Export conversation"',
  turnLimit: 'data-testid="conversation-turn-limit"',
  usage: 'data-testid="group-usage-chip"',
  folder: 'title="Group working folder"',
  responder: 'aria-label="Default responder"',
  members: 'aria-label="Manage members: 9 bots in this group"',
};
const shown = (markup: string) => Object.entries(CONTROLS).filter(([, mark]) => markup.includes(mark)).map(([name]) => name);
const BULLETIN = "Desk HQ: the recruiting desk&#x27;s room.";

beforeEach(() => {
  fixture.state = { bots };
  fixture.chrome = undefined;
  fixture.dispatch.mockReset();
});

describe("the room header", () => {
  it("keeps every control and the instructions line", () => {
    const markup = view(room());
    expect(shown(header(markup))).toEqual(Object.keys(CONTROLS));
    expect(header(markup)).not.toContain("data-room-name");
    expect(markup).toContain(BULLETIN);
  });

  it("keeps today's header on a remote client, which cannot open the Room panel", () => {
    const markup = view(room(), { remoteClient: { active: true } });
    // A remote client never had the folder chip, the responder picker or Manage members.
    expect(shown(header(markup))).toEqual(["threads", "find", "export", "turnLimit", "usage"]);
    expect(header(markup)).not.toContain("data-room-name");
    expect(markup).toContain(BULLETIN);
  });

  it("leaves a DM's header as it is", () => {
    const markup = view(room({ dm: true, memberIds: ["bot-0"], name: "Desk Manager" }));
    expect(shown(header(markup))).toEqual(["find", "export", "turnLimit", "usage"]);
    expect(header(markup)).not.toContain("data-room-name");
  });

  it("leaves a room that is still being set up as it is", () => {
    const markup = view(room({ setupCompletedAt: null, setupSkippedAt: null }));
    expect(shown(header(markup))).toEqual(["find", "export", "usage", "members"]);
    expect(header(markup)).not.toContain("data-room-name");
  });
});
