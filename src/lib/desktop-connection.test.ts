// @vitest-environment happy-dom
// One connection path for every in-app desktop: the panel's live desktop and the full-page viewer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clients = vi.hoisted(() => [] as Array<{
  url: string;
  password: string;
  listeners: Map<string, Array<(event: { detail: { text: string } }) => void>>;
  disconnected: number;
  viewOnly: boolean;
  pasted: string[];
  keys: unknown[][];
  emit(type: string, text?: string): void;
}>);
vi.mock("@novnc/novnc", () => ({
  default: class {
    url: string;
    password: string;
    listeners = new Map<string, Array<(event: { detail: { text: string } }) => void>>();
    disconnected = 0;
    viewOnly = false;
    pasted: string[] = [];
    keys: unknown[][] = [];
    scaleViewport = false;
    background = "";
    constructor(_screen: HTMLElement, url: string, options: { credentials: { password: string } }) {
      this.url = url;
      this.password = options.credentials.password;
      clients.push(this);
    }
    addEventListener(type: string, listener: (event: { detail: { text: string } }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    clipboardPasteFrom(text: string) {
      this.pasted.push(text);
    }
    sendKey(...key: unknown[]) {
      this.keys.push(key);
    }
    disconnect() {
      this.disconnected++;
      this.emit("disconnect");
    }
    emit(type: string, text = "") {
      for (const listener of this.listeners.get(type) ?? []) listener({ detail: { text } });
    }
  },
}));

const { connectDesktop, DesktopUnreachable, typeOnDesktop } = await import("./desktop-connection");
const asked: string[] = [];
const events = () => ({ connected: vi.fn(), disconnected: vi.fn(), clipboard: vi.fn() });

beforeEach(() => {
  clients.length = 0;
  asked.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    asked.push(`${init?.method ?? "GET"} ${url}`);
    return new Response(JSON.stringify({ password: "fixture-secret" }), { status: 200 });
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.ogb;
});

describe("connecting to a desktop", () => {
  it("speaks RFB through the app's own proxy, never the VM's page", async () => {
    const on = events();
    await connectDesktop(document.createElement("div"), `local/bot-${"a".repeat(64)}`, { signal: new AbortController().signal, events: on });
    expect(asked).toEqual([`GET /api/desktop-viewer/local/bot-${"a".repeat(64)}`]);
    expect(clients[0]!.url).toBe(`ws://${location.host}/api/desktop-viewer/local/bot-${"a".repeat(64)}/websockify`);
    expect(clients[0]!.password).toBe("fixture-secret");
    clients[0]!.emit("connect");
    clients[0]!.emit("clipboard", "copied");
    expect(on.connected).toHaveBeenCalledTimes(1);
    expect(on.clipboard).toHaveBeenCalledWith("copied");
  });

  it("opens a VPS's tunnel for this conversation first", async () => {
    await connectDesktop(document.createElement("div"), "vps/scout", { threadId: "thread", signal: new AbortController().signal, events: events() });
    expect(asked).toEqual(["POST /api/bots/scout/computer/join?threadId=thread", "GET /api/desktop-viewer/vps/scout"]);
  });

  it("refuses a target the proxy does not serve, before any request", async () => {
    await expect(connectDesktop(document.createElement("div"), "../api/secret", { signal: new AbortController().signal, events: events() }))
      .rejects.toMatchObject({ invalid: true });
    expect(asked).toEqual([]);
  });

  it("a viewer the server refuses is unreachable, not a hang", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 409 })));
    await expect(connectDesktop(document.createElement("div"), "local/shared", { signal: new AbortController().signal, events: events() }))
      .rejects.toBeInstanceOf(DesktopUnreachable);
  });

  it("a desktop that never answers is given up after 15 seconds, and says so once", async () => {
    vi.useFakeTimers();
    const on = events();
    await connectDesktop(document.createElement("div"), "local/shared", { signal: new AbortController().signal, events: on });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(clients[0]!.disconnected).toBe(1);
    expect(on.disconnected).toHaveBeenCalledTimes(1);
  });

  it("goes quiet once the viewer has left", async () => {
    vi.useFakeTimers();
    const left = new AbortController();
    const on = events();
    await connectDesktop(document.createElement("div"), "local/shared", { signal: left.signal, events: on });
    left.abort();
    clients[0]!.emit("connect");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(on.connected).not.toHaveBeenCalled();
    expect(on.disconnected).not.toHaveBeenCalled();
  });

  it("types text as keysyms, Latin and not", () => {
    const sent: number[] = [];
    typeOnDesktop({ sendKey: (keysym: number) => sent.push(keysym) } as never, "a\n\tП");
    expect(sent).toEqual([0x61, 0xff0d, 0xff09, 0x0100041f]);
  });
});

