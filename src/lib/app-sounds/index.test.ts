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
    expect(busy.sounds.notificationSound(mention("m3", "t3"), false)).toBe("silenced");
    local.setItem(quiet.sounds.SOUND_WINDOW_KEY, JSON.stringify({ id: "closed-without-a-word", at: Date.now() - quiet.sounds.SOUND_WINDOW_STALE_MS }));
    expect(busy.sounds.notificationSound(mention("m4", "t4"), false)).toBe("played");
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
