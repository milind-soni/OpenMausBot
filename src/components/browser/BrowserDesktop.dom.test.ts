// @vitest-environment happy-dom
// The browser's window on a Cloud's private display: one noVNC client on the desktop route, view-only unless the person
// holds the browser, and the picture view kept where the browser runs without a display.
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => [] as Array<{ socket: { url: string; binaryType: string; close(code: number): void }; client: { viewOnly: boolean; resizeSession: boolean; focusOnClick: boolean; disconnected: number; focused: number; keys: unknown[][]; typed: string[] } }>);
vi.mock("@/lib/desktop-connection", () => ({
  socketUrl: (path: string) => `ws://app.test${path}`,
  openDesktop: (_screen: HTMLElement, socket: never) => {
    const client = { viewOnly: false, resizeSession: false, focusOnClick: true, disconnected: 0, focused: 0, keys: [] as unknown[][], typed: [] as string[], disconnect() { this.disconnected++; }, focus() { this.focused++; }, sendKey(...args: unknown[]) { this.keys.push(args); } };
    opened.push({ socket, client });
    return client;
  },
  typeOnDesktop: (client: { typed: string[] }, text: string) => { client.typed.push(text); },
}));

class FakeSocket extends EventTarget {
  binaryType = "blob";
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
  }
  close(code: number): void {
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}

const { BrowserDesktop, DESKTOP_VIEW_CLOSE } = await import("./BrowserDesktop");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  opened.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const render = (props: { controlling: boolean; onUnavailable?: () => void; scope?: Record<string, string>; pill?: boolean }) => flushSync(() => root.render(createElement(BrowserDesktop, {
  botId: "scout", scope: props.scope ?? {}, controlling: props.controlling, label: "Scout's page", onUnavailable: props.onUnavailable ?? (() => {}),
}, props.pill ? createElement("div", { "data-pill": "" }) : null)));

/** What a phone keyboard does to the hidden field: the field's whole new value, then an input event. */
const typeInto = (field: HTMLTextAreaElement, value: string) => {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("the browser desktop view", () => {
  it("opens the desktop route of the conversation's browser, view-only while the person watches", () => {
    render({ controlling: false, scope: { threadId: "room-1" } });
    expect(opened).toHaveLength(1);
    expect(opened[0]!.socket.url).toBe("ws://app.test/api/bots/scout/browser/desktop?threadId=room-1");
    expect(opened[0]!.socket.binaryType).toBe("arraybuffer");
    expect(opened[0]!.client.viewOnly).toBe(true);
    expect(host.querySelector("[data-browser-desktop]")?.getAttribute("aria-label")).toBe("Scout's page");
  });

  it("drives once the person holds the browser, and stops when they hand it back", () => {
    render({ controlling: false });
    expect(opened[0]!.client.resizeSession).toBe(false);
    render({ controlling: true });
    expect(opened[0]!.client.viewOnly).toBe(false);
    expect(opened[0]!.client.resizeSession).toBe(true);
    expect(opened[0]!.client.focused).toBe(1);
    render({ controlling: false });
    expect(opened[0]!.client.viewOnly).toBe(true);
    expect(opened).toHaveLength(1);
  });

  it("opens the phone's keyboard on a tap while the person holds the browser, and sends what they type as keys", () => {
    render({ controlling: false });
    const screen = host.querySelector<HTMLElement>("[data-browser-desktop]")!;
    const field = host.querySelector<HTMLTextAreaElement>("textarea")!;
    screen.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true }), { pointerType: "touch" }));
    expect(document.activeElement).not.toBe(field);
    render({ controlling: true });
    screen.dispatchEvent(Object.assign(new Event("pointerdown", { bubbles: true }), { pointerType: "touch" }));
    expect(document.activeElement).toBe(field);
    expect(opened[0]!.client.focusOnClick).toBe(false);
    typeInto(field, "\u200bhé😀");
    typeInto(field, "\u200bok\nnext");
    typeInto(field, "");
    const client = opened[0]!.client;
    expect(client.typed).toEqual(["hé😀", "ok", "next"]);
    expect(client.keys).toEqual([[0xff0d, "Enter"], [0xff08, "Backspace"]]);
    expect(field.value).toBe("\u200b");
    field.blur();
    expect(opened[0]!.client.focusOnClick).toBe(true);
  });

  it("keeps what is typed from a watcher's keyboard off the browser", () => {
    render({ controlling: false });
    typeInto(host.querySelector<HTMLTextAreaElement>("textarea")!, "\u200bsecret");
    expect(opened[0]!.client.typed).toEqual([]);
  });

  it("shows what sits over the picture, such as the handoff pill", () => {
    render({ controlling: false, pill: true });
    expect(host.querySelector("[data-browser-desktop-view] [data-pill]")).not.toBeNull();
  });

  it("gives way to the picture view where the browser has no display, and reconnects after any other close", async () => {
    const unavailable = vi.fn();
    render({ controlling: false, onUnavailable: unavailable });
    opened[0]!.socket.close(DESKTOP_VIEW_CLOSE.heldElsewhere);
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(opened).toHaveLength(2);
    expect(opened[0]!.client.disconnected).toBe(1);
    opened[1]!.socket.close(DESKTOP_VIEW_CLOSE.pictures);
    expect(unavailable).toHaveBeenCalledOnce();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(opened).toHaveLength(2);
  });
});
