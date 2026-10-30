import { Children, createElement, isValidElement, type KeyboardEvent, type MemoExoticComponent, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, type AppState, type Bot, type Group } from "@/state/store";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

const fixture = vi.hoisted(() => ({ advanced: false, showThreads: true, state: {} as Partial<AppState>, dispatch: vi.fn() }));
vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => fixture.advanced,
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.showThreads }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }) };
});

import { BotContextMenu, BotListItem, BotThreadList, botRowProps, GroupListItem, PinnedBotCircle, type BotRowProps } from "./Sidebar";
import { SidebarBotActivity, sidebarBotActivityTasks } from "./SidebarBotActivity";
import { forgetSearchDisclosuresForTests } from "@/lib/search-disclosure";
import { noteTurnEvent, resetTurnLive } from "@/state/turn-status";
import type { RuntimeEvent } from "../../shared/runtime-events";

const bot: Bot = {
  id: "atlas", threadId: "last-selected", name: "Atlas", title: "", description: "",
  notifications: true, color: "green", unread: true,
  modelSelection: { instanceId: "fake", model: "test" }, messages: [],
  projects: [{ id: "private-folder", name: "Quiet folder" }],
  tasks: [
    { threadId: "last-selected", title: "Last selected conversation", createdAt: 1 },
    { threadId: "idle-history", title: "Idle history", createdAt: 2, projectId: "private-folder" },
    { threadId: "approval", title: "Review permission", createdAt: 3, busy: false, activity: "waiting-on-you", projectId: "private-folder" },
    { threadId: "working", title: "Running job", createdAt: 4, busy: true, activity: "working" },
    { threadId: "queued", title: "Next job", createdAt: 5 },
    { threadId: "unread", title: "Finished reply", createdAt: 6, unread: true },
  ],
};
const densities: SidebarDensity[] = ["comfortable", "compact", "icons"];
const botRow = (BotListItem as MemoExoticComponent<(props: BotRowProps) => ReactNode>).type;
const pinnedCircle = (PinnedBotCircle as MemoExoticComponent<(props: BotRowProps) => ReactNode>).type;
const rowProps = (density: SidebarDensity, candidate: Bot = bot, query = "") =>
  botRowProps({ ...initialState, ...fixture.state }, fixture.dispatch, candidate, { density, quiet: false, query, onMenu: vi.fn() });

type ElementProps = { children?: ReactNode; onClick?: (event: MouseEvent) => void; onKeyDown?: (event: KeyboardEvent) => void; [key: string]: unknown };
function findElement(tree: ReactNode, attribute: string, value: string): ReactElement<ElementProps> | undefined {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<ElementProps>(child)) continue;
    if (child.props[attribute] === value) return child;
    const found = findElement(child.props.children, attribute, value);
    if (found) return found;
  }
}

