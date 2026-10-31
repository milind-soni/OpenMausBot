import { Children, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, effects: [] as EffectCallback[], advanced: false,
  state: {} as AppState, dispatch: vi.fn(), storage: new Map<string, string>(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(fixture.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
  useLayoutEffect: () => {},
}));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./MenuMotion", () => ({
  useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "", exitProps: {} }),
  useHeldMenuMotion: (value: unknown) => ({ shown: value !== null, value, closing: false, className: "", exitProps: {} }),
}));
vi.mock("./DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  return { useDesktopCapabilities: () => ({ capabilities: initialDesktopCapabilities() }), windowFramed: () => false };
});
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.advanced }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) };
});

import { initialState } from "@/state/store";
import { BOTS_SECTION_ID, CHANNELS_SECTION_ID, PINNED_SECTION_ID, userSectionId } from "@/lib/sidebar-layout";
import { SIDEBAR_COLLAPSED_SECTIONS_KEY, SIDEBAR_DENSITY_KEY, SIDEBAR_SECTION_ORDER_KEY, SIDEBAR_WIDTH_KEY, SIMPLE_SIDEBAR_SECTION_ORDER_KEY, SIMPLE_SIDEBAR_WIDTH_KEY, setSidebarDensity } from "@/lib/sidebar-preferences";
import { Sidebar, TeamMenuItems } from "./Sidebar";
import { PinnedBotRoster } from "./PinnedCircleThreads";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { SidebarTileGrid } from "./SidebarTiles";
import { GlassBar, GlassScrollFrame, GlassScroller } from "./GlassScrollFrame";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { SidebarSearchPill, SidebarSearchToggle } from "./SidebarSimpleTop";
import { SidebarRailSeparator, SimpleRailFooter } from "./SidebarSimpleRail";

const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", notifications: true,
  color: "green", unread: false, modelSelection: { instanceId: "fake", model: "m" }, messages: [], ...extra,
});
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch room", memberIds: ["atlas"], messages: [],
  defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1,
};

type Props = { children?: ReactNode; className?: string; style?: Record<string, string>; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement<Props>(child)) return [];
    return [child, ...nodes(child.props.children)];
  });
}
function render(collapseToIcons = false) {
  fixture.index = 0;
  fixture.effects = [];
  const root = Sidebar({ open: false, onClose: () => {}, collapseToIcons }) as ReactElement<Props>;
  return { root, tree: [root, ...nodes(root.props.children)] };
}
const sectionOrder = (tree: ReactElement<Props>[]) => tree.map((node) => node.props["data-sidebar-section-id"]).filter(Boolean);
const headers = (tree: ReactElement<Props>[]) => tree.filter((node) => node.type === SidebarSectionHeader) as ReactElement<Parameters<typeof SidebarSectionHeader>[0]>[];
const listedBots = (tree: ReactElement<Props>[]) => tree.map((node) => (node.props.bot as Bot | undefined)?.id).filter(Boolean);
const labelled = (tree: ReactElement<Props>[], label: string) => tree.some((node) => node.props["aria-label"] === label);

beforeEach(() => {
  fixture.values = [];
  fixture.advanced = false;
  fixture.storage = new Map();
  fixture.dispatch.mockClear();
  fixture.state = {
    ...initialState,
    bots: [bot("atlas"), bot("bea"), bot("dodo", { section: "Work" })],
    groups: [room],
    sections: ["Work"],
  };
  vi.stubGlobal("window", Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 800, ogb: undefined, setTimeout, clearTimeout }));
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => fixture.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { fixture.storage.set(key, value); },
    removeItem: (key: string) => { fixture.storage.delete(key); },
  });
});
afterEach(() => {
  setSidebarDensity("comfortable");
  vi.unstubAllGlobals();
});

