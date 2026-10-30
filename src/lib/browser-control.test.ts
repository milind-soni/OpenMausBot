import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_HAND_BACK_MS, BROWSER_TAKE_NOTICE_MS, createBrowserControl, streamTransport } from "./browser-control";
import type { PreviewStreamControl, PreviewStreamInput } from "./browser-stream-client";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
// Takes, flushes and hand-backs chain several promises; let them all run.
const settle = async () => { for (let turn = 0; turn < 50; turn++) await Promise.resolve(); };
const ACTIONS = { mousePressed: "down", mouseReleased: "up", mouseMoved: "move" } as const;
const mouse = (eventType: keyof typeof ACTIONS, button: "left" | "none" = "left"): PreviewStreamInput => ({ type: "mouse", action: ACTIONS[eventType], x: 10, y: 20, button, buttons: eventType === "mousePressed" ? 1 : 0, clickCount: 1, modifiers: 0 });
const key = (eventType: "keyDown" | "keyUp", value = "a"): PreviewStreamInput => ({ type: "key", action: eventType === "keyDown" ? "down" : "up", key: value,
  code: value === "Shift" ? "ShiftLeft" : `Key${value.toUpperCase()}`, modifiers: 0 });
const press = mouse("mousePressed"), lift = mouse("mouseReleased"), hover = mouse("mouseMoved", "none");
const back: PreviewStreamInput = { type: "history", delta: -1 };
const refused = "Another browser view or bot action is using this browser. Try again shortly.";

function harness() {
  const sent: PreviewStreamInput[] = [];
  const server = { owned: false };
  const transport = {
    send: vi.fn((input: PreviewStreamInput) => { sent.push(input); }),
    drain: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
    size: vi.fn(() => 0),
    stopped: vi.fn(() => false),
    take: vi.fn(async (): Promise<{ waited: boolean } | void> => ({ waited: false })),
    release: vi.fn(async (): Promise<void> => {}),
  };
  const options = {
    transport,
    owned: () => server.owned,
    onTakeStatus: vi.fn(),
    onError: vi.fn(),
    onHalted: vi.fn(),
  };
  const control = createBrowserControl(options);
  const interact = (...inputs: PreviewStreamInput[]) => { for (const input of inputs) control.interact(input); };
  return { control, options, transport, server, sent, interact };
}

afterEach(() => { vi.useRealTimers(); });

