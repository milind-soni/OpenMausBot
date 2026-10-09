// @vitest-environment happy-dom
// Calling a bot from a Cloud, the way a person does it, in a real page.
//
// Taking turns listens with the Mac app's own on-device speech recognition,
// so only the Mac app's page for This computer can take turns. Everywhere
// else (a browser, the Windows or Linux app, any server's page such as My
// Cloud) a one-to-one chat's call button is a Live call: no amber dot, no
// "Call unavailable" and no trip to This computer, which would leave the bot
// being called. A Live call asks for the microphone first, so a page that
// can't have one says so (and how to make the call) before anyone pastes a
// key. Where the microphone works but there is no OpenAI key yet, the first
// call asks for it, saves it where the page runs (a server's page sends
// `PUT /api/config`; the app's own page saves it through the app), and goes
// straight on to the call. Rooms have no Live call, so a room's call button
// is only shown where taking turns can run.
//
// The desktop app's pages get the bridge the real preload builds for them
// (electron/preload.cjs: a server's page gets only its safe subset) and the
// capabilities the real builder reports (electron/capabilities.cjs).
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
    // null: what the page finds by itself (here a browser: no desktop bridge)
    useDesktopCapabilities: () => {
      const detected = real.useDesktopCapabilities();
      return fixture.desktop ?? detected;
    },
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

// This browser's (or app's) storage, where the picked call mode is kept.
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
/** What the page asked the desktop app for (its IPC channel and arguments). */
let invoked: Array<{ channel: string; args: unknown[] }>;
/** The app's answer about this page's microphone (perm:status's `pageMic`);
 * undefined is an app older than that answer. */
let pageMic: "allowed" | "refused" | undefined;
/** The OpenAI key the computer behind the page has for Live, once saved. */
let liveKey: string;
/** The microphone: given, or refused (by the app, the browser or the OS). */
let microphone: "allowed" | "refused";

