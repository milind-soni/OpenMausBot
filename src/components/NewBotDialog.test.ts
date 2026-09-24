import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode, type KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ effects: [] as EffectCallback[], dispatch: vi.fn(), api: vi.fn(), create: vi.fn(), ready: false, hook: 0, admin: false }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: {} }) }));
vi.mock("react", async importOriginal => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); }, useState: (initial: unknown) => {
    const state = react.useState(initial);
    const index = fixture.hook++;
    if (fixture.ready && index === 1) {
      const draft = state[0] as { bot: { name: string }; patch: (patch: { name: string }) => void };
      if (draft.bot.name !== "Fixture") draft.patch({ name: "Fixture" });
    }
    return fixture.ready && index === 3 ? [true, state[1]] : state;
  } };
});
vi.mock("@/lib/create-configured-bot", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/create-configured-bot")>(), createConfiguredBot: fixture.create,
}));
vi.mock("@/state/store", async importOriginal => {
  const store = await importOriginal<typeof import("@/state/store")>();
  return { ...store, api: fixture.api, BotEditorStore: () => null, useStore: () => ({ state: store.initialState, dispatch: fixture.dispatch }) };
});
import { LocalNewBotDialog as NewBotDialog, CompanionNewBotDialog, NewBotDialog as RoutedNewBotDialog } from "./NewBotDialog";

type Node = ReactElement<{ children?: ReactNode; role?: string; "aria-label"?: string; onClick?: () => void; onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void; disabled?: boolean }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function render(defaultsMode = false, onCreated?: () => void | Promise<void>) {
  let tree!: ReturnType<typeof NewBotDialog>;
  function Capture() { fixture.hook = 0; tree = NewBotDialog({ defaultsMode, onCreated }); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
beforeEach(() => {
  fixture.effects = []; fixture.dispatch.mockReset(); fixture.api.mockReset();
  fixture.ready = false; fixture.admin = false; fixture.create.mockReset();
  fixture.api.mockReturnValue(new Promise(() => {}));
});
afterEach(() => vi.unstubAllGlobals());

describe("bot draft dialog", () => {
  it("preserves upstream audience selection for browser admins before creation", () => {
    fixture.admin = true;
    vi.stubGlobal("window", {});
    expect(render().html).toContain("Who can see it");
    expect(render().html).toContain("Admins only");
    expect(render(true).html).not.toContain("Who can see it");
    fixture.admin = false;
    expect(render().html).not.toContain("Who can see it");
    fixture.admin = true;
    vi.stubGlobal("window", { ogb: {} });
    expect(render().html).not.toContain("Who can see it");
  });
  it.each([false, true])("closes after a successful creation when its caller fails (async=%s)", async asyncFailure => {
    fixture.ready = true;
    const bot = { id: "created", name: "Fixture" };
    fixture.create.mockResolvedValue({ bot, warnings: [] });
    const failed = () => { throw new Error("Caller failed"); };
    const result = render(false, asyncFailure ? async () => failed() : failed);
    result.nodes.filter(node => node.type === "button").at(-1)!.props.onClick!();
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "toggleNewBot", open: false }));
    expect(fixture.create).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "botAdded", bot, preserveSelection: false });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "error", message: "Caller failed" });
  });
  it("keeps initial backward keyboard navigation inside the companion dialog", () => {
    let tree!: ReturnType<typeof CompanionNewBotDialog>;
    function Capture() { tree = CompanionNewBotDialog(); return tree; }
    renderToStaticMarkup(createElement(Capture));
    const first = { focus: vi.fn() }, last = { focus: vi.fn() };
    const root = { querySelectorAll: () => [first, last] };
    vi.stubGlobal("document", { activeElement: root });
    const preventDefault = vi.fn();
    nodes(tree).find(node => node.props.role === "dialog")!.props.onKeyDown!({
      key: "Tab", shiftKey: true, currentTarget: root, preventDefault,
    } as unknown as KeyboardEvent<HTMLDivElement>);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(last.focus).toHaveBeenCalledOnce();
    expect(first.focus).not.toHaveBeenCalled();
  });
  it("keeps companion creation on its permitted single-request path", () => {
    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    const routed = RoutedNewBotDialog();
    expect(routed.type).toBe(CompanionNewBotDialog);
    let tree!: ReturnType<typeof CompanionNewBotDialog>;
    function Capture() { tree = CompanionNewBotDialog(); return tree; }
    const html = renderToStaticMarkup(createElement(Capture));
    expect(html).toContain("Create bot");
    const create = nodes(tree).filter(node => node.type === "button").at(-1)!;
    create.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "newBot", onCreated: expect.any(Function) });
    expect(fixture.api).not.toHaveBeenCalled();
  });
  it("opens immediately with all sections and no creation request", () => {
    const result = render();
    expect(result.html).toContain('role="dialog"');
    for (const section of ["Identity", "Soul", "Skills", "Memory", "Routines", "Access", "Model", "Permissions", "Voice &amp; alerts"]) {
      expect(result.html).toContain(section);
    }
    fixture.effects[0]();
    expect(fixture.api).toHaveBeenCalledExactlyOnceWith("/api/bot-defaults");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    const submit = result.nodes.find(node => node.type === "button" && node.props.disabled)!;
    expect(submit.props.disabled).toBe(true);
  });

  it("can cancel a loading draft without creating or deleting a bot", () => {
    const result = render();
    result.nodes.find(node => node.type === "button" && node.props["aria-label"] === "Close")!.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleNewBot", open: false });
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("uses the same section editor for default templates", () => {
    const result = render(true);
    expect(result.html).toContain("Defaults for new bots");
    expect(result.html).toContain("Save defaults");
    expect(result.html).not.toContain(">Create bot<");
  });
});
