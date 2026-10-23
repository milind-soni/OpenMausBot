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
vi.mock("./MenuMotion", () => ({
  useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "", exitProps: {} }),
  useHeldMenuMotion: (value: unknown) => ({ shown: value !== null, value, closing: false, className: "", exitProps: {} }),
}));
vi.mock("./DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  return { useDesktopCapabilities: () => ({ capabilities: initialDesktopCapabilities() }) };
});
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.advanced }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) };
});

import { initialState } from "@/state/store";
import { BOTS_SECTION_ID, CHANNELS_SECTION_ID, PINNED_SECTION_ID, userSectionId } from "@/lib/sidebar-layout";
import { SIDEBAR_COLLAPSED_SECTIONS_KEY, SIDEBAR_DENSITY_KEY, SIDEBAR_SECTION_ORDER_KEY, SIDEBAR_WIDTH_KEY, SIMPLE_SIDEBAR_WIDTH_KEY, setSidebarDensity } from "@/lib/sidebar-preferences";
import { Sidebar, TeamMenuItems } from "./Sidebar";
import { SidebarResizeHandle } from "./SidebarResizeHandle";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { SidebarEdgeToggle, SidebarSearchPill, SidebarSearchToggle } from "./SidebarSimpleTop";
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
  it("lists ungrouped bots first with no heading, then Group chats and teams as thin lines", () => {
    const { tree } = render();
    expect(sectionOrder(tree)).toEqual([BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId("Work")]);
    expect(listedBots(tree)).toEqual(["atlas", "bea", "dodo"]);
    const lines = headers(tree);
    expect(lines.map((header) => header.props.name)).toEqual(["Group chats", "Work"]);
    for (const header of lines) {
      expect(header.props.line).toBe(true);
      expect(header.props.onDelete).toBeUndefined();
    }
    expect(lines[0]!.props.onMenu).toBeUndefined();
    expect(lines[1]!.props.onMenu).toBeTypeOf("function");
    expect(labelled(tree, "Add or remove bots in Work")).toBe(false);
  });

  it("names the bots with a thin line only when pinned bots sit above them", () => {
    fixture.state = { ...fixture.state, bots: [bot("atlas", { pinned: true }), bot("bea"), bot("dodo", { section: "Work" })] };
    const { tree } = render();
    expect(sectionOrder(tree)).toEqual([PINNED_SECTION_ID, BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId("Work")]);
    const lines = headers(tree);
    expect(lines.map((header) => header.props.name)).toEqual(["Pinned", "Bots", "Group chats", "Work"]);
    expect(lines.map((header) => header.props.reorderable)).toEqual([false, false, true, true]);
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

  it("keeps a saved order for the other sections and writes a Simple move back without moving Bots", () => {
    const saved = [userSectionId("Work"), CHANNELS_SECTION_ID, BOTS_SECTION_ID];
    fixture.storage.set(SIDEBAR_SECTION_ORDER_KEY, JSON.stringify(saved));
    expect(sectionOrder(render().tree)).toEqual([BOTS_SECTION_ID, userSectionId("Work"), CHANNELS_SECTION_ID]);
    const channels = () => headers(render().tree).find((header) => header.props.name === "Group chats")!;
    expect(channels().props.reorderable).toBe(true);
    channels().props.onMove!(-1);
    expect(JSON.parse(fixture.storage.get(SIDEBAR_SECTION_ORDER_KEY)!)).toEqual([CHANNELS_SECTION_ID, userSectionId("Work"), BOTS_SECTION_ID]);
    expect(sectionOrder(render().tree)).toEqual([BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId("Work")]);
    channels().props.onMove!(-1);
    expect(JSON.parse(fixture.storage.get(SIDEBAR_SECTION_ORDER_KEY)!)).toEqual([CHANNELS_SECTION_ID, userSectionId("Work"), BOTS_SECTION_ID]);
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

  it("opens at 288px in Simple and 320px in Advanced, each remembering its own resized width", () => {
    const width = () => render().root.props.style!["--sidebar-width"];
    expect(width()).toBe("288px");
    expect(render().root.props.className).toContain("w-[288px]");
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
    expect(handle.sizing.defaultWidth).toBe(288);
    expect(handle.sizing.valueNow).toBe(300);
    fixture.advanced = true;
    render();
    for (const effect of fixture.effects) {
      try { effect(); } catch {}
    }
    expect(width()).toBe("360px");
  });
  it("collapses to a rail from the edge bump, keeping the Simple order with a hairline between sections", () => {
    const toggle = render().tree.find((node) => node.type === SidebarEdgeToggle)!.props as Parameters<typeof SidebarEdgeToggle>[0];
    expect(toggle.collapsed).toBe(false);
    toggle.onToggle();
    expect(fixture.storage.get(SIDEBAR_DENSITY_KEY)).toBe("icons");
    const { root, tree } = render();
    expect(root.props.className).toContain("w-[92px]");
    expect(sectionOrder(tree)).toEqual([BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId("Work")]);
    expect(listedBots(tree)).toEqual(["atlas", "bea", "dodo"]);
    expect(headers(tree)).toEqual([]);
    expect(tree.filter((node) => node.type === SidebarRailSeparator)).toHaveLength(2);
    expect(tree.some((node) => node.type === SidebarSearchToggle)).toBe(false);
    expect((tree.find((node) => node.type === SidebarEdgeToggle)!.props as Parameters<typeof SidebarEdgeToggle>[0]).collapsed).toBe(true);
    expect(tree.some((node) => node.props["data-sidebar-top-buttons"] !== undefined)).toBe(false);
  });

  it("puts search and the same + menu at the foot of the rail, and the edge bump expands it again", () => {
    setSidebarDensity("icons");
    const footer = () => render().tree.find((node) => node.type === SimpleRailFooter)!.props as Parameters<typeof SimpleRailFooter>[0];
    const plus = () => nodes(footer().plus).find((node) => node.type === "button" && node.props["aria-label"] === "New or share")!;
    (plus().props.onClick as () => void)();
    const menu = nodes(footer().plus).find((node) => /\bw-52\b/.test(node.props.className ?? ""))!;
    expect(menu.props.className).toEqual(expect.stringContaining("bottom-0 left-full"));
    const item = (label: string) => nodes(footer().plus).find((node) => node.type === "button" && nodes(node.props.children).concat(node).some((part) => Children.toArray(part.props.children).includes(label)));
    expect(item("Create department"), "Simple mode never asks the person to design a department").toBeUndefined();
    expect(item("Templates")).toBeUndefined();
    expect(item("New Bot")).toBeDefined();
    (render().tree.find((node) => node.type === SidebarEdgeToggle)!.props as Parameters<typeof SidebarEdgeToggle>[0]).onToggle();
    expect(fixture.storage.get(SIDEBAR_DENSITY_KEY)).toBe("comfortable");
    expect(render().tree.some((node) => node.type === SimpleRailFooter)).toBe(false);
  });

  it("New Bot opens the form in both modes, Chief of Staff or not; Advanced keeps Create department and Templates", () => {
    fixture.state = { ...fixture.state, bots: [bot("atlas", { chiefOfStaff: true }), bot("bea")] };
    const openMenu = () => {
      const plus = () => render().tree.find((node) => node.type === "button" && node.props["aria-label"] === "New or share")!;
      (plus().props.onClick as () => void)();
      const tree = render().tree;
      return (label: string) => tree.find((node) => node.type === "button" && nodes(node.props.children).concat(node).some((part) => Children.toArray(part.props.children).includes(label)));
    };
    (openMenu()("New Bot")!.props.onClick as () => void)();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "toggleNewBot", open: true }]);
    fixture.dispatch.mockClear();
    fixture.values = [];
    fixture.advanced = true;
    const item = openMenu();
    expect(item("Create department")).toBeDefined();
    expect(item("Templates")).toBeDefined();
    (item("New Bot")!.props.onClick as () => void)();
    expect(fixture.dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "toggleNewBot", open: true }]);
  });

  it("opens the search pill from the rail's search button by expanding the sidebar", () => {
    setSidebarDensity("icons");
    expect(render().tree.some((node) => node.type === SidebarSearchPill)).toBe(false);
    (render().tree.find((node) => node.type === SimpleRailFooter)!.props as Parameters<typeof SimpleRailFooter>[0]).onSearch();
    const { tree } = render();
    expect(tree.some((node) => node.type === SimpleRailFooter)).toBe(false);
    expect(tree.some((node) => node.type === SidebarSearchPill)).toBe(true);
  });

  it("opens the command palette instead when a side panel holds the sidebar collapsed", () => {
    const opened = vi.fn();
    window.addEventListener("omb:open-command-palette", opened);
    const footer = render(true).tree.find((node) => node.type === SimpleRailFooter)!.props as Parameters<typeof SimpleRailFooter>[0];
    expect(render(true).tree.some((node) => node.type === SidebarEdgeToggle)).toBe(false);
    footer.onSearch();
    expect(opened).toHaveBeenCalledOnce();
    expect(render(true).tree.some((node) => node.type === SimpleRailFooter)).toBe(true);
  });
});