describe("Simple-mode sidebar layout", () => {
  it("lists the bots with no heading, then gives group chats and a person's own departments a quiet heading with a count", () => {
    const { tree } = render();
    expect(sectionOrder(tree)).toEqual([BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId("Work")]);
    expect(listedBots(tree)).toEqual(["atlas", "bea", "dodo"]);
    const lines = headers(tree);
    expect(lines.map((header) => [header.props.name, header.props.line, header.props.count])).toEqual([["Group chats", true, 1], ["Work", true, 1]]);
    expect(lines[0]!.props.onMenu).toBeUndefined();
    expect(lines[1]!.props.onDelete).toBeUndefined();
    expect(lines[1]!.props.onMenu).toBeTypeOf("function");
    expect(labelled(tree, "Add or remove bots in Work")).toBe(false);
    expect(tree.some((node) => node.type === SidebarTileGrid)).toBe(false);
  });

  it("shows the Chief and the pinned bots as tiles above the rows, with no Pinned or Bots heading", () => {
    fixture.state = { ...fixture.state, bots: [bot("chief", { chiefOfStaff: true, pinned: true }), bot("atlas", { pinned: true }), bot("bea"), bot("dodo", { section: "Work", pinned: true })] };
    const { tree } = render();
    const grid = tree.find((node) => node.type === SidebarTileGrid)!.props as Parameters<typeof SidebarTileGrid>[0];
    expect(grid.primary?.id).toBe("chief");
    expect(grid.pinned.map((candidate) => candidate.id)).toEqual(["atlas", "dodo"]);
    expect(sectionOrder(tree)).toEqual([BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId("Work")]);
    expect(listedBots(tree)).toEqual(["bea"]);
    expect(headers(tree).map((header) => header.props.name)).toEqual(["Group chats", "Work"]);
  });

  it("fades the list's edges in both modes, with the top buttons and the tiles fixed above it", () => {
    fixture.state = { ...fixture.state, bots: [bot("chief", { chiefOfStaff: true, pinned: true }), bot("atlas", { pinned: true }), bot("bea")] };
    const simple = render();
    expect(simple.tree.find((node) => node.type === GlassScrollFrame)!.props.fade).toBe(true);
    const head = simple.tree.find((node) => node.type === GlassBar && node.props.edge === "top")!;
    expect(nodes(head.props.children).some((node) => node.type === SidebarTileGrid)).toBe(true);
    const list = simple.tree.find((node) => node.type === GlassScroller)!;
    expect(nodes(list.props.children).some((node) => node.type === SidebarTileGrid)).toBe(false);
    expect(simple.root.props.className).toContain("max-md:[--scroll-fade-surface:var(--color-app)]");
    fixture.advanced = true;
    const advanced = render();
    expect(advanced.tree.find((node) => node.type === GlassScrollFrame)!.props.fade).toBe(true);
    expect(advanced.root.props.className).toContain("max-md:[--scroll-fade-surface:var(--color-app)]");
  });

  it("keeps Advanced's Pinned heading and rows, with the Chief as a row", () => {
    fixture.advanced = true;
    fixture.state = { ...fixture.state, bots: [bot("chief", { chiefOfStaff: true }), bot("atlas", { pinned: true }), bot("bea")] };
    const { tree } = render();
    expect(tree.some((node) => node.type === SidebarTileGrid)).toBe(false);
    expect(sectionOrder(tree)).toContain(PINNED_SECTION_ID);
    expect(listedBots(tree)).toEqual(["chief", "bea"]);
    const roster = tree.find((node) => node.type === PinnedBotRoster)!.props as Parameters<typeof PinnedBotRoster>[0];
    expect(roster.bots.map((candidate) => candidate.id)).toEqual(["atlas"]);
    expect(headers(tree).map((header) => header.props.name)).toContain("Pinned");
  });

  it("draws the same faint edge in both modes, with the Simple footer in Simple mode and Advanced's footer in Advanced", () => {
    const footer = (tree: ReactElement<Props>[]) => (tree.find((node) => node.type === SidebarFooter)!.props as Parameters<typeof SidebarFooter>[0]).simple;
    const simple = render();
    expect(simple.root.props.className).toContain("border-r border-ink/[0.04]");
    expect(simple.root.props.className).not.toContain("border-hairline");
    expect(footer(simple.tree)).toBe(true);
    fixture.values = [];
    fixture.advanced = true;
    const advanced = render();
    expect(advanced.root.props.className).toContain("border-r border-ink/[0.04]");
    expect(footer(advanced.tree)).toBe(false);
  });

  it("still offers Add bots under an empty team", () => {
    fixture.state = { ...fixture.state, sections: ["Work", "Empty"] };
    const { tree } = render();
    expect(headers(tree).map((header) => header.props.name)).toEqual(["Group chats", "Work", "Empty"]);
    expect(labelled(tree, "Add bots to Empty")).toBe(true);
    expect(labelled(tree, "Add or remove bots in Work")).toBe(false);
  });

  it("keeps Advanced's headings, trash button and order", () => {
    fixture.advanced = true;
    const { tree } = render();
    expect(sectionOrder(tree)).toEqual([CHANNELS_SECTION_ID, BOTS_SECTION_ID, userSectionId("Work")]);
    const all = headers(tree);
    expect(all.map((header) => header.props.name)).toEqual(["Group chats", "Bots", "Work"]);
    for (const header of all) {
      expect(header.props.line).toBe(false);
      expect(header.props.onMenu).toBeUndefined();
    }
    expect(all[2]!.props.onDelete).toBeTypeOf("function");
    expect(labelled(tree, "Add or remove bots in Work")).toBe(true);
  });

  it("opens the team menu from the line's ⋯ button, under it, with every team action", () => {
    const work = () => headers(render().tree).find((header) => header.props.name === "Work")!;
    const button = { getBoundingClientRect: () => ({ right: 280, bottom: 300 }), focus: vi.fn(), isConnected: true } as unknown as HTMLButtonElement;
    expect(work().props.menuOpen).toBe(false);
    work().props.onMenu!(button);
    const { tree } = render();
    expect(work().props.menuOpen).toBe(true);
    const menu = tree.find((node) => node.props.role === "menu")!;
    expect(menu.props["aria-label"]).toBe("Work");
    expect(menu.props.style).toEqual({ left: 24, top: 304 });
    const items = tree.find((node) => node.type === TeamMenuItems)!.props as Parameters<typeof TeamMenuItems>[0];
    for (const action of ["onAddBots", "onRename", "onShare", "onDelete"] as const) expect(items[action]).toBeTypeOf("function");
  });

  it("starts from the shared order for the departments, and a Simple move is saved for Simple only", () => {
    fixture.state = { ...fixture.state, sections: ["Work", "Home"] };
    const saved = [userSectionId("Home"), CHANNELS_SECTION_ID, BOTS_SECTION_ID, userSectionId("Work")];
    fixture.storage.set(SIDEBAR_SECTION_ORDER_KEY, JSON.stringify(saved));
    expect(sectionOrder(render().tree)).toEqual([BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId("Home"), userSectionId("Work")]);
    const work = () => headers(render().tree).find((header) => header.props.name === "Work")!;
    expect(work().props.reorderable).toBe(true);
    work().props.onMove!(-1);
    const moved = [BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId("Work"), userSectionId("Home")];
    expect(JSON.parse(fixture.storage.get(SIMPLE_SIDEBAR_SECTION_ORDER_KEY)!)).toEqual(moved);
    expect(JSON.parse(fixture.storage.get(SIDEBAR_SECTION_ORDER_KEY)!)).toEqual(saved);
    expect(sectionOrder(render().tree)).toEqual(moved);
  });

  it("moves group chats above the bots, which then get their own heading, and leaves Advanced's order alone", () => {
    const chats = () => headers(render().tree).find((header) => header.props.name === "Group chats")!;
    expect(chats().props.reorderable).toBe(true);
    chats().props.onMove!(-1);
    const { tree } = render();
    expect(sectionOrder(tree)).toEqual([CHANNELS_SECTION_ID, BOTS_SECTION_ID, userSectionId("Work")]);
    expect(headers(tree).map((header) => header.props.name)).toEqual(["Group chats", "Bots", "Work"]);
    expect(listedBots(tree)).toEqual(["atlas", "bea", "dodo"]);
    expect(fixture.storage.get(SIDEBAR_SECTION_ORDER_KEY)).toBeUndefined();
  });

  it("never hides the heading-less bots behind a collapse saved in Advanced", () => {
    fixture.storage.set(SIDEBAR_COLLAPSED_SECTIONS_KEY, JSON.stringify([BOTS_SECTION_ID, userSectionId("Work")]));
    const { tree } = render();
    expect(listedBots(tree)).toEqual(["atlas", "bea"]);
    expect(headers(tree).find((header) => header.props.name === "Work")!.props.collapsed).toBe(true);
  });

  it("toggles a search pill from the round search button, and closing it clears the filter", () => {
    const toggle = () => render().tree.find((node) => node.type === SidebarSearchToggle)!.props as Parameters<typeof SidebarSearchToggle>[0];
    const pill = () => render().tree.find((node) => node.type === SidebarSearchPill)?.props as Parameters<typeof SidebarSearchPill>[0] | undefined;
    expect(render().tree.some((node) => node.props["aria-label"] === "Search bots and messages" && node.type === "input")).toBe(false);
    expect(pill()).toBeUndefined();
    expect(toggle().open).toBe(false);
    toggle().onToggle();
    expect(toggle().open).toBe(true);
    pill()!.onQuery("bea");
    expect(pill()!.query).toBe("bea");
    expect(listedBots(render().tree)).toEqual(["bea"]);
    pill()!.onClose();
    expect(pill()).toBeUndefined();
    expect(listedBots(render().tree)).toEqual(["atlas", "bea", "dodo"]);
    toggle().onToggle();
    pill()!.onQuery("atlas");
    toggle().onToggle();
    expect(pill()).toBeUndefined();
    expect(listedBots(render().tree)).toHaveLength(3);
  });

  it("opens at 280px in Simple and 320px in Advanced, each remembering its own resized width", () => {
    const width = () => render().root.props.style!["--sidebar-width"];
    expect(width()).toBe("280px");
    expect(render().root.props.className).toContain("w-[280px]");
    fixture.values = [];
    fixture.advanced = true;
    expect(width()).toBe("320px");
    fixture.storage.set(SIDEBAR_WIDTH_KEY, "360");
    fixture.storage.set(SIMPLE_SIDEBAR_WIDTH_KEY, "300");
    fixture.values = [];
    expect(width()).toBe("360px");
    fixture.values = [];
    fixture.advanced = false;
    expect(width()).toBe("300px");
    const handle = render().tree.find((node) => node.type === SidebarResizeHandle)!.props as Parameters<typeof SidebarResizeHandle>[0];
    expect(handle.sizing.defaultWidth).toBe(280);
    expect(handle.sizing.valueNow).toBe(300);
    fixture.storage.set(SIMPLE_SIDEBAR_WIDTH_KEY, "460");
    fixture.values = [];
    expect(width()).toBe("400px");
    fixture.storage.set(SIMPLE_SIDEBAR_WIDTH_KEY, "300");
    fixture.values = [];
    fixture.advanced = true;
    render();
    for (const effect of fixture.effects) {
      try { effect(); } catch {}
    }
    expect(width()).toBe("360px");
  });
  const edge = (tree: ReactElement<Props>[]) => tree.find((node) => node.type === SidebarResizeHandle)?.props as Parameters<typeof SidebarResizeHandle>[0] | undefined;

  it("becomes a rail when its edge is dragged narrow, keeping the Simple order with a hairline between sections", () => {
    const handle = edge(render().tree)!;
    expect(handle.avatars).toBe(false);
    handle.onAvatars(true);
    expect(fixture.storage.get(SIDEBAR_DENSITY_KEY)).toBe("avatars");
    const { root, tree } = render();
    expect(root.props.className).toContain("w-[92px]");
    expect(sectionOrder(tree)).toEqual([BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId("Work")]);
    expect(listedBots(tree)).toEqual(["atlas", "bea", "dodo"]);
    expect(headers(tree)).toEqual([]);
    expect(tree.filter((node) => node.type === SidebarRailSeparator)).toHaveLength(2);
    expect(tree.some((node) => node.type === SidebarSearchToggle)).toBe(false);
    expect(edge(tree)?.avatars, "the rail keeps its edge, to drag it open again").toBe(true);
    expect(edge(tree)?.avatarsWidth).toBe(92);
    expect(tree.some((node) => node.props["data-sidebar-top-buttons"] !== undefined)).toBe(false);
  });

  it("puts round search and the same + menu at the top of the rail, and dragging its edge out opens it again", () => {
    setSidebarDensity("icons");
    const top = () => render().tree.find((node) => node.props["data-sidebar-rail-top"] !== undefined)!;
    const plus = () => nodes(top().props.children).find((node) => node.type === "button" && node.props["aria-label"] === "New or share")!;
    expect(plus().props.className).toEqual(expect.stringContaining("size-9"));
    (plus().props.onClick as () => void)();
    const menu = nodes(top().props.children).find((node) => /\bmin-w-\[200px\]/.test(node.props.className ?? ""))!;
    expect(menu.props.className).toEqual(expect.stringContaining("left-full top-0"));
    expect(menu.props.className).toEqual(expect.stringContaining("rounded-[var(--radius-menu)]"));
    const item = (label: string) => nodes(top().props.children).find((node) => node.type === "button" && nodes(node.props.children).concat(node).some((part) => Children.toArray(part.props.children).includes(label)));
    expect(item("Create department"), "Simple makes a department from its bots, by dragging one onto another or from a bot's menu").toBeUndefined();
    expect(item("New chat"), "a new conversation starts from the bot panel").toBeUndefined();
    expect(item("New bot")).toBeDefined();
    expect(item("New group chat")).toBeDefined();
    expect(item("Templates")).toBeDefined();
    edge(render().tree)!.onAvatars(false);
    expect(fixture.storage.get(SIDEBAR_DENSITY_KEY)).toBe("comfortable");
    expect(render().tree.some((node) => node.type === SimpleRailFooter)).toBe(false);
  });

  it("New Bot makes a bot at once in both modes, Chief of Staff or not; Advanced keeps Create department and Templates", () => {
    fixture.state = { ...fixture.state, bots: [bot("atlas", { chiefOfStaff: true }), bot("bea")] };
    const openMenu = () => {
      const plus = () => render().tree.find((node) => node.type === "button" && node.props["aria-label"] === "New or share")!;
      (plus().props.onClick as () => void)();
      const tree = render().tree;
      return (label: string) => tree.find((node) => node.type === "button" && nodes(node.props.children).concat(node).some((part) => Children.toArray(part.props.children).includes(label)));
    };
    (openMenu()("New bot")!.props.onClick as () => void)();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "newBot" }]);
    fixture.dispatch.mockClear();
    fixture.values = [];
    fixture.advanced = true;
    const item = openMenu();
    expect(item("Create department")).toBeDefined();
    expect(item("Templates")).toBeDefined();
    (item("New Bot")!.props.onClick as () => void)();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "newBot" }]);
  });

  const railSearch = (tree: ReactElement<Props>[]) => tree.find((node) => node.type === "button" && node.props["aria-label"] === "Search bots and messages")!.props.onClick as () => void;

  it("opens the search pill from the rail's search button by expanding the sidebar", () => {
    setSidebarDensity("icons");
    expect(render().tree.some((node) => node.type === SidebarSearchPill)).toBe(false);
    railSearch(render().tree)();
    const { tree } = render();
    expect(tree.some((node) => node.type === SimpleRailFooter)).toBe(false);
    expect(tree.some((node) => node.type === SidebarSearchPill)).toBe(true);
  });

  it("opens the command palette instead when a side panel holds the sidebar collapsed", () => {
    const opened = vi.fn();
    window.addEventListener("omb:open-command-palette", opened);
    const search = railSearch(render(true).tree);
    expect(edge(render(true).tree), "no edge to drag while a side panel holds it collapsed").toBeUndefined();
    search();
    expect(opened).toHaveBeenCalledOnce();
    expect(render(true).tree.some((node) => node.type === SimpleRailFooter)).toBe(true);
  });
});