describe("taking browser control implicitly", () => {
  it("takes control on the first click and sends that click exactly once after the take", async () => {
    const h = harness();
    const take = deferred();
    h.transport.take.mockImplementationOnce(() => take.promise);
    h.interact(press, lift);
    await settle();
    expect(h.transport.take).toHaveBeenCalledOnce();
    expect(h.transport.send).not.toHaveBeenCalled();
    take.resolve(); await settle();
    expect(h.transport.send.mock.calls.map(([body]) => body)).toEqual([press, lift]);
    h.interact(press);
    expect(h.transport.send).toHaveBeenLastCalledWith(press);
    await settle();
    expect(h.transport.take).toHaveBeenCalledOnce();
  });

  it("buffers page input and toolbar actions during a pending take and sends them in order", async () => {
    const h = harness();
    const take = deferred();
    h.transport.take.mockImplementationOnce(() => take.promise);
    h.interact(press, hover, lift, back, key("keyDown"), key("keyUp"));
    await settle();
    expect(h.sent).toEqual([]);
    take.resolve(); await settle();
    expect(h.sent).toEqual([press, hover, lift, back, key("keyDown"), key("keyUp")]);
    h.interact(key("keyDown", "b"));
    expect(h.sent.at(-1)).toEqual(key("keyDown", "b"));
    expect(h.transport.take).toHaveBeenCalledOnce();
  });

  it("never takes control for hover, a lone modifier, or a release", async () => {
    const h = harness();
    h.interact(hover, lift, key("keyUp"), key("keyDown", "Shift"));
    await settle();
    expect(h.transport.take).not.toHaveBeenCalled();
    expect(h.transport.send).not.toHaveBeenCalled();
    expect(h.options.onTakeStatus).not.toHaveBeenCalled();
  });

  it.each<[string, PreviewStreamInput]>([
    ["a scroll", { type: "wheel", x: 1, y: 2, deltaX: 0, deltaY: 40, modifiers: 0 }],
    ["a key", key("keyDown")],
    ["pasted text", { type: "text", text: "hello" }],
    ["a toolbar action", { type: "reload" }],
    ["a tab switch", { type: "tabSelect", tabId: "t2" }],
  ])("takes control for %s", async (_name, item) => {
    const h = harness();
    h.interact(item);
    await settle();
    expect(h.transport.take).toHaveBeenCalledOnce();
    expect(h.sent).toEqual([item]);
  });

  it("drops what it buffered and reports the server's message when the take is refused", async () => {
    const h = harness();
    h.transport.take.mockRejectedValueOnce(new Error(refused));
    h.interact(press, lift, back);
    await settle();
    expect(h.options.onError).toHaveBeenLastCalledWith(refused);
    expect(h.sent).toEqual([]);
    expect(h.options.onTakeStatus).toHaveBeenLastCalledWith("");
    h.interact(lift); await settle();
    expect(h.transport.take).toHaveBeenCalledOnce();
    h.interact(press); await settle();
    expect(h.transport.take).toHaveBeenCalledTimes(2);
    expect(h.sent).toEqual([press]);
  });

  it("shows the waiting status only when the take outlasts 300ms", async () => {
    vi.useFakeTimers();
    const h = harness();
    const take = deferred();
    h.transport.take.mockImplementationOnce(() => take.promise);
    h.interact(press);
    expect(h.options.onTakeStatus).toHaveBeenLastCalledWith("pending");
    vi.advanceTimersByTime(BROWSER_TAKE_NOTICE_MS - 1);
    expect(h.options.onTakeStatus).not.toHaveBeenCalledWith("slow");
    vi.advanceTimersByTime(1);
    expect(h.options.onTakeStatus).toHaveBeenLastCalledWith("slow");
    take.resolve(); await settle();
    expect(h.options.onTakeStatus).toHaveBeenLastCalledWith("");
    const quick = harness();
    quick.interact(press); await settle();
    vi.advanceTimersByTime(1_000);
    expect(quick.options.onTakeStatus.mock.calls.map(([status]) => status)).toEqual(["pending", ""]);
  });

  it("drops what the person aimed at the page when the grant waited for the bot's own action", async () => {
    const h = harness();
    const take = deferred();
    h.transport.take.mockImplementationOnce(async () => { await take.promise; return { waited: true }; });
    const navigate: PreviewStreamInput = { type: "navigate", url: "https://example.com/" };
    h.interact(press, lift, key("keyDown"), navigate);
    take.resolve(); await settle();
    expect(h.sent).toEqual([navigate]);
    expect(h.options.onTakeStatus).toHaveBeenLastCalledWith("stale");
    h.interact(key("keyUp"));
    expect(h.transport.send).toHaveBeenCalledOnce();
    h.interact(press);
    expect(h.transport.send).toHaveBeenLastCalledWith(press);
    expect(h.options.onTakeStatus).toHaveBeenLastCalledWith("");
    expect(h.transport.take).toHaveBeenCalledOnce();
  });

  it("drops page-relative toolbar actions after a waited grant, and says nothing when nothing was lost", async () => {
    const h = harness();
    h.transport.take.mockResolvedValueOnce({ waited: true });
    h.interact(back); await settle();
    expect(h.sent).toEqual([]);
    expect(h.options.onTakeStatus).toHaveBeenLastCalledWith("stale");
    const quiet = harness();
    quiet.transport.take.mockResolvedValueOnce({ waited: true });
    quiet.interact({ type: "tabNew" }, hover); await settle();
    expect(quiet.sent).toEqual([{ type: "tabNew" }]);
    expect(quiet.options.onTakeStatus).toHaveBeenLastCalledWith("");
  });

  it("keeps one toolbar action while a take waits, so repeated clicks do not pile up", async () => {
    const h = harness();
    const take = deferred();
    h.transport.take.mockImplementationOnce(() => take.promise);
    h.interact(back, back, press, lift, { type: "tabNew" });
    take.resolve(); await settle();
    expect(h.sent).toEqual([back, press, lift]);
  });

  it("does not take control for page input after the input queue halted", async () => {
    const h = harness();
    h.transport.stopped.mockReturnValue(true);
    h.interact(press); await settle();
    expect(h.transport.take).not.toHaveBeenCalled();
    expect(h.options.onHalted).toHaveBeenCalledOnce();
    h.interact({ type: "reload" }); await settle();
    expect(h.transport.take).toHaveBeenCalledOnce();
    expect(h.sent).toEqual([{ type: "reload" }]);
  });

  it("feeds a long buffer to the input queue in batches it always accepts", async () => {
    const h = harness();
    let unsent = 0, most = 0;
    h.transport.send.mockImplementation(() => { most = Math.max(most, ++unsent); });
    h.transport.size.mockImplementation(() => unsent);
    h.transport.settle.mockImplementation(async () => { unsent = 0; });
    const take = deferred();
    h.transport.take.mockImplementationOnce(() => take.promise);
    const typed = Array.from("an email address typed while waiting").flatMap((letter) => [key("keyDown", letter), key("keyUp", letter)]);
    for (const input of typed) h.control.interact(input);
    take.resolve(); await settle();
    expect(h.transport.send.mock.calls.map(([body]) => body)).toEqual(typed);
    expect(most).toBeLessThanOrEqual(16);
    expect(h.transport.settle).toHaveBeenCalled();
  });
});

