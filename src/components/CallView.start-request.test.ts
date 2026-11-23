// @vitest-environment happy-dom
// The Simple composer's + menu picks the call mode away from the call button; the button starts the call exactly as
// its own call-mode menu would.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@/state/store";

const fixture = vi.hoisted(() => ({ liveCall: null as AppState["liveCall"], dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        config: {
          tts: { configured: true, ready: true, voice: "v" },
          live: { configured: true, voice: "marin", readTypedReplies: true, idleMinutes: 5 },
        } as AppState["config"],
        liveCall: fixture.liveCall,
      },
      dispatch: fixture.dispatch,
    }),
  };
});
vi.mock("./DesktopCapabilities", () => ({
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: true, engine: "apple-speech", onDevice: true } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { CallTargetButton } = await import("./CallView");
const { requestCallStart } = await import("@/lib/call-start-request");
const { callMode, setCallMode } = await import("@/lib/call-mode");
const { currentCall, endCall, startCall } = await import("@/lib/call");
const { configureLiveMedia, liveMedia, resetLiveMedia } = await import("@/lib/live-call-media");
const { newChatThreadId } = await import("@/state/new-chat");

let root: Root;
let container: HTMLDivElement;
const onStart = vi.fn();
const render = (threadId = "thread-atlas") => flushSync(() => root.render(createElement(CallTargetButton, {
  targetId: "atlas", targetName: "Atlas", threadId, voices: ["v"],
  requireExplicitVoices: false, liveCapable: true, placement: "composer", fill: "#8057C8", onStart,
})));
const remount = () => {
  flushSync(() => root.unmount());
  root = createRoot(container);
};

beforeEach(() => {
  fixture.liveCall = null;
  fixture.dispatch.mockClear();
  window.ogb = { speechStart: vi.fn(), speechStop: vi.fn(async () => {}) } as unknown as NonNullable<Window["ogb"]>;
  configureLiveMedia({ getUserMedia: () => new Promise<MediaStream>(() => {}) });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render();
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  setCallMode("turns");
  resetLiveMedia();
  endCall();
  onStart.mockClear();
  delete window.ogb;
});

describe("a call started from the composer's + menu", () => {
  it("takes turns with this bot, and remembers the mode", () => {
    setCallMode("live");
    flushSync(() => requestCallStart("atlas", "turns"));
    expect(currentCall()).toBe("atlas");
    expect(liveMedia().phase).toBe("idle");
    expect(onStart).toHaveBeenCalledWith("turns");
    expect(callMode()).toBe("turns");
  });

  it("goes Live through the Live media", () => {
    flushSync(() => requestCallStart("atlas", "live"));
    expect(liveMedia()).toMatchObject({ phase: "starting", botId: "atlas", threadId: "thread-atlas" });
    expect(onStart).toHaveBeenCalledWith("live");
    expect(callMode()).toBe("live");
  });

  it("goes Live from a blank chat once the conversation it makes exists", () => {
    render(newChatThreadId("atlas"));
    flushSync(() => requestCallStart("atlas", "live"));
    expect(onStart).toHaveBeenCalledWith("live");
    expect(liveMedia().phase).toBe("idle");
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: "makeNewChat", botId: "atlas", threadId: newChatThreadId("atlas") }));

    flushSync(() => fixture.dispatch.mock.calls[0][0].onMade("made"));
    expect(liveMedia()).toMatchObject({ phase: "starting", botId: "atlas", threadId: "made" });
  });

  it("waits for the blank chat's Live start when Live is pressed again before its settings are saved", () => {
    render(newChatThreadId("atlas"));
    flushSync(() => requestCallStart("atlas", "live"));
    render("made");
    flushSync(() => requestCallStart("atlas", "live"));
    expect(liveMedia().phase).toBe("idle");
    expect(fixture.dispatch).toHaveBeenCalledOnce();

    flushSync(() => fixture.dispatch.mock.calls[0][0].onMade("made"));
    expect(liveMedia()).toMatchObject({ phase: "starting", botId: "atlas", threadId: "made" });
  });

  it("lets Live be pressed again once making the blank chat's conversation failed", () => {
    render(newChatThreadId("atlas"));
    flushSync(() => requestCallStart("atlas", "live"));
    flushSync(() => fixture.dispatch.mock.calls[0][0].onError());
    render("made");
    flushSync(() => requestCallStart("atlas", "live"));
    expect(liveMedia()).toMatchObject({ phase: "starting", botId: "atlas", threadId: "made" });
  });

  it("never goes Live from a blank chat after a Turns call started and hung up while the conversation was being made", () => {
    render(newChatThreadId("atlas"));
    flushSync(() => requestCallStart("atlas", "live"));
    flushSync(() => requestCallStart("atlas", "turns"));
    expect(currentCall()).toBe("atlas");
    flushSync(() => endCall("atlas"));

    flushSync(() => fixture.dispatch.mock.calls[0][0].onMade("made"));
    expect(liveMedia().phase).toBe("idle");
  });

  it("waits for the blank chat's Live start when the made conversation remounts the button before Live is pressed again", () => {
    render(newChatThreadId("atlas"));
    flushSync(() => requestCallStart("atlas", "live"));
    remount();
    render("made");
    flushSync(() => requestCallStart("atlas", "live"));
    expect(liveMedia().phase).toBe("idle");
    expect(fixture.dispatch).toHaveBeenCalledOnce();

    flushSync(() => fixture.dispatch.mock.calls[0][0].onMade("made"));
    expect(liveMedia()).toMatchObject({ phase: "starting", botId: "atlas", threadId: "made" });
  });

  it("never goes Live from a blank chat after a Turns call started on the remounted button", () => {
    render(newChatThreadId("atlas"));
    flushSync(() => requestCallStart("atlas", "live"));
    remount();
    render("made");
    flushSync(() => requestCallStart("atlas", "turns"));
    expect(currentCall()).toBe("atlas");
    flushSync(() => endCall("atlas"));

    flushSync(() => fixture.dispatch.mock.calls[0][0].onMade("made"));
    expect(liveMedia().phase).toBe("idle");
  });

  it("is ignored for another bot, and while this one is already on a call", () => {
    flushSync(() => requestCallStart("juniper", "turns"));
    expect(currentCall()).toBeNull();
    flushSync(() => startCall("atlas"));
    flushSync(() => requestCallStart("atlas", "live"));
    expect(liveMedia().phase).toBe("idle");
    expect(onStart).not.toHaveBeenCalled();
  });

  it("starts nothing while Live is the mode and its line is held on another device, where the button hides", () => {
    setCallMode("live");
    fixture.liveCall = { callId: "phone-call", botId: "atlas", threadId: "thread-atlas", client: "ios", voice: "marin", startedAt: 1, status: "live" };
    render();
    expect(container.querySelector("[data-call-button]")).toBeNull();
    for (const mode of ["turns", "live"] as const) flushSync(() => requestCallStart("atlas", mode));
    expect(currentCall()).toBeNull();
    expect(liveMedia().phase).toBe("idle");
    expect(onStart).not.toHaveBeenCalled();
    expect(callMode()).toBe("live");
  });
});
