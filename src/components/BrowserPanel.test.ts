import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  refs: [] as RefObject<unknown>[],
  control: { held: false, controlling: false, owned: false },
  frame: null as { seq: number; data: string } | null,
  queues: [] as Array<{ enqueue: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; drain: ReturnType<typeof vi.fn> }>,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react,
    useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
    useRef: (value: unknown) => { const ref = react.useRef(value); fixture.refs.push(ref); return ref; },
    useState: (value: unknown) => react.useState(value === null ? fixture.frame : value && typeof value === "object" && "controlling" in value ? fixture.control : value),
  };
});
vi.mock("@/state/store", () => ({ api: vi.fn().mockResolvedValue({}), useStore: () => ({ state: { config: { browserProfiles: [] } } }) }));
vi.mock("./BrowserProfilesManager", () => ({ BrowserProfilesManager: () => null }));
vi.mock("@/lib/browser-input-queue", () => ({ createBrowserInputQueue: () => {
  const queue = { enqueue: vi.fn(), clear: vi.fn(), drain: vi.fn().mockResolvedValue(undefined) };
  fixture.queues.push(queue); return queue;
} }));
import { LiveBrowser } from "./BrowserPanel";
import { BrowserViewport } from "./BrowserViewport";

class FixtureEventSource {
  static instances: FixtureEventSource[] = [];
  listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  close = vi.fn();
  constructor(readonly url: string) { FixtureEventSource.instances.push(this); }
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]);
  }
  emit(name: string, data: unknown) {
    for (const listener of this.listeners.get(name) ?? []) listener(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}
const bot = { id: "pepper", name: "Pepper" } as Bot;
const render = () => renderToStaticMarkup(createElement(LiveBrowser, { bot }));
beforeEach(() => {
  fixture.effects = []; fixture.refs = []; fixture.queues = [];
  fixture.control = { held: false, controlling: false, owned: false };
  fixture.frame = null;
  FixtureEventSource.instances = [];
  vi.stubGlobal("EventSource", FixtureEventSource);
});
afterEach(() => vi.unstubAllGlobals());

describe("live browser connection lifecycle", () => {
  it("does not let an old source error discard the replacement viewer or input queue", () => {
    render();
    // Replay the real connection effect's cleanup/setup, as on reconnect or
    // StrictMode, while retaining the same component refs.
    const connect = fixture.effects[2]!;
    const firstCleanup = connect();
    const first = FixtureEventSource.instances[0]!;
    first.emit("ready", { viewerId: "old-viewer" });
    const viewer = fixture.refs.find((ref) => ref.current === "old-viewer")!;
    expect(viewer).toBeDefined();
    firstCleanup?.();
    expect(fixture.queues[0]!.clear).toHaveBeenCalledOnce();
    const secondCleanup = connect();
    const second = FixtureEventSource.instances[1]!;
    second.emit("ready", { viewerId: "new-viewer" });
    first.emit("error", { message: "delayed old disconnect" });
    expect(viewer.current).toBe("new-viewer");
    expect(fixture.queues[1]!.clear).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
    secondCleanup?.();
  });

  it("still clears input and closes the current source on a real connection error", () => {
    render();
    const cleanup = fixture.effects[2]!();
    const source = FixtureEventSource.instances[0]!;
    source.emit("ready", { viewerId: "current-viewer" });
    const viewer = fixture.refs.find((ref) => ref.current === "current-viewer")!;
    source.emit("error", { message: "connection ended" });
    expect(viewer.current).toBe("");
    expect(fixture.queues[0]!.clear).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
    source.emit("ready", { viewerId: "late-viewer" });
    expect(viewer.current).toBe("");
    expect(fixture.queues).toHaveLength(1);
    cleanup?.();
  });
});

describe("live browser control affordance", () => {
  it("returns viewport focus to the existing browser address field", () => {
    fixture.frame = { seq: 1, data: "fixture" };
    let tree!: ReturnType<typeof LiveBrowser>;
    function Capture() { tree = LiveBrowser({ bot }); return tree; }
    renderToStaticMarkup(createElement(Capture));
    type Node = ReactElement<{ children?: ReactNode; "aria-label"?: string; ref?: RefObject<HTMLInputElement | null>; onReturnToToolbar?: () => void }>;
    const elements = (node: ReactNode): Node[] => {
      if (!isValidElement(node)) return [];
      const element = node as Node;
      return [element, ...Children.toArray(element.props.children).flatMap(elements)];
    };
    const nodes = elements(tree);
    const address = nodes.find((node) => node.props["aria-label"] === "Browser address")!;
    const viewport = nodes.find((node) => node.type === BrowserViewport)!;
    const focus = vi.fn();
    address.props.ref!.current = { focus } as unknown as HTMLInputElement;
    viewport.props.onReturnToToolbar!();
    expect(focus).toHaveBeenCalledOnce();
  });

  it("visibly labels takeover in the existing toolbar", () => {
    const html = render();
    expect(html).toContain('<span>Take control</span>');
    expect(html).toContain('aria-label="Take control" aria-pressed="false"');
    expect(html).toContain('aria-label="Browser profiles"');
  });

  it("visibly labels hand-back when this viewer owns control", () => {
    fixture.control = { held: true, controlling: true, owned: true };
    const html = render();
    expect(html).toContain('<span>Return to bot</span>');
    expect(html).toContain('aria-label="Return to bot" aria-pressed="true"');
    expect(html).not.toContain('<span>Take control</span>');
  });
});
