import { Children, createElement, isValidElement, type KeyboardEvent, type MemoExoticComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialState, type Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

import { BotListItem, botRowProps } from "./Sidebar";
import { SidebarBotTile, SidebarTileGrid } from "./SidebarTiles";

const bot = (extra: Partial<Bot> = {}): Bot => ({
  id: "mausbot", threadId: "t", name: "MausBot", title: "", description: "", notifications: true, color: "chrome",
  unread: false, modelSelection: { instanceId: "fake", model: "m" }, messages: [], ...extra,
});
const dispatch = vi.fn();
const onMenu = vi.fn();
const props = (candidate: Bot, selected = false) => botRowProps({ ...initialState, bots: [candidate], selectedId: selected ? candidate.id : "", activeView: "chat" }, dispatch, candidate, { density: "comfortable", onMenu });
const tile = (SidebarBotTile as MemoExoticComponent<(props: Parameters<typeof SidebarBotTile>[0]) => ReactNode>).type;

type Props = { children?: ReactNode; [key: string]: unknown };
function find(tree: ReactNode, attribute: string): ReactElement<Props> | undefined {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<Props>(child)) continue;
    if (child.props[attribute] !== undefined) return child;
    const found = find(child.props.children, attribute);
    if (found) return found;
  }
}

beforeEach(() => {
  dispatch.mockClear();
  onMenu.mockClear();
  vi.stubGlobal("window", { innerWidth: 1280, innerHeight: 800 });
  vi.stubGlobal("HTMLInputElement", class {});
});
afterEach(() => vi.unstubAllGlobals());

describe("the sidebar tiles", () => {
  it.each([true, false])("draws the main tile and a pinned tile the same: 78 by 92, radius 8, a 56px avatar over a one-line 13px medium name (main %s)", (primary) => {
    const html = renderToStaticMarkup(createElement(SidebarBotTile, { ...props(bot({ chiefOfStaff: primary })), primary }));
    expect(html).toMatch(new RegExp(`data-sidebar-tile="${primary ? "primary" : "pinned"}"[^>]*class="[^"]*\\bh-\\[92px\\] w-\\[78px\\][^"]*\\brounded-\\[8px\\]`));
    expect(html).toContain('width="56px" height="56px"');
    expect(html).toMatch(/truncate text-center text-\[13px\] font-medium leading-4 text-ink"[^>]*>MausBot</);
    expect(html).not.toContain("data-provider-mark");
  });

  it("gives the crown to the main tile only, and only when it is the Chief", () => {
    const tileHtml = (extra: Partial<Bot>, primary: boolean) => renderToStaticMarkup(createElement(SidebarBotTile, { ...props(bot(extra)), primary }));
    const main = tileHtml({ chiefOfStaff: true }, true);
    expect(main).toContain('data-testid="chief-badge"');
    expect(main).toContain('title="MausBot · Chief of Staff"');
    expect(tileHtml({ chiefOfStaff: true }, false)).not.toContain('data-testid="chief-badge"');
    expect(tileHtml({}, true)).not.toContain('data-testid="chief-badge"');
  });

  it("fills the selected tile and marks it current, and shows working, waiting and unread as a dot on the avatar", () => {
    const selected = renderToStaticMarkup(createElement(SidebarBotTile, { ...props(bot(), true), primary: true }));
    expect(selected).toContain('aria-current="page"');
    expect(selected).toContain("[--tile:var(--color-raised)]");
    expect(renderToStaticMarkup(createElement(SidebarBotTile, props(bot({ busy: true }))))).toContain('data-testid="working-dot"');
    expect(renderToStaticMarkup(createElement(SidebarBotTile, props(bot({ activity: "waiting-on-you" }))))).toContain('data-testid="waiting-dot"');
    const unread = renderToStaticMarkup(createElement(SidebarBotTile, props(bot({ unread: true }))));
    expect(unread).toContain('data-testid="unread-dot"');
    expect(unread).toContain('aria-label="MausBot · Unread"');
  });

  it("shows a failed last turn as a red dot on the tile and on a Simple row, never the orange waiting one", () => {
    const failed = bot({ messages: [{ id: "e1", role: "bot", kind: "activity", at: 2, tool: { name: "error: The site did not answer.", ok: false } }] as Bot["messages"] });
    const html = renderToStaticMarkup(createElement(SidebarBotTile, props(failed)));
    expect(html).toMatch(/data-testid="failed-dot"[^>]*class="[^"]*\bbg-danger\b/);
    expect(html).toContain('aria-label="MausBot · Ran into a problem"');
    expect(html).not.toContain('data-testid="waiting-dot"');
    const row = renderToStaticMarkup(createElement(BotListItem, props(failed)));
    expect(row).toMatch(/data-testid="failed-dot"[^>]*class="[^"]*\bbg-danger\b/);
    expect(row).not.toContain('data-testid="waiting-dot"');
    expect(row).toContain('<span class="sr-only">Ran into a problem</span>');
  });

  it("opens the bot on Enter and its menu from the ContextMenu key", () => {
    let tree: ReactNode;
    function Capture() { tree = tile({ ...props(bot()), primary: true }); return tree; }
    renderToStaticMarkup(createElement(Capture));
    const element = find(tree, "data-sidebar-tile")!;
    const key = (name: string) => (element.props.onKeyDown as (event: KeyboardEvent) => void)({
      key: name, shiftKey: false, preventDefault: vi.fn(), currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 94, height: 92 }) },
    } as unknown as KeyboardEvent);
    key("Enter");
    expect(dispatch).toHaveBeenCalledWith({ type: "select", id: "mausbot" });
    key("ContextMenu");
    expect(onMenu).toHaveBeenCalledWith({ botId: "mausbot", x: 57, y: 66 });
  });
});

describe("a tile with a dot", () => {
  it("opens the main chat even when the dot marks background work", () => {
    const withWork = bot({ threadId: "main", mainThreadId: "main", unread: true, tasks: [{ threadId: "main", title: "Main", createdAt: 1 }, { threadId: "work", title: "@Scout · work", createdAt: 2, unread: true }] });
    let tree: ReactNode;
    function Capture() { tree = tile({ ...props(withWork), primary: true }); return tree; }
    renderToStaticMarkup(createElement(Capture));
    (find(tree, "data-sidebar-tile")!.props.onKeyDown as (event: KeyboardEvent) => void)({ key: "Enter", preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(dispatch.mock.calls).toEqual([[{ type: "select", id: "mausbot" }]]);
  });
});

it("shows the pin after the name on a desktop bot row", () => {
  const pinned = props(bot({ pinned: true }));
  const desktop = renderToStaticMarkup(createElement(BotListItem, pinned));
  const phone = renderToStaticMarkup(createElement(BotListItem, { ...pinned, phoneHome: true }));
  expect(desktop).toMatch(/MausBot<\/[^>]+><svg[^>]+aria-label="Pinned"/);
  expect(phone).not.toContain('aria-label="Pinned"');
});

describe("the primary tile container", () => {
  it("shows the Chief tile when a primary bot exists", () => {
    const primary = bot({ chiefOfStaff: true });
    const row = (candidate: Bot) => botRowProps({ ...initialState, bots: [primary], selectedId: "", activeView: "chat" }, dispatch, candidate, { density: "comfortable", onMenu });
    expect(renderToStaticMarkup(createElement(SidebarTileGrid, { primary, row }))).toContain('data-sidebar-tile="primary"');
    expect(renderToStaticMarkup(createElement(SidebarTileGrid, { primary: null, row }))).toBe("");
  });
});