beforeEach(() => {
  fixture.advanced = false;
  fixture.showThreads = true;
  fixture.state = { bots: [bot], selectedId: "other-bot", activeView: "chat", pendingQueued: { queued: [{ queueId: "q", text: "next" }] } };
  fixture.dispatch.mockClear();
  vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 });
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("HTMLInputElement", class {});
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("bot-first sidebar", () => {
  it.each([false, true])("uses the selected mode for bot and room tool previews (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    fixture.showThreads = false;
    const messages: Bot["messages"] = [{ id: "step", role: "bot", kind: "activity", at: 1, tool: { name: "mcp__omb__computer_batch", ok: true } }];
    const candidate = { ...bot, messages, tasks: [], projects: [] };
    const group: Group = { id: "room", threadId: "room-thread", name: "Team", memberIds: [bot.id], messages, defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1 };
    const expected = advanced ? "mcp__omb__computer_batch" : "Use the screen";
    const other = advanced ? "Use the screen" : "mcp__omb__computer_batch";
    for (const markup of [
      renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", candidate))),
      renderToStaticMarkup(createElement(GroupListItem, { group, density: "comfortable", onMenu: vi.fn() })),
    ]) {
      expect(markup).toContain(expected);
      expect(markup).not.toContain(other);
    }
  });

  it.each([
    { advanced: true, enabled: true, density: "comfortable", size: 32, spacing: ["gap-2", "py-2", "pl-6"] },
    { advanced: true, enabled: true, density: "compact", size: 26, spacing: ["gap-1.5", "py-1", "pl-6"] },
    { advanced: true, enabled: true, density: "icons", size: 44, spacing: ["justify-center", "px-1", "py-1.5"] },
    { advanced: true, enabled: false, density: "comfortable", size: 44, spacing: ["gap-3", "py-2", "pl-2.5", "pr-9"] },
    { advanced: false, enabled: false, density: "comfortable", size: 42, spacing: ["gap-2", "rounded-[10px]", "pl-2", "pr-2", "md:h-[54px]"] },
    { advanced: false, enabled: false, density: "compact", size: 36, spacing: ["gap-2.5", "py-1.5", "pl-2", "pr-9"] },
    { advanced: false, enabled: false, density: "icons", size: 36, spacing: ["h-[54px]", "justify-center"] },
  ] as const)("sizes bot portraits and row spacing in $density density with threads $enabled (advanced $advanced)", ({ advanced, enabled, density, size, spacing }) => {
    fixture.advanced = advanced;
    fixture.showThreads = enabled;
    for (const avatar of [{}, { avatarUrl: "/api/attachments/portrait.png", avatarCrop: "circle" as const }]) {
      let tree: ReactNode;
      function Capture() { tree = botRow(rowProps(density, { ...bot, ...avatar })); return tree; }
      const markup = renderToStaticMarkup(createElement(Capture));
      const row = findElement(tree, "data-sidebar-bot-row", bot.id)!;
      expect(String(row.props.className).split(" ")).toEqual(expect.arrayContaining([...spacing]));
      expect(markup).toContain(avatar.avatarUrl
        ? `width="${size}" height="${size}"`
        : `width="${size}px" height="${size}px"`);
      // Simple draws its mascot larger than the 36px it takes in the row, so the text stays where it was.
      if (!advanced && density === "comfortable") expect(markup).toContain('<span class="relative flex shrink-0 -m-[3px]">');
    }
  });

  for (const enabled of [true, false]) {
    it.each(densities)(`opens the last selected conversation on mouse or keyboard, %s density, threads ${enabled ? "on" : "off"}`, (density) => {
      fixture.showThreads = enabled;
      let tree: ReactNode;
      function Capture() { tree = botRow(rowProps(density)); return tree; }
      renderToStaticMarkup(createElement(Capture));
      const row = findElement(tree, "data-sidebar-bot-row", bot.id)!;
      row.props.onClick!({ type: "click", target: {} } as MouseEvent);
      expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: bot.id });
      expect(bot.threadId).toBe("last-selected");
      for (const key of ["Enter", " "]) {
        fixture.dispatch.mockClear();
        const preventDefault = vi.fn();
        row.props.onKeyDown!({ key, preventDefault } as unknown as KeyboardEvent);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: bot.id });
      }
    });
  }

  it.each([false, true])("uses 14px medium names in Simple comfortable rows and keeps 15px semibold otherwise (advanced %s)", (advanced) => {
    fixture.advanced = advanced;
    fixture.showThreads = false;
    const markup = renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", { ...bot, tasks: [], projects: [] })));
    const name = markup.match(/<span class="flex min-w-0 grow items-center gap-1\.5 truncate text-ink ([^"]*)"/)?.[1];
    expect(name).toBe(advanced ? "text-[15px] font-semibold leading-5" : "text-[14px] font-medium leading-5");
    expect(markup).toContain("truncate text-[13px] leading-[18px]");
  });

  it.each(["comfortable", "compact"] as const)("puts the bot's role in its name line in Advanced mode, %s density", (density) => {
    fixture.advanced = true;
    const markup = renderToStaticMarkup(createElement(BotListItem, rowProps(density, { ...bot, title: "Research" })));
    const nameLine = markup.match(/<span class="flex min-w-0 grow items-center gap-1\.5 truncate text-ink [^"]*">([\s\S]*?)<\/span><\/span><\/span>/)?.[1] ?? "";
    expect(nameLine.indexOf(">Atlas<")).toBeGreaterThan(-1);
    expect(nameLine.indexOf('data-testid="bot-role"')).toBeGreaterThan(nameLine.indexOf(">Atlas<"));
    expect(nameLine).toContain("Research");
    expect(renderToStaticMarkup(createElement(BotListItem, rowProps(density)))).not.toContain('data-testid="bot-role"');
  });

  it("ends a Simple row's preview line with its engine's faded mark, puts the unread dot at the name line's top right where ⋯ shows, and never moves the name", () => {
    fixture.showThreads = false;
    fixture.state = { ...fixture.state, instances: [{ instanceId: "fake", driverKind: "claudeAgent", displayName: "Claude" }] as unknown as AppState["instances"] };
    const candidate = { ...bot, tasks: [], projects: [], unread: true, messages: [{ id: "m", role: "bot", kind: "text", text: "Done.", at: 1 }] } as Bot;
    let tree: ReactNode;
    function Capture() { tree = botRow(rowProps("comfortable", candidate)); return tree; }
    const markup = renderToStaticMarkup(createElement(Capture));
    const line = markup.slice(markup.indexOf(">Done.<"));
    expect(line).toMatch(/^>Done\.<\/span><\/span><span data-testid="model-badge" role="img" aria-label="Model: [^"]+ \(Claude\)" class="[^"]*\bms-auto\b[^"]*"><span data-provider-mark="brand" class="[^"]*\bopacity-60\b/);
    expect(line).toMatch(/^>Done\.<\/span><\/span><span data-testid="model-badge"[^>]*><span data-provider-mark="brand"[^>]*><svg[\s\S]*?<\/svg><\/span><\/span><\/div><span class="sr-only">Unread<\/span>/);
    const name = markup.slice(markup.indexOf('class="flex items-baseline justify-between gap-2 pr-7"'), markup.indexOf(">Done.<"));
    expect(name).toMatch(/<span aria-hidden="true" data-row-dot="" class="pointer-events-none absolute right-2 top-1 flex size-7 items-center justify-center transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 touch:opacity-0 max-md:hidden"><span data-testid="unread-dot" title="Unread" class="size-2 shrink-0 rounded-full bg-accent"><\/span><\/span>/);
    expect(name).toContain('<span aria-hidden="true" title="Unread" class="size-2 shrink-0 rounded-full bg-accent hidden self-center max-md:block touch:block"></span>');
    expect(markup.match(/data-provider-mark=/g)).toHaveLength(1);
    expect(line.slice(0, line.indexOf("data-provider-mark"))).not.toContain("title=");
    expect(String(findElement(tree, "data-sidebar-bot-row", bot.id)!.props.className)).not.toContain("group-hover:pr-9");
    expect(markup).not.toContain("group-hover:pr-7");
    expect(markup).toMatch(/data-bot-actions="atlas"[^>]*class="[^"]*\bright-2 top-1 translate-y-0\b/);
  });

  it("fades the collapsed rail's engine badge in both modes", () => {
    fixture.showThreads = false;
    fixture.state = { ...fixture.state, instances: [{ instanceId: "fake", driverKind: "claudeAgent", displayName: "Claude" }] as unknown as AppState["instances"] };
    const candidate = { ...bot, tasks: [], projects: [] };
    const rail = renderToStaticMarkup(createElement(BotListItem, rowProps("icons", candidate)));
    expect(rail).toMatch(/<span data-testid="model-badge"[^>]*><span data-provider-mark="brand" class="[^"]*\bopacity-60\b/);
    fixture.advanced = true;
    const advanced = renderToStaticMarkup(createElement(BotListItem, rowProps("icons", candidate)));
    expect(advanced).toMatch(/<span data-testid="model-badge"[^>]*><span data-provider-mark="brand" class="[^"]*\bopacity-60\b/);
  });

  it("shows a waiting Simple row as an amber dot and preview, and a working one as a ring-cut dot on the avatar, with no badge or live region", () => {
    fixture.showThreads = false;
    const quiet = { ...bot, tasks: [], projects: [], unread: false };
    const waiting = renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", { ...quiet, activity: "waiting-on-you" })));
    expect(waiting).toContain('data-testid="waiting-dot" title="Waiting for you…" class="size-2 shrink-0 rounded-full bg-warning"');
    expect(waiting).not.toContain(">!<");
    expect(waiting).not.toContain("font-semibold text-warning");
    expect(waiting).not.toContain('role="status"');
    const working = renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", { ...quiet, busy: true })));
    expect(working).toContain('data-testid="working-dot" title="Working" class="absolute bottom-0.5 right-0.5 size-2 rounded-full ring-2 ring-[var(--row)] bg-success"');
    expect(working).toContain('<span class="sr-only">Working</span>');
    expect(working).not.toContain('role="status"');
    expect(working).toContain("[--row:var(--color-panel)]");
  });

  it.each([false, true])("says the step a working bot is on in place of its last message, and its last message again once done (advanced: %s)", (advanced) => {
    fixture.advanced = advanced;
    fixture.showThreads = false;
    resetTurnLive();
    const said: Bot["messages"] = [{ id: "hi", role: "bot", kind: "text", at: 1, text: "Here are the leads from Monday." }];
    const leads = { threadId: "leads", title: "Leads", createdAt: 1 };
    const candidate: Bot = { ...bot, threadId: "leads", messages: said, unread: false, projects: [], tasks: [{ ...leads, busy: true, activity: "working" }], busy: true };
    noteTurnEvent({ eventId: "e1", provider: "claudeAgent", threadId: "leads", createdAt: "2026-10-28T12:00:00.000Z", turnId: "t1",
      type: "turn.progress", activity: "command", itemId: "c1", target: "scrape.py", quiet: { kind: "busy" } } as RuntimeEvent);
    const working = renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", candidate)));
    expect(working).toContain('<span dir="auto" data-sidebar-working-phrase="" class="truncate">Running scrape.py</span>');
    expect(working, "the row's second line keeps its height: no taller dots").not.toContain("h-[1.5em]");
    expect(working).not.toContain("Monday");
    expect(working, "the row says the step alone, not how it is doing").not.toContain("busy, no output yet");
    const done = renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", { ...candidate, busy: false, tasks: [{ ...leads, busy: false, activity: "idle" }] })));
    expect(done).toContain("Here are the leads from Monday.");
    expect(done).not.toContain("scrape.py");
    resetTurnLive();
  });

  it("speaks for the conversation that is working when another one is open", () => {
    fixture.advanced = true;
    fixture.showThreads = false;
    resetTurnLive();
    const candidate: Bot = { ...bot, threadId: "open", messages: [], unread: false, projects: [], busy: true,
      tasks: [{ threadId: "open", title: "Open", createdAt: 1 }, { threadId: "leads", title: "Leads", createdAt: 2, busy: true, activity: "working" }] };
    noteTurnEvent({ eventId: "e2", provider: "codex", threadId: "leads", createdAt: "2026-10-28T12:00:00.000Z", turnId: "t1",
      type: "turn.progress", activity: "web", itemId: "w1", target: "Biber Dammbau" } as RuntimeEvent);
    expect(renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", candidate)))).toContain(">Searching the web for “Biber Dammbau”</span>");
    resetTurnLive();
  });

  it("rings a focused row or group chat inside its edge in both modes", () => {
    fixture.showThreads = false;
    const group: Group = { id: "room", threadId: "room-thread", name: "Launch", memberIds: [bot.id], messages: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1 };
    const simple = renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", { ...bot, tasks: [], projects: [] }))) + renderToStaticMarkup(createElement(GroupListItem, { group, density: "comfortable", onMenu: vi.fn() }));
    expect(simple.match(/focus-visible:outline-2 focus-visible:-outline-offset-2! focus-visible:outline-focus/g)).toHaveLength(2);
    expect(simple).not.toContain("focus-visible:ring-accent/60");
    fixture.advanced = true;
    const advanced = renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", { ...bot, tasks: [], projects: [] })));
    expect(advanced).toContain("focus-visible:outline-2 focus-visible:-outline-offset-2! focus-visible:outline-focus");
    expect(advanced).not.toContain("focus-visible:ring-accent/60");
  });

  it("hides even the selected Simple row's actions until hover or focus, where Advanced keeps them shown", () => {
    fixture.showThreads = false;
    fixture.state = { ...fixture.state, selectedId: bot.id, activeView: "chat" };
    const candidate = { ...bot, tasks: [], projects: [] };
    const simple = renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", candidate)));
    expect(simple).toContain("[--row:var(--color-raised)]");
    expect(simple).toMatch(/data-bot-actions="atlas"[^>]*class="[^"]*\bpointer-events-none opacity-0 group-hover:pointer-events-auto/);
    expect(simple).toContain('class="flex items-baseline justify-between gap-2 pr-7"');
    fixture.advanced = true;
    expect(renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", candidate)))).toMatch(/data-bot-actions="atlas"[^>]*class="[^"]*\bpointer-events-auto opacity-100/);
  });

  it("marks an unread Simple group chat with the same top-right dot as a bot row, said once for a screen reader", () => {
    const group: Group = { id: "room", threadId: "room-thread", name: "Launch", memberIds: [bot.id], messages: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: true, createdAt: 1 };
    const markup = renderToStaticMarkup(createElement(GroupListItem, { group, density: "comfortable", onMenu: vi.fn() }));
    const name = markup.slice(markup.indexOf('class="flex items-baseline justify-between gap-2 pr-7"'));
    expect(name.indexOf('data-row-dot=""')).toBeLessThan(name.indexOf("</div>"));
    expect(markup.match(/data-testid="unread-dot"/g)).toHaveLength(1);
    expect(markup).toContain('<span class="sr-only">Unread</span>');
  });

  it("draws no engine mark for a bot with no AI yet or in a group chat, and a faded one in Advanced mode", () => {
    fixture.showThreads = false;
    fixture.state = { ...fixture.state, instances: [{ instanceId: "fake", driverKind: "claudeAgent", displayName: "Claude" }] as unknown as AppState["instances"] };
    const candidate = { ...bot, tasks: [], projects: [] };
    expect(renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", { ...candidate, modelSelection: { instanceId: "none", model: "m" } })))).not.toContain("data-provider-mark");
    const group: Group = { id: "room", threadId: "room-thread", name: "Launch", memberIds: [bot.id], messages: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1 };
    expect(renderToStaticMarkup(createElement(GroupListItem, { group, density: "comfortable", onMenu: vi.fn() }))).not.toContain("data-provider-mark");
    fixture.advanced = true;
    const advanced = renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", candidate)));
    expect(advanced).toMatch(/data-testid="model-badge"[^>]*><span data-provider-mark="brand" class="[^"]*\bopacity-60\b/);
  });

  it.each(["comfortable", "compact"] as const)("keeps a Simple row to its name, preview and one faded engine mark, naming role, Chief and engine in its tooltip, %s density", (density) => {
    fixture.showThreads = false;
    const instances = [{ instanceId: "fake", driverKind: "claude", displayName: "Claude", models: { options: [{ id: "test", label: "Sonnet" }] } }] as unknown as AppState["instances"];
    fixture.state = { ...fixture.state, instances, selectedId: bot.id };
    const candidate = { ...bot, title: "Research", chiefOfStaff: true, pinned: true, tasks: [], projects: [], messages: [{ id: "m", role: "bot", kind: "text", text: "Done.", at: 1 }] } as Bot;
    let tree: ReactNode;
    function Capture() { tree = botRow(rowProps(density, candidate)); return tree; }
    const markup = renderToStaticMarkup(createElement(Capture));
    expect(markup).not.toContain('data-testid="bot-role"');
    expect(markup.match(/data-testid="model-badge"/g)).toHaveLength(1);
    expect(markup.match(/data-provider-mark=/g)).toHaveLength(1);
    if (density === "comfortable") expect(markup).toMatch(/<span class="absolute -left-1 -top-1 flex rounded-full bg-raised p-\[3px\]"><svg[^>]*role="img"[^>]*aria-label="Chief of Staff"[^>]*data-testid="chief-crown"/);
    else expect(markup).not.toContain('data-testid="chief-crown"');
    expect(markup).not.toContain("lucide-pin");
    expect(markup).not.toMatch(/tabular-nums text-ink-secondary transition-opacity group-hover:opacity-0/);
    const row = findElement(tree, "data-sidebar-bot-row", bot.id)!;
    expect(row.props.title).toBe("Atlas · Research · Chief of Staff · Model: Sonnet (Claude)");
  });

  it.each([
    { advanced: false, density: "comfortable", face: 36, spacing: ["gap-2", "rounded-[10px]", "pl-2", "pr-2", "md:h-[54px]"], name: "font-medium", preview: "text-[13px]" },
    { advanced: false, density: "icons", face: 36, spacing: ["h-[54px]", "justify-center"], name: "font-semibold", preview: "text-[11px]" },
    { advanced: true, density: "icons", face: 44, spacing: ["justify-center", "px-1", "py-1.5"], name: "font-semibold", preview: "text-[11px]" },
    { advanced: true, density: "comfortable", face: 32, spacing: ["gap-2", "py-1.5", "pl-6", "pr-9"], name: "font-semibold", preview: "text-[11px]" },
    { advanced: false, density: "compact", face: 26, spacing: ["gap-1.5", "py-1", "pl-6", "pr-9"], name: "font-semibold", preview: "text-[11px]" },
  ] as const)("sizes group chat rows in $density density (advanced $advanced)", ({ advanced, density, face, spacing, name, preview }) => {
    fixture.advanced = advanced;
    const group: Group = { id: "room", threadId: "room-thread", name: "Launch", memberIds: [bot.id], messages: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1 };
    let tree: ReactNode;
    function Capture() { tree = GroupListItem({ group, density, onMenu: vi.fn() }); return tree; }
    const markup = renderToStaticMarkup(createElement(Capture));
    const row = findElement(tree, "data-sidebar-group-row", group.id)!;
    expect(String(row.props.className).split(" ")).toEqual(expect.arrayContaining([...spacing]));
    expect(markup).toContain(`width="${face}px" height="${face}px"`);
    expect(markup).toMatch(new RegExp(`truncate text-\\[14px\\] text-ink ${name}`));
    expect(markup).toContain(`truncate text-ink-secondary ${preview}`);
  });

  it("keeps the queued dot small", () => {
    const queuedBot: Bot = {
      ...bot,
      unread: false,
      projects: [],
      tasks: [{ threadId: "queued", title: "Next job", createdAt: 5 }],
    };
    const markup = renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", queuedBot)));
    const queuedDot = markup.match(/<span[^>]*data-testid="queued-dot"[^>]*>/)?.[0] ?? "";
    expect(queuedDot).toContain("size-2.5");
    expect(queuedDot).toContain("bg-ink-secondary");
    expect(queuedDot).not.toContain("size-4");
    expect(queuedDot).not.toContain("size-5");
    expect(markup).toContain('class="truncate">Queued</span>');
    expect(markup).not.toContain("font-semibold text-warning");
    expect(markup).not.toContain("waiting-dot");
  });

  it.each(densities)("opens the thread the person last wrote in when threads are hidden, %s density", (density) => {
    const used = { ...bot, mainThreadId: "idle-history" };
    for (const enabled of [false, true]) {
      fixture.showThreads = enabled;
      const opened = enabled ? { type: "select", id: bot.id } : { type: "switchTask", botId: bot.id, threadId: "idle-history" };
      const trees: ReactNode[] = [];
      function Capture() { const tree = [botRow(rowProps(density, used)), pinnedCircle(rowProps(density, used))]; trees.push(...tree); return tree; }
      renderToStaticMarkup(createElement(Capture));
      for (const tree of trees) {
        const row = findElement(tree, "data-sidebar-bot-row", bot.id)!;
        fixture.dispatch.mockClear();
        row.props.onClick!({ type: "click", target: {} } as MouseEvent);
        expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(opened);
        if (!row.props.onKeyDown) continue;
        fixture.dispatch.mockClear();
        row.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() } as unknown as KeyboardEvent);
        expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(opened);
      }
    }
  });

  it.each(densities)("keeps selection separate from expansion in %s density", (density) => {
    fixture.state.selectedId = bot.id;
    const markup = renderToStaticMarkup(createElement(BotListItem, rowProps(density)));
    expect(markup).not.toContain("data-sidebar-thread-row");
    if (density !== "icons") expect(markup).toContain('aria-label="Expand Atlas threads" aria-expanded="false"');
  });

  it.each(densities)("with Advanced threads off, hides thread browsing and creation but keeps attention accessible in %s density", (density) => {
    fixture.advanced = true;
    fixture.showThreads = false;
    const markup = renderToStaticMarkup(createElement(BotListItem, rowProps(density)));
    expect(markup).not.toContain("data-sidebar-thread-row");
    expect(markup).not.toContain("data-sidebar-folder-row");
    expect(markup).not.toContain("Idle history");
    expect(markup).not.toContain("Quiet folder");
    expect(markup).not.toContain("New thread");
    expect(markup).not.toContain("New folder");
    expect(markup).not.toContain("Expand Atlas threads");
    expect(markup).toContain('data-testid="waiting-dot"');
    for (const id of ["approval", "working", "queued", "unread"]) expect(markup).toContain(`data-sidebar-activity-row="${id}"`);
    expect(markup).toContain('aria-label="Atlas: Review permission · Waiting for you…"');
    expect(markup).toContain('aria-label="Atlas: Next job · Queued"');
    expect(markup).toContain('aria-label="Atlas: Finished reply · Unread"');
  });

  it("removes child controls and portals from a retained hidden folder list", () => {
    const markup = renderToStaticMarkup(createElement(BotThreadList, { ...rowProps("comfortable"), selected: true, hidden: true }));
    expect(markup).toContain('hidden=""');
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("data-sidebar-thread-row");
    const shown = renderToStaticMarkup(createElement(BotThreadList, { ...rowProps("comfortable"), selected: true }));
    expect(shown).toContain('data-sidebar-folder-row="private-folder"');
    expect(shown).toContain('data-sidebar-thread-row="idle-history"');
  });

  it("only hides thread/folder creation in the bot context menu", () => {
    fixture.advanced = true;
    const render = () => renderToStaticMarkup(createElement(BotContextMenu, {
      menu: { botId: bot.id, x: 0, y: 0 }, onClose: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(), onMoveToSection: vi.fn(), onNewFolder: vi.fn(), onNewTaskFolder: vi.fn(),
    }));
    const enabled = render();
    expect(enabled).toContain("New thread");
    expect(enabled).toContain("New folder");
    expect(enabled).toContain("Delete all threads…");
    fixture.showThreads = false;
    const disabled = render();
    expect(disabled).not.toContain("New thread");
    expect(disabled).not.toContain("New folder");
    expect(disabled).toContain("Delete all threads…");
    expect(disabled).toContain("Edit Profile");
    expect(disabled).toContain("Move to department");
  });

  it("Edit profile opens the panel without naming a section", () => {
    fixture.advanced = true;
    let tree: ReactNode;
    // Called inside a render so its hooks run and the returned tree carries the items' handlers.
    function Capture() {
      tree = BotContextMenu({
        menu: { botId: bot.id, x: 0, y: 0 }, onClose: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(), onMoveToSection: vi.fn(), onNewFolder: vi.fn(), onNewTaskFolder: vi.fn(),
      });
      return tree;
    }
    const editProfile = () => {
      const items: ReactElement<ElementProps>[] = [];
      const walk = (node: ReactNode) => {
        for (const child of Children.toArray(node)) {
          if (!isValidElement<ElementProps>(child)) continue;
          if (child.props.role === "menuitem") items.push(child);
          walk(child.props.children);
        }
      };
      walk(tree);
      return items.find((item) => Children.toArray(item.props.children).includes("Edit Profile"))!;
    };
    const render = () => renderToStaticMarkup(createElement(Capture));

    render();
    editProfile().props.onClick!({} as MouseEvent);
    expect(fixture.dispatch.mock.calls).toEqual([
      [{ type: "select", id: bot.id }],
      [{ type: "toggleSettings", open: true }],
    ]);

    fixture.dispatch.mockClear();
    fixture.state.settingsOpen = true;
    render();
    editProfile().props.onClick!({} as MouseEvent);
    expect(fixture.dispatch.mock.calls).toEqual([[{ type: "select", id: bot.id }]]);

    vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768, ogb: { remoteClient: { active: true } } });
    fixture.dispatch.mockClear();
    fixture.state.settingsOpen = false;
    render();
    editProfile().props.onClick!({} as MouseEvent);
    expect(fixture.dispatch.mock.calls).toEqual([
      [{ type: "select", id: bot.id }],
      [{ type: "toggleSettings", open: true }],
    ]);
  });

  it.each(densities)("lists the bot alone in Simple mode, with no thread or activity rows under it, keeping its dots, in %s density", (density) => {
    // Its threads were left expanded in Advanced mode.
    fixture.advanced = true;
    let tree: ReactNode;
    function Capture() { tree = botRow(rowProps(density)); return tree; }
    renderToStaticMarkup(createElement(Capture));
    findElement(tree, "aria-label", "Expand Atlas threads")?.props.onClick!({} as MouseEvent);
    if (density !== "icons") expect(renderToStaticMarkup(createElement(BotListItem, rowProps(density)))).toContain('aria-label="Atlas threads"');
    fixture.advanced = false;
    fixture.showThreads = false;
    for (const query of ["", "history"]) {
      const markup = renderToStaticMarkup(createElement(BotListItem, rowProps(density, bot, query)));
      expect(markup).toContain(`data-sidebar-bot-row="${bot.id}"`);
      expect(markup).not.toContain("data-sidebar-thread-row");
      expect(markup).not.toContain("data-sidebar-folder-row");
      expect(markup).not.toContain("data-sidebar-activity-row");
      expect(markup).not.toContain("data-sidebar-bot-activity");
      expect(markup).not.toContain('aria-label="Atlas threads"');
      expect(markup).toContain('data-testid="waiting-dot"');
    }
    const unread = renderToStaticMarkup(createElement(BotListItem, rowProps(density, { ...bot, tasks: [bot.tasks![0]!, bot.tasks![5]!] })));
    expect(unread).not.toContain("data-sidebar-activity-row");
    expect(unread).toContain(density === "icons" ? "rounded-full border border-panel bg-accent" : density === "comfortable" ? 'data-testid="unread-dot"' : 'aria-label="Unread threads"');
    forgetSearchDisclosuresForTests();
  });

  it("reveals a matching sole thread when searching a bot", () => {
    fixture.advanced = true;
    const single = { ...bot, projects: [], tasks: [bot.tasks![0]], unread: false };
    const markup = renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", single, "last selected")));
    expect(markup).toContain('data-sidebar-thread-row="last-selected"');
  });

  it("does not change group collaboration histories or creation", () => {
    fixture.showThreads = false;
    const group: Group = {
      id: "group", name: "Planning", threadId: "group-thread", memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 0, messages: [],
      tasks: [{ threadId: "group-thread", title: "Group conversation", createdAt: 1 }, { threadId: "group-earlier", title: "Earlier planning", createdAt: 0 }],
    };
    fixture.state.selectedId = group.id;
    const markup = renderToStaticMarkup(createElement(GroupListItem, { group, density: "comfortable", onMenu: vi.fn() }));
    expect(markup).toContain('data-sidebar-thread-row="group-thread"');
    expect(markup).toContain('aria-label="New thread"');
    expect(markup).toContain('aria-label="Collapse Planning threads"');
    const working = renderToStaticMarkup(createElement(GroupListItem, { group: { ...group, working: true }, density: "comfortable", onMenu: vi.fn() }));
    expect(working).toMatch(/<button type="button" disabled="" aria-label="New thread"/);
    const single = renderToStaticMarkup(createElement(GroupListItem, { group: { ...group, tasks: [group.tasks![0]] }, density: "comfortable", onMenu: vi.fn() }));
    expect(single).not.toContain("Planning threads");
    expect(single).not.toContain('data-sidebar-thread-row=');
    const searched = renderToStaticMarkup(createElement(GroupListItem, {
      group: { ...group, tasks: [group.tasks![0]] }, density: "comfortable", query: "conversation", onMenu: vi.fn(),
    }));
    expect(searched).toContain('data-sidebar-thread-row="group-thread"');
  });
});

