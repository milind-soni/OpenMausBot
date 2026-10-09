import { afterEach, describe, expect, it, vi } from "vitest";
import { BROWSER_HAND_BACK_MS, BROWSER_TAKE_NOTICE_MS, createBrowserControl, type BrowserInteraction } from "./browser-control";

type Body = Record<string, unknown>;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
// Takes, flushes and hand-backs chain several promises; let them all run.
const settle = async () => { for (let turn = 0; turn < 50; turn++) await Promise.resolve(); };
const mouse = (eventType: string, button = "left") => ({ type: "input_mouse", eventType, x: 10, y: 20, button, clickCount: 1, modifiers: 0 });
const key = (eventType: string, value = "a") => ({ type: "input_keyboard", eventType, key: value,
  code: value === "Shift" ? "ShiftLeft" : `Key${value.toUpperCase()}`, modifiers: 0 });
const press = mouse("mousePressed"), lift = mouse("mouseReleased"), hover = mouse("mouseMoved", "none");
const refused = "Another browser view or bot action is using this browser. Try again shortly.";

function harness() {
  const sent: Array<[string, Body]> = [];
  const server = { owned: false, busy: false };
  const queue = {
    enqueue: vi.fn((body: Body) => { sent.push(["input", body]); }),
    drain: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
    size: vi.fn(() => 0),
    stopped: vi.fn(() => false),
  };
  const options = {
    queue,
    take: vi.fn(async (): Promise<unknown> => ({})),
    release: vi.fn(async (): Promise<unknown> => ({})),
    command: vi.fn(async (body: Body) => { sent.push(["command", body]); }),
    busy: () => server.busy,
    owned: () => server.owned,
    onTakeStatus: vi.fn(),
    onError: vi.fn(),
    onHalted: vi.fn(),
  };
  const control = createBrowserControl(options);
  const interact = (...items: BrowserInteraction[]) => { for (const item of items) control.interact(item); };
  return { control, options, queue, server, sent, interact };
}

afterEach(() => { vi.useRealTimers(); });

