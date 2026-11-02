import { Children, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, AppState, Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, advanced: false, phone: false, admin: null as boolean | null,
  state: {} as AppState, dispatch: vi.fn(), storage: new Map<string, string>(),
  requests: [] as Array<{ path: string; method: string; body: unknown }>,
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
  useEffect: (_effect: EffectCallback) => {},
  useLayoutEffect: () => {},
}));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("./MenuMotion", () => ({
  useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "", exitProps: {} }),
  useHeldMenuMotion: (value: unknown) => ({ shown: value !== null, value, closing: false, className: "", exitProps: {} }),
}));
vi.mock("./DesktopCapabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./DesktopCapabilities")>();
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  return {
    ...actual,
    useDesktopCapabilities: () => ({ capabilities: initialDesktopCapabilities(), ready: true }),
  };
});
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.advanced }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) };
});

import { initialState } from "@/state/store";
import { BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId } from "@/lib/sidebar-layout";
import { PHONE_LAYOUT } from "@/lib/use-media-query";
import { BotContextMenu, BotListItem, Sidebar, TeamMenuItems } from "./Sidebar";
import { NEW_DEPARTMENT } from "./SidebarBotDrag";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { ConfirmDialog } from "./ConfirmDialog";
import { TeamDialog } from "./TeamDialog";

const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", notifications: true,
  color: "green", unread: false, modelSelection: { instanceId: "fake", model: "m" }, messages: [], ...extra,
});
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch room", memberIds: ["atlas"], messages: [],
  defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1,
};

type Props = { children?: ReactNode; [key: string]: unknown };
type RowProps = Parameters<typeof BotListItem>[0];
type HeaderProps = Parameters<typeof SidebarSectionHeader>[0];
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement<Props>(child)) return [];
    return [child, ...nodes(child.props.children)];
  });
}
function render() {
  fixture.index = 0;
  const root = Sidebar({ open: false, onClose: () => {} }) as ReactElement<Props>;
  return [root, ...nodes(root.props.children)];
}
const rows = () => render().filter((node) => node.type === BotListItem).map((node) => node.props as unknown as RowProps);
const row = (id: string) => rows().find((props) => props.bot.id === id)!;
const listed = () => rows().map((props) => props.bot.id);
const sections = () => render().map((node) => node.props["data-sidebar-section-id"]).filter(Boolean);
const section = (id: string) => render().find((node) => node.props["data-sidebar-section-id"] === id)!.props as unknown as {
  onDragOver: (event: unknown) => void; onDrop: (event: unknown) => void; children: ReactNode;
};
const headers = () => render().filter((node) => node.type === SidebarSectionHeader).map((node) => node.props as unknown as HeaderProps);
const header = (name: string) => headers().find((props) => props.name === name)!;
const actions = () => fixture.dispatch.mock.calls.map(([action]) => action as Action);

function transfer() {
  const data = new Map<string, string>();
  return { types: [] as string[], effectAllowed: "", dropEffect: "", setData(type: string, value: string) { data.set(type, value); this.types.push(type); }, getData: (type: string) => data.get(type) ?? "" };
}
let carried = transfer();
/** The bot rows a section's drop zone finds under it, each 54px tall from `top`. */
let rowElements: Array<{ dataset: { sidebarBotRow: string }; getBoundingClientRect: () => { top: number; bottom: number; height: number } }> = [];
const laidOut = (...ids: string[]) => {
  rowElements = ids.map((id, index) => ({ dataset: { sidebarBotRow: id }, getBoundingClientRect: () => ({ top: 30 + index * 56, bottom: 84 + index * 56, height: 54 }) }));
};
/** A drag event `offset` pixels into a 54px row. */
const at = (offset = 27) => ({
  dataTransfer: carried, clientY: offset, currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 54 }), querySelectorAll: () => rowElements },
  preventDefault: vi.fn(), stopPropagation: vi.fn(),
});
function drag(id: string) {
  carried = transfer();
  row(id).botDrag!.row(id).onDragStart(at() as never);
}

