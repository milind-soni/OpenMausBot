import { Children, createElement, isValidElement, type ComponentProps, type MemoExoticComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialState, type Bot } from "@/state/store";
import type { BotAvatarCrop } from "../../shared/bot-avatar";

// renderToStaticMarkup reads useShowThreads's server snapshot, which ignores
// the stored choice, so the cases flip the hook itself.
const threads = vi.hoisted(() => ({ show: true }));

// Threads are an Advanced-mode surface (Simple keeps one conversation per bot), so these render as Advanced.
vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => true,
}));
vi.mock("@/lib/thread-preferences", async (original) => ({
  ...await original<typeof import("@/lib/thread-preferences")>(),
  useShowThreads: () => threads.show,
}));
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({}),
}));

import { BotListItem, botRowProps, PinnedBotCircle, PinnedCircleThreadPanel, PinnedCircleThreadSection } from "./Sidebar";
import { PinnedBotRoster } from "./PinnedCircleThreads";
import { setPinnedCircleOrder } from "@/lib/sidebar-preferences";
import { PINNED_CIRCLE_DRAG_TYPE } from "@/lib/pinned-circle-order";
import { forgetSearchDisclosuresForTests } from "@/lib/search-disclosure";

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
  botRowProps({ ...initialState, selectedId, activeView: "chat" }, vi.fn(), candidate, { density: "comfortable", query: "", onMenu: vi.fn() });

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
    expect(markup).not.toContain("Expand Atlas threads");
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

  it("offers the thread list from the circle, closed until the chevron opens it", () => {
    const markup = renderCircle(atlas);
    const toggle = markup.match(/<button[^>]*aria-label="Expand Atlas threads"[^>]*>/)?.[0];
    expect(toggle).toContain('aria-expanded="false"');
    expect(toggle).toContain('aria-controls="pinned-circle-threads-atlas"');
    const botButton = markup.slice(markup.indexOf('data-sidebar-bot-row="atlas"'), markup.indexOf("</button>"));
    expect(botButton).not.toContain("Expand Atlas threads");
    expect(markup).not.toContain("data-sidebar-thread-row");
  });

  it("lists that circle's threads, with a way to start another", () => {
    const markup = renderToStaticMarkup(createElement(PinnedCircleThreadPanel, row(atlas)));
    expect(markup).toContain('data-sidebar-pinned-circle-thread-list="atlas"');
    expect(markup).toContain("Current");
    expect(markup).toContain("Earlier");
    expect(markup).toContain("data-sidebar-thread-row");
    expect(markup).toContain("New thread");
  });

  it("hides the circle disclosure when threads are off", () => {
    threads.show = false;
    const markup = renderCircle(atlas);
    expect(markup).not.toContain("Expand Atlas threads");
    expect(markup).not.toContain("New thread");
    expect(renderToStaticMarkup(createElement(PinnedCircleThreadPanel, row(atlas)))).not.toContain("New thread");
  });
});

