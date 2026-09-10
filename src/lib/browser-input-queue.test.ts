import { describe, expect, it, vi } from "vitest";
import { createBrowserInputQueue } from "./browser-input-queue";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const move = (x: number) => ({ type: "input_mouse", eventType: "mouseMoved", x, y: 10 });
const wheel = (deltaY: number) => ({ type: "input_mouse", eventType: "mouseWheel", x: 10, y: 10, deltaY });
const key = (eventType: string, value = "a") => ({ type: "input_keyboard", eventType, key: value });
const up = { type: "input_mouse", eventType: "mouseReleased", button: "left" };

describe("bounded browser input queue", () => {
  it("coalesces adjacent movement and scroll without crossing keyboard/button boundaries", async () => {
    const first = deferred();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    send.mockImplementationOnce(() => first.promise);
    const queue = createBrowserInputQueue(send, vi.fn());
    queue.enqueue(key("keyDown"));
    queue.enqueue(move(1)); queue.enqueue(move(2)); queue.enqueue(move(3));
    queue.enqueue(key("keyUp"));
    queue.enqueue(wheel(10)); queue.enqueue(wheel(20));
    queue.enqueue(up);
    expect(send).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(5));
    expect(send.mock.calls.map(([body]) => body)).toEqual([
      key("keyDown"), move(3), key("keyUp"), { ...wheel(30), deltaX: 0 }, up,
    ]);
    await queue.drain();
  });

  it("drains key/button releases but discards queued movement on hand-back", async () => {
    const first = deferred();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    send.mockImplementationOnce(() => first.promise);
    const queue = createBrowserInputQueue(send, vi.fn());
    queue.enqueue(key("keyDown")); queue.enqueue(move(12)); queue.enqueue(wheel(100));
    queue.enqueue(key("keyUp")); queue.enqueue(up);
    let drained = false;
    const finished = queue.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    first.resolve(); await finished;
    expect(send.mock.calls.map(([body]) => body)).toEqual([key("keyDown"), key("keyUp"), up]);
  });

  it("invalidates old unsent input and ignores old errors after reconnect", async () => {
    let fail!: (cause: Error) => void;
    const first = new Promise<void>((_, reject) => { fail = reject; });
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    send.mockImplementationOnce(() => first);
    const onError = vi.fn();
    const queue = createBrowserInputQueue(send, onError);
    queue.enqueue(key("keyDown", "old")); queue.enqueue(key("keyUp", "old"));
    queue.clear(); queue.enqueue(key("keyDown", "new"));
    fail(new Error("old viewer closed")); await queue.drain();
    expect(send.mock.calls.map(([body]) => body.key)).toEqual(["old", "new"]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("halts overflowing presses while retaining pending and later releases", async () => {
    const first = deferred();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockResolvedValue();
    send.mockImplementationOnce(() => first.promise);
    const onError = vi.fn();
    const queue = createBrowserInputQueue(send, onError);
    queue.enqueue(key("keyDown", "held")); queue.enqueue(key("keyUp", "held"));
    for (let n = 0; n < 40; n++) queue.enqueue(key("keyDown", String(n)));
    queue.enqueue(up);
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining("Release control and reconnect") }));
    first.resolve(); await queue.drain();
    expect(send.mock.calls.map(([body]) => body)).toEqual([key("keyDown", "held"), key("keyUp", "held"), up]);
    queue.clear(); queue.enqueue(key("keyDown", "after reconnect")); await queue.drain();
    expect(send).toHaveBeenLastCalledWith(key("keyDown", "after reconnect"));
  });

  it("does not replay queued presses after a transport failure", async () => {
    const onError = vi.fn();
    const send = vi.fn<(body: Record<string, unknown>) => Promise<void>>().mockRejectedValueOnce(new Error("uncertain input")).mockResolvedValue();
    const queue = createBrowserInputQueue(send, onError);
    queue.enqueue(key("keyDown")); queue.enqueue(key("keyDown", "b")); queue.enqueue(key("keyUp"));
    await queue.drain();
    expect(send.mock.calls.map(([body]) => body)).toEqual([key("keyDown"), key("keyUp")]);
    expect(onError).toHaveBeenCalledOnce();
  });
});
