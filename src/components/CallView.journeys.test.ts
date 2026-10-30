// @vitest-environment happy-dom
// Pages get the bridge the real preload builds for them and the capabilities the real builder reports.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createElement, useReducer, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group } from "@/state/store";

type Desktop = { capabilities: DesktopCapabilities; ready: boolean };
const fixture = vi.hoisted(() => ({ desktop: null as Desktop | null }));
vi.mock("./DesktopCapabilities", async (importOriginal) => {
  const real = await importOriginal<typeof import("./DesktopCapabilities")>();
  return {
    ...real,
    useDesktopCapabilities: () => {
      const detected = real.useDesktopCapabilities();
      return fixture.desktop ?? detected;
    },
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const stored = new Map<string, string>();
const storage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
};
vi.stubGlobal("localStorage", storage);

const { CallButton } = await import("./CallView");
const { GroupCallButton } = await import("./GroupCallView");
const { LiveCallBar } = await import("./LiveCallBar");
const { BotEditorStore, initialState, reducer } = await import("@/state/store");
const { callMode, setCallMode } = await import("@/lib/call-mode");
const { currentCall, endCall } = await import("@/lib/call");
const { configureLiveMedia, liveMedia, resetLiveMedia } = await import("@/lib/live-call-media");
const { cacheDesktopCapabilities, initialDesktopCapabilities } = await import("@/lib/desktop");

const { desktopCapabilities } = createRequire(import.meta.url)("../../electron/capabilities.cjs") as {
  desktopCapabilities(options: { platform: string; remote?: boolean; env?: Record<string, string>; homeDir?: string }): DesktopCapabilities;
};
const PRELOAD = readFileSync(join(process.cwd(), "electron", "preload.cjs"), "utf8");
const LOCAL_ORIGIN = "http://127.0.0.1:8799";
const CLOUD_ORIGIN = "https://omb-t-0123456789ab.fly.dev";

type Bridge = NonNullable<Window["ogb"]>;
type Platform = "darwin" | "win32" | "linux";
let invoked: Array<{ channel: string; args: unknown[] }>;
let pageMic: "allowed" | "refused" | undefined;
let liveKey: string;
let microphone: "allowed" | "refused";

function desktopApp(platform: Platform, page: "this-computer" | "my-cloud"): { bridge: Bridge; desktop: Desktop } {
  let bridge: Bridge | undefined;
  runInNewContext(PRELOAD, {
    process: { platform, argv: [`--omb-local-origin=${LOCAL_ORIGIN}`] },
    location: { origin: page === "this-computer" ? LOCAL_ORIGIN : CLOUD_ORIGIN },
    TextEncoder,
    localStorage: { getItem: () => null },
    require: () => ({
      webUtils: {},
      contextBridge: { exposeInMainWorld: (_name: string, value: Bridge) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: async (channel: string, ...args: unknown[]) => answer(channel, args) },
    }),
  });
  const capabilities = desktopCapabilities({ platform, remote: page === "my-cloud", env: {}, homeDir: "/Users/ada" });
  return { bridge: bridge!, desktop: { capabilities, ready: true } };
}
async function answer(channel: string, args: unknown[]): Promise<unknown> {
  invoked.push({ channel, args });
  if (channel === "credential:set" && args[0] === "openaiLiveKey") {
    liveKey = String(args[1]);
    return { ...THIS_COMPUTER, live: { ...noKey, configured: true } };
  }
  if (channel === "perm:status") return pageMic === undefined ? {} : { pageMic };
  if (channel === "desktop:capabilities") return fixture.desktop?.capabilities;
  return undefined;
}
function open(app: { bridge: Bridge; desktop: Desktop }) {
  (window as { ogb?: Bridge }).ogb = app.bridge;
  fixture.desktop = app.desktop;
  cacheDesktopCapabilities(app.desktop.capabilities);
}

const ada: Bot = {
  id: "ada", threadId: "thread-ada", name: "Ada", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], voice: "voice-1",
  modelSelection: { instanceId: "claude", model: "m" },
};
const room = {
  id: "room", threadId: "thread-room", name: "Standup", memberIds: ["ada"], defaultResponder: "everyone",
  bulletin: "", unread: false, createdAt: 1, messages: [],
} as unknown as Group;
const noKey = { configured: false, voice: "marin", readTypedReplies: true, idleMinutes: 5 };
const CLOUD = { cloudHome: true, tts: { configured: true, ready: true, voice: "preset" }, live: noKey } as AppState["config"];
const SERVER = { tts: { configured: true, ready: true, voice: "preset" }, live: noKey } as AppState["config"];
const THIS_COMPUTER = { tts: { configured: true, ready: true, voice: "voice-1" }, live: noKey } as AppState["config"];
const KEY_NEEDED = "Live calls use your own OpenAI key. Add it in Settings → API keys.";
const APP_REFUSED = "The app didn't let this page use the microphone. Open it in your web browser to make the Live call.";

function Page({ config, children }: { config: AppState["config"]; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { ...initialState, config, bots: [ada] });
  const value = { state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  return createElement(BotEditorStore, { value, children });
}

let root: Root;
let container: HTMLElement;
let requests: Array<{ path: string; method: string; body: unknown }>;
let getUserMedia: ReturnType<typeof vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>>;
const track = { enabled: true, stop() {} };
const createPeer = () => ({
  iceGatheringState: "complete", connectionState: "new", localDescription: { sdp: "v=0" },
  addTrack() {}, createDataChannel: () => ({ close() {} }), createOffer: async () => ({ type: "offer", sdp: "v=0" }),
  setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() {},
}) as unknown as RTCPeerConnection;

function chat(config: AppState["config"]) {
  flushSync(() => root.render(createElement(Page, {
    config,
    children: [
      createElement(CallButton, { key: "call", bot: ada, placement: "composer" }),
      createElement(LiveCallBar, { key: "bar", bot: ada }),
    ],
  })));
}
function roomHeader(config: AppState["config"]) {
  flushSync(() => root.render(createElement(Page, { config, children: createElement(GroupCallButton, { group: room, members: [ada] }) })));
}
const callButton = () => container.querySelector<HTMLButtonElement>("[data-call-button]");
const press = (element: Element | null) => {
  if (!element) throw new Error("nothing to press");
  flushSync(() => (element as HTMLElement).click());
};
const menuItems = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
const text = () => container.textContent ?? "";

async function firstLiveCall() {
  const button = callButton();
  expect(button?.getAttribute("aria-label")).toBe("Live call with Ada");
  expect(button?.querySelector(".bg-warning")).toBeNull();
  press(button);
  await vi.waitFor(() => expect(text()).toContain(KEY_NEEDED));
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(requests.map(({ path, method }) => `${method} ${path}`)).toEqual(["POST /api/live/session"]);
  expect(text()).not.toContain("Call unavailable");
  expect(container.querySelector("input")).toBeNull();
  const openApiKeys = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === "Open API keys");
  press(openApiKeys ?? null);
  expect(text()).not.toContain(KEY_NEEDED);

  liveKey = "sk-live-test";
  press(callButton());
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(requests.filter(({ path }) => path === "/api/live/session")).toHaveLength(2));
  expect(liveMedia()).toMatchObject({ phase: "starting", botId: "ada", threadId: "thread-ada" });
  await vi.waitFor(() => expect(text()).toContain("Live with Ada"));
  expect(text()).not.toContain(KEY_NEEDED);
  expect(text()).not.toContain("Choose This computer");
  expect(requests.filter(({ path }) => path === "/api/config")).toEqual([]);
  expect(invoked.map(({ channel }) => channel)).not.toContain("credential:set");
}