beforeEach(() => {
  fixture.values = [];
  fixture.advanced = false;
  fixture.phone = false;
  fixture.admin = null;
  fixture.storage = new Map();
  fixture.requests = [];
  rowElements = [];
  fixture.dispatch.mockClear();
  fixture.state = {
    ...initialState,
    bots: [bot("atlas"), bot("bea"), bot("cleo"), bot("dodo", { section: "Work" }), bot("echo", { section: "Work" })],
    groups: [room],
    sections: ["Work"],
  };
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    innerWidth: 1280, innerHeight: 800, ogb: undefined, setTimeout, clearTimeout,
    matchMedia: (query: string) => ({ matches: fixture.phone && query === PHONE_LAYOUT, addEventListener() {}, removeEventListener() {} }),
  }));
  vi.stubGlobal("document", { body: {}, querySelector: () => null });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    fixture.requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ sections: ["Clients"], botIds: [] }), { status: 200 });
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => fixture.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { fixture.storage.set(key, value); },
    removeItem: (key: string) => { fixture.storage.delete(key); },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Simple's sidebar before anyone drags", () => {
  it("looks as it did: the same sections and rows, nothing marked, each row ready to drag", () => {
    expect(sections()).toEqual([BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId("Work")]);
    expect(listed()).toEqual(["atlas", "bea", "cleo", "dodo", "echo"]);
    for (const props of rows()) {
      expect(props.botDrop).toBeNull();
      expect(props.botDragging).toBe(false);
      expect(props.botDrag!.row(props.bot.id).draggable).toBe(true);
    }
    expect(headers().every((props) => !props.dropInto && !props.naming)).toBe(true);
  });

  it("leaves rows still on a phone, where the menu moves them", () => {
    fixture.phone = true;
    expect(rows().every((props) => props.botDrag === undefined)).toBe(true);
  });
});