describe("handing browser control back", () => {
  it("hands back after 8 idle seconds, once releases are confirmed, and any input restarts the wait", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.interact(press, lift); await settle();
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS - 1); await settle();
    h.interact(hover);
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS - 1); await settle();
    expect(h.transport.release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); await settle();
    expect(h.transport.release).toHaveBeenCalledOnce();
    expect(h.transport.drain.mock.invocationCallOrder[0]).toBeLessThan(h.transport.release.mock.invocationCallOrder[0]!);
    h.interact(press); await settle();
    expect(h.transport.take).toHaveBeenCalledTimes(2);
  });

  it("never hands back while a mouse button or key is held down", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.interact(press); await settle();
    vi.advanceTimersByTime(60_000); await settle();
    expect(h.transport.release).not.toHaveBeenCalled();
    h.interact(key("keyDown"), lift);
    vi.advanceTimersByTime(60_000); await settle();
    expect(h.transport.release).not.toHaveBeenCalled();
    h.interact(key("keyUp"));
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(h.transport.release).toHaveBeenCalledOnce();
  });

  it("keeps control when input arrives while the hand-back waits for what is still being sent", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.interact(press, lift); await settle();
    const drain = deferred();
    h.transport.drain.mockImplementationOnce(() => drain.promise);
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(h.transport.drain).toHaveBeenCalledOnce();
    h.interact(hover);
    drain.resolve(); await settle();
    expect(h.transport.release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(h.transport.release).toHaveBeenCalledOnce();
  });

  it("hands back only once a toolbar action still being sent has gone", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.interact(press, lift); await settle();
    const reload = deferred();
    h.transport.drain.mockImplementationOnce(() => reload.promise);
    h.interact({ type: "reload" });
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(h.transport.release).not.toHaveBeenCalled();
    reload.resolve(); await settle();
    expect(h.transport.release).toHaveBeenCalledOnce();
  });

  it("sends the next take only after an idle hand-back has finished", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.interact(press, lift); await settle();
    const release = deferred();
    h.transport.release.mockImplementationOnce(() => release.promise);
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(h.transport.release).toHaveBeenCalledOnce();
    h.interact(hover, press, lift);
    await settle();
    expect(h.transport.take).toHaveBeenCalledOnce();
    release.resolve(); await settle();
    expect(h.transport.take).toHaveBeenCalledTimes(2);
    expect(h.transport.release.mock.invocationCallOrder[0]).toBeLessThan(h.transport.take.mock.invocationCallOrder[1]!);
    expect(h.transport.send.mock.calls.slice(2).map(([body]) => body)).toEqual([press, lift]);
  });

  it("hands back a hold the server kept after a timed-out take, but never another person's", async () => {
    vi.useFakeTimers();
    // The server gives up waiting for the bot after 15s and keeps the hold.
    const timedOut = () => new Promise<void>((_, reject) => { setTimeout(() => reject(new Error(refused)), 15_000); });
    const kept = harness();
    kept.transport.take.mockImplementationOnce(timedOut);
    kept.server.owned = true;
    kept.interact(press); await settle();
    vi.advanceTimersByTime(15_000); await settle();
    expect(kept.options.onError).toHaveBeenLastCalledWith(refused);
    expect(kept.transport.release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(kept.transport.release).toHaveBeenCalledOnce();
    const other = harness();
    other.transport.take.mockImplementationOnce(timedOut);
    other.interact(press); await settle();
    vi.advanceTimersByTime(15_000 + BROWSER_HAND_BACK_MS); await settle();
    expect(other.transport.release).not.toHaveBeenCalled();
  });

  it("hands back an unused hold the server reports, without postponing an armed hand-back", async () => {
    vi.useFakeTimers();
    const unused = harness();
    unused.server.owned = true;
    unused.control.observe();
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(unused.transport.release).toHaveBeenCalledOnce();
    const h = harness();
    h.interact(press, lift); await settle();
    h.server.owned = true;
    vi.advanceTimersByTime(5_000);
    h.control.observe();
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS - 5_000); await settle();
    expect(h.transport.release).toHaveBeenCalledOnce();
  });

  it("hands back when the panel closes only if nothing is held, unsent or running", async () => {
    const idle = harness();
    idle.interact(press, lift); await settle();
    idle.control.leave();
    expect(idle.transport.release).toHaveBeenCalledOnce();
    const pressed = harness();
    pressed.interact(press); await settle();
    pressed.control.leave();
    expect(pressed.transport.release).not.toHaveBeenCalled();
    const unsent = harness();
    unsent.interact(press, lift); await settle();
    unsent.transport.size.mockReturnValue(1);
    unsent.control.leave();
    expect(unsent.transport.release).not.toHaveBeenCalled();
    const watching = harness();
    watching.control.leave();
    expect(watching.transport.release).not.toHaveBeenCalled();
  });

  it.each([
    ["a Cmd shortcut whose key-up macOS never sends", [key("keyDown", "Meta"), { ...key("keyDown", "c"), modifiers: 4 } as PreviewStreamInput, key("keyUp", "Meta")]],
    ["a discrete key the server sends as one press", [key("keyDown", "Enter")]],
  ])("hands back after %s", async (_name, inputs) => {
    vi.useFakeTimers();
    const h = harness();
    for (const input of inputs) h.interact(input);
    await settle();
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(h.transport.release).toHaveBeenCalledOnce();
  });

  it("hands back at once when asked (switching profiles), once what is being sent has gone", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.interact(press, lift); await settle();
    h.control.handBack();
    vi.advanceTimersByTime(0); await settle();
    expect(h.transport.release).toHaveBeenCalledOnce();
    const busy = harness();
    busy.interact(press, lift); await settle();
    const reload = deferred();
    busy.transport.drain.mockImplementationOnce(() => reload.promise);
    busy.interact({ type: "reload" });
    busy.control.handBack();
    vi.advanceTimersByTime(0); await settle();
    expect(busy.transport.release).not.toHaveBeenCalled();
    reload.resolve(); await settle();
    expect(busy.transport.release).toHaveBeenCalledOnce();
    busy.interact(press, lift); await settle();
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS - 1); await settle();
    expect(busy.transport.take).toHaveBeenCalledTimes(2);
    expect(busy.transport.release).toHaveBeenCalledOnce();
  });

  it("keeps control while the typing dialog is open, then waits the usual idle time", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.interact(press, lift); await settle();
    h.control.hold(true);
    vi.advanceTimersByTime(60_000); await settle();
    expect(h.transport.release).not.toHaveBeenCalled();
    h.control.hold(false);
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS - 1); await settle();
    expect(h.transport.release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); await settle();
    expect(h.transport.release).toHaveBeenCalledOnce();
  });

  it("does nothing once closed: no late flush, status, error or hand-back", async () => {
    vi.useFakeTimers();
    const h = harness();
    const take = deferred();
    h.transport.take.mockImplementationOnce(() => take.promise);
    h.interact(press, lift); await settle();
    h.control.close();
    take.resolve(); await settle();
    vi.advanceTimersByTime(60_000); await settle();
    expect(h.transport.send).not.toHaveBeenCalled();
    expect(h.transport.release).not.toHaveBeenCalled();
    expect(h.options.onTakeStatus.mock.calls.map(([status]) => status)).toEqual(["pending"]);
    h.interact(press); await settle();
    expect(h.transport.take).toHaveBeenCalledOnce();
  });
});

