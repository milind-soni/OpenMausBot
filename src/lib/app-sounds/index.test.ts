import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

let local: ReturnType<typeof memoryStorage>;
let page = { visibilityState: "visible", hasFocus: () => true };
let contexts = 0;
let started = 0;

class FakeAudioContext {
  sampleRate = 48_000;
  state = "running";
  destination = {};
  constructor() {
    contexts += 1;
  }
  resume = async () => undefined;
  createBuffer = () => ({ copyToChannel: () => undefined });
  createBufferSource = () => ({ connect: () => undefined, start: () => void (started += 1) });
}

/** One app window: its own copy of the module and its own event target, sharing this device's storage. */
async function openWindow() {
  vi.resetModules();
  const target = new EventTarget();
  vi.stubGlobal("window", target);
  const sounds = await import("./index");
  sounds.startAppSounds();
  return { sounds, fire: (type: string) => target.dispatchEvent(new Event(type)) };
}

const mention = (id: string, threadId: string) => ({ kind: "mention" as const, botId: "b", threadId, id });

beforeEach(() => {
  vi.useFakeTimers();
  local = memoryStorage();
  page = { visibilityState: "visible", hasFocus: () => true };
  contexts = 0;
  started = 0;
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("document", page);
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("app sounds in a window", () => {
  it("creates its audio context on the first click, not before", async () => {
    const { sounds, fire } = await openWindow();
    expect(sounds.playAppSound("send")).toBe("unplayable");
    expect(contexts).toBe(0);
    fire("pointerdown");
    expect(contexts).toBe(1);
    expect(sounds.playAppSound("send")).toBe("played");
  });

  it("follows the window used last across every window of the app", async () => {
    const first = await openWindow();
    const second = await openWindow();
    first.fire("pointerdown");
    expect(first.sounds.isSoundWindow()).toBe(true);
    expect(second.sounds.isSoundWindow()).toBe(false);
    second.fire("keydown");
    expect(second.sounds.isSoundWindow()).toBe(true);
    expect(first.sounds.isSoundWindow()).toBe(false);
    first.fire("focus");
    expect(first.sounds.isSoundWindow()).toBe(true);
  });

  it("hands the lead to a window still open when the one in use closes", async () => {
    const left = await openWindow();
    const right = await openWindow();
    right.fire("pointerdown");
    left.fire("pointerdown");
    page.visibilityState = "hidden";
    page.hasFocus = () => false;
    expect(left.sounds.notificationSound(mention("m1", "t1"), false)).toBe("played");
    expect(right.sounds.notificationSound(mention("m1", "t1"), false)).toBe("silenced");
    left.fire("pagehide");
    expect(right.sounds.notificationSound(mention("m2", "t2"), false)).toBe("played");
    expect(left.sounds.isSoundWindow()).toBe(false);
  });

  it("takes over from a window that stopped answering, but not from one still open in the background", async () => {
    const quiet = await openWindow();
    const busy = await openWindow();
    busy.fire("pointerdown");
    quiet.fire("pointerdown");
    page.visibilityState = "hidden";
    page.hasFocus = () => false;
    vi.advanceTimersByTime(quiet.sounds.SOUND_WINDOW_STALE_MS * 2);
    expect(busy.sounds.isSoundWindow()).toBe(false);
    local.setItem(quiet.sounds.SOUND_WINDOW_KEY, JSON.stringify({ id: "closed-without-a-word", at: Date.now() }));
    vi.advanceTimersByTime(quiet.sounds.SOUND_WINDOW_STALE_MS - 1);
    const waiting = busy.sounds.notificationSound(mention("m3", "t3"), false);
    vi.advanceTimersByTime(busy.sounds.SOUND_ACK_WAIT_MS);
    await expect(waiting).resolves.toBe("unplayable");
    local.setItem(quiet.sounds.SOUND_WINDOW_KEY, JSON.stringify({ id: "closed-without-a-word", at: Date.now() - quiet.sounds.SOUND_WINDOW_STALE_MS }));
    expect(busy.sounds.notificationSound(mention("m4", "t4"), false)).toBe("played");
  });

  it("chimes through another window's banner when the window in use is frozen and never takes the notice", async () => {
    const frozen = await openWindow();
    const other = await openWindow();
    other.fire("pointerdown");
    frozen.fire("pointerdown");
    page.visibilityState = "hidden";
    page.hasFocus = () => false;
    const waiting = other.sounds.notificationSound(mention("m5", "t5"), false);
    expect(typeof waiting).not.toBe("string");
    vi.advanceTimersByTime(other.sounds.SOUND_ACK_WAIT_MS - 1);
    let outcome: string | undefined;
    void Promise.resolve(waiting).then((value) => void (outcome = value));
    await Promise.resolve();
    expect(outcome).toBeUndefined();
    vi.advanceTimersByTime(1);
    await expect(waiting).resolves.toBe("unplayable");
    expect(started).toBe(0);
  });

  it("makes one sound when the window in use takes the notice, whichever window hears of it first", async () => {
    const leader = await openWindow();
    const other = await openWindow();
    other.fire("pointerdown");
    leader.fire("pointerdown");
    page.visibilityState = "hidden";
    page.hasFocus = () => false;
    const waiting = other.sounds.notificationSound(mention("m6", "t6"), false);
    expect(leader.sounds.notificationSound(mention("m6", "t6"), false)).toBe("played");
    vi.advanceTimersByTime(other.sounds.SOUND_ACK_WAIT_MS);
    await expect(waiting).resolves.toBe("silenced");
    expect(started).toBe(1);
  });

  it("chimes through only one of the other windows when the window in use is frozen", async () => {
    const frozen = await openWindow();
    const left = await openWindow();
    const right = await openWindow();
    left.fire("pointerdown");
    right.fire("pointerdown");
    frozen.fire("pointerdown");
    page.visibilityState = "hidden";
    page.hasFocus = () => false;
    const waiting = [left.sounds.notificationSound(mention("m7", "t7"), false), right.sounds.notificationSound(mention("m7", "t7"), false)];
    vi.advanceTimersByTime(left.sounds.SOUND_ACK_WAIT_MS);
    const outcomes = await Promise.all(waiting);
    expect(outcomes.filter((outcome) => outcome === "unplayable")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "silenced")).toHaveLength(1);
  });

  it.each([
    ["is read", (sounds: Awaited<ReturnType<typeof openWindow>>["sounds"]) => sounds.notificationsRead(["m8"])],
    ["arrives during a call", (sounds: Awaited<ReturnType<typeof openWindow>>["sounds"]) => void sounds.holdAppSounds("call")],
    ["arrives during a recording", (sounds: Awaited<ReturnType<typeof openWindow>>["sounds"]) => void sounds.holdAppSounds("recording")],
    ["arrives with sounds turned off", () => local.setItem("omb-notification-sounds", "0")],
  ])("chimes through no window when the frozen leader's notice %s before the wait ends", async (_change, change) => {
    const frozen = await openWindow();
    const left = await openWindow();
    const right = await openWindow();
    left.fire("pointerdown");
    right.fire("pointerdown");
    frozen.fire("pointerdown");
    page.visibilityState = "hidden";
    page.hasFocus = () => false;
    const waiting = [left.sounds.notificationSound(mention("m8", "t8"), false), right.sounds.notificationSound(mention("m8", "t8"), false)];
    change(left.sounds);
    change(right.sounds);
    vi.advanceTimersByTime(left.sounds.SOUND_ACK_WAIT_MS);
    await expect(Promise.all(waiting)).resolves.toEqual(["silenced", "silenced"]);
  });

  it("plays no style sample while recording", async () => {
    const { sounds, fire } = await openWindow();
    fire("pointerdown");
    const release = sounds.holdAppSounds("recording");
    expect(sounds.previewAppSound("retro")).toBe("silenced");
    expect(started).toBe(0);
    release();
    expect(sounds.previewAppSound("retro")).toBe("played");
    expect(started).toBe(1);
  });
});
