import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialState, type Bot } from "@/state/store";
import type { BotAvatarCrop } from "../../shared/bot-avatar";

// Threads are an Advanced-mode surface: Simple mode keeps one conversation
// per bot (useShowThreads), so these render as Advanced.
vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => true,
}));
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));

import { botRowProps, PinnedBotCircle, PinnedCircleThreadSection } from "./Sidebar";

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "atlas",
  threadId: "thread-atlas",
  name: "Atlas",
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  pinned: true,
  modelSelection: { instanceId: "claude", model: "test" },
  messages: [],
  ...overrides,
});

const frame = (markup: string) => {
  const match = markup.match(/class="flex size-16 items-center justify-center overflow-hidden[^"]*" style="([^"]*)"/);
  expect(match, markup).not.toBeNull();
  return match![0];
};

const row = (candidate: Bot, selectedId = initialState.selectedId) =>
  botRowProps({ ...initialState, selectedId, activeView: "chat" }, vi.fn(), candidate, { density: "comfortable", quiet: false, query: "", onMenu: vi.fn() });

function renderCircle(candidate: Bot, selected = false) {
  return renderToStaticMarkup(createElement(PinnedBotCircle, row(candidate, selected ? candidate.id : initialState.selectedId)));
}

function renderThreads(collapsed: boolean, bots: Bot[]) {
  return renderToStaticMarkup(createElement(PinnedCircleThreadSection, {
    bots,
    collapsed,
    onToggle: () => {},
    row: (candidate) => row(candidate),
  }));
}

describe("pinned circle frame", () => {
  it.each([
    ["circle", "50%"],
    ["rounded", "22%"],
    ["square", "0"],
    ["mascot", "0"],
  ] as const)("keeps a %s crop (%s) and does not force rounded-full", (crop: BotAvatarCrop, radius: string) => {
    const markup = renderCircle(bot({
      avatarCrop: crop,
      avatarUrl: crop === "mascot" ? undefined : "/api/attachments/cat.webp",
    }));
    const clipped = frame(markup);
    expect(clipped).toContain(`border-radius:${radius}`);
    expect(clipped).not.toContain("rounded-full");
    expect(markup).not.toContain("rounded-full");
  });

  it("draws the selection ring on the same crop as the frame", () => {
    const markup = renderCircle(bot({
      avatarCrop: "rounded",
      avatarUrl: "/api/attachments/cat.webp",
    }), true);
    const clipped = frame(markup);
    expect(clipped).toContain("ring-2");
    expect(clipped).toContain("ring-accent");
    expect(clipped).toContain("border-radius:22%");
    expect(clipped).not.toContain("rounded-full");
  });
});

describe("pinned circle thread list", () => {
  const atlas = bot({
    tasks: [
      { threadId: "thread-atlas", title: "Current", createdAt: 2 },
      { threadId: "thread-earlier", title: "Earlier", createdAt: 1 },
    ] as Bot["tasks"],
  });
  const beacon = bot({ id: "beacon", threadId: "thread-beacon", name: "Beacon" });

  it("stays closed, without a second circle grid or a reorder handle", () => {
    const markup = renderThreads(true, [atlas, beacon]);
    expect(markup).toContain('data-sidebar-pinned-circle-threads=""');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Expand Pinned");
    expect(markup).not.toContain("Atlas");
    expect(markup).not.toContain("Beacon");
    expect(markup).not.toContain("data-sidebar-pinned-circles");
    expect(markup).not.toContain("Drag to reorder");
  });

  it("opens the same pinned bots as rows, in circle order, with the thread menu", () => {
    const markup = renderThreads(false, [atlas, beacon]);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Collapse Pinned");
    expect(markup.indexOf("Atlas")).toBeLessThan(markup.indexOf("Beacon"));
    expect(markup).toContain('aria-label="Actions for Atlas"');
    expect(markup).toContain("Expand Atlas threads");
    expect(markup).not.toContain("data-sidebar-pinned-circles");
    expect(markup).not.toContain("Drag to reorder");
  });
});

afterEach(() => {
  initialState.selectedId = "";
  initialState.activeView = "chat";
});