describe("taking browser control implicitly", () => {
  it("takes control on the first click and sends that click exactly once after the take", async () => {
    const h = harness();
    const take = deferred();
    h.options.take.mockImplementationOnce(() => take.promise);
    h.interact({ input: press }, { input: lift });
    await settle();
    expect(h.options.take).toHaveBeenCalledOnce();
    expect(h.queue.enqueue).not.toHaveBeenCalled();
    take.resolve(); await settle();
    expect(h.queue.enqueue.mock.calls.map(([body]) => body)).toEqual([press, lift]);
    // Control is held now, so the next click goes straight to the page.
    h.interact({ input: press });
    expect(h.queue.enqueue).toHaveBeenLastCalledWith(press);
    await settle();
    expect(h.options.take).toHaveBeenCalledOnce();
  });

  it("buffers page input and toolbar actions during a pending take and sends them in order", async () => {
    const h = harness();
    const take = deferred(), back = deferred();
    h.options.take.mockImplementationOnce(() => take.promise);
    h.options.command.mockImplementationOnce(async (body) => { h.sent.push(["command", body]); await back.promise; });
    h.interact({ input: press }, { input: hover }, { input: lift }, { command: { type: "back" } },
      { input: key("keyDown") }, { input: key("keyUp") });
    await settle();
    expect(h.sent).toEqual([]);
    take.resolve(); await settle();
    // The toolbar action finishes before any later page input is sent.
    expect(h.sent).toEqual([["input", press], ["input", hover], ["input", lift], ["command", { type: "back" }]]);
    // Input arriving while that action runs still waits behind the buffer.
    h.interact({ input: key("keyDown", "b") });
    back.resolve(); await settle();
    expect(h.sent.slice(4)).toEqual([["input", key("keyDown")], ["input", key("keyUp")], ["input", key("keyDown", "b")]]);
    expect(h.options.take).toHaveBeenCalledOnce();
  });

  it("never takes control for hover, a lone modifier, or a release", async () => {
    const h = harness();
    h.interact({ input: hover }, { input: lift }, { input: key("keyUp") }, { input: key("keyDown", "Shift") });
    await settle();
    expect(h.options.take).not.toHaveBeenCalled();
    expect(h.queue.enqueue).not.toHaveBeenCalled();
    expect(h.options.onTakeStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["a scroll", { input: { type: "input_mouse", eventType: "mouseWheel", x: 1, y: 2, deltaX: 0, deltaY: 40, modifiers: 0 } }],
    ["a key", { input: key("keyDown") }],
    ["pasted text", { input: { type: "input_keyboard", eventType: "char", text: "hello" } }],
    ["a toolbar action", { command: { type: "reload" } }],
  ])("takes control for %s", async (_name, item) => {
    const h = harness();
    h.interact(item as BrowserInteraction);
    await settle();
    expect(h.options.take).toHaveBeenCalledOnce();
    expect(h.sent).toEqual(["input" in item ? ["input", item.input] : ["command", item.command]]);
  });

  it("drops what it buffered and reports the server's message when the take is refused", async () => {
    const h = harness();
    h.options.take.mockRejectedValueOnce(new Error(refused));
    h.interact({ input: press }, { input: lift }, { command: { type: "back" } });
    await settle();
    expect(h.options.onError).toHaveBeenLastCalledWith(refused);
    expect(h.sent).toEqual([]);
    expect(h.options.onTakeStatus).toHaveBeenLastCalledWith("");
    // The release of that dropped click is not a new interaction; a new click is.
    h.interact({ input: lift }); await settle();
    expect(h.options.take).toHaveBeenCalledOnce();
    h.interact({ input: press }); await settle();
    expect(h.options.take).toHaveBeenCalledTimes(2);
    expect(h.sent).toEqual([["input", press]]);
  });

  it("shows the waiting status only when the take outlasts 300ms", async () => {
    vi.useFakeTimers();
    const h = harness();
    const take = deferred();
    h.options.take.mockImplementationOnce(() => take.promise);
    h.interact({ input: press });
    expect(h.options.onTakeStatus).toHaveBeenLastCalledWith("pending");
    vi.advanceTimersByTime(BROWSER_TAKE_NOTICE_MS - 1);
    expect(h.options.onTakeStatus).not.toHaveBeenCalledWith("slow");
    vi.advanceTimersByTime(1);
    expect(h.options.onTakeStatus).toHaveBeenLastCalledWith("slow");
    take.resolve(); await settle();
    expect(h.options.onTakeStatus).toHaveBeenLastCalledWith("");
    const quick = harness();
    quick.interact({ input: press }); await settle();
    vi.advanceTimersByTime(1_000);
    expect(quick.options.onTakeStatus.mock.calls.map(([status]) => status)).toEqual(["pending", ""]);
  });

  it("drops what the person aimed at the page when the grant waited for the bot's own action", async () => {
    const h = harness();
    const take = deferred();
    h.options.take.mockImplementationOnce(async () => { await take.promise; return { ok: true, waited: true }; });
    const navigate = { type: "navigate", url: "https://example.com/" };
    h.interact({ input: press }, { input: lift }, { input: key("keyDown") }, { command: navigate });
    take.resolve(); await settle();
    // Only the toolbar action that means the same on any page still runs.
    expect(h.sent).toEqual([["command", navigate]]);
    expect(h.options.onTakeStatus).toHaveBeenLastCalledWith("stale");
    // The key's release never reaches the page that never saw it go down.
    h.interact({ input: key("keyUp") });
    expect(h.queue.enqueue).not.toHaveBeenCalled();
    // The next click is the person's own, on the page as it is now.
    h.interact({ input: press });
    expect(h.queue.enqueue).toHaveBeenLastCalledWith(press);
    expect(h.options.onTakeStatus).toHaveBeenLastCalledWith("");
    expect(h.options.take).toHaveBeenCalledOnce();
  });

  it("drops page-relative toolbar actions after a waited grant, and says nothing when nothing was lost", async () => {
    const h = harness();
    h.options.take.mockResolvedValueOnce({ ok: true, waited: true });
    h.interact({ command: { type: "back" } }); await settle();
    expect(h.sent).toEqual([]);
    expect(h.options.onTakeStatus).toHaveBeenLastCalledWith("stale");
    const quiet = harness();
    quiet.options.take.mockResolvedValueOnce({ ok: true, waited: true });
    quiet.interact({ command: { type: "tab-new" } }, { input: hover }); await settle();
    expect(quiet.sent).toEqual([["command", { type: "tab-new" }]]);
    expect(quiet.options.onTakeStatus).toHaveBeenLastCalledWith("");
  });

  it("keeps one toolbar action while a take waits, so repeated clicks do not pile up", async () => {
    const h = harness();
    const take = deferred();
    h.options.take.mockImplementationOnce(() => take.promise);
    h.interact({ command: { type: "back" } }, { command: { type: "back" } }, { input: press }, { input: lift },
      { command: { type: "tab-new" } });
    take.resolve(); await settle();
    expect(h.sent).toEqual([["command", { type: "back" }], ["input", press], ["input", lift]]);
  });

  it("does not take control for page input after the input queue halted", async () => {
    const h = harness();
    h.queue.stopped.mockReturnValue(true);
    h.interact({ input: press }); await settle();
    expect(h.options.take).not.toHaveBeenCalled();
    expect(h.options.onHalted).toHaveBeenCalledOnce();
    // Toolbar actions do not go through the halted queue.
    h.interact({ command: { type: "reload" } }); await settle();
    expect(h.options.take).toHaveBeenCalledOnce();
    expect(h.sent).toEqual([["command", { type: "reload" }]]);
  });

  it("feeds a long buffer to the input queue in batches it always accepts", async () => {
    const h = harness();
    let unsent = 0, most = 0;
    h.queue.enqueue.mockImplementation(() => { most = Math.max(most, ++unsent); });
    h.queue.size.mockImplementation(() => unsent);
    h.queue.settle.mockImplementation(async () => { unsent = 0; });
    const take = deferred();
    h.options.take.mockImplementationOnce(() => take.promise);
    const typed = Array.from("an email address typed while waiting").flatMap((letter) => [key("keyDown", letter), key("keyUp", letter)]);
    for (const input of typed) h.control.interact({ input });
    take.resolve(); await settle();
    expect(h.queue.enqueue.mock.calls.map(([body]) => body)).toEqual(typed);
    expect(most).toBeLessThanOrEqual(16);
    expect(h.queue.settle).toHaveBeenCalled();
  });
});

describe("handing browser control back", () => {
  it("hands back after 8 idle seconds, once releases are confirmed, and any input restarts the wait", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.interact({ input: press }, { input: lift }); await settle();
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS - 1); await settle();
    h.interact({ input: hover });
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS - 1); await settle();
    expect(h.options.release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); await settle();
    expect(h.options.release).toHaveBeenCalledOnce();
    expect(h.queue.drain.mock.invocationCallOrder[0]).toBeLessThan(h.options.release.mock.invocationCallOrder[0]!);
    // The bot has it again: the next click takes control afresh.
    h.interact({ input: press }); await settle();
    expect(h.options.take).toHaveBeenCalledTimes(2);
  });

  it("never hands back while a mouse button or key is held down", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.interact({ input: press }); await settle();
    vi.advanceTimersByTime(60_000); await settle();
    expect(h.options.release).not.toHaveBeenCalled();
    h.interact({ input: key("keyDown") }, { input: lift });
    vi.advanceTimersByTime(60_000); await settle();
    expect(h.options.release).not.toHaveBeenCalled();
    h.interact({ input: key("keyUp") });
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(h.options.release).toHaveBeenCalledOnce();
  });

  it("waits out a running toolbar action and keeps control when input arrives during the final drain", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.interact({ input: press }, { input: lift }); await settle();
    h.server.busy = true;
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(h.options.release).not.toHaveBeenCalled();
    h.server.busy = false;
    const drain = deferred();
    h.queue.drain.mockImplementationOnce(() => drain.promise);
    h.interact({ input: hover });
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(h.queue.drain).toHaveBeenCalledOnce();
    h.interact({ input: hover });
    drain.resolve(); await settle();
    expect(h.options.release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(h.options.release).toHaveBeenCalledOnce();
  });

  it("re-arms the wait when a toolbar action finishes", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.interact({ input: press }, { input: lift }); await settle();
    const reload = deferred();
    h.options.command.mockImplementationOnce(async () => { h.server.busy = true; await reload.promise; h.server.busy = false; });
    h.interact({ command: { type: "reload" } });
    vi.advanceTimersByTime(30_000); await settle();
    expect(h.options.release).not.toHaveBeenCalled();
    reload.resolve(); await settle();
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(h.options.release).toHaveBeenCalledOnce();
  });

  it("sends the next take only after an idle hand-back has finished", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.interact({ input: press }, { input: lift }); await settle();
    const release = deferred();
    h.options.release.mockImplementationOnce(() => release.promise);
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(h.options.release).toHaveBeenCalledOnce();
    h.interact({ input: hover }, { input: press }, { input: lift });
    await settle();
    expect(h.options.take).toHaveBeenCalledOnce();
    release.resolve(); await settle();
    expect(h.options.take).toHaveBeenCalledTimes(2);
    expect(h.options.release.mock.invocationCallOrder[0]).toBeLessThan(h.options.take.mock.invocationCallOrder[1]!);
    expect(h.queue.enqueue.mock.calls.slice(2).map(([body]) => body)).toEqual([press, lift]);
  });

  it("hands back a hold the server kept after a timed-out take, but never another person's", async () => {
    vi.useFakeTimers();
    // The server gives up waiting for the bot after 15s and keeps the hold.
    const timedOut = () => new Promise<unknown>((_, reject) => { setTimeout(() => reject(new Error(refused)), 15_000); });
    const kept = harness();
    kept.options.take.mockImplementationOnce(timedOut);
    kept.server.owned = true;
    kept.interact({ input: press }); await settle();
    vi.advanceTimersByTime(15_000); await settle();
    expect(kept.options.onError).toHaveBeenLastCalledWith(refused);
    expect(kept.options.release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(kept.options.release).toHaveBeenCalledOnce();
    const other = harness();
    other.options.take.mockImplementationOnce(timedOut);
    other.interact({ input: press }); await settle();
    vi.advanceTimersByTime(15_000 + BROWSER_HAND_BACK_MS); await settle();
    expect(other.options.release).not.toHaveBeenCalled();
  });

  it("hands back an unused hold the server reports, without postponing an armed hand-back", async () => {
    vi.useFakeTimers();
    const unused = harness();
    unused.server.owned = true; // e.g. a failed restart left this viewer holding the browser
    unused.control.observe();
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(unused.options.release).toHaveBeenCalledOnce();
    const h = harness();
    h.interact({ input: press }, { input: lift }); await settle();
    h.server.owned = true;
    vi.advanceTimersByTime(5_000);
    h.control.observe(); // a control event must not keep the bot waiting longer
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS - 5_000); await settle();
    expect(h.options.release).toHaveBeenCalledOnce();
  });

  it("hands back when the panel closes only if nothing is held, unsent or running", async () => {
    const idle = harness();
    idle.interact({ input: press }, { input: lift }); await settle();
    idle.control.leave();
    expect(idle.options.release).toHaveBeenCalledOnce();
    const pressed = harness();
    pressed.interact({ input: press }); await settle();
    pressed.control.leave();
    expect(pressed.options.release).not.toHaveBeenCalled();
    const unsent = harness();
    unsent.interact({ input: press }, { input: lift }); await settle();
    unsent.queue.size.mockReturnValue(1);
    unsent.control.leave();
    expect(unsent.options.release).not.toHaveBeenCalled();
    const watching = harness();
    watching.control.leave();
    expect(watching.options.release).not.toHaveBeenCalled();
  });

  it.each([
    ["a Cmd shortcut whose key-up macOS never sends", [key("keyDown", "Meta"), { ...key("keyDown", "c"), modifiers: 4 }, key("keyUp", "Meta")]],
    ["a discrete key the server sends as one press", [key("keyDown", "Enter")]],
  ])("hands back after %s", async (_name, inputs) => {
    vi.useFakeTimers();
    const h = harness();
    for (const input of inputs) h.interact({ input });
    await settle();
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS); await settle();
    expect(h.options.release).toHaveBeenCalledOnce();
  });

  it("hands back at once when asked (switching profiles), or as soon as a running action ends", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.interact({ input: press }, { input: lift }); await settle();
    h.control.handBack();
    vi.advanceTimersByTime(0); await settle();
    expect(h.options.release).toHaveBeenCalledOnce();
    const busy = harness();
    busy.interact({ input: press }, { input: lift }); await settle();
    const reload = deferred();
    busy.options.command.mockImplementationOnce(async () => { busy.server.busy = true; await reload.promise; busy.server.busy = false; });
    busy.interact({ command: { type: "reload" } });
    busy.control.handBack();
    vi.advanceTimersByTime(0); await settle();
    expect(busy.options.release).not.toHaveBeenCalled();
    reload.resolve(); await settle();
    vi.advanceTimersByTime(0); await settle();
    expect(busy.options.release).toHaveBeenCalledOnce();
    // Taking control again goes back to the normal idle wait.
    busy.interact({ input: press }, { input: lift }); await settle();
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS - 1); await settle();
    expect(busy.options.take).toHaveBeenCalledTimes(2);
    expect(busy.options.release).toHaveBeenCalledOnce();
  });

  it("keeps control while the typing dialog is open, then waits the usual idle time", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.interact({ input: press }, { input: lift }); await settle();
    h.control.hold(true);
    vi.advanceTimersByTime(60_000); await settle();
    expect(h.options.release).not.toHaveBeenCalled();
    h.control.hold(false);
    vi.advanceTimersByTime(BROWSER_HAND_BACK_MS - 1); await settle();
    expect(h.options.release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); await settle();
    expect(h.options.release).toHaveBeenCalledOnce();
  });

  it("does nothing once closed: no late flush, status, error or hand-back", async () => {
    vi.useFakeTimers();
    const h = harness();
    const take = deferred();
    h.options.take.mockImplementationOnce(() => take.promise);
    h.interact({ input: press }, { input: lift }); await settle();
    h.control.close();
    take.resolve(); await settle();
    vi.advanceTimersByTime(60_000); await settle();
    expect(h.queue.enqueue).not.toHaveBeenCalled();
    expect(h.options.release).not.toHaveBeenCalled();
    expect(h.options.onTakeStatus.mock.calls.map(([status]) => status)).toEqual(["pending"]);
    h.interact({ input: press }); await settle();
    expect(h.options.take).toHaveBeenCalledOnce();
  });
});