describe("pinned circle order", () => {
  const atlas = bot();
  const beacon = bot({ id: "beacon", threadId: "thread-beacon", name: "Beacon" });
  const comet = bot({ id: "comet", threadId: "thread-comet", name: "Comet" });
  const names = (markup: string) => ["Atlas", "Beacon", "Comet"].sort((a, b) => markup.indexOf(`title="${a}"`) - markup.indexOf(`title="${b}"`));
  const roster = (circles: boolean) => createElement(PinnedBotRoster, { bots: [atlas, beacon, comet], density: "comfortable", circles, row: (candidate) => row(candidate), listItem: BotListItem });
  type Props = { children?: ReactNode; [key: string]: unknown };
  const find = (tree: ReactNode, match: (props: Props) => boolean): ReactElement<Props> | undefined => {
    for (const child of Children.toArray(tree)) {
      if (!isValidElement<Props>(child)) continue;
      if (match(child.props)) return child;
      const found = find(child.props.children, match);
      if (found) return found;
    }
  };
  afterEach(() => {
    setPinnedCircleOrder([]);
    vi.unstubAllGlobals();
  });

  it("lists pinned bots in the saved order in the circle grid, the pinned rows and the thread section", () => {
    expect(names(renderToStaticMarkup(roster(true)))).toEqual(["Atlas", "Beacon", "Comet"]);
    setPinnedCircleOrder(["comet", "atlas"]);
    expect(names(renderToStaticMarkup(roster(true)))).toEqual(["Comet", "Atlas", "Beacon"]);
    expect(names(renderToStaticMarkup(roster(false)))).toEqual(["Comet", "Atlas", "Beacon"]);
    expect(names(renderThreads(false, [atlas, beacon, comet]))).toEqual(["Comet", "Atlas", "Beacon"]);
  });

  it("drags a circle onto another, or moves it with Alt+Up and Alt+Down", () => {
    vi.stubGlobal("document", { documentElement: { dir: "ltr" } });
    const drag = { reorder: vi.fn(), setDragging: vi.fn(), setDrop: vi.fn() };
    const circle = (PinnedBotCircle as MemoExoticComponent<(props: ComponentProps<typeof PinnedBotCircle>) => ReactNode>).type;
    let tree: ReactNode;
    function Capture() { tree = circle({ ...row(atlas), drag, prevId: "comet", nextId: "beacon" }); return tree; }
    renderToStaticMarkup(createElement(Capture));
    const button = find(tree, (props) => props["data-sidebar-pinned-circle"] === "atlas")!;
    expect(button.props.draggable).toBe(true);
    expect(button.props["aria-keyshortcuts"]).toBe("Alt+ArrowUp Alt+ArrowDown");
    type Handler = (event: unknown) => void;
    const key = (event: Record<string, unknown>) => (button.props.onKeyDown as Handler)({ preventDefault: vi.fn(), ...event });
    key({ key: "ArrowUp", altKey: true });
    key({ key: "ArrowDown", altKey: true });
    key({ key: "ArrowUp", altKey: false });
    key({ key: "ArrowDown", altKey: true, shiftKey: true });
    expect(drag.reorder.mock.calls).toEqual([["atlas", "comet", "before"], ["atlas", "beacon", "after"]]);
    const setData = vi.fn();
    (button.props.onDragStart as Handler)({ stopPropagation: vi.fn(), dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith(PINNED_CIRCLE_DRAG_TYPE, "atlas");
    expect(drag.setDragging).toHaveBeenCalledWith("atlas");
    const rect = { left: 0, top: 0, width: 80, height: 80 };
    const dropEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 70, clientY: 40, currentTarget: { getBoundingClientRect: () => rect }, dataTransfer: { types: [PINNED_CIRCLE_DRAG_TYPE], getData: () => "comet" } };
    (button.props.onDrop as Handler)(dropEvent);
    expect(drag.reorder).toHaveBeenLastCalledWith("comet", "atlas", "after");
    (button.props.onDrop as Handler)({ ...dropEvent, dataTransfer: { types: ["application/x-openmausbot-folder"], getData: () => "comet" } });
    expect(drag.reorder).toHaveBeenCalledTimes(3);

    let still: ReactNode;
    function Plain() { still = circle(row(atlas)); return still; }
    renderToStaticMarkup(createElement(Plain));
    const plain = find(still, (props) => props["data-sidebar-pinned-circle"] === "atlas")!;
    expect(plain.props.draggable).toBe(false);
    expect(plain.props.onKeyDown).toBeUndefined();
  });

  it("saves the new order from a drop and leaves it alone when nothing moves", () => {
    let tree: ReactNode;
    function Capture() { tree = (PinnedBotRoster as (props: Parameters<typeof PinnedBotRoster>[0]) => ReactNode)(roster(true).props); return tree; }
    renderToStaticMarkup(createElement(Capture));
    const gridRow = find(tree, (props) => typeof props.circleDrag === "function")!;
    const { drag } = (gridRow.props.circleDrag as (candidate: Bot) => { drag: { reorder: (from: string, to: string, place: "before" | "after") => void } })(atlas);
    drag.reorder("comet", "atlas", "before");
    expect(names(renderToStaticMarkup(roster(true)))).toEqual(["Comet", "Atlas", "Beacon"]);
    drag.reorder("comet", "comet", "after");
    drag.reorder("gone", "atlas", "before");
    expect(names(renderToStaticMarkup(roster(true)))).toEqual(["Comet", "Atlas", "Beacon"]);
  });
});

afterEach(() => {
  threads.show = true;
  forgetSearchDisclosuresForTests();
  initialState.selectedId = "";
  initialState.activeView = "chat";
});
