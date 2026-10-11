// The sidebar's other ways of opening a bot open it as its row does
// (openBot): Edit profile on another bot, a bot restored from Archived bots
// or by Undo, and the next bot after archiving the one on screen. With
// threads hidden a bot is one conversation, its main thread, so none of them
// lands on a thread an activity row or a notification left it on, where the
// person's next words would make it theirs. With threads shown they select
// the bot, as they always did.
import { Children, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, effects: [] as EffectCallback[], showThreads: false,
  state: {} as AppState, dispatch: vi.fn(), api: vi.fn(),
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
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.showThreads }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => true, setAdvancedMode: () => {} }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api: fixture.api, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) };
});

import { initialState } from "@/state/store";
import { ConfirmDialog } from "./ConfirmDialog";
import { ArchivedBotsPanel, BotContextMenu, Sidebar } from "./Sidebar";

/** A bot left on an older thread; the person last wrote in its main one. */
const left = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-left`, mainThreadId: `${id}-main`, name: id, title: "", description: "", notifications: true,
  color: "green", unread: false, modelSelection: { instanceId: "fake", model: "m" }, messages: [],
  tasks: [{ threadId: `${id}-left`, title: "Routine report", createdAt: 1, unread: true }, { threadId: `${id}-main`, title: "Main chat", createdAt: 2 }],
  ...extra,
});

type Props = { children?: ReactNode; onClick?: () => void; onRestore?: () => void; onConfirm?: () => void; onArchive?: (bot: Bot) => void; open?: boolean; role?: string; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement<Props>(child)) return [];
    return [child, ...nodes(child.props.children)];
  });
}
function render(component: () => ReactNode) {
  fixture.index = 0;
  fixture.effects = [];
  return nodes(component());
}
const label = (node: ReactElement<Props>) => Children.toArray(node.props.children).filter((child) => typeof child === "string").join("");
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
/** What opening `id` dispatches: its main thread by the switch alone with threads hidden, the bot selected with threads shown. */
const opened = (id: string) => fixture.showThreads ? { type: "select", id } : { type: "switchTask", botId: id, threadId: `${id}-main` };
const actions = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type !== "botPatched");

beforeEach(() => {
  fixture.values = [];
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  vi.stubGlobal("window", Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 800, ogb: undefined, setTimeout, clearTimeout }));
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("document", { body: {} });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe.each([false, true])("with threads shown: %s", (shown) => {
  beforeEach(() => { fixture.showThreads = shown; });

  it("opens another bot behind Edit profile as its row does, and keeps the bot on screen where it is", () => {
    fixture.state = { ...initialState, bots: [left("scout"), left("atlas")], selectedId: "scout", activeView: "chat" };
    const menu = (botId: string) => render(() => BotContextMenu({
      menu: { botId, x: 0, y: 0 }, onClose: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(), onMoveToSection: vi.fn(), onNewFolder: vi.fn(), onNewTaskFolder: vi.fn(),
    })).find((node) => node.props.role === "menuitem" && label(node) === "Edit Profile")!;
    menu("atlas").props.onClick!();
    expect(actions()).toEqual([opened("atlas"), { type: "toggleSettings", open: true, section: "identity" }]);
    fixture.dispatch.mockReset();
    menu("scout").props.onClick!();
    expect(actions()).toEqual([{ type: "select", id: "scout" }, { type: "toggleSettings", open: true, section: "identity" }]);
  });

  it("opens the next bot after archiving the one on screen, and the archived one again on Undo", async () => {
    fixture.state = { ...initialState, bots: [left("scout"), left("atlas")], selectedId: "scout", activeView: "chat" };
    fixture.api.mockImplementation(async (_path: string, init: RequestInit) => ({ bot: { ...left("scout"), ...JSON.parse(String(init.body)) } }));
    const sidebar = () => render(() => Sidebar({ open: false, onClose: () => {} }));
    sidebar().find((node) => node.type === BotContextMenu)!.props.onArchive!(fixture.state.bots[0]!);
    sidebar().find((node) => node.type === ConfirmDialog && node.props.open)!.props.onConfirm!();
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout", expect.objectContaining({ body: JSON.stringify({ hidden: true }) }));
    expect(actions()).toEqual([opened("atlas")]);
    fixture.dispatch.mockReset();
    sidebar().find((node) => node.type === "button" && label(node) === "Undo")!.props.onClick!();
    await flush();
    expect(actions()).toEqual([opened("scout")]);
  });

  it("opens a bot restored from Archived bots, and the first of all restored", async () => {
    const archived = [left("scout", { hidden: true }), left("atlas", { hidden: true })];
    fixture.state = { ...initialState, bots: [left("other"), ...archived], selectedId: "other", activeView: "chat" };
    fixture.api.mockImplementation(async (path: string) => ({ bot: left(path.split("/").at(-1)!) }));
    const panel = () => render(() => ArchivedBotsPanel({ bots: archived, onClose: vi.fn(), onRestored: vi.fn() }));
    panel().find((node) => node.props.onRestore && (node.props.bot as Bot).id === "atlas")!.props.onRestore!();
    await flush();
    expect(actions()).toEqual([opened("atlas")]);
    fixture.dispatch.mockReset();
    panel().find((node) => node.type === "button" && label(node) === "Restore all")!.props.onClick!();
    await flush();
    expect(actions()).toEqual([opened("scout")]);
  });
});
