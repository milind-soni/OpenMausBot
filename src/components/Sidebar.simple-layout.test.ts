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
vi.mock("@/state/store-select", async (importOriginal) => (await import("@/testing/plain-store-select")).plainStoreSelect(await importOriginal()));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) };
});

import { initialState } from "@/state/store";
import { BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId } from "@/lib/sidebar-layout";
import { SIDEBAR_COLLAPSED_SECTIONS_KEY, SIDEBAR_DENSITY_KEY, SIMPLE_SIDEBAR_WIDTH_KEY, setSidebarDensity } from "@/lib/sidebar-preferences";
import { Sidebar, TeamMenuItems } from "./Sidebar";
const drawSidebar = (Sidebar as unknown as { type: (props: import("react").ComponentProps<typeof Sidebar>) => import("react").ReactNode }).type;
import { SidebarFooter } from "./SidebarFooter";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { SidebarTileGrid } from "./SidebarTiles";
import { GlassBar, GlassScrollFrame, GlassScroller } from "./GlassScrollFrame";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { SidebarSearchButton } from "./SidebarSimpleTop";
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
  const root = drawSidebar({ open: false, onClose: () => {}, collapseToIcons }) as ReactElement<Props>;
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
  it("lists the bots with no heading, then gives group chats and a person's own departments a quiet heading with no count", () => {
    const { tree } = render();
    expect(sectionOrder(tree)).toEqual([BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId("Work")]);
    expect(listedBots(tree)).toEqual(["atlas", "bea", "dodo"]);
    const lines = headers(tree);
    expect(lines.map((header) => [header.props.name, header.props.line, "count" in header.props])).toEqual([["Group chats", true, false], ["Work", true, false]]);
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


  it("draws the same faint edge in both modes, with the same footer in both modes", () => {
    const footer = (tree: ReactElement<Props>[]) => tree.some((node) => node.type === SidebarFooter);
    const simple = render();
    expect(simple.root.props.className).toContain("border-r-[0.5px] border-edge");
    expect(simple.root.props.className).not.toContain("border-hairline");
    expect(footer(simple.tree)).toBe(true);
    fixture.values = [];
    fixture.advanced = true;
    const advanced = render();
    expect(advanced.root.props.className).toContain("border-r-[0.5px] border-edge");
    expect(footer(advanced.tree)).toBe(true);
  });

  it("still offers Add bots under an empty team", () => {
    fixture.state = { ...fixture.state, sections: ["Work", "Empty"] };
    const { tree } = render();
    expect(headers(tree).map((header) => header.props.name)).toEqual(["Group chats", "Work", "Empty"]);
    expect(labelled(tree, "Add bots to Empty")).toBe(true);
    expect(labelled(tree, "Add or remove bots in Work")).toBe(false);
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


  it("moves group chats above the bots, which then get their own heading, in either mode", () => {
    const chats = () => headers(render().tree).find((header) => header.props.name === "Group chats")!;
    expect(chats().props.reorderable).toBe(true);
    chats().props.onMove!(-1);
    const { tree } = render();
    expect(sectionOrder(tree)).toEqual([CHANNELS_SECTION_ID, BOTS_SECTION_ID, userSectionId("Work")]);
    expect(headers(tree).map((header) => header.props.name)).toEqual(["Group chats", "Bots", "Work"]);
    expect(listedBots(tree)).toEqual(["atlas", "bea", "dodo"]);
    fixture.advanced = true;
    expect(sectionOrder(render().tree)).toEqual(sectionOrder(tree));
  });

  it("never hides the heading-less bots behind a collapse saved in Advanced", () => {
    fixture.storage.set(SIDEBAR_COLLAPSED_SECTIONS_KEY, JSON.stringify([BOTS_SECTION_ID, userSectionId("Work")]));
    const { tree } = render();
    expect(listedBots(tree)).toEqual(["atlas", "bea"]);
    expect(headers(tree).find((header) => header.props.name === "Work")!.props.collapsed).toBe(true);
  });


  it.each([false, true])("uses a 280px default and the shared saved width (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    expect(render().root.props.style!["--sidebar-width"]).toBe("280px");
    expect(render().root.props.style!["--sidebar-min"]).toBe("280px");
    fixture.storage.set(SIMPLE_SIDEBAR_WIDTH_KEY, "300");
    fixture.values = [];
    expect(render().root.props.style!["--sidebar-width"]).toBe("300px");
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
    expect(tree.some((node) => node.type === SidebarSearchButton)).toBe(true);
    expect(edge(tree)?.avatars, "the rail keeps its edge, to drag it open again").toBe(true);
    expect(edge(tree)?.avatarsWidth).toBe(92);
    expect(tree.some((node) => node.props["data-sidebar-top-buttons"] !== undefined)).toBe(false);
  });

  it("separates the chief from the first bot section in the rail", () => {
    fixture.state = { ...fixture.state, bots: [bot("chief", { chiefOfStaff: true }), bot("atlas")] };
    setSidebarDensity("icons");
    const { tree } = render();
    const chief = tree.findIndex((node) => (node.props.bot as Bot | undefined)?.id === "chief");
    const line = tree.findIndex((node) => node.type === SidebarRailSeparator);
    const firstBot = tree.findIndex((node) => (node.props.bot as Bot | undefined)?.id === "atlas");
    expect(chief).toBeGreaterThanOrEqual(0);
    expect(line).toBeGreaterThan(chief);
    expect(firstBot).toBeGreaterThan(line);
  });

  it("can expand a rail that was automatically collapsed beside a panel", () => {
    const toggle = () => render(true).tree.find((node) => node.props["data-sidebar-density-toggle"])!;
    expect(toggle().props["aria-expanded"]).toBe(false);
    (toggle().props.onClick as () => void)();
    expect(toggle().props["aria-expanded"]).toBe(true);
    (toggle().props.onClick as () => void)();
    expect(toggle().props["aria-expanded"]).toBe(false);
  });

  it("puts round search and the same + menu at the foot of the rail, and dragging its edge out opens it again", () => {
    setSidebarDensity("icons");
    const footer = () => render().tree.find((node) => node.type === SimpleRailFooter)!;
    const plus = () => nodes(footer().props.children).find((node) => node.type === "button" && node.props["aria-label"] === "New or share")!;
    expect(plus().props.className).toEqual(expect.stringContaining("size-9"));
    (plus().props.onClick as () => void)();
    const menu = nodes(footer().props.children).find((node) => /\bmin-w-\[200px\]/.test(node.props.className ?? ""))!;
    expect(menu.props.className).toEqual(expect.stringContaining("bottom-0 left-full"));
    expect(menu.props.className).toEqual(expect.stringContaining("rounded-[var(--radius-menu)]"));
    const item = (label: string) => nodes(footer().props.children).find((node) => node.type === "button" && nodes(node.props.children).concat(node).some((part) => Children.toArray(part.props.children).includes(label)));
    expect(item("Add department"), "Add department is offered in both modes").toBeDefined();
    expect(item("Import…")).toBeDefined();
    expect(item("New chat")).toBeDefined();
    expect(item("New bot")).toBeDefined();
    expect(item("New group chat")).toBeDefined();
    expect(item("Templates")).toBeDefined();
    edge(render().tree)!.onAvatars(false);
    expect(fixture.storage.get(SIDEBAR_DENSITY_KEY)).toBe("comfortable");
    expect(render().tree.some((node) => node.type === SimpleRailFooter)).toBe(false);
  });

  it("New Bot makes a bot at once in both modes, Chief of Staff or not; both keep Add department and Templates", () => {
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
    expect(item("Add department")).toBeDefined();
    expect(item("Templates")).toBeDefined();
    (item("New bot")!.props.onClick as () => void)();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "newBot" }]);
  });

  const railSearch = (tree: ReactElement<Props>[]) => SidebarSearchButton({ corner: Boolean(tree.find((node) => node.type === SidebarSearchButton)!.props.corner) }).props.onClick as () => void;

  it("opens the search modal from the rail without expanding the sidebar", () => {
    setSidebarDensity("icons");
    const opened = vi.fn();
    window.addEventListener("omb:open-command-palette", opened, { once: true });
    railSearch(render().tree)();
    expect(opened).toHaveBeenCalledOnce();
    expect(render().tree.some((node) => node.type === SimpleRailFooter)).toBe(true);
  });

  it("opens the command palette when a side panel holds the sidebar collapsed", () => {
    const opened = vi.fn();
    window.addEventListener("omb:open-command-palette", opened);
    const search = railSearch(render(true).tree);
    expect(edge(render(true).tree), "no edge to drag while a side panel holds it collapsed").toBeUndefined();
    search();
    expect(opened).toHaveBeenCalledOnce();
    expect(render(true).tree.some((node) => node.type === SimpleRailFooter)).toBe(true);
  });
});