describe("holding the browser on purpose", () => {
  it("takes control on Take control without sending anything but the take", async () => {
    const h = harness();
    h.control.takeControl();
    await settle();
    expect(h.transport.take).toHaveBeenCalledOnce();
    expect(h.sent).toEqual([]);
    h.control.takeControl();
    await settle();
    expect(h.transport.take).toHaveBeenCalledOnce();
  });

  it("keeps a hold past idle time until it is let go, then the idle wait starts again", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.control.keep(true);
    h.interact(press, lift);
    await settle();
    h.server.owned = true;
    vi.advanceTimersByTime(10 * BROWSER_HAND_BACK_MS); await settle();
    expect(h.transport.release).not.toHaveBeenCalled();
    h.control.keep(false);
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(h.transport.release).toHaveBeenCalledOnce();
  });

  it("hands back at once on an explicit hand back, even while kept", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.control.keep(true);
    h.control.takeControl();
    await settle();
    h.control.handBack();
    vi.advanceTimersByTime(0); await settle();
    expect(h.transport.release).toHaveBeenCalledOnce();
  });

  it("hands back at once a hold the person has from another view, which this one never took", async () => {
    const h = harness();
    h.control.handBack();
    await settle();
    expect(h.transport.release).not.toHaveBeenCalled();
    const mine = createBrowserControl({ ...h.options, mine: () => true });
    mine.handBack();
    await settle();
    expect(h.transport.release).toHaveBeenCalledOnce();
  });

  it("after a hand-back from elsewhere, the next interaction takes control again", async () => {
    const h = harness();
    h.interact(press, lift);
    await settle();
    h.server.owned = true;
    h.control.observe();
    h.server.owned = false;
    h.control.observe();
    h.interact(press);
    await settle();
    expect(h.transport.take).toHaveBeenCalledTimes(2);
  });

  it("does not mistake an event older than its own take for a hand-back", async () => {
    const h = harness();
    h.interact(press, lift);
    await settle();
    h.control.observe();
    h.interact(press);
    expect(h.transport.send).toHaveBeenLastCalledWith(press);
    expect(h.transport.take).toHaveBeenCalledOnce();
  });
});