describe("pasting into a desktop", () => {
  // The canvas noVNC types from sits inside the screen; its own key listener stands in for noVNC's.
  async function desktop(platform: string, leave = new AbortController()) {
    window.ogb = { platform } as typeof window.ogb;
    const screen = document.createElement("div");
    const canvas = screen.appendChild(document.createElement("canvas"));
    const forwarded: string[] = [];
    canvas.addEventListener("keydown", (event) => forwarded.push(event.key));
    await connectDesktop(screen, "local/shared", { signal: leave.signal, events: events() });
    const client = clients[0]!;
    const press = (key: string, init: KeyboardEventInit = {}) =>
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
    const paste = (text: string) => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => type === "text/plain" ? text : "" } });
      canvas.dispatchEvent(event);
      return event;
    };
    const lift = (code: string) => canvas.dispatchEvent(new KeyboardEvent("keyup", { code, bubbles: true }));
    return { client, forwarded, press, lift, paste };
  }

  it("⌘V on a Mac puts the Mac's text on the desktop's clipboard and presses Ctrl+V there, not ⌘", async () => {
    const { client, forwarded, press, lift, paste } = await desktop("darwin");
    press("Meta", { code: "MetaLeft", metaKey: true });
    press("v", { code: "KeyV", metaKey: true });
    lift("KeyV"); // the app's Edit menu can deliver the paste after V is up
    const event = paste("from the Mac");
    expect(forwarded).toEqual(["Meta"]);
    expect(event.defaultPrevented).toBe(true);
    expect(client.pasted).toEqual(["from the Mac"]);
    expect(client.keys).toEqual([[0xffe3, "ControlLeft", true], [0xffe9, "MetaLeft", false], [0x76, "KeyV"], [0xffe3, "ControlLeft", false]]);
  });

  it("Ctrl+V elsewhere pastes the same way, leaving the held Ctrl to the person's own release", async () => {
    const { client, forwarded, press, paste } = await desktop("win32");
    press("Control", { code: "ControlLeft", ctrlKey: true });
    press("v", { code: "KeyV", ctrlKey: true });
    paste("from Windows");
    expect(forwarded).toEqual(["Control"]);
    expect(client.pasted).toEqual(["from Windows"]);
    expect(client.keys).toEqual([[0xffe3, "ControlLeft", true], [0x76, "KeyV"]]);
  });

  it("once ⌘ is let go, a paste from the menu presses the whole Ctrl+V", async () => {
    const { client, press, lift, paste } = await desktop("darwin");
    press("Meta", { code: "MetaLeft", metaKey: true });
    lift("MetaLeft");
    paste("menu");
    expect(client.keys).toEqual([[0xffe3, "ControlLeft", true], [0x76, "KeyV"], [0xffe3, "ControlLeft", false]]);
  });

  it("a clipboard with no text still presses Ctrl+V, so the desktop pastes its own clipboard as before", async () => {
    const { client, paste } = await desktop("linux");
    paste("");
    expect(client.pasted).toEqual([]);
    expect(client.keys).toEqual([[0xffe3, "ControlLeft", true], [0x76, "KeyV"], [0xffe3, "ControlLeft", false]]);
  });

  it("the V key pastes on a non-Latin layout too, but a Latin layout's other letter there stays a key", async () => {
    const { client, forwarded, press, paste } = await desktop("win32");
    press("м", { code: "KeyV", ctrlKey: true }); // Russian layout
    press("k", { code: "KeyV", ctrlKey: true }); // Dvorak: Ctrl+K, not a paste
    paste("Привет");
    expect(forwarded).toEqual(["k"]);
    expect(client.pasted).toEqual(["Привет"]);
  });

  it("other shortcuts still reach the desktop as keys: Ctrl+V on a Mac, ⌘⇧V", async () => {
    const { client, forwarded, press } = await desktop("darwin");
    press("v", { code: "KeyV", ctrlKey: true });
    press("V", { code: "KeyV", metaKey: true, shiftKey: true });
    expect(forwarded).toEqual(["v", "V"]);
    expect(client.keys).toEqual([]);
  });

  it("a view-only desktop gets nothing", async () => {
    const { client, paste } = await desktop("darwin");
    client.viewOnly = true;
    paste("secret");
    expect(client.pasted).toEqual([]);
    expect(client.keys).toEqual([]);
  });

  it("stops once the viewer has left", async () => {
    const leave = new AbortController();
    const { client, forwarded, press, paste } = await desktop("darwin", leave);
    leave.abort();
    press("v", { code: "KeyV", metaKey: true });
    paste("late");
    expect(forwarded).toEqual(["v"]);
    expect(client.pasted).toEqual([]);
  });
});