function expectTurnsDisabled(reason: string) {
  press(container.querySelector('[aria-label="Call mode"]'));
  const [turns, live] = menuItems();
  expect(turns?.textContent).toContain("Take turns");
  expect(turns?.getAttribute("aria-disabled")).toBe("true");
  expect(turns?.textContent).toContain(reason);
  expect(turns?.getAttribute("aria-checked")).toBe("false");
  expect(live?.textContent).toContain("Live");
  expect(live?.hasAttribute("aria-disabled")).toBe(false);
  expect(live?.getAttribute("aria-checked")).toBe("true");
  expect(text()).not.toContain("Choose This computer");
  expect(document.activeElement).toBe(live);
  const key = (name: string) => flushSync(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
  key("ArrowUp");
  expect(document.activeElement).toBe(turns);
  key("ArrowDown");
  expect(document.activeElement).toBe(live);
  key("Home");
  expect(document.activeElement).toBe(turns);
  const mode = callMode();
  press(turns);
  expect(menuItems()).toHaveLength(2);
  expect(callMode()).toBe(mode);
  expect(currentCall()).toBeNull();
  expect(getUserMedia).not.toHaveBeenCalled();
  press(container.querySelector('[aria-label="Call mode"]'));
  expect(menuItems()).toHaveLength(0);
}

beforeEach(() => {
  vi.stubGlobal("localStorage", storage);
  setCallMode("turns");
  stored.clear();
  fixture.desktop = null;
  delete (window as { ogb?: Bridge }).ogb;
  cacheDesktopCapabilities(initialDesktopCapabilities());
  requests = [];
  invoked = [];
  pageMic = undefined;
  liveKey = "";
  microphone = "allowed";
  vi.stubGlobal("fetch", async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, body });
    if (path === "/api/live/session" && method === "POST") {
      if (!liveKey) return new Response(JSON.stringify({ error: KEY_NEEDED, needsKey: true }), { status: 409 });
      return new Promise<Response>(() => {});
    }
    return new Response(JSON.stringify({ error: "not here" }), { status: 404 });
  });
  getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => {
    if (microphone === "refused") throw new DOMException("Permission denied", "NotAllowedError");
    return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  });
  configureLiveMedia({ getUserMedia, createPeer });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  resetLiveMedia();
  endCall();
  setCallMode("turns");
  fixture.desktop = null;
  delete (window as { ogb?: Bridge }).ogb;
  vi.unstubAllGlobals();
});