describe("dragging a bot", () => {
  it("shows a line where it lands and saves the new order", () => {
    drag("cleo");
    expect(row("cleo").botDragging).toBe(true);
    row("atlas").botDrag!.row("atlas").onDragOver(at(5) as never);
    expect(row("atlas").botDrop).toBe("before");
    row("atlas").botDrag!.row("atlas").onDrop(at(5) as never);
    expect(actions()).toEqual([{ type: "botsOrdered", botIds: ["cleo", "atlas", "bea"] }]);
    expect(fixture.requests).toEqual([{ path: "/api/bots/order", method: "PUT", body: { botIds: ["cleo", "atlas", "bea"] } }]);
    expect(rows().every((props) => !props.botDrop && !props.botDragging)).toBe(true);
  });

  it("onto the middle of a bot puts both in a new department, named in place, and Enter keeps the name", () => {
    drag("cleo");
    row("atlas").botDrag!.row("atlas").onDragOver(at() as never);
    expect(row("atlas").botDrop).toBe("group");
    row("atlas").botDrag!.row("atlas").onDrop(at() as never);
    expect(actions()).toEqual([]);
    expect(sections()).toEqual([BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId("Work"), userSectionId(NEW_DEPARTMENT)]);
    const naming = header(NEW_DEPARTMENT).naming!;
    expect(naming.value).toBe("New department");
    expect(naming.label).toBe("New department name");
    expect(listed()).toEqual(["bea", "dodo", "echo", "atlas", "cleo"]);
    naming.onCommit("  ");
    expect(actions()).toEqual([
      { type: "updateBot", botId: "atlas", patch: { section: "New department" } },
      { type: "updateBot", botId: "cleo", patch: { section: "New department" } },
    ]);
    expect(sections()).not.toContain(userSectionId(NEW_DEPARTMENT));
  });

  it("gives a new department the first free name, and Escape puts the bots back", () => {
    fixture.state = { ...fixture.state, sections: ["Work", "New department"] };
    drag("cleo");
    row("bea").botDrag!.row("bea").onDrop(at() as never);
    expect(header(NEW_DEPARTMENT).naming!.value).toBe("New department 2");
    drag("atlas");
    const over = at();
    section(userSectionId(NEW_DEPARTMENT)).onDragOver(over as never);
    expect(over.preventDefault).not.toHaveBeenCalled();
    expect(header(NEW_DEPARTMENT).dropInto).toBe(false);
    header(NEW_DEPARTMENT).naming!.onCancel();
    expect(listed()).toEqual(["atlas", "bea", "cleo", "dodo", "echo"]);
    expect(actions()).toEqual([]);
  });

  it("into a department over its heading, or between its rows", () => {
    drag("atlas");
    section(userSectionId("Work")).onDragOver(at() as never);
    expect(header("Work").dropInto).toBe(true);
    section(userSectionId("Work")).onDrop(at() as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "atlas", patch: { section: "Work" } }, { type: "botsOrdered", botIds: ["dodo", "echo", "atlas"] }]);
    fixture.dispatch.mockClear();
    drag("bea");
    row("echo").botDrag!.row("echo").onDragOver(at(26) as never);
    expect(row("echo").botDrop).toBe("before");
    row("echo").botDrag!.row("echo").onDrop(at(26) as never);
    expect(actions()).toEqual([
      { type: "updateBot", botId: "bea", patch: { section: "Work" } },
      { type: "botsOrdered", botIds: ["dodo", "bea", "echo"] },
    ]);
  });

  it("between rows or under the last one, by the nearest row; over a department's heading, into it", () => {
    drag("atlas");
    laidOut("dodo", "echo");
    section(userSectionId("Work")).onDragOver(at(10) as never);
    expect(header("Work").dropInto).toBe(true);
    section(userSectionId("Work")).onDragOver(at(85) as never);
    expect([header("Work").dropInto, row("echo").botDrop]).toEqual([false, "before"]);
    section(userSectionId("Work")).onDragOver(at(400) as never);
    expect(row("echo").botDrop).toBe("after");
    section(userSectionId("Work")).onDrop(at(85) as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "atlas", patch: { section: "Work" } }, { type: "botsOrdered", botIds: ["dodo", "atlas", "echo"] }]);
    fixture.dispatch.mockClear();
    drag("cleo");
    laidOut("atlas", "bea", "cleo");
    section(BOTS_SECTION_ID).onDragOver(at(85) as never);
    expect(row("bea").botDrop).toBe("before");
    section(BOTS_SECTION_ID).onDragOver(at(170) as never);
    expect(rows().some((props) => props.botDrop)).toBe(false);
  });

  it("out of a department to the end of the main list, or a place in it", () => {
    drag("echo");
    section(BOTS_SECTION_ID).onDragOver(at() as never);
    expect(row("cleo").botDrop).toBe("after");
    section(BOTS_SECTION_ID).onDrop(at() as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "echo", patch: { section: "" } }]);
    expect(fixture.requests).toEqual([]);
    fixture.dispatch.mockClear();
    drag("dodo");
    row("bea").botDrag!.row("bea").onDrop(at(50) as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "dodo", patch: { section: "" } }, { type: "botsOrdered", botIds: ["atlas", "bea", "dodo", "cleo"] }]);
  });

  it("offers a place to drop it out when every row is in a department", () => {
    fixture.state = { ...fixture.state, bots: fixture.state.bots.map((candidate) => ({ ...candidate, section: "Work" })) };
    expect(sections()).not.toContain(BOTS_SECTION_ID);
    drag("dodo");
    expect(sections()[0]).toBe(BOTS_SECTION_ID);
    section(BOTS_SECTION_ID).onDragOver(at() as never);
    expect(render().some((node) => node.props["data-bot-drop-slot"] !== undefined)).toBe(true);
    section(BOTS_SECTION_ID).onDrop(at() as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "dodo", patch: { section: "" } }]);
    expect(sections()).not.toContain(BOTS_SECTION_ID);
  });

  it("never drops on group chats, and hands a heading's drag to the section order", () => {
    drag("atlas");
    const event = at();
    section(CHANNELS_SECTION_ID).onDragOver(event as never);
    expect(event.preventDefault).not.toHaveBeenCalled();
    section(CHANNELS_SECTION_ID).onDrop(event as never);
    expect(actions()).toEqual([]);
    expect(rows().every((props) => !props.botDragging)).toBe(true);
  });

  it("moves with Alt+Up/Down within its list and says where it went", () => {
    row("bea").botDrag!.step("bea", 1);
    expect(actions()).toEqual([{ type: "botsOrdered", botIds: ["atlas", "cleo", "bea"] }]);
    const live = render().find((node) => node.props["aria-live"] === "polite")!;
    expect(live.props.children).toBe("bea moved to position 3 of 3");
    fixture.dispatch.mockClear();
    row("atlas").botDrag!.step("atlas", -1);
    expect(actions()).toEqual([]);
  });

  it("works the same in Advanced, where the bots' list has a heading", () => {
    fixture.advanced = true;
    drag("dodo");
    row("atlas").botDrag!.row("atlas").onDrop(at() as never);
    expect(header(NEW_DEPARTMENT).naming!.value).toBe("New department");
  });
});

