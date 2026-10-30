import { describe, expect, it, vi } from "vitest";

import { DialogWatch, localDevToolsUrl } from "./browser-dialogs.ts";
import type { Cdp, CdpListeners } from "./browser-sites.ts";

async function watching() {
  let listeners: CdpListeners = {};
  const cdp: Cdp = { send: vi.fn(async () => ({})), close: vi.fn() };
  const changes: unknown[] = [];
  const watch = new DialogWatch((dialog) => changes.push(dialog));
  await watch.start("ws://127.0.0.1:9222/devtools/browser/x", async (_url, _timeout, given) => { listeners = given; return cdp; });
  const emit = (method: string, params: Record<string, unknown>, sessionId?: string) => listeners.event?.({ method, params, sessionId });
  return { watch, cdp, changes, emit, closed: () => listeners.closed?.() };
}

describe("a browser's page dialogs", () => {
  it("connects only to the engine's own Chrome on this machine", () => {
    expect(localDevToolsUrl("ws://127.0.0.1:9222/devtools/browser/ab-12")).toBe("ws://127.0.0.1:9222/devtools/browser/ab-12");
    for (const url of ["ws://browser.example.net:9222/devtools/browser/x", "ws://127.0.0.1:9222/devtools/page/x", "http://127.0.0.1:9222/json", 9222, null]) {
      expect(localDevToolsUrl(url)).toBeNull();
    }
  });

  it("tracks a confirm or prompt, never the alerts the engine answers itself, until it closes or its page goes", async () => {
    const { watch, changes, emit } = await watching();
    emit("Page.javascriptDialogOpening", { type: "alert", message: "Hi" }, "page-1");
    emit("Page.javascriptDialogOpening", { type: "beforeunload", message: "" }, "page-1");
    expect(watch.dialog).toBeNull();
    emit("Page.javascriptDialogOpening", { type: "prompt", message: "Name?", defaultPrompt: "Ada" }, "page-1");
    expect(watch.dialog).toEqual({ type: "prompt", message: "Name?", defaultValue: "Ada" });
    emit("Page.javascriptDialogClosed", {}, "page-2");
    expect(watch.dialog).not.toBeNull();
    emit("Target.detachedFromTarget", { sessionId: "page-1" });
    expect(watch.dialog).toBeNull();
    expect(changes).toEqual([{ type: "prompt", message: "Name?", defaultValue: "Ada" }, null]);
    expect(watch.opened).toBe(1);
  });

  it("answers on the page that asked, and only while it asks", async () => {
    const { watch, cdp, emit } = await watching();
    expect(await watch.answer(true)).toBe(false);
    emit("Page.javascriptDialogOpening", { type: "confirm", message: "Leave?" }, "page-1");
    const settled = watch.settled();
    expect(await watch.answer(true, "ignored for a confirm")).toBe(true);
    expect(cdp.send).toHaveBeenLastCalledWith("Page.handleJavaScriptDialog", { accept: true }, "page-1");
    await settled;
    expect(watch.dialog).toBeNull();
  });

  it("stops waiting when its view goes or its connection closes", async () => {
    const { watch, emit, closed } = await watching();
    emit("Page.javascriptDialogOpening", { type: "confirm", message: "Leave?" }, "page-1");
    const view = new AbortController();
    const waiting = watch.settled(view.signal);
    view.abort();
    await waiting;
    const pending = watch.settled();
    closed();
    await pending;
    expect(watch.closed).toBe(true);
  });
});