/** The desktop app on `platform`, showing This computer's page or a server's
 * page (My Cloud): the bridge its preload gives that page, and what the app
 * reports the page can do. */
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
/** The desktop app's main process, for the channels these calls use. */
async function answer(channel: string, args: unknown[]): Promise<unknown> {
  invoked.push({ channel, args });
  if (channel === "credential:set" && args[0] === "openaiLiveKey") {
    // saved in this computer's credential store, then on its own server
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
  // what the page has learnt from the app by the time anyone calls
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
/** The person's own Cloud: the voice comes with the plan, Live has no key yet. */
const CLOUD = { cloudHome: true, tts: { configured: true, ready: true, voice: "preset" }, live: noKey } as AppState["config"];
/** Someone else's server, saved in the app's server menu. */
const SERVER = { tts: { configured: true, ready: true, voice: "preset" }, live: noKey } as AppState["config"];
const THIS_COMPUTER = { tts: { configured: true, ready: true, voice: "voice-1" }, live: noKey } as AppState["config"];
const KEY_FORM = "Live calls use OpenAI GPT-Live";
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
/** This window's WebRTC: an offer at once; OpenAI's answer is never applied here. */
const createPeer = () => ({
  iceGatheringState: "complete", connectionState: "new", localDescription: { sdp: "v=0" },
  addTrack() {}, createDataChannel: () => ({ close() {} }), createOffer: async () => ({ type: "offer", sdp: "v=0" }),
  setLocalDescription: async () => {}, setRemoteDescription: async () => {}, close() {},
}) as unknown as RTCPeerConnection;

/** A chat with Ada: its call button, and the call bar above the composer. */
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

/** Click the call button: the microphone is asked for first, then the
 * computer with no key yet asks for one. Paste it, save: the Live call
 * starts. `savedBy`: where the key goes, the page's own server (a server's
 * page, a browser) or the app (its own page, through credential:set). */
async function firstLiveCall(savedBy: "the server" | "the app") {
  const button = callButton();
  expect(button?.getAttribute("aria-label")).toBe("Live call with Ada");
  // the ordinary call button: no amber dot, nothing to explain
  expect(button?.querySelector(".bg-warning")).toBeNull();
  press(button);
  await vi.waitFor(() => expect(text()).toContain(KEY_FORM));
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  expect(requests.map(({ path, method }) => `${method} ${path}`)).toEqual(["POST /api/live/session"]);
  expect(text()).not.toContain("Call unavailable");
  const field = container.querySelector<HTMLInputElement>('input[aria-label="OpenAI API key for Live calls"]')!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!.call(field, "sk-live-test");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  flushSync(() => field.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(liveKey).toBe("sk-live-test"));
  const saves = invoked.filter(({ channel }) => channel === "credential:set");
  if (savedBy === "the server") {
    // saved where the page runs: the Cloud (or server) keeps the key
    expect(requests).toContainEqual({ path: "/api/config", method: "PUT", body: { live: { key: "sk-live-test" } } });
    expect(saves).toEqual([]);
  } else {
    // the app's own page: this computer's credential store, never a plain PUT
    expect(saves).toEqual([{ channel: "credential:set", args: ["openaiLiveKey", "sk-live-test"] }]);
    expect(requests.filter(({ path }) => path === "/api/config")).toEqual([]);
  }
  // and the call goes on: the microphone again, the call bar shows
  await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(requests.filter(({ path }) => path === "/api/live/session")).toHaveLength(2));
  expect(liveMedia()).toMatchObject({ phase: "starting", botId: "ada", threadId: "thread-ada" });
  await vi.waitFor(() => expect(text()).toContain("Live with Ada"));
  expect(text()).not.toContain(KEY_FORM);
  expect(text()).not.toContain("Choose This computer");
}

/** The arrow's menu: Take turns is there but can't be picked here; Live is the call. */
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
  // The keyboard reaches Take turns too, so its reason is read out: the
  // menu opens on Live, and the arrow keys move to Take turns and back.
  expect(document.activeElement).toBe(live);
  const key = (name: string) => flushSync(() => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
  key("ArrowUp");
  expect(document.activeElement).toBe(turns);
  key("ArrowDown");
  expect(document.activeElement).toBe(live);
  key("Home");
  expect(document.activeElement).toBe(turns);
  // choosing it does nothing: no call, nothing remembered, the menu stays
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
  // a first visit: nothing remembered in this browser or app
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
  // The computer behind the page (a Cloud, a server, or this one's own).
  vi.stubGlobal("fetch", async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ path, method, body });
    if (path === "/api/config" && method === "PUT") {
      liveKey = body.live.key;
      return new Response(JSON.stringify({ ...CLOUD, live: { ...noKey, configured: true } }), { status: 200 });
    }
    if (path === "/api/live/session" && method === "POST") {
      // no plan includes a key: the server says so before calling OpenAI
      if (!liveKey) return new Response(JSON.stringify({ error: "Add an OpenAI API key to use Live calls.", needsKey: true }), { status: 409 });
      // OpenAI is still answering: the call stays "starting"
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
  it("in a browser on the person's Cloud, the first visit's call button is a Live call that asks for the key once and calls", async () => {
    expect(callMode()).toBe("turns");
    chat(CLOUD);
    await firstLiveCall("the server");
    expect(requests.filter((request) => request.method !== "GET").map(({ path, method }) => `${method} ${path}`))
      .toEqual(["POST /api/live/session", "PUT /api/config", "POST /api/live/session"]);
  });

  it("on My Cloud in the Mac app, the call is Live, and Take turns says it works on This computer", async () => {
    open(desktopApp("darwin", "my-cloud"));
    chat(CLOUD);
    expectTurnsDisabled("Calls where you take turns work on This computer. They listen with your Mac's own speech recognition, which only This computer can use.");
    await firstLiveCall("the server");
  });

  it.each(["win32", "linux"] as const)("on My Cloud in the %s app, the call is Live, and Take turns says it needs the Mac app", async (platform) => {
    open(desktopApp(platform, "my-cloud"));
    chat(CLOUD);
    expectTurnsDisabled("Calls where you take turns need the Mac app");
    await firstLiveCall("the server");
  });

  // The Windows and Linux apps can't take turns on their own page either.
  it.each(["win32", "linux"] as const)("on This computer in the %s app, the call is Live and its key is saved through the app", async (platform) => {
    open(desktopApp(platform, "this-computer"));
    chat(THIS_COMPUTER);
    expectTurnsDisabled("Calls where you take turns need the Mac app");
    await firstLiveCall("the app");
  });

  // Desktop apps up to 0.1.95 refuse every server's page the microphone, and
  // later ones refuse any page but a verified My Cloud. The call says so,
  // with the way to make it, before anyone pastes a key it can't use here.
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
    expect(text()).not.toContain(KEY_FORM);
    expect(container.querySelector('input[aria-label="OpenAI API key for Live calls"]')).toBeNull();
    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(invoked.map(({ channel }) => channel)).not.toContain("credential:set");
  });

  // A browser that can't use a microphone at all, such as a server opened
  // at a plain http:// address on the network: one plain sentence that says
  // what to do, and no key form.
  it("in a browser with no microphone support, says how to make the call, and no key is asked for", async () => {
    resetLiveMedia();
    expect(globalThis.navigator.mediaDevices).toBeUndefined();
    chat(SERVER);
    press(callButton());
    await vi.waitFor(() => expect(text()).toContain("Live calls need a microphone, and this window can't use one. Open OpenMausBot at a secure https address to make the call."));
    expect(text()).not.toContain("WebRTC");
    expect(text()).not.toContain(KEY_FORM);
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