describe("who may drag a bot: whoever the bot menu offers Move to department", () => {
  it("gives a Team Cloud member without the admin scope no row to drag and no Alt+Up/Down, and starts no drag", () => {
    const drawnEarlier = row("atlas").botDrag!;
    fixture.admin = false;
    expect(listed()).toEqual(["atlas", "bea", "cleo", "dodo", "echo"]);
    expect(rows().map((props) => props.botDrag)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    carried = transfer();
    drawnEarlier.row("atlas").onDragStart(at() as never);
    drawnEarlier.step("atlas", 1);
    expect(carried.types).toEqual([]);
    expect(actions()).toEqual([]);
  });

  it("drops nothing from a drag begun before the session said they are a member", () => {
    drag("atlas");
    fixture.admin = false;
    section(userSectionId("Work")).onDragOver(at() as never);
    section(userSectionId("Work")).onDrop(at() as never);
    expect(actions()).toEqual([]);
    expect(fixture.requests).toEqual([]);
  });

  it("lets an admin drag", () => {
    fixture.admin = true;
    for (const props of rows()) expect(props.botDrag!.row(props.bot.id).draggable).toBe(true);
    drag("atlas");
    section(userSectionId("Work")).onDrop(at() as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "atlas", patch: { section: "Work" } }, { type: "botsOrdered", botIds: ["dodo", "echo", "atlas"] }]);
  });
});

describe("a department's menu in Simple", () => {
  const openMenu = (name: string) => {
    const button = { getBoundingClientRect: () => ({ right: 280, bottom: 300 }), focus: vi.fn(), isConnected: true } as unknown as HTMLButtonElement;
    header(name).onMenu!(button);
    return render().find((node) => node.type === TeamMenuItems)!.props as unknown as Parameters<typeof TeamMenuItems>[0];
  };

  it("renames it in place", async () => {
    openMenu("Work").onRename();
    expect(render().some((node) => node.type === TeamDialog)).toBe(false);
    const naming = header("Work").naming!;
    expect([naming.value, naming.label]).toEqual(["Work", "Rename Work department"]);
    naming.onCommit("Clients");
    await vi.waitFor(() => expect(actions()).toEqual([{ type: "sections", sections: ["Clients"] }]));
    expect(fixture.requests).toEqual([{ path: "/api/sidebar-sections?section=Work", method: "PATCH", body: { name: "Clients" } }]);
  });

  it("deletes it saying the bots stay, out of any department", () => {
    openMenu("Work").onDelete();
    const dialog = render().find((node) => node.type === ConfirmDialog && node.props.open === true)!;
    expect(dialog.props.body).toBe("Its bots and group chats stay, with their conversations, outside any department. The department and its shared instructions are deleted. This cannot be undone.");
  });

  it("keeps Advanced's rename dialog", () => {
    fixture.advanced = true;
    const button = { getBoundingClientRect: () => ({ right: 280, bottom: 300 }), focus: vi.fn(), isConnected: true } as unknown as HTMLButtonElement;
    const work = render().find((node) => node.type === SidebarSectionHeader && (node.props as unknown as HeaderProps).name === "Work")!.props as unknown as HeaderProps;
    work.onContextMenu!({ preventDefault: () => {}, clientX: 10, clientY: 10, currentTarget: { querySelector: () => button } } as never);
    (render().find((node) => node.type === TeamMenuItems)!.props as unknown as Parameters<typeof TeamMenuItems>[0]).onRename();
    expect(render().some((node) => node.type === TeamDialog)).toBe(true);
    expect(header("Work").naming).toBeUndefined();
  });
});

