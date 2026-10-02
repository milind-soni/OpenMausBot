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
  // Initial values by useState call order, for state no other fixture covers.
  states: {} as Record<number, unknown>,
  queues: [] as Array<{ enqueue: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; drain: ReturnType<typeof vi.fn>;
    settle: ReturnType<typeof vi.fn>; size: ReturnType<typeof vi.fn>; stopped: ReturnType<typeof vi.fn> }>,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react,
    useEffect: (effect: EffectCallback) => { fixture.effects.push(effect); },
    useRef: (value: unknown) => { const ref = react.useRef(value); fixture.refs.push(ref); return ref; },
    useState: (value: unknown) => {
      const index = fixture.setters.length;
      const [state] = react.useState(index in fixture.states ? fixture.states[index] : value === null ? fixture.frame : value && typeof value === "object" && "controlling" in value ? fixture.control : value);
      const setter = vi.fn(); fixture.setters.push(setter); return [state, setter];
    },
  };
});
vi.mock("@/state/store", () => ({ api: vi.fn().mockResolvedValue({}), useStore: () => ({ state: { config: { browserProfiles: [] } } }) }));
vi.mock("./BrowserProfilesManager", () => ({ BrowserProfilesManager: () => null }));
vi.mock("@/lib/browser-input-queue", () => ({ createBrowserInputQueue: () => {
  const queue = { enqueue: vi.fn(), clear: vi.fn(), drain: vi.fn().mockResolvedValue(undefined),
    settle: vi.fn().mockResolvedValue(undefined), size: vi.fn(() => 0), stopped: vi.fn(() => false) };
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
  disconnect() {
    for (const listener of this.listeners.get("error") ?? []) listener(new Event("error") as MessageEvent);
  }
}
const bot = { id: "pepper", name: "Pepper" } as Bot;
const render = () => renderToStaticMarkup(createElement(LiveBrowser, { bot }));
type Node = ReactElement<{
  children?: ReactNode; "aria-label"?: string; ref?: RefObject<HTMLInputElement | null>;
  disabled?: boolean; readOnly?: boolean; driving?: boolean;
  onReturnToToolbar?: () => void; onClick?: (event: unknown) => void; onProfileChanged?: () => void;
  onFocus?: (event: { target: { select: () => void } }) => void;
  acknowledge?: (seq: number) => void; onDecodeError?: () => void;
  input?: (body: Record<string, unknown>) => void;
  onSubmit?: (event: { preventDefault: () => void; currentTarget: { elements: { namedItem: (name: string) => { value: string } } } }) => void;
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
// An implicit take chains several promises before the action it unlocks.
const settleAll = async () => { for (let turn = 0; turn < 50; turn++) await Promise.resolve(); };
const sentTypes = () => vi.mocked(api).mock.calls.map(([, init]) => JSON.parse(String(init?.body)).type);
beforeEach(() => {
  fixture.effects = []; fixture.refs = []; fixture.queues = []; fixture.setters = [];
  fixture.control = { held: false, controlling: false, owned: false };
  fixture.frame = null; fixture.states = {};
  FixtureEventSource.instances = [];
  vi.stubGlobal("EventSource", FixtureEventSource);
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
  vi.mocked(api).mockReset().mockResolvedValue({});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("live browser connection lifecycle", () => {
  it("restores the address after reconnecting while the old address field was focused", () => {
    const nodes = renderElements();
    const connect = fixture.effects[2]!;
    const cleanup = connect();
    nodes.find((node) => node.props["aria-label"] === "Browser address")!.props.onFocus!({ target: { select: vi.fn() } });
    cleanup?.();
    const replacementCleanup = connect();
    FixtureEventSource.instances[1]!.emit("tabs", { tabs: [{ tabId: "t1", active: true, title: "Fixture", url: "https://example.test/" }] });
    expect(fixture.setters[3]).toHaveBeenLastCalledWith("https://example.test/");
    replacementCleanup?.();
  });

  it.each(["network", "stream"])("automatically reconnects a %s failure without replaying input or taking control", (failure) => {
    vi.useFakeTimers();
    render();
    const connect = fixture.effects[2]!;
    const cleanup = connect();
    const source = FixtureEventSource.instances[0]!;
    source.emit("ready", { viewerId: "old-viewer" });
    if (failure === "network") source.disconnect();
    else source.emit("error", { retryable: true, message: "Stream disconnected" });
    expect(fixture.queues[0]!.clear).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(999);
    expect(fixture.setters[0]).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fixture.setters[0]).toHaveBeenCalledOnce();
    cleanup?.();
    const replacementCleanup = connect();
    FixtureEventSource.instances[1]!.emit("ready", { viewerId: "new-viewer" });
    expect(api).not.toHaveBeenCalled();
    expect(fixture.queues[1]!.enqueue).not.toHaveBeenCalled();
    replacementCleanup?.();
  });

  it("bounds retries even when a flapping stream sends ready before disconnecting", () => {
    vi.useFakeTimers();
    render();
    const connect = fixture.effects[2]!;
    for (let attempt = 0; attempt < 6; attempt++) {
      const cleanup = connect();
      const source = FixtureEventSource.instances.at(-1)!;
      source.emit("ready", { viewerId: `viewer-${attempt}` });
      source.disconnect();
      vi.advanceTimersByTime(30_000);
      expect(fixture.setters[0]).toHaveBeenCalledTimes(Math.min(attempt + 1, 5));
      cleanup?.();
    }
  });

  it("resets the retry delay only after a healthy heartbeat", () => {
    vi.useFakeTimers();
    render();
    const connect = fixture.effects[2]!;
    const firstCleanup = connect();
    FixtureEventSource.instances[0]!.disconnect();
    vi.advanceTimersByTime(1_000);
    firstCleanup?.();
    const cleanup = connect();
    const source = FixtureEventSource.instances[1]!;
    source.emit("ready", { viewerId: "healthy" });
    source.emit("heartbeat", {});
    source.disconnect();
    vi.advanceTimersByTime(1_000);
    expect(fixture.setters[0]).toHaveBeenCalledTimes(2);
    cleanup?.();
  });

  it.each(["unmount", "manual reconnect", "profile change"])("cancels scheduled retries on %s", (replacement) => {
    vi.useFakeTimers();
    const nodes = renderElements();
    const cleanup = fixture.effects[2]!();
    FixtureEventSource.instances[0]!.disconnect();
    if (replacement === "manual reconnect") click(nodes, "Reconnect view");
    if (replacement === "profile change") nodes.find((node) => node.type === BrowserProfilesManager)!.props.onProfileChanged!();
    cleanup?.();
    fixture.setters[0]!.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(fixture.setters[0]).not.toHaveBeenCalled();
  });

  it("does not retry terminal server refusals", () => {
    vi.useFakeTimers();
    render();
    const cleanup = fixture.effects[2]!();
    FixtureEventSource.instances[0]!.emit("error", { message: "Browser access is disabled" });
    vi.advanceTimersByTime(30_000);
    expect(fixture.setters[0]).not.toHaveBeenCalled();
    cleanup?.();
  });

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
      timeoutMs: 120_000,
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
    // Each viewer's first toolbar action takes control by itself, then runs.
    vi.mocked(api).mockResolvedValueOnce({}).mockReturnValueOnce(oldAction.promise)
      .mockResolvedValueOnce({}).mockReturnValueOnce(currentAction.promise);
    click(nodes, "Back"); await settleAll();
    cleanup?.();
    const secondCleanup = connect();
    FixtureEventSource.instances[1]!.emit("ready", { viewerId: "new-viewer" });
    click(nodes, "Back"); await settleAll();
    expect(sentTypes()).toEqual(["take", "back", "take", "back"]);
    fixture.setters.forEach((setter) => setter.mockClear());
    oldAction.reject(new Error("Old action failed")); await settleAll();
    expect(fixture.setters[6]).not.toHaveBeenCalled();
    expect(fixture.setters[7]).not.toHaveBeenCalled();
    currentAction.resolve(); await settleAll();
    expect(fixture.setters[6]).toHaveBeenCalledWith(false);
    secondCleanup?.();
  });

  it("serializes commands even when clicked twice before pending state renders", async () => {
    const nodes = renderElements();
    const cleanup = fixture.effects[2]!();
    FixtureEventSource.instances[0]!.emit("ready", { viewerId: "current-viewer" });
    click(nodes, "Reload page"); await settleAll();
    expect(sentTypes()).toEqual(["take", "reload"]);
    vi.mocked(api).mockClear(); fixture.queues[0]!.drain.mockClear();
    const action = deferred();
    vi.mocked(api).mockReturnValueOnce(action.promise);
    click(nodes, "Back"); click(nodes, "Back"); await settleAll();
    expect(api).toHaveBeenCalledOnce();
    expect(fixture.queues[0]!.drain).toHaveBeenCalledOnce();
    action.resolve(); await settleAll();
    click(nodes, "Back"); await settleAll();
    expect(sentTypes()).toEqual(["back", "back"]);
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
      timeoutMs: 120_000,
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

  it.each([
    ["the bot has the browser", { held: false, controlling: false, owned: false }],
    ["this viewer holds it", { held: true, controlling: true, owned: true }],
  ])("has no Take control or Return to bot button while %s", (_state, control) => {
    fixture.control = control;
    const html = render();
    expect(html).not.toMatch(/Take control|Return to bot|aria-pressed/);
    expect(html).toContain('aria-label="Browser profiles"');
    expect(html).toContain("Restart browser…");
  });

  // The status floats over the live view, so its words show at any panel width
  // and it never takes a click from the page.
  const status = (html: string) => /<div role="status"([^>]*)>(.*?)<\/div><\/div><dialog/.exec(html)!;

  it("shows a status pill, not a control, over the page only while this viewer holds the browser", () => {
    expect(status(render())[2]).toBe("");
    fixture.control = { held: true, controlling: true, owned: true };
    fixture.frame = { seq: 1, data: "fixture", viewerId: "current-viewer", generation: 1 };
    const [, attributes, pill] = status(render());
    expect(attributes).toContain("pointer-events-none");
    expect(pill).toContain("You’re using the browser");
    expect(pill).toContain('aria-description="Pepper’s browser tools are paused while you use it. Control goes back to Pepper after a few seconds without input."');
    expect(pill).not.toMatch(/<button|<a |sr-only/);
  });

  it("says, in words, that it is waiting for the bot once a take is slow", () => {
    fixture.states = { 11: "slow" };
    const [, , pill] = status(render());
    expect(pill).toContain("Waiting for Pepper to finish…");
    expect(pill).not.toMatch(/sr-only|You’re using the browser/);
  });

  it("says when input made while the bot finished was not sent", () => {
    fixture.states = { 11: "stale" };
    fixture.control = { held: true, controlling: true, owned: true };
    const [, , pill] = status(render());
    expect(pill).toContain("Pepper was busy, so that wasn’t sent. Try again.");
    expect(pill).not.toContain("You’re using the browser");
  });

  it("keeps the toolbar and page usable while the bot has the browser, but not while another window holds it", () => {
    fixture.states = { 4: true };
    fixture.frame = { seq: 1, data: "fixture", viewerId: "current-viewer", generation: 1 };
    const controls = () => {
      fixture.setters = []; // fixture.states index this render's useState calls
      const nodes = renderElements();
      const find = (label: string) => nodes.find((node) => node.props["aria-label"] === label)!;
      return { back: find("Back"), reload: find("Reload page"), newTab: find("New tab"), address: find("Browser address"),
        viewport: nodes.find((node) => node.type === BrowserViewport)! };
    };
    const watching = controls();
    expect([watching.back, watching.reload, watching.newTab].map((node) => node.props.disabled)).toEqual([false, false, false]);
    expect(watching.address.props.readOnly).toBe(false);
    expect(watching.viewport.props.driving).toBe(true);
    // A pending take holds toolbar actions back, while page input still reaches the take.
    fixture.states = { 4: true, 11: "pending" };
    const taking = controls();
    expect([taking.back, taking.reload, taking.newTab].map((node) => node.props.disabled)).toEqual([true, true, true]);
    expect(taking.address.props.readOnly).toBe(true);
    expect(taking.viewport.props.driving).toBe(true);
    fixture.states = { 4: true };
    fixture.control = { held: true, controlling: false, owned: false };
    const elsewhere = controls();
    expect([elsewhere.back, elsewhere.reload, elsewhere.newTab].map((node) => node.props.disabled)).toEqual([true, true, true]);
    expect(elsewhere.address.props.readOnly).toBe(true);
    expect(elsewhere.viewport.props.driving).toBe(false);
  });

  it.each([
    ["the bot owns the page", { held: false, controlling: false, owned: false }, true, false, false],
    ["this viewer is still taking control", { held: true, controlling: false, owned: true }, true, false, false],
    ["another viewer owns the page", { held: true, controlling: true, owned: false }, true, false, false],
    ["this viewer controls the page", { held: true, controlling: true, owned: true }, true, false, true],
    ["the connection was lost", { held: true, controlling: true, owned: true }, false, false, false],
    ["a command is still running", { held: true, controlling: true, owned: true }, true, true, false],
  ])("requires a granted lease for the typing dialog while %s", (_label, control, connected, pending, ready) => {
    fixture.control = control;
    fixture.states = { 4: connected, 6: pending, 9: true };
    const nodes = renderElements();
    const open = nodes.find((node) => node.props.children === "Type or paste text…")!;
    const submit = nodes.find((node) => node.type === "button" && node.props.children === "Type")!;
    expect(open.props.disabled).toBe(!ready);
    expect(submit.props.disabled).toBe(!ready);
    if (!ready) {
      // A stale dialog stays open with its draft intact until the person
      // closes it; submitting must never take control and insert into a
      // field the bot could have changed while the dialog was open.
      const form = nodes.find((node) => node.type === "form" && elements(node).some((child) => child.type === "button" && child.props.children === "Type"))!;
      const field = { value: "private@example.test" };
      form.props.onSubmit!({ preventDefault: vi.fn(), currentTarget: { elements: { namedItem: () => field } } });
      expect(field.value).toBe("private@example.test");
      expect(api).not.toHaveBeenCalled();
      expect(fixture.setters[9]).not.toHaveBeenCalled();
    }
  });

  it("says why profiles are locked while another window holds the browser or an action runs", () => {
    const fresh = () => { fixture.setters = []; return render(); };
    expect(fresh()).not.toMatch(/Another window is using this browser|Profiles unlock/);
    fixture.control = { held: true, controlling: false, owned: false };
    expect(fresh()).toContain("Another window is using this browser. Switch profiles once it’s done.");
    // An idle hold of its own needs no line: opening the profiles hands it back.
    fixture.control = { held: true, controlling: true, owned: true };
    expect(fresh()).not.toMatch(/Another window is using this browser|Profiles unlock/);
    fixture.states = { 6: true };
    expect(fresh()).toContain("Profiles unlock once the current browser action finishes.");
  });

  it("keeps the page while its own take waits but hides it while another window holds it", () => {
    fixture.control = { held: true, controlling: false, owned: false };
    expect(render()).toContain("Live view paused for human control");
    fixture.control = { held: false, controlling: false, owned: false };
    const cleanup = fixture.effects[2]!();
    const source = FixtureEventSource.instances[0]!;
    source.emit("ready", { viewerId: "current-viewer" });
    fixture.setters[1]!.mockClear();
    source.emit("control", { held: true, controlling: false, owned: true });
    expect(fixture.setters[1]).not.toHaveBeenCalled();
    source.emit("control", { held: true, controlling: false, owned: false });
    expect(fixture.setters[1]).toHaveBeenCalledWith(null);
    cleanup?.();
  });
});

describe("implicit browser control", () => {
  const press = { type: "input_mouse", eventType: "mousePressed", x: 4, y: 5, button: "left", clickCount: 1, modifiers: 0 };
  const lift = { ...press, eventType: "mouseReleased" };
  const hover = { type: "input_mouse", eventType: "mouseMoved", x: 6, y: 7, button: "none", modifiers: 0 };
  const refused = "Another browser view or bot action is using this browser. Try again shortly.";
  const connectViewer = () => {
    fixture.frame = { seq: 1, data: "fixture", viewerId: "current-viewer", generation: 1 };
    const nodes = renderElements();
    const cleanup = fixture.effects[2]!();
    const source = FixtureEventSource.instances[0]!;
    source.emit("ready", { viewerId: "current-viewer" });
    return { cleanup, source, nodes, input: nodes.find((node) => node.type === BrowserViewport)!.props.input! };
  };

  it("takes control on the first click and sends that click exactly once after the take", async () => {
    const { cleanup, input } = connectViewer();
    const take = deferred();
    vi.mocked(api).mockReturnValueOnce(take.promise);
    input(press); input(lift); await settleAll();
    expect(api).toHaveBeenCalledExactlyOnceWith("/api/bots/pepper/browser/action", {
      method: "POST", body: JSON.stringify({ type: "take", viewerId: "current-viewer" }), timeoutMs: 120_000,
    });
    expect(fixture.queues[0]!.enqueue).not.toHaveBeenCalled();
    take.resolve(); await settleAll();
    expect(fixture.queues[0]!.enqueue.mock.calls.map(([body]) => body)).toEqual([press, lift]);
    input(press);
    expect(fixture.queues[0]!.enqueue).toHaveBeenLastCalledWith(press);
    expect(sentTypes()).toEqual(["take"]);
    cleanup?.();
  });

  it("drops the click and shows the server's message in the error bar when the take is refused", async () => {
    const { cleanup, input } = connectViewer();
    vi.mocked(api).mockRejectedValueOnce(new Error(refused));
    input(press); input(lift); await settleAll();
    expect(fixture.queues[0]!.enqueue).not.toHaveBeenCalled();
    expect(fixture.setters[7]).toHaveBeenLastCalledWith(refused);
    cleanup?.();
  });

  it("never takes control for hover alone", async () => {
    const { cleanup, input } = connectViewer();
    input(hover); input(hover); await settleAll();
    expect(api).not.toHaveBeenCalled();
    expect(fixture.queues[0]!.enqueue).not.toHaveBeenCalled();
    cleanup?.();
  });

  it("hands back after 8 idle seconds, never while a mouse button is held", async () => {
    vi.useFakeTimers();
    const { cleanup, input } = connectViewer();
    input(press); await settleAll();
    vi.advanceTimersByTime(30_000); await settleAll();
    expect(sentTypes()).toEqual(["take"]);
    input(lift);
    vi.advanceTimersByTime(7_999); await settleAll();
    expect(sentTypes()).toEqual(["take"]);
    vi.advanceTimersByTime(1); await settleAll();
    expect(sentTypes()).toEqual(["take", "release"]);
    cleanup?.();
  });

  it("hands control back when the panel closes, unless a button is still held", async () => {
    const idle = connectViewer();
    idle.input(press); idle.input(lift); await settleAll();
    idle.cleanup?.();
    expect(sentTypes()).toEqual(["take", "release"]);
    vi.mocked(api).mockClear(); fixture.effects = []; FixtureEventSource.instances = [];
    const held = connectViewer();
    held.input(press); await settleAll();
    held.cleanup?.();
    expect(sentTypes()).toEqual(["take"]);
  });

  it("drops a click made while the bot finished its own action and says so, then takes the next click", async () => {
    const { cleanup, input } = connectViewer();
    vi.mocked(api).mockResolvedValueOnce({ ok: true, waited: true });
    input(press); input(lift); await settleAll();
    expect(fixture.queues[0]!.enqueue).not.toHaveBeenCalled();
    expect(fixture.setters[11]).toHaveBeenLastCalledWith("stale");
    input(press);
    expect(fixture.queues[0]!.enqueue).toHaveBeenCalledExactlyOnceWith(press);
    expect(fixture.setters[11]).toHaveBeenLastCalledWith("");
    expect(sentTypes()).toEqual(["take"]);
    cleanup?.();
  });

  it("runs a toolbar action clicked twice during a slow take only once", async () => {
    const nodes = renderElements();
    const cleanup = fixture.effects[2]!();
    FixtureEventSource.instances[0]!.emit("ready", { viewerId: "current-viewer" });
    const take = deferred();
    vi.mocked(api).mockReturnValueOnce(take.promise);
    click(nodes, "Back"); click(nodes, "Back"); await settleAll();
    take.resolve(); await settleAll();
    expect(sentTypes()).toEqual(["take", "back"]);
    cleanup?.();
  });

  it("hands the browser back as soon as the profiles open, not after the idle wait", async () => {
    vi.useFakeTimers();
    const { cleanup, input, nodes } = connectViewer();
    input(press); input(lift); await settleAll();
    expect(sentTypes()).toEqual(["take"]);
    click(nodes, "Browser profiles");
    vi.advanceTimersByTime(0); await settleAll();
    expect(sentTypes()).toEqual(["take", "release"]);
    cleanup?.();
  });

  it("keeps control while the typing dialog is open", async () => {
    vi.useFakeTimers();
    fixture.states = { 9: true };
    const { cleanup, input } = connectViewer();
    input(press); input(lift); await settleAll();
    fixture.effects[1]!();
    vi.advanceTimersByTime(60_000); await settleAll();
    expect(sentTypes()).toEqual(["take"]);
    cleanup?.();
  });

  it("does not contest another window's hold", async () => {
    const { cleanup, input, source } = connectViewer();
    source.emit("control", { held: true, controlling: false, owned: false });
    input(press); await settleAll();
    expect(api).not.toHaveBeenCalled();
    cleanup?.();
  });
});

// MOCA-266: the expand button only ever entered full screen. On macOS that
// takes the whole window into native full screen, where minimize is disabled,
// and clicking the button again did nothing.
describe("browser full screen", () => {
  const fullscreenDocument = () => {
    const listeners = new Map<string, () => void>();
    const doc = {
      fullscreenElement: null as unknown,
      exitFullscreen: vi.fn().mockResolvedValue(undefined),
      addEventListener: vi.fn((name: string, listener: () => void) => { listeners.set(name, listener); }),
      removeEventListener: vi.fn((name: string) => { listeners.delete(name); }),
    };
    vi.stubGlobal("document", doc);
    return { doc, listeners };
  };
  const panelElement = () => {
    const element = { requestFullscreen: vi.fn().mockResolvedValue(undefined) };
    (fixture.refs[3] as RefObject<unknown>).current = element;
    return element;
  };

  it("leaves full screen on the second click instead of asking for it again", async () => {
    const { doc } = fullscreenDocument();
    const nodes = renderElements();
    const panel = panelElement();

    click(nodes, "Full screen");
    expect(panel.requestFullscreen).toHaveBeenCalledOnce();
    doc.fullscreenElement = panel;
    click(nodes, "Full screen");
    await settle();
    expect(doc.exitFullscreen).toHaveBeenCalledOnce();
    expect(panel.requestFullscreen).toHaveBeenCalledOnce();
  });

  it("follows the document, so Esc and the window's own controls keep the button right", () => {
    const { doc, listeners } = fullscreenDocument();
    renderElements();
    const panel = panelElement();
    // useState call order: takeStatus (11) sits just before fullscreen (12).
    const fullscreenSetter = fixture.setters[12]!;
    const cleanup = fixture.effects[3]!();

    doc.fullscreenElement = panel;
    listeners.get("fullscreenchange")!();
    expect(fullscreenSetter).toHaveBeenLastCalledWith(true);
    doc.fullscreenElement = null;
    listeners.get("fullscreenchange")!();
    expect(fullscreenSetter).toHaveBeenLastCalledWith(false);
    cleanup?.();
    expect(listeners.has("fullscreenchange")).toBe(false);
  });

  it("says when leaving full screen fails", async () => {
    const { doc } = fullscreenDocument();
    doc.exitFullscreen.mockRejectedValue(new Error("denied"));
    const nodes = renderElements();
    const panel = panelElement();
    doc.fullscreenElement = panel;
    click(nodes, "Full screen");
    await settle();
    expect(fixture.setters[7]).toHaveBeenLastCalledWith("Could not leave full screen. Press Esc instead.");
  });
});