describe("group preview", () => {
  it("previews the last reply, not the digest receipt that follows it", () => {
    const group: Group = {
      id: "group", name: "Planning", threadId: "group-thread", memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 0,
      messages: [
        { id: "b1", role: "bot", kind: "text", text: "Plan drafted.", at: 2, from: { botId: "atlas", name: "Atlas", color: "green" } },
        { id: "d1", role: "bot", kind: "digest", text: "[digest] · tools: Write ×1", at: 3, digest: { turnId: "t1", tools: [{ name: "Write", count: 1 }], hookCoverage: "full" } },
      ] as Group["messages"],
      tasks: [{ threadId: "group-thread", title: "Group conversation", createdAt: 1 }],
    };
    const markup = renderToStaticMarkup(createElement(GroupListItem, { group, density: "comfortable", onMenu: vi.fn() }));
    expect(markup).toContain("Atlas: Plan drafted.");
    expect(markup).not.toContain("[digest]");
  });
});

describe("activity-only escape hatch", () => {
  it("includes waiting approvals even with busy false and never treats aggregate activity as every sibling's status", () => {
    const tasks = sidebarBotActivityTasks({ ...bot, busy: true, activity: "waiting-on-you" }, fixture.state.pendingQueued!);
    expect(tasks.map((task) => task.threadId)).toEqual(["approval", "working", "queued", "unread"]);
  });

  it("switches directly to the requested work and offers no thread-management actions", () => {
    let tree: ReactNode;
    function Capture() { tree = SidebarBotActivity({ bot, rowThreadId: bot.threadId, density: "comfortable", pendingQueued: fixture.state.pendingQueued!, dispatch: fixture.dispatch }); return tree; }
    const markup = renderToStaticMarkup(createElement(Capture));
    findElement(tree, "data-sidebar-activity-row", "approval")!.props.onClick!({} as MouseEvent);
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: bot.id, threadId: "approval" });
    expect(markup).not.toContain("Actions for");
    expect(markup).not.toContain("New thread");
    expect(markup).not.toContain("Delete");
  });

  it("removes selected and settled activity but keeps unread completed replies", () => {
    const selected = { ...bot, threadId: "approval", tasks: bot.tasks!.map((task) => task.threadId === "working" ? { ...task, busy: false, activity: "idle" as const } : task) };
    const markup = renderToStaticMarkup(createElement(SidebarBotActivity, { bot: selected, rowThreadId: selected.threadId, density: "compact", pendingQueued: fixture.state.pendingQueued!, dispatch: fixture.dispatch }));
    expect(markup).not.toContain('data-sidebar-activity-row="approval"');
    expect(markup).not.toContain('data-sidebar-activity-row="working"');
    expect(markup).toContain('data-sidebar-activity-row="unread"');
  });

  it("lists a reply in the thread a bot was left on, since its row opens the main thread", () => {
    const left: Bot = { ...bot, threadId: "left-behind", mainThreadId: "main-chat", tasks: [
      { threadId: "left-behind", title: "Routine report", createdAt: 1, unread: true },
      { threadId: "main-chat", title: "Main chat", createdAt: 2, unread: true },
    ] };
    const rows = () => {
      const markup = renderToStaticMarkup(createElement(BotListItem, rowProps("comfortable", left)));
      return ["left-behind", "main-chat"].filter((threadId) => markup.includes(`data-sidebar-activity-row="${threadId}"`));
    };
    fixture.advanced = true;
    fixture.showThreads = false;
    expect(rows()).toEqual(["left-behind"]);
    fixture.state.selectedId = left.id;
    expect(rows()).toEqual(["main-chat"]);
    fixture.showThreads = true;
    fixture.state.selectedId = "other-bot";
    expect(rows()).toEqual(["main-chat"]);
  });
});