describe("the v2 stream as a control transport", () => {
  const control = (controller: PreviewStreamControl["controller"]): PreviewStreamControl => ({ canOperate: true, controller, generation: 1, dialog: null });
  function stream(initial: PreviewStreamControl | null, connected = true) {
    let current = initial;
    const listeners = new Set<(next: PreviewStreamControl | null) => void>();
    const client = { send: vi.fn((_input: PreviewStreamInput) => connected), stop: vi.fn() };
    const transport = streamTransport(client, {
      current: () => current,
      watch: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    }, "held elsewhere");
    const set = (next: PreviewStreamControl | null) => { current = next; for (const listener of listeners) listener(next); };
    return { client, transport, set, listeners };
  }

  it("takes control once the server says this viewer has it, and reports that the bot was busy", async () => {
    const h = stream(control("agent"));
    const taking = h.transport.take();
    expect(h.client.send).toHaveBeenCalledWith({ type: "takeControl" });
    h.set(control("agent"));
    h.set(control("you"));
    await expect(taking).resolves.toEqual({ waited: true });
    expect(h.listeners.size).toBe(0);
    const quiet = stream(control("unclaimed"));
    const free = quiet.transport.take();
    quiet.set(control("you"));
    await expect(free).resolves.toEqual({ waited: false });
  });

  it("fails a take that another viewer won, or that a closed view cannot send", async () => {
    const h = stream(control("unclaimed"));
    const taking = h.transport.take();
    h.set(control("another-viewer"));
    await expect(taking).rejects.toThrow("held elsewhere");
    const dropped = stream(control("unclaimed"));
    const lost = dropped.transport.take();
    dropped.set(null);
    await expect(lost).rejects.toThrow("disconnected");
    await expect(stream(control("unclaimed"), false).transport.take()).rejects.toThrow("not connected");
  });

  it("gives up on a take the server never grants", async () => {
    vi.useFakeTimers();
    const h = stream(control("agent"));
    const taking = h.transport.take();
    const failed = expect(taking).rejects.toThrow("Could not take control");
    vi.advanceTimersByTime(20_000);
    await failed;
  });

  it("sends input at once and lets go with a release", async () => {
    const h = stream(control("you"));
    const click: PreviewStreamInput = { type: "mouse", action: "down", x: 1, y: 2, button: "left", buttons: 1, clickCount: 1, modifiers: 0 };
    h.transport.send(click);
    await h.transport.release();
    expect(h.client.send.mock.calls.map(([input]) => input)).toEqual([click, { type: "releaseControl" }]);
    await expect(h.transport.take()).resolves.toEqual({ waited: false });
  });
});