describe("calling a bot off the Mac", () => {
  it("in a browser on the person's Cloud, the first visit's call button is a Live call that points to API keys, then calls once a key is saved", async () => {
    expect(callMode()).toBe("turns");
    chat(CLOUD);
    await firstLiveCall();
    expect(requests.filter((request) => request.method !== "GET").map(({ path, method }) => `${method} ${path}`))
      .toEqual(["POST /api/live/session", "POST /api/live/session"]);
  });

  it("on My Cloud in the Mac app, the call is Live, and Take turns says it works on This computer", async () => {
    open(desktopApp("darwin", "my-cloud"));
    chat(CLOUD);
    expectTurnsDisabled("Calls where you take turns work with bots on this Mac. They listen with your Mac's own speech recognition, which only bots on this Mac can use.");
    await firstLiveCall();
  });

  it.each(["win32", "linux"] as const)("on My Cloud in the %s app, the call is Live, and Take turns says it needs the Mac app", async (platform) => {
    open(desktopApp(platform, "my-cloud"));
    chat(CLOUD);
    expectTurnsDisabled("Calls where you take turns need the Mac app");
    await firstLiveCall();
  });

  it.each(["win32", "linux"] as const)("on This computer in the %s app, the call is Live and points to API keys for its key", async (platform) => {
    open(desktopApp(platform, "this-computer"));
    chat(THIS_COMPUTER);
    expectTurnsDisabled("Calls where you take turns need the Mac app");
    await firstLiveCall();
  });

  it.each([
    ["My Cloud in a Mac app that doesn't say", "darwin", CLOUD, undefined],
    ["My Cloud in a Windows app that refused it", "win32", CLOUD, "refused"],
    ["another server in the Linux app", "linux", SERVER, "refused"],
  ] as const)("on %s, a refused microphone says so with Open in browser, and no key is asked for", async (_where, platform, config, answer) => {
    microphone = "refused";
    pageMic = answer;
    open(desktopApp(platform, "my-cloud"));
    chat(config);
    press(callButton());
    await vi.waitFor(() => expect(text()).toContain(APP_REFUSED));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(Array.from(container.querySelectorAll("button"), (button) => button.textContent?.trim())).toContain("Open in browser");
    expect(text()).not.toContain(KEY_NEEDED);
    expect(container.querySelector('input[aria-label="OpenAI API key for Live calls"]')).toBeNull();
    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(invoked.map(({ channel }) => channel)).not.toContain("credential:set");
  });

  it("in a browser with no microphone support, says how to make the call, and no key is asked for", async () => {
    resetLiveMedia();
    expect(globalThis.navigator.mediaDevices).toBeUndefined();
    chat(SERVER);
    press(callButton());
    await vi.waitFor(() => expect(text()).toContain("Live calls need a microphone, and this window can't use one. Open MausBot at a secure https address to make the call."));
    expect(text()).not.toContain("WebRTC");
    expect(text()).not.toContain(KEY_NEEDED);
    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
  });

  it("on This computer in the Mac app, Take turns stays the default and a picked mode is kept", () => {
    open(desktopApp("darwin", "this-computer"));
    chat(THIS_COMPUTER);
    expect(callButton()?.getAttribute("aria-label")).toBe("Call Ada");
    press(container.querySelector('[aria-label="Call mode"]'));
    expect(menuItems().map((item) => [item.getAttribute("aria-disabled"), item.getAttribute("aria-checked")])).toEqual([[null, "true"], [null, "false"]]);
    press(container.querySelector('[aria-label="Call mode"]'));

    press(callButton());
    expect(currentCall()).toBe("ada");
    expect(liveMedia().phase).toBe("idle");
    endCall();

    setCallMode("live");
    chat(THIS_COMPUTER);
    expect(callButton()?.getAttribute("aria-label")).toBe("Live call with Ada");
    setCallMode("turns");
    chat(THIS_COMPUTER);
    expect(callButton()?.getAttribute("aria-label")).toBe("Call Ada");
  });

  it("shows a room's call button only where taking turns can run: the Mac app's own page", () => {
    roomHeader(CLOUD);
    expect(callButton()).toBeNull();
    for (const platform of ["darwin", "win32", "linux"] as const) {
      open(desktopApp(platform, "my-cloud"));
      roomHeader(CLOUD);
      expect(callButton(), `${platform} on My Cloud`).toBeNull();
    }
    for (const platform of ["win32", "linux"] as const) {
      open(desktopApp(platform, "this-computer"));
      roomHeader(THIS_COMPUTER);
      expect(callButton(), `${platform} on This computer`).toBeNull();
    }

    open(desktopApp("darwin", "this-computer"));
    roomHeader(THIS_COMPUTER);
    expect(callButton()?.getAttribute("aria-label")).toBe("Call Standup");
  });
});
