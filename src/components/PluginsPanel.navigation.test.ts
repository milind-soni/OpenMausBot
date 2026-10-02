import { Children, createElement, isValidElement, type DependencyList, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";

// PluginsPanel's own state, seeded by call order: effects never run under
// server rendering, so the catalog is put in place the way a finished fetch
// would leave it. Indexes outside the map keep their initial values.
const fixture = vi.hoisted(() => ({
  surface: "apps" as "apps" | "mcp",
  dispatch: vi.fn(),
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
      return [seeded, () => {}];
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
  McpServersPanel: ({ embedded }: { embedded?: boolean }) => createElement("div", { "data-embedded": String(Boolean(embedded)) }, "MCP inventory"),
}));
vi.mock("./Avatar", () => ({ BotAvatar: ({ bot }: { bot: Bot }) => createElement("span", { "data-avatar": bot.id }) }));
import { APPS_PREVIEW_COUNT, PluginsPanel, USED_BY_AVATAR_SIZE, botsUsingService } from "./PluginsPanel";
import { FACE_BOX } from "./cursor-face-data";
import { MASCOT_BODIES } from "../../shared/mascot-bodies";

const CARDS = 0;
const CONFIGURED = 3;
const STATUS = 6;
const PHASE = 13;

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

    // A resize can hide whichever search previously held focus.
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
    expect(html).toContain("grid-cols-1 gap-3 @lg:grid-cols-2 @3xl:grid-cols-3");
    for (const slug of ["gmail", "slack", "notion"]) expect(html).toContain(`data-app-tile="${slug}"`);
    // the connected app leads the grid
    expect(html.indexOf('data-app-tile="slack"')).toBeLessThan(html.indexOf('data-app-tile="gmail"'));
    expect(html).toContain("MCP inventory");
    expect(html).toContain('data-embedded="true"');
    // no separate MCP tab any more
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

  it("shows only connected apps, and no MCP section, under Connected", () => {
    fixture.overrides.set(16, "connected");
    const { html, nodes: tree } = render();
    expect(chip(tree, "connected").props["aria-pressed"]).toBe(true);
    expect(html).toContain('data-app-tile="slack"');
    expect(html).not.toContain('data-app-tile="gmail"');
    expect(html).not.toContain("MCP inventory");
    expect(html).toContain("Connected 1");
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
    fixture.overrides.set(7, true); // stale
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
      // a fixed disc that clips, with the avatar centred in it
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
      // Absolute moves and cubics only, so the numbers pair up as points.
      expect(d.replace(/[-\d.\s]/g, ""), body.id).toMatch(/^[MCZ]+$/);
      const [x, y, scale] = body.fit.match(/-?\d*\.?\d+/g)!.map(Number) as [number, number, number];
      const numbers = d.match(/-?\d*\.?\d+/g)!.map(Number);
      // A cubic stays inside its control points' hull, and distance from the
      // centre is convex, so the farthest control point bounds the outline.
      let reach = 0;
      for (let i = 0; i + 1 < numbers.length; i += 2) {
        reach = Math.max(reach, Math.hypot(x + numbers[i]! * scale - centre, y + numbers[i + 1]! * scale - centre));
      }
      // inside a size-5 ring: a 10px radius
      expect((reach / box) * USED_BY_AVATAR_SIZE, body.id).toBeLessThan(10);
    }
  });
});
