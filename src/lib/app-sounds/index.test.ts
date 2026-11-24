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
let browser: EventTarget;
let contexts = 0;

class FakeAudioContext {
  sampleRate = 48_000;
  state = "running";
  destination = {};
  constructor() {
    contexts += 1;
  }
  resume = async () => undefined;
  createBuffer = () => ({ copyToChannel: () => undefined });
  createBufferSource = () => ({ connect: () => undefined, start: () => undefined });
}

beforeEach(() => {
  vi.resetModules();
  local = memoryStorage();
  browser = new EventTarget();
  contexts = 0;
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => true });
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("app sounds in a window", () => {
  it("creates its audio context on the first click, not before", async () => {
    const sounds = await import("./index");
    sounds.startAppSounds();
    expect(sounds.playAppSound("send")).toBe(false);
    expect(contexts).toBe(0);
    browser.dispatchEvent(new Event("pointerdown"));
    expect(contexts).toBe(1);
    expect(sounds.playAppSound("send")).toBe(true);
  });

  it("follows the window used last across every window of the app", async () => {
    const sounds = await import("./index");
    sounds.startAppSounds();
    expect(sounds.isSoundWindow()).toBe(true);
    local.setItem(sounds.SOUND_WINDOW_KEY, "another-window");
    expect(sounds.isSoundWindow()).toBe(false);
    browser.dispatchEvent(new Event("keydown"));
    expect(sounds.isSoundWindow()).toBe(true);
    local.setItem(sounds.SOUND_WINDOW_KEY, "another-window");
    browser.dispatchEvent(new Event("focus"));
    expect(sounds.isSoundWindow()).toBe(true);
  });

  it("leaves the system chime only to an untouched window in use, with sounds on", async () => {
    const sounds = await import("./index");
    sounds.startAppSounds();
    expect(sounds.bannerSilent()).toBe(false);
    local.setItem(sounds.SOUND_WINDOW_KEY, "another-window");
    expect(sounds.bannerSilent()).toBe(true);
    local.removeItem(sounds.SOUND_WINDOW_KEY);
    local.setItem("omb-notification-sounds", "0");
    expect(sounds.bannerSilent()).toBe(true);
    local.setItem("omb-notification-sounds", "glass");
    browser.dispatchEvent(new Event("pointerdown"));
    expect(sounds.bannerSilent()).toBe(true);
  });
});
