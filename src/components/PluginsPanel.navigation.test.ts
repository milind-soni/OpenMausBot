import { Children, createElement, isValidElement, type DependencyList, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { api } from "@/state/store";

// PluginsPanel's own state, seeded by call order: effects never run under server rendering, so the catalog is placed as
// a finished fetch would leave it.
const fixture = vi.hoisted(() => ({
  surface: "apps" as "apps" | "mcp",
  dispatch: vi.fn(),
  track: vi.fn(),
  bots: [] as unknown[],
  instances: [] as unknown[],
  overrides: new Map<number, unknown>(),
  index: 0,
  counting: false,
  effects: [] as Array<{ effect: EffectCallback; deps?: DependencyList }>,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useEffect: (effect: EffectCallback, deps?: DependencyList) => { fixture.effects.push({ effect, deps }); },
    useState: (initial: unknown) => {
      if (!fixture.counting) return react.useState(initial);
      const index = fixture.index++;
      const seeded = fixture.overrides.has(index) ? fixture.overrides.get(index) : typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [seeded, (value: unknown) => {
        const current = fixture.overrides.has(index) ? fixture.overrides.get(index) : seeded;
        fixture.overrides.set(index, typeof value === "function" ? (value as (current: unknown) => unknown)(current) : value);
      }];
    },
  };
});
vi.mock("@/state/store", () => ({
  api: vi.fn(() => new Promise(() => {})),
  useStore: () => ({
    state: { pluginsSurface: fixture.surface, bots: fixture.bots, instances: fixture.instances },
    dispatch: fixture.dispatch,
  }),
}));
vi.mock("./McpServersPanel", () => ({
  McpServersPanel: ({ embedded, whopCard }: { embedded?: boolean; whopCard?: boolean }) => whopCard
    ? createElement("div", { "data-whop-card": true }, "Connect Whop")
    : createElement("div", { "data-embedded": String(Boolean(embedded)) }, "MCP inventory"),
}));
vi.mock("@/lib/analytics", () => ({ track: fixture.track }));
vi.mock("./Avatar", () => ({ BotAvatar: ({ bot }: { bot: Bot }) => createElement("span", { "data-avatar": bot.id }) }));
// The native HighLevel card has its own DOM suite; here it is a marker so tile counts stay the catalog's.
vi.mock("./HighLevelCard", () => ({
  HighLevelCard: () => createElement("div", { "data-highlevel-card": true }, "Connect HighLevel"),
}));
vi.mock("./XCard", () => ({
  X_CARD_SEARCH: "x twitter treg tweets posts",
  XCard: () => createElement("div", { "data-x-card": true }, "X (Twitter)"),
}));
import { APPS_PREVIEW_COUNT, PluginsPanel, USED_BY_AVATAR_SIZE, botsUsingService } from "./PluginsPanel";
import { FACE_BOX } from "./cursor-face-data";
import { MASCOT_BODIES } from "../../shared/mascot-bodies";

const CARDS = 0;
const CONFIGURED = 3;
const STATUS = 6;
const PHASE = 13;
const HIGHLEVEL_CONNECTED = 21;
const X_CONNECTED = 22;
const MODE = 4;
const SEARCH = 15;
const TAB = 16;

type Node = ReactElement<{ children?: ReactNode; "aria-pressed"?: boolean; "data-apps-filter"?: string; onClick?: () => void; [key: string]: unknown }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function render() {
  let tree!: ReturnType<typeof PluginsPanel>;
  function Capture() {
    fixture.index = 0;
    fixture.counting = true;
    try { tree = PluginsPanel(); } finally { fixture.counting = false; }
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
const chip = (tree: Node[], id: string) => tree.find((node) => node.props["data-apps-filter"] === id)!;
const card = (slug: string) => ({ slug, label: slug[0]!.toUpperCase() + slug.slice(1), blurb: `${slug} things`, logo: null, domain: null });
const claude = { instanceId: "claude", capabilities: { composioMcp: true } } as unknown as InstanceInfo;
const bot = (id: string, extra: Partial<Bot> = {}) => ({ id, name: id, hidden: false, modelSelection: { instanceId: "claude", model: "m" }, ...extra }) as unknown as Bot;

beforeEach(() => {
  vi.stubGlobal("window", {});
  fixture.surface = "apps";
  fixture.dispatch.mockReset();
  fixture.track.mockReset();
  fixture.effects = [];
  fixture.bots = [];
  fixture.instances = [];
  fixture.overrides = new Map<number, unknown>([
    [CARDS, [card("gmail"), card("slack"), card("notion")]],
    [CONFIGURED, true],
    [STATUS, { slack: { connected: true, accounts: [{ id: "ca_1", status: "ACTIVE" }] } }],
    [PHASE, "ready"],
  ]);
});
afterEach(() => vi.unstubAllGlobals());

describe("Apps pop-up", () => {
  it("connects Whop inside the apps grid without a Composio key or MCP detour", () => {
    fixture.overrides.set(CONFIGURED, false);
    const { html, nodes: tree } = render();
    expect(html).toContain("Connect Whop");
    expect(html).not.toContain("Set up Whop");
    const grid = tree.find((node) => node.props["data-apps-grid"] !== undefined)!;
    expect(nodes(grid).some((node) => node.props.whopCard === true)).toBe(true);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
  it("counts Whop among connected apps", () => {
    fixture.overrides.set(18, true);
    const { html } = render();
    expect(html).toContain("2 connected");
  });
  it("shows the native HighLevel card in the grid and counts it once connected", () => {
    const { html, nodes: tree } = render();
    const grid = tree.find((node) => node.props["data-apps-grid"] !== undefined)!;
    expect(nodes(grid).some((node) => node.props.onConnection !== undefined && node.props.refreshKey !== undefined)).toBe(true);
    expect(html).toContain("Connect HighLevel");
    expect(html).toContain("1 connected");
    fixture.overrides.set(HIGHLEVEL_CONNECTED, true);
    expect(render().html).toContain("2 connected");
  });
  it("hides HighLevel from the Connected tab until it is connected, and from a search that does not name it", () => {
    fixture.overrides.set(16, "connected");
    fixture.overrides.set(HIGHLEVEL_CONNECTED, false);
    const wrapper = (tree: Node[]) => tree.find((node) => node.props["data-native-card"] === "highlevel")!;
    expect(wrapper(render().nodes).props.className).toBe("hidden");
    fixture.overrides.set(HIGHLEVEL_CONNECTED, true);
    expect(wrapper(render().nodes).props.className).toBe("contents");
    fixture.overrides.set(16, "marketplace");
    fixture.overrides.set(15, "growably");
    expect(wrapper(render().nodes).props.className).toBe("contents");
    fixture.overrides.set(15, "zendesk");
    expect(wrapper(render().nodes).props.className).toBe("hidden");
  });
  it("shows the X card in the grid for every install and counts it once bots have X", () => {
    const wrapper = (tree: Node[]) => tree.find((node) => node.props["data-native-card"] === "x")!;
    const { html, nodes: tree } = render();
    expect(nodes(wrapper(tree)).some((node) => node.props.onConnection !== undefined && node.props.refreshKey !== undefined)).toBe(true);
    expect(wrapper(tree).props.className).toBe("contents");
    expect(html).toContain("1 connected");
    fixture.overrides.set(X_CONNECTED, true);
    expect(render().html).toContain("2 connected");
    fixture.overrides.set(TAB, "connected");
    expect(wrapper(render().nodes).props.className).toBe("contents");
    fixture.overrides.set(X_CONNECTED, false);
    expect(wrapper(render().nodes).props.className).toBe("hidden");
    fixture.overrides.set(TAB, "marketplace");
    fixture.overrides.set(SEARCH, "twitter");
    expect(wrapper(render().nodes).props.className).toBe("contents");
    fixture.overrides.set(SEARCH, "gmail");
    expect(wrapper(render().nodes).props.className).toBe("hidden");
  });
  it("leaves out the managed install's dead Twitter tile, which the X card replaces, unless it is already connected", () => {
    const tile = (tree: Node[]) => tree.find((node) => node.props["data-app-tile"] === "twitter");
    fixture.overrides.set(CARDS, [card("gmail"), card("twitter")]);
    fixture.overrides.set(MODE, "managed");
    expect(tile(render().nodes)).toBeUndefined();
    fixture.overrides.set(STATUS, { twitter: { connected: true, accounts: [{ id: "ca_x", status: "ACTIVE" }] } });
    expect(tile(render().nodes)).toBeDefined();
    fixture.overrides.set(STATUS, {});
    fixture.overrides.set(MODE, "self-hosted");
    expect(tile(render().nodes)).toBeDefined();
  });
  it("keeps a safe explicit authorization link and reopens without creating another account", async () => {
    const url = "https://auth.example.test/flow";
    fixture.overrides.set(STATUS, { gmail: { connected: false, pending: true } });
    fixture.overrides.set(8, { gmail: { url, createdAt: Date.now() } });
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.fn(() => page);
    vi.stubGlobal("window", { open });
    const { nodes: tree } = render();
    const link = tree.find((node) => node.type === "a" && node.props.href === url)!;
    expect(link.props.target).toBe("_blank");
    expect(link.props.rel).toBe("noopener noreferrer");
    const tile = tree.find((node) => node.props["data-app-tile"] === "gmail")!;
    const button = nodes(tile).find((node) => node.type === "button")!;
    vi.mocked(api).mockClear();
    button.props.onClick!();
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(page.opener).toBeNull();
    await Promise.resolve();
    expect(page.location.replace).toHaveBeenCalledWith(url);
    expect(api).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
  });

  it("reserves before requesting authorization and closes its blank when the panel closes", async () => {
    fixture.overrides.set(9, "gmail");
    fixture.overrides.set(10, "work");
    let resolve!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.fn(() => page);
    vi.stubGlobal("window", { open });
    const { nodes: tree } = render();
    const form = tree.find((node) => node.type === "form")!;
    (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} });
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api).mock.invocationCallOrder.at(-1)!);
    const cleanup = fixture.effects.find(({ deps }) => deps?.length === 0)!.effect();
    if (typeof cleanup === "function") cleanup();
    expect(page.close).toHaveBeenCalledOnce();
    resolve({ url: "https://auth.example.test/late" });
    await Promise.resolve();
    expect(page.location.replace).not.toHaveBeenCalled();
  });

  it("renews an expired retained link without reusing its occupied account alias", async () => {
    fixture.overrides.set(STATUS, { gmail: { connected: false, pending: true, status: "INITIALIZING", accounts: [{ id: "ca_old", alias: "work", status: "INITIALIZING" }] } });
    fixture.overrides.set(8, { gmail: { url: "https://auth.example.test/old", createdAt: Date.now() - 600_000 } });
    vi.mocked(api).mockClear();
    vi.mocked(api).mockImplementationOnce(async (_path, request) => {
      if (request?.body) throw new Error("That account alias is already in use");
      return { url: "https://auth.example.test/new" };
    });
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal("window", { open: () => page });
    const { nodes: tree } = render();
    expect(tree.some((node) => node.type === "a" && node.props.href === "https://auth.example.test/old")).toBe(false);
    const tile = tree.find((node) => node.props["data-app-tile"] === "gmail")!;
    nodes(tile).find((node) => node.type === "button")!.props.onClick!();
    expect(api).toHaveBeenCalledWith("/api/connectors/gmail/authorize", { method: "POST" });
    await Promise.resolve();
    expect(page.location.replace).toHaveBeenCalledWith("https://auth.example.test/new");
    const cleanup = fixture.effects.find(({ deps }) => deps?.length === 0)!.effect();
    if (typeof cleanup === "function") cleanup();
  });

  it("retries an INITIALIZING account after reload instead of polling without a usable link", async () => {
    fixture.overrides.set(STATUS, { gmail: { connected: false, pending: true, status: "INITIALIZING", accounts: [{ id: "ca_abandoned", alias: "work", status: "INITIALIZING" }] } });
    vi.mocked(api).mockClear();
    vi.mocked(api).mockResolvedValueOnce({ url: "https://auth.example.test/retry" });
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal("window", { open: () => page });
    const { nodes: tree } = render();
    const tile = tree.find((node) => node.props["data-app-tile"] === "gmail")!;
    nodes(tile).find((node) => node.type === "button")!.props.onClick!();
    expect(api).toHaveBeenCalledWith("/api/connectors/gmail/authorize", { method: "POST" });
    await Promise.resolve();
    expect(page.location.replace).toHaveBeenCalledWith("https://auth.example.test/retry");
    const cleanup = fixture.effects.find(({ deps }) => deps?.length === 0)!.effect();
    if (typeof cleanup === "function") cleanup();
  });

  it("shows an app whose only account expired as signed out, and reconnects that account under its own label", async () => {
    fixture.overrides.set(STATUS, { gmail: { connected: true, pending: false, status: "EXPIRED", accounts: [{ id: "ca_old", alias: "work", status: "EXPIRED" }] } });
    vi.mocked(api).mockClear();
    vi.mocked(api).mockResolvedValueOnce({ removed: 1 }).mockResolvedValueOnce({ url: "https://auth.example.test/again" });
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal("window", { open: () => page });
    const { html, nodes: tree } = render();
    const tile = nodes(tree.find((node) => node.props["data-app-tile"] === "gmail"));
    expect(tile.some((node) => node.props["aria-label"] === "Connected")).toBe(false);
    expect(tile.some((node) => node.props.title === "Signed out. Reconnect to keep using it.")).toBe(true);
    expect(html).not.toContain("1 connected");
    const button = tile.find((node) => node.type === "button")!;
    expect(button.props.children).toBe("Reconnect");
    expect(tile.filter((node) => node.type === "button").map((node) => node.props.children)).not.toContain("Add account");
    button.props.onClick!();
    await vi.waitFor(() => expect(page.location.replace).toHaveBeenCalledWith("https://auth.example.test/again"));
    expect(vi.mocked(api).mock.calls).toEqual([
      ["/api/connectors/gmail/accounts/ca_old", { method: "DELETE" }],
      ["/api/connectors/gmail/authorize", { method: "POST", body: JSON.stringify({ alias: "work" }) }],
    ]);
  });

  it("reports how a Connect ended once, by its curated app, and nothing after the panel closes", async () => {
    vi.useFakeTimers();
    try {
      const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
      vi.stubGlobal("window", { open: () => page });
      const connectApp = async (slug: string) => {
        fixture.overrides.set(CARDS, [card(slug)]);
        fixture.overrides.set(9, slug);
        fixture.overrides.set(10, "work");
        vi.mocked(api).mockReset();
        vi.mocked(api).mockResolvedValueOnce({ url: `https://auth.example.test/${slug}` });
        const form = render().nodes.find((node) => node.type === "form")!;
        (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} });
        await vi.advanceTimersByTimeAsync(0);
        expect(page.location.replace).toHaveBeenLastCalledWith(`https://auth.example.test/${slug}`);
        vi.mocked(api).mockResolvedValue({ services: { [slug]: { connected: true, pending: false, status: "ACTIVE" } } });
      };
      await connectApp("gmail");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fixture.track.mock.calls).toEqual([["connector_connect", { app: "gmail", result: "connected" }]]);

      fixture.track.mockReset();
      await connectApp("acme-internal-crm");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fixture.track.mock.calls).toEqual([["connector_connect", { app: "other", result: "connected" }]]);

      fixture.track.mockReset();
      fixture.effects = [];
      await connectApp("notion");
      const cleanup = fixture.effects.find(({ deps }) => deps?.length === 0)!.effect();
      if (typeof cleanup === "function") cleanup();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fixture.track).not.toHaveBeenCalled();
    } finally {
      vi.mocked(api).mockReset();
      vi.useRealTimers();
    }
  });

  it("reports an Add account connected once the new account works, not when the app's other account already does", async () => {
    vi.useFakeTimers();
    try {
      const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
      vi.stubGlobal("window", { open: () => page });
      fixture.overrides.set(CARDS, [card("slack")]);
      fixture.overrides.set(9, "slack");
      fixture.overrides.set(10, "home");
      vi.mocked(api).mockReset();
      vi.mocked(api).mockResolvedValueOnce({ url: "https://auth.example.test/slack" });
      const form = render().nodes.find((node) => node.type === "form")!;
      (form.props.onSubmit as (event: { preventDefault(): void }) => void)({ preventDefault() {} });
      await vi.advanceTimersByTimeAsync(0);
      const working = { id: "ca_1", status: "ACTIVE" };
      vi.mocked(api).mockResolvedValue({ services: { slack: { connected: true, pending: true, status: "ACTIVE", accounts: [working, { id: "ca_2", status: "INITIATED" }] } } });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fixture.track).not.toHaveBeenCalled();
      vi.mocked(api).mockResolvedValue({ services: { slack: { connected: true, pending: false, status: "ACTIVE", accounts: [working, { id: "ca_2", status: "ACTIVE" }] } } });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fixture.track.mock.calls).toEqual([["connector_connect", { app: "slack", result: "connected" }]]);
    } finally {
      vi.mocked(api).mockReset();
      vi.useRealTimers();
    }
  });

  it("offers Reconnect on a dead account beside a working one", () => {
    fixture.overrides.set(STATUS, { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [
      { id: "ca_personal", alias: "personal", status: "ACTIVE" },
      { id: "ca_work", alias: "work", status: "FAILED" },
    ] } });
    const { html, nodes: tree } = render();
    const tile = nodes(tree.find((node) => node.props["data-app-tile"] === "gmail"));
    expect(tile.some((node) => node.props["aria-label"] === "Connected")).toBe(true);
    expect(tile.find((node) => node.type === "button")!.props.children).toBe("Add account");
    expect(html).toContain('aria-label="Reconnect work to Gmail"');
    expect(html).not.toContain('aria-label="Reconnect personal to Gmail"');
  });

  it("shows the required alias form for mixed active and unfinished accounts", async () => {
    fixture.overrides.set(STATUS, { gmail: { connected: true, pending: true, status: "ACTIVE", accounts: [
      { id: "ca_active", alias: "work", status: "ACTIVE" },
      { id: "ca_abandoned", status: "INITIALIZING" },
    ] } });
    vi.mocked(api).mockClear();
    vi.mocked(api).mockRejectedValueOnce(new Error("Add an account alias so the existing connection is not replaced"));
    const page = { opener: {}, closed: false, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal("window", { open: () => page });
    const initial = render();
    const tile = initial.nodes.find((node) => node.props["data-app-tile"] === "gmail")!;
    nodes(tile).find((node) => node.type === "button")!.props.onClick!();
    await Promise.resolve();
    const recovered = render();
    const recoveredTile = recovered.nodes.find((node) => node.props["data-app-tile"] === "gmail")!;
    expect(nodes(recoveredTile).some((node) => node.type === "form")).toBe(true);
    expect(recovered.html).toContain('aria-label="Label for another Gmail account"');
    expect(page.close).toHaveBeenCalledOnce();
    expect(page.location.replace).not.toHaveBeenCalled();
  });

  it("focuses and wraps through visible controls in a narrow window", () => {
    let active: Control;
    const focusElement = (element: Control) => { active = element; };
    class Control {
      constructor(readonly input = false, public visible = true) {}
      focus = vi.fn(() => focusElement(this));
      getClientRects = () => this.visible ? [{}] : [];
      matches = (selector: string) => selector === "input" && this.input;
    }
    const hiddenDesktopSearch = new Control(true, false);
    const first = new Control();
    const mobileSearch = new Control(true);
    const last = new Control();
    const opener = new Control();
    active = opener;
    const pane = Object.assign(new Control(), {
      querySelectorAll: () => [hiddenDesktopSearch, first, mobileSearch, last],
    });
    const listeners = new Map<string, (event: KeyboardEvent) => void>();
    vi.stubGlobal("HTMLElement", Control);
    vi.stubGlobal("document", { get activeElement() { return active; } });
    vi.stubGlobal("window", {
      addEventListener: (name: string, listener: (event: KeyboardEvent) => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    });
    const { nodes: tree } = render();
    const dialog = tree.find((node) => node.props.role === "dialog")!;
    (dialog.props.ref as { current: unknown }).current = pane;
    const cleanup = fixture.effects.find(({ deps }) => deps?.length === 1 && deps[0] === fixture.dispatch)!.effect();
    expect(mobileSearch.focus).toHaveBeenCalledOnce();
    expect(hiddenDesktopSearch.focus).not.toHaveBeenCalled();

    const tab = (shiftKey = false) => {
      const event = { key: "Tab", shiftKey, preventDefault: vi.fn() };
      listeners.get("keydown")!(event as unknown as KeyboardEvent);
      return event;
    };
    active = last;
    expect(tab().preventDefault).toHaveBeenCalledOnce();
    expect(active).toBe(first);
    expect(tab(true).preventDefault).toHaveBeenCalledOnce();
    expect(active).toBe(last);

    active = hiddenDesktopSearch;
    expect(tab().preventDefault).toHaveBeenCalledOnce();
    expect(active).toBe(first);
    expect(hiddenDesktopSearch.focus).not.toHaveBeenCalled();
    if (typeof cleanup === "function") cleanup();
    expect(active).toBe(opener);
  });

  it("is titled Apps and shows app tiles and the MCP servers section on one view", () => {
    const { html } = render();
    expect(html).toContain(">Apps</h2>");
    expect(html).toContain("Connect an app or your own MCP server once. Then choose which bots may use it.");
    expect(html).toContain("glass-surface");
    expect(html).toContain("@container");
    expect(html).toContain("grid grid-cols-1 items-start gap-x-6 gap-y-1 @xl:grid-cols-2");
    for (const slug of ["gmail", "slack", "notion"]) expect(html).toContain(`data-app-tile="${slug}"`);
    expect(html.indexOf('data-app-tile="slack"')).toBeLessThan(html.indexOf('data-app-tile="gmail"'));
    expect(html).toContain("MCP inventory");
    expect(html).toContain('data-embedded="true"');
    expect(html).not.toContain('role="tab"');
  });

  it("filters with chips, keeping the MCP chip on the store's surface", () => {
    const initial = render();
    expect(chip(initial.nodes, "all").props["aria-pressed"]).toBe(true);
    chip(initial.nodes, "mcp").props.onClick!();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "togglePlugins", open: true, surface: "mcp" });

    fixture.surface = "mcp";
    const mcp = render();
    expect(chip(mcp.nodes, "mcp").props["aria-pressed"]).toBe(true);
    expect(mcp.html).toContain("MCP inventory");
    expect(mcp.html).not.toContain("data-app-tile");
    chip(mcp.nodes, "connected").props.onClick!();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "togglePlugins", open: true, surface: "apps" });
  });

  it("drops a selected category when a filter is chosen, so the MCP section comes back", () => {
    fixture.overrides.set(20, "Design");
    expect(render().html).not.toContain("MCP inventory");
    chip(render().nodes, "mcp").props.onClick!();
    expect(fixture.overrides.get(20)).toBeNull();
    expect(render().html).toContain("MCP inventory");
  });

  it("shows only connected apps, and no MCP section, under Connected", () => {
    fixture.overrides.set(16, "connected");
    const { html, nodes: tree } = render();
    expect(chip(tree, "connected").props["aria-pressed"]).toBe(true);
    expect(html).toContain('data-app-tile="slack"');
    expect(html).not.toContain('data-app-tile="gmail"');
    expect(html).not.toContain("MCP inventory");
    expect(html).toContain("1 connected");
  });

  it("groups the catalog into connected apps, category previews and every app, with a View all per section", () => {
    const categorized = (slug: string, category: string) => ({ ...card(slug), categories: [category] });
    fixture.overrides.set(CARDS, [
      categorized("slack", "Communication"),
      categorized("gmail", "Communication"),
      ...Array.from({ length: 5 }, (_, index) => categorized(`doc${index}`, "Productivity")),
      categorized("figma", "Design"),
      ...["Files", "Finance", "Social", "Analytics"].map((category) => categorized(category.toLowerCase(), category)),
    ]);
    const { html, nodes: tree } = render();
    const headings = [...html.matchAll(/<h3 id="[^"]*"[^>]*>([^<]*)/g)].map((match) => match[1]);
    expect(headings).toEqual(["Connected", "Productivity", "Communication", "Analytics", "All apps"]);
    expect(tree.filter((node) => node.props["data-apps-category"]).map((node) => node.props["data-apps-category"])).toEqual(["Productivity", "Communication", "Analytics", "Design", "Files"]);
    expect(html).toContain('aria-label="More categories"');
    tree.find((node) => node.props["data-apps-category"] === "Design")!.props.onClick!();
    const design = render();
    expect(design.html.match(/data-app-tile="(?!whop)[^"]*"/g)).toEqual(['data-app-tile="figma"']);
    expect([...design.html.matchAll(/<h3 id="[^"]*"[^>]*>([^<]*)/g)].map((match) => match[1])).toEqual(["Design"]);
    expect(chip(design.nodes, "all").props["aria-pressed"]).toBe(false);
    expect(design.nodes.find((node) => node.props["data-apps-category"] === "Design")!.props["aria-pressed"]).toBe(true);
    fixture.overrides.set(20, null);
    const again = render();
    expect(again.html.match(/>View all</g)).toHaveLength(1);
    const sections = again.nodes.filter((node) => node.props.viewAll);
    expect(sections.map((node) => node.props.title)).toEqual(["Productivity"]);
    (sections[0]!.props.viewAll as { onClick: () => void }).onClick();
    expect(fixture.overrides.get(20)).toBe("Productivity");
  });

  it("pairs the search with an MCP servers pill and puts the connected count, with app icons, in the header", () => {
    const { html, nodes: tree } = render();
    expect(chip(tree, "mcp").props["aria-pressed"]).toBe(false);
    const indicator = chip(tree, "connected");
    expect(indicator.props["aria-pressed"]).toBe(false);
    expect(html).toContain("1 connected");
    indicator.props.onClick!();
    expect(fixture.overrides.get(16)).toBe("connected");
  });

  it("caps the unsearched catalog so the MCP servers stay a short scroll away", () => {
    fixture.overrides.set(CARDS, Array.from({ length: APPS_PREVIEW_COUNT + 5 }, (_, index) => card(`app${index}`)));
    const { html } = render();
    expect(html.match(/data-app-tile=/g)).toHaveLength(APPS_PREVIEW_COUNT);
    expect(html).toContain(`Show all ${APPS_PREVIEW_COUNT + 5} apps`);
  });

  it("keeps the per-bot banner, stale notice and self-host key link reachable", () => {
    fixture.instances = [claude];
    fixture.bots = [bot("scout", { composio: false })];
    fixture.overrides.set(7, true);
    let { html } = render();
    expect(html).toContain("Showing what was connected last time");
    fixture.overrides.set(7, false);
    ({ html } = render());
    expect(html).toContain("Not every bot can use these apps.");
    expect(html).toContain("Allow scout");
  });

  it("names the bots that use a connected app", () => {
    fixture.instances = [claude];
    fixture.bots = [bot("scout"), bot("quiet", { composio: false }), bot("narrow", { connectorTools: { gmail: { tools: "*" } } })];
    const { html } = render();
    expect(html).toContain('aria-label="Used by scout"');
    expect(botsUsingService(fixture.bots as Bot[], fixture.instances as InstanceInfo[], "gmail").map((entry) => entry.id)).toEqual(["scout", "narrow"]);
  });

  it("keeps each bot's avatar inside its round ring, whatever its shape", () => {
    fixture.instances = [claude];
    fixture.bots = [
      bot("scout"),
      bot("arrow", { mascotBody: "cursor" }),
      bot("photo", { avatarUrl: "/api/attachments/photo.webp", avatarCrop: "square" }),
    ];
    const { nodes: tree } = render();
    const rings = tree.filter((node) => node.props["data-used-by-avatar"] !== undefined);
    expect(rings.map((ring) => ring.props["data-used-by-avatar"])).toEqual(["scout", "arrow", "photo"]);
    for (const ring of rings) {
      expect(String(ring.props.className).split(" ")).toEqual(expect.arrayContaining([
        "flex", "size-5", "shrink-0", "items-center", "justify-center", "overflow-hidden", "rounded-full", "bg-menu", "ring-2", "ring-menu",
      ]));
      const avatar = Children.only(ring.props.children) as Node;
      expect(avatar.props.size).toBe(USED_BY_AVATAR_SIZE);
    }
  });

  it("draws them small enough that no mascot body reaches the ring", () => {
    // CursorAvatar's viewBox is the face box plus 15 units on every side.
    const box = FACE_BOX + 30;
    const centre = FACE_BOX / 2;
    for (const body of Object.values(MASCOT_BODIES)) {
      const d = body.body.match(/ d="([^"]+)"/)![1]!;
      expect(d.replace(/[-\d.\s]/g, ""), body.id).toMatch(/^[MCZ]+$/);
      const [x, y, scale] = body.fit.match(/-?\d*\.?\d+/g)!.map(Number) as [number, number, number];
      const numbers = d.match(/-?\d*\.?\d+/g)!.map(Number);
      // A cubic stays inside its control points' hull and distance from the centre is convex, so the farthest control
      // point bounds the outline.
      let reach = 0;
      for (let i = 0; i + 1 < numbers.length; i += 2) {
        reach = Math.max(reach, Math.hypot(x + numbers[i]! * scale - centre, y + numbers[i + 1]! * scale - centre));
      }
      expect((reach / box) * USED_BY_AVATAR_SIZE, body.id).toBeLessThan(10);
    }
  });
});
