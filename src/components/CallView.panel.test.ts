// @vitest-environment happy-dom
// The bot panel's Call button: small, round and named, starting the same call as the composer's, which alone answers
// the composer's + menu.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot } from "@/state/store";

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: { ...original.initialState, config: { tts: { configured: true, ready: true, voice: "v" } } as AppState["config"] },
      dispatch: vi.fn(),
    }),
  };
});
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: true, engine: "apple-speech", onDevice: true } }, ready: true }),
}));
const track = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track }));

const { CallButton, CallTargetButton } = await import("./CallView");
const { requestCallStart } = await import("@/lib/call-start-request");
const { currentCall, endCall } = await import("@/lib/call");
const { setCallMode } = await import("@/lib/call-mode");

const atlas: Bot = {
  id: "atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "", notifications: true, color: "green",
  unread: false, messages: [], voice: "v", modelSelection: { instanceId: "fake", model: "fake" },
};
let root: Root;
let host: HTMLDivElement;
const composerStarts = vi.fn();

beforeEach(() => {
  setCallMode("turns");
  window.ogb = { speechStart: vi.fn(), speechStop: vi.fn(async () => {}) } as unknown as NonNullable<Window["ogb"]>;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  endCall();
  composerStarts.mockReset();
  track.mockReset();
  delete window.ogb;
});

const panelButton = () => host.querySelector<HTMLButtonElement>('[data-call-button="panel"]')!;

describe("the bot panel's Call button", () => {
  it("is a small round phone button named for the bot, with no call-mode chevron beside it", () => {
    flushSync(() => root.render(createElement(CallButton, { bot: atlas, placement: "panel" })));
    const button = panelButton();
    expect(button.getAttribute("aria-label")).toBe("Call Atlas");
    expect(button.className.split(" ")).toEqual(expect.arrayContaining(["rounded-full", "size-8"]));
    expect(button.className).not.toContain("rounded-l-3xl");
    expect(button.querySelector("svg.lucide-phone")).not.toBeNull();
    expect(host.querySelector('[aria-label="Call mode"]')).toBeNull();
  });

  it("starts the call and then hangs it up, as the other call buttons do", () => {
    flushSync(() => root.render(createElement(CallButton, { bot: atlas, placement: "panel" })));
    flushSync(() => panelButton().click());
    expect(currentCall()).toBe("atlas");
    expect(track).toHaveBeenCalledWith("call_started", expect.objectContaining({ mode: "turns" }));
    expect(panelButton().getAttribute("aria-label")).toBe("Hang up on Atlas");
    flushSync(() => panelButton().click());
    expect(currentCall()).toBeNull();
  });

  it("leaves the composer's + menu to the composer's button, so one choice starts one call", () => {
    flushSync(() => root.render(createElement("div", null,
      createElement(CallButton, { bot: atlas, placement: "panel" }),
      createElement(CallTargetButton, {
        targetId: "atlas", targetName: "Atlas", threadId: "thread-atlas", voices: ["v"], requireExplicitVoices: false,
        liveCapable: true, placement: "composer", fill: "#8057C8", onStart: composerStarts,
      }),
    )));
    flushSync(() => requestCallStart("atlas", "turns"));
    expect(composerStarts).toHaveBeenCalledExactlyOnceWith("turns");
    expect(track.mock.calls.filter(([event]) => event === "call_started")).toEqual([]);
    expect(currentCall()).toBe("atlas");
  });
});
