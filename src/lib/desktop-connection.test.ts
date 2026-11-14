// @vitest-environment happy-dom
// One connection path for every in-app desktop: the panel's live desktop and the full-page viewer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clients = vi.hoisted(() => [] as Array<{
  url: string;
  password: string;
  listeners: Map<string, Array<(event: { detail: { text: string } }) => void>>;
  disconnected: number;
  emit(type: string, text?: string): void;
}>);
vi.mock("@novnc/novnc", () => ({
  default: class {
    url: string;
    password: string;
    listeners = new Map<string, Array<(event: { detail: { text: string } }) => void>>();
    disconnected = 0;
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
