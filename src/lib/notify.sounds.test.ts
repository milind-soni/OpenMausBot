import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyFrame } from "./notify";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

let banners: Array<{ title: string; options?: NotificationOptions }> = [];
let audio = { state: "running", resumes: true };
let started = 0;

class FakeAudioContext {
  sampleRate = 48_000;
  state = audio.state;
  destination = {};
  resume = async () => {
    if (!audio.resumes) throw new Error("not allowed to start");
    this.state = "running";
  };
  createBuffer = () => ({ copyToChannel: () => undefined });
  createBufferSource = () => ({ connect: () => undefined, start: () => void (started += 1) });
}

class FakeNotification {
  static permission = "granted";
  onclick: (() => void) | null = null;
  constructor(public title: string, public options?: NotificationOptions) {
    banners.push(this);
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const mention = (id: string, over: Partial<NotifyFrame> = {}): NotifyFrame => ({ kind: "mention", botId: "b", botName: "Scout", threadId: `t-${id}`, title: "Scout", body: "@you", id, ...over });
const chimes = () => banners.map((banner) => banner.options?.silent !== true);

async function openApp() {
  vi.resetModules();
  const target = Object.assign(new EventTarget(), { focus: vi.fn() });
  vi.stubGlobal("window", target);
  const { startAppSounds } = await import("./app-sounds");
  const { showNotification } = await import("./notify");
  startAppSounds();
  return { show: (frame: NotifyFrame) => showNotification(frame, () => {}), gesture: () => target.dispatchEvent(new Event("pointerdown")) };
}

beforeEach(() => {
  banners = [];
  audio = { state: "running", resumes: true };
  started = 0;
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("document", { visibilityState: "hidden", hasFocus: () => false });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("Notification", FakeNotification);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("one decision per notice, for the app's sound and the system banner together", () => {
  it("before any click, a new mention chimes through the system; read or repeated it never does", async () => {
    const app = await openApp();
    app.show(mention("m1"));
    app.show(mention("m1"));
    app.show(mention("m2", { read: true }));
    expect(chimes()).toEqual([true, false, false]);
    expect(started).toBe(0);
  });

  it("once the app plays the mention itself, the banner stays silent", async () => {
    const app = await openApp();
    app.gesture();
    app.show(mention("m1"));
    expect(started).toBe(1);
    expect(chimes()).toEqual([false]);
  });

  it("a suspended context that wakes plays the mention, with a silent banner", async () => {
    audio = { state: "suspended", resumes: true };
    const app = await openApp();
    app.gesture();
    app.show(mention("m1"));
    await flush();
    expect(started).toBe(1);
    expect(chimes()).toEqual([false]);
  });

  it("a suspended context that will not wake leaves a new mention to the system chime", async () => {
    audio = { state: "suspended", resumes: false };
    const app = await openApp();
    app.gesture();
    app.show(mention("m1"));
    await flush();
    expect(started).toBe(0);
    expect(chimes()).toEqual([true]);
  });

  it("with sounds off, neither the app nor the system makes a sound", async () => {
    const app = await openApp();
    localStorage.setItem("omb-notification-sounds", "0");
    app.show(mention("m1"));
    app.gesture();
    app.show(mention("m2"));
    expect(started).toBe(0);
    expect(chimes()).toEqual([false, false]);
  });
});