describe("a bot's menu in Simple", () => {
  type MenuProps = Parameters<typeof BotContextMenu>[0];
  const menuProps = (botId: string, extra: Partial<MenuProps> = {}): MenuProps => ({
    menu: { botId, x: 0, y: 0 }, onClose: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(), onMoveToSection: vi.fn(),
    onNewFolder: vi.fn(), onNewTaskFolder: vi.fn(), onNewSection: vi.fn(), ...extra,
  });
  const open = (props: MenuProps) => {
    fixture.index = 0;
    const tree = nodes(BotContextMenu(props));
    const move = tree.find((node) => node.props["data-bot-menu-move"] !== undefined)!;
    (move.props.onClick as (event: { detail: number }) => void)({ detail: 1 });
    fixture.index = 0;
    const flyout = nodes(BotContextMenu(props)).find((node) => node.props["data-bot-menu-flyout"] === "move")!;
    return nodes(flyout.props.children).filter((node) => node.props.role === "menuitem");
  };
  const label = (node: ReactElement<Props>) => nodes(node.props.children).length
    ? Children.toArray(node.props.children).filter((part) => typeof part === "string").join("") : String(node.props.children);

  it("moves it to a department, a new one or out of one, from Move to department", () => {
    fixture.state = { ...fixture.state, sections: ["Work", "Home"] };
    const props = menuProps("dodo");
    const items = open(props);
    expect(items.map(label)).toEqual(["Work", "Home", "New department…", "Remove from department"]);
    expect(items[0]!.props.disabled).toBe(true);
    (items[1]!.props.onClick as () => void)();
    (items[3]!.props.onClick as () => void)();
    expect(actions()).toEqual([
      { type: "updateBot", botId: "dodo", patch: { section: "Home" } },
      { type: "updateBot", botId: "dodo", patch: { section: "" } },
    ]);
    (items[2]!.props.onClick as () => void)();
    expect(props.onNewSection).toHaveBeenCalledWith("dodo");
  });

  it("offers only New department… to a bot in none, when there are no departments yet", () => {
    fixture.state = { ...fixture.state, sections: [], bots: [bot("atlas"), bot("bea")] };
    expect(open(menuProps("atlas")).map(label)).toEqual(["New department…"]);
  });
});

describe("deleting a Chief of Staff", () => {
  type MenuProps = Parameters<typeof BotContextMenu>[0];
  const askToDelete = (target: Bot) => (render().find((node) => node.type === BotContextMenu)!.props as unknown as MenuProps).onDelete(target);
  const openDialog = () => render().find((node) => node.type === ConfirmDialog && node.props.open === true);

  it("offers Archive first, which keeps its chats, and archives it as an ordinary bot", async () => {
    const chief = bot("atlas", { chiefOfStaff: true });
    fixture.state = { ...fixture.state, bots: [chief, bot("bea")] };
    askToDelete(chief);
    const dialog = openDialog()!;
    expect(dialog.props.body).toContain("Archive it instead to keep every conversation");
    const alternative = dialog.props.alternative as { label: string; onClick: () => void };
    expect(alternative.label).toBe("Archive instead");
    alternative.onClick();
    await vi.waitFor(() => expect(fixture.requests).toContainEqual({ path: "/api/bots/atlas", method: "PATCH", body: { hidden: true, chiefOfStaff: false } }));
    expect(openDialog()).toBeUndefined();
  });

  it("offers nothing else for any other bot, or for the last bot there is", () => {
    askToDelete(bot("bea"));
    expect(openDialog()!.props.alternative).toBeUndefined();
    const chief = bot("atlas", { chiefOfStaff: true });
    fixture.values = [];
    fixture.state = { ...fixture.state, bots: [chief] };
    askToDelete(chief);
    expect(openDialog()!.props.alternative).toBeUndefined();
  });
});
