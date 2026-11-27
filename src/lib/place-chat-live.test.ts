// The live stream of a My Cloud bot open in place never wakes My Cloud by itself: once it has gone quiet it opens again
// only after main says My Cloud is awake (the Admin's word), on a retry or on the person's input.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keepLive, resetPlaceChatForTest } from "./place-chat";

class Source {
  onopen: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close() { this.closed = true; }
}

let made: Source[], target: EventTarget, awake: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
const platform = () => ({ createEventSource: (url: string) => { const source = new Source(url); made.push(source); return source; }, visible: () => true, awake, target: target as unknown as Window });
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  made = [];
  target = new EventTarget();
  awake = vi.fn(async () => false);
});
afterEach(() => {
  resetPlaceChatForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("after My Cloud agrees to sleep, the person's input reconnects only once main says it is awake, and asks at most every 10 s", async () => {
  keepLive("cloud:scout", () => {}, platform());
  made[0]!.onopen?.();
  made[0]!.onmessage?.({ data: JSON.stringify({ kind: "power", state: "sleeping" }) });
  expect(made[0]!.closed).toBe(true);
  target.dispatchEvent(new Event("keydown"));
  await settle();
  expect(awake).toHaveBeenCalledTimes(1);
  expect(made).toHaveLength(1);
  // Typing on asks nothing more for a while: the Admin is not asked on every key.
  for (let i = 0; i < 20; i++) target.dispatchEvent(new Event("keydown"));
  await settle();
  expect(awake).toHaveBeenCalledTimes(1);
  // One look again a while later (a send of theirs wakes it): now awake, the stream opens.
  awake.mockResolvedValue(true);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(awake).toHaveBeenCalledTimes(2);
  expect(made).toHaveLength(2);
  // Left alone after that, nothing asks again.
  made[1]!.onopen?.();
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(awake).toHaveBeenCalledTimes(2);
});

it("a dropped stream retries only after main says My Cloud is awake, and never keeps retrying while it sleeps", async () => {
  keepLive("cloud:scout", () => {}, platform());
  made[0]!.onopen?.();
  made[0]!.onerror?.();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(awake).toHaveBeenCalledTimes(1);
  expect(made).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  expect(awake).toHaveBeenCalledTimes(1);
  awake.mockResolvedValue(true);
  target.dispatchEvent(new Event("pointerdown"));
  await settle();
  expect(made).toHaveLength(2);
});

it("a first open that never connects tries again at once, even while the Admin's word lags, then opens My Cloud's page", async () => {
  const cannot = vi.fn();
  keepLive("cloud:scout", cannot, platform());
  made[0]!.onerror?.();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(made).toHaveLength(2);
  made[1]!.onerror?.();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(made).toHaveLength(3);
  made[2]!.onerror?.();
  expect(cannot).toHaveBeenCalledOnce();
  expect(awake).not.toHaveBeenCalled();
});

it("reads the bot again as background work when the stream starts over", async () => {
  keepLive("cloud:scout", () => {}, platform());
  made[0]!.onmessage?.({ data: JSON.stringify({ kind: "hello", cursor: "s:1", resumed: false }) });
  await settle();
  const [path, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
  expect(String(path)).toBe("/api/bots/cloud%3Ascout?messages=80");
  expect(new Headers((init as RequestInit).headers).get("x-omb-background")).toBe("1");
});
