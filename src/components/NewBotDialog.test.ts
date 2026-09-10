import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ effects: [] as EffectCallback[], dispatch: vi.fn(), creating: false, error: null as string | null }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react,
    useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
    useState: (initial: unknown) => react.useState(fixture.error ?? initial),
  };
});
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { botCreationPending: fixture.creating }, dispatch: fixture.dispatch }) }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
import { NewBotDialog } from "./NewBotDialog";

type Node = ReactElement<{ children?: ReactNode; role?: string; "aria-label"?: string; onClick?: () => void; ref?: RefObject<HTMLDivElement | null>; disabled?: boolean }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function render() {
  let tree!: ReturnType<typeof NewBotDialog>;
  function Capture() { tree = NewBotDialog(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
beforeEach(() => { fixture.effects = []; fixture.dispatch.mockReset(); fixture.creating = false; fixture.error = null; });
afterEach(() => vi.unstubAllGlobals());

describe("new bot role dialog", () => {
  it("waits for creation before closing the current dialog", () => {
    const { nodes } = render();
    const blank = nodes.find((node) => node.type === "button" && renderToStaticMarkup(node).includes("Blank bot"))!;
    blank.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    const action = fixture.dispatch.mock.calls[0][0];
    expect(action).toMatchObject({ type: "newBot", onCreated: expect.any(Function), onError: expect.any(Function) });
    action.onCreated();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleNewBot", open: false });
  });

  it("leaves a failed POST open for retry and makes pending controls unavailable", () => {
    const { nodes } = render();
    const blank = nodes.find((node) => node.type === "button" && renderToStaticMarkup(node).includes("Blank bot"))!;
    blank.props.onClick!();
    fixture.dispatch.mock.calls[0][0].onError("Creation failed");
    expect(fixture.dispatch).toHaveBeenCalledOnce();
    blank.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    fixture.creating = true;
    const pending = render();
    expect(pending.html).toContain('aria-busy="true"');
    expect(pending.nodes.filter((node) => node.type === "button" && node.props["aria-label"] !== "Close").every((node) => node.props.disabled)).toBe(true);
    // A remounted picker gets pending from the store, not its local state.
    const pendingBlank = pending.nodes.find((node) => node.type === "button" && renderToStaticMarkup(node).includes("Blank bot"))!;
    pendingBlank.props.onClick!();
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    const close = pending.nodes.find((node) => node.type === "button" && node.props["aria-label"] === "Close")!;
    expect(close.props.disabled).not.toBe(true);
    close.props.onClick!();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleNewBot", open: false });
    fixture.creating = false;
    fixture.error = "Creation failed";
    expect(render().html).toContain('role="alert"');
  });

  it("traps Tab, restores focus, and ignores callbacks after unmount", () => {
    let keydown!: (event: KeyboardEvent) => void;
    const doc = { activeElement: null as unknown };
    class Control { isConnected = true; focus() { doc.activeElement = this; } }
    const opener = new Control();
    const first = new Control();
    const last = new Control();
    doc.activeElement = opener;
    vi.stubGlobal("HTMLElement", Control);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", { addEventListener: (_name: string, callback: typeof keydown) => { keydown = callback; }, removeEventListener: vi.fn() });
    const rendered = render();
    const dialog = rendered.nodes.find((node) => node.props.role === "dialog")!;
    dialog.props.ref!.current = { querySelector: () => first, querySelectorAll: () => [first, last], contains: (element: unknown) => element === first || element === last } as unknown as HTMLDivElement;
    const cleanup = fixture.effects[0]();
    expect(doc.activeElement).toBe(first);
    keydown({ key: "Tab", shiftKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(doc.activeElement).toBe(last);
    keydown({ key: "Tab", shiftKey: false, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(doc.activeElement).toBe(first);
    const blank = rendered.nodes.find((node) => node.type === "button" && renderToStaticMarkup(node).includes("Blank bot"))!;
    blank.props.onClick!();
    keydown({ key: "Escape", preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleNewBot", open: false });
    cleanup?.();
    expect(doc.activeElement).toBe(opener);
    fixture.dispatch.mock.calls[0][0].onCreated();
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
  });
});
