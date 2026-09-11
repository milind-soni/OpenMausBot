import { Children, createElement, isValidElement, type EffectCallback, type ReactElement, type ReactNode, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  effects: [] as EffectCallback[],
  refs: [] as RefObject<unknown>[],
  setters: [] as Array<ReturnType<typeof vi.fn>>,
  control: { held: false, controlling: false, owned: false },
  frame: null as { seq: number; data: string; viewerId: string; generation: number } | null,
  queues: [] as Array<{ enqueue: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; drain: ReturnType<typeof vi.fn> }>,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react,
    useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
    useRef: (value: unknown) => { const ref = react.useRef(value); fixture.refs.push(ref); return ref; },
    useState: (value: unknown) => {
      const [state] = react.useState(value === null ? fixture.frame : value && typeof value === "object" && "controlling" in value ? fixture.control : value);
      const setter = vi.fn(); fixture.setters.push(setter); return [state, setter];
    },
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
import { BrowserProfilesManager } from "./BrowserProfilesManager";
import { api } from "@/state/store";

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
type Node = ReactElement<{
  children?: ReactNode; "aria-label"?: string; ref?: RefObject<HTMLInputElement | null>;
  onReturnToToolbar?: () => void; onClick?: (event: unknown) => void; onProfileChanged?: () => void;
  acknowledge?: (seq: number) => void; onDecodeError?: () => void;
}>;
const elements = (node: ReactNode): Node[] => {
  if (!isValidElement(node)) return [];
  const element = node as Node;
  return [element, ...Children.toArray(element.props.children).flatMap(elements)];
};
const renderElements = () => {
  let tree!: ReturnType<typeof LiveBrowser>;
  function Capture() { tree = LiveBrowser({ bot }); return tree; }
  renderToStaticMarkup(createElement(Capture));
  return elements(tree);
};
const click = (nodes: Node[], label: string) => {
  const node = nodes.find((node) => node.props["aria-label"] === label || node.props.children === label)!;
  node.props.onClick!({ currentTarget: { closest: () => null } });
};
const deferred = () => {
  let resolve!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  fixture.effects = []; fixture.refs = []; fixture.queues = []; fixture.setters = [];
  fixture.control = { held: false, controlling: false, owned: false };
  fixture.frame = null;
  FixtureEventSource.instances = [];
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
  vi.mocked(api).mockReset().mockResolvedValue({});
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

  it("reconnects after its own successful restart closes the stream before replying", async () => {
    const nodes = renderElements();
    const cleanup = fixture.effects[2]!();
    const source = FixtureEventSource.instances[0]!;
    source.emit("ready", { viewerId: "current-viewer" });
    const restart = deferred();
    vi.mocked(api).mockReturnValueOnce(restart.promise);
    click(nodes, "Restart browser…");
    await settle();
    expect(api).toHaveBeenCalledWith("/api/bots/pepper/browser/action", {
      method: "POST", body: JSON.stringify({ type: "restart", viewerId: "current-viewer" }),
    });
    source.emit("error", { message: "Browser restarted" });
    restart.resolve(); await settle();
    expect(fixture.setters[0]).toHaveBeenCalledOnce();
    cleanup?.();
  });

  it.each(["reconnect", "profile", "effect cleanup"])("ignores a late successful restart after %s replaces its connection", async (replacement) => {
    const nodes = renderElements();
    const connect = fixture.effects[2]!;
    const cleanup = connect();
    FixtureEventSource.instances[0]!.emit("ready", { viewerId: "old-viewer" });
    const restart = deferred();
    vi.mocked(api).mockReturnValueOnce(restart.promise);
    click(nodes, "Restart browser…"); await settle();
    if (replacement === "reconnect") click(nodes, "Reconnect view");
    if (replacement === "profile") nodes.find((node) => node.type === BrowserProfilesManager)!.props.onProfileChanged!();
    cleanup?.();
    const secondCleanup = connect();
    const replacementSource = FixtureEventSource.instances[1]!;
    replacementSource.emit("ready", { viewerId: "new-viewer" });
    const viewer = fixture.refs.find((ref) => ref.current === "new-viewer")!;
    fixture.setters.forEach((setter) => setter.mockClear());
    restart.resolve(); await settle();
    expect(fixture.setters[0]).not.toHaveBeenCalled();
    expect(fixture.setters[6]).not.toHaveBeenCalled();
    expect(fixture.setters[7]).not.toHaveBeenCalled();
    expect(viewer.current).toBe("new-viewer");
    expect(replacementSource.close).not.toHaveBeenCalled();
    expect(fixture.queues[1]!.clear).not.toHaveBeenCalled();
    secondCleanup?.();
  });

  it("invalidates an old restart immediately when reconnect is requested", async () => {
    const nodes = renderElements();
    const cleanup = fixture.effects[2]!();
    FixtureEventSource.instances[0]!.emit("ready", { viewerId: "old-viewer" });
    const restart = deferred();
    vi.mocked(api).mockReturnValueOnce(restart.promise);
    click(nodes, "Restart browser…"); await settle();
    click(nodes, "Reconnect view");
    fixture.setters.forEach((setter) => setter.mockClear());
    // Complete the request before React has run reconnect's cleanup/setup.
    restart.resolve(); await settle();
    expect(fixture.setters[0]).not.toHaveBeenCalled();
    expect(fixture.setters[6]).not.toHaveBeenCalled();
    cleanup?.();
  });

  it("does not dispatch a command if its input drain finishes after a reconnect", async () => {
    const nodes = renderElements();
    const connect = fixture.effects[2]!;
    const cleanup = connect();
    FixtureEventSource.instances[0]!.emit("ready", { viewerId: "old-viewer" });
    const drain = deferred();
    fixture.queues[0]!.drain.mockReturnValueOnce(drain.promise);
    click(nodes, "Restart browser…");
    cleanup?.();
    const secondCleanup = connect();
    FixtureEventSource.instances[1]!.emit("ready", { viewerId: "new-viewer" });
    drain.resolve(); await settle();
    expect(api).not.toHaveBeenCalled();
    secondCleanup?.();
  });

  it("does not show old errors or clear a replacement operation's pending state", async () => {
    const nodes = renderElements();
    const connect = fixture.effects[2]!;
    const cleanup = connect();
    FixtureEventSource.instances[0]!.emit("ready", { viewerId: "old-viewer" });
    const oldAction = deferred(); const currentAction = deferred();
    vi.mocked(api).mockReturnValueOnce(oldAction.promise).mockReturnValueOnce(currentAction.promise);
    click(nodes, "Take control"); await settle();
    cleanup?.();
    const secondCleanup = connect();
    FixtureEventSource.instances[1]!.emit("ready", { viewerId: "new-viewer" });
    click(nodes, "Take control"); await settle();
    fixture.setters.forEach((setter) => setter.mockClear());
    oldAction.reject(new Error("Old action failed")); await settle();
    expect(fixture.setters[6]).not.toHaveBeenCalled();
    expect(fixture.setters[7]).not.toHaveBeenCalled();
    currentAction.resolve(); await settle();
    expect(fixture.setters[6]).toHaveBeenCalledWith(false);
    secondCleanup?.();
  });

  it("serializes commands even when clicked twice before pending state renders", async () => {
    const nodes = renderElements();
    const cleanup = fixture.effects[2]!();
    FixtureEventSource.instances[0]!.emit("ready", { viewerId: "current-viewer" });
    const action = deferred();
    vi.mocked(api).mockReturnValueOnce(action.promise);
    click(nodes, "Take control"); click(nodes, "Take control"); await settle();
    expect(api).toHaveBeenCalledOnce();
    expect(fixture.queues[0]!.drain).toHaveBeenCalledOnce();
    action.resolve(); await settle();
    click(nodes, "Take control"); await settle();
    expect(api).toHaveBeenCalledTimes(2);
    cleanup?.();
  });

  it("binds frame acknowledgements and decode errors to the frame's connection", () => {
    fixture.frame = { seq: 8, data: "fixture", viewerId: "old-viewer", generation: 1 };
    const nodes = renderElements();
    const viewport = nodes.find((node) => node.type === BrowserViewport)!;
    const connect = fixture.effects[2]!;
    const cleanup = connect();
    FixtureEventSource.instances[0]!.emit("ready", { viewerId: "old-viewer" });
    viewport.props.acknowledge!(8);
    expect(api).toHaveBeenCalledWith("/api/bots/pepper/browser/action", {
      method: "POST", body: JSON.stringify({ type: "ack", seq: 8, viewerId: "old-viewer" }),
    });
    cleanup?.();
    const secondCleanup = connect();
    FixtureEventSource.instances[1]!.emit("ready", { viewerId: "new-viewer" });
    vi.mocked(api).mockClear(); fixture.setters[7]!.mockClear();
    viewport.props.acknowledge!(8); viewport.props.onDecodeError!();
    expect(api).not.toHaveBeenCalled();
    expect(fixture.setters[7]).not.toHaveBeenCalled();
    secondCleanup?.();
  });
});

describe("live browser control affordance", () => {
  it("returns viewport focus to the existing browser address field", () => {
    fixture.frame = { seq: 1, data: "fixture", viewerId: "current-viewer", generation: 1 };
    const nodes = renderElements();
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
