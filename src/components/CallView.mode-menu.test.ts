// What the call button and its mode menu start. Pressing a button here reads
// the rendered element tree and calls its handler; the calls themselves are
// observed through the call and Live media modules.
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({ liveConfigured: true, liveCall: null as AppState["liveCall"], cloudHome: false }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        liveCall: fixture.liveCall,
        config: {
          tts: { configured: true, ready: true, voice: "v" },
          live: { configured: fixture.liveConfigured, voice: "marin", readTypedReplies: true, idleMinutes: 5 },
          cloudHome: fixture.cloudHome,
        } as AppState["config"],
      },
      dispatch: vi.fn(),
    }),
  };
});
vi.mock("./DesktopCapabilities", () => ({
  // a Mac that can take turns
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: true, engine: "apple-speech", onDevice: true } }, ready: true }),
}));

import { CallModeMenu, CallTargetButton } from "./CallView";
import { setCallMode, type CallMode } from "@/lib/call-mode";
import { currentCall, endCall, startCall } from "@/lib/call";
import { configureLiveMedia, liveMedia, resetLiveMedia, startLiveCall } from "@/lib/live-call-media";

type ElementProps = { children?: ReactNode; onClick?: () => void; [key: string]: unknown };
function findElement(tree: ReactNode, match: (props: ElementProps) => boolean): ReactElement<ElementProps> | undefined {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<ElementProps>(child)) continue;
    if (match(child.props)) return child;
    const found = findElement(child.props.children, match);
    if (found) return found;
  }
}

const bot: Pick<Bot, "id" | "threadId" | "name"> = { id: "atlas", threadId: "thread-atlas", name: "Atlas" };
/** A phone's Live call with another bot: it holds the one Live line. */
const phoneCall: NonNullable<AppState["liveCall"]> = {
  callId: "c9", botId: "juniper", threadId: "t9", client: "ios", voice: "marin", startedAt: 0, status: "live",
};

/** The one-to-one call button's markup. */
function renderButton(): string {
  return renderToStaticMarkup(createElement(CallTargetButton, {
    targetId: bot.id, targetName: bot.name, threadId: bot.threadId, voices: ["v"],
    requireExplicitVoices: false, liveCapable: true, onStart: vi.fn(),
  }));
}

/** Render the one-to-one call button and press the phone. */
function pressPhone(onStart: (mode: CallMode) => void) {
  let tree: ReactNode = null;
  function Capture() {
    tree = CallTargetButton({
      targetId: bot.id, targetName: bot.name, threadId: bot.threadId, voices: ["v"],
      requireExplicitVoices: false, liveCapable: true, onStart,
    });
    return tree;
  }
  renderToStaticMarkup(createElement(Capture));
  const phone = findElement(tree, (props) => typeof props["aria-label"] === "string" && /Atlas/.test(props["aria-label"] as string));
  if (!phone) throw new Error("no phone button");
  phone.props.onClick?.();
}

beforeEach(() => {
  fixture.liveConfigured = true;
  fixture.liveCall = null;
  fixture.cloudHome = false;
  vi.stubGlobal("window", { ogb: { speechStart: vi.fn(), speechStop: vi.fn(async () => {}) } });
  // the microphone prompt never answers: a Live call stays "starting"
  configureLiveMedia({ getUserMedia: () => new Promise<MediaStream>(() => {}) });
});
afterEach(() => {
  setCallMode("turns");
  resetLiveMedia();
  endCall();
  vi.unstubAllGlobals();
});

describe("the call button", () => {
  it("starts a Live call through the Live media, not the take-turns overlay", () => {
    setCallMode("live");
    const onStart = vi.fn();
    pressPhone(onStart);
    expect(liveMedia()).toMatchObject({ phase: "starting", botId: "atlas", threadId: "thread-atlas" });
    expect(onStart).toHaveBeenCalledWith("live");
  });

  it("asks for a key instead of calling when Live has none", () => {
    fixture.liveConfigured = false;
    setCallMode("live");
    const onStart = vi.fn();
    pressPhone(onStart);
    expect(liveMedia().phase).toBe("idle");
    expect(currentCall()).toBeNull();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("hangs up this window's Live call", () => {
    setCallMode("live");
    void startLiveCall({ botId: "atlas", threadId: "thread-atlas" });
    pressPhone(vi.fn());
    // hung up before the harness knew the call: nothing to wait for
    expect(liveMedia().phase).toBe("idle");
    expect(currentCall()).toBeNull();
  });

  // Another device holds the one Live line: no Live call button at all (the
  // iPhone's rule), instead of one that can only be refused as busy.
  it("is not there in Live mode while another device holds the Live line, on any bot", () => {
    setCallMode("live");
    expect(renderButton()).toContain('aria-label="Live call with Atlas"');
    fixture.liveCall = phoneCall;
    expect(renderButton()).toBe("");
    fixture.liveCall = { ...phoneCall, status: "ended", endReason: "hung-up" };
    expect(renderButton()).toContain('aria-label="Live call with Atlas"');
  });

  // Take turns never uses the Live line, so a phone's Live call leaves it be.
  it("keeps Take turns while another device holds the Live line", () => {
    setCallMode("turns");
    fixture.liveCall = phoneCall;
    expect(renderButton()).toContain('aria-label="Call Atlas"');
    const onStart = vi.fn();
    pressPhone(onStart);
    expect(currentCall()).toBe("atlas");
    expect(liveMedia().phase).toBe("idle");
    expect(onStart).toHaveBeenCalledWith("turns");
    expect(renderButton()).toContain('aria-label="Hang up on Atlas"');
  });

  it("keeps a running Take-turns call's Hang up when a phone takes the Live line, in either mode", () => {
    startCall("atlas");
    fixture.liveCall = phoneCall;
    for (const mode of ["turns", "live"] as const) {
      setCallMode(mode);
      expect(renderButton()).toContain('aria-label="Hang up on Atlas"');
    }
  });

  // The desktop app lets only the person's own Cloud use the microphone: a
  // block there is the computer's, and on another server a browser is the way.
  it("tells a blocked microphone on a server's page whether it is the person's Cloud", async () => {
    for (const [cloudHome, notice] of [
      [true, "Allow microphone access for this app in your computer's privacy settings"],
      [false, "Open this server in your web browser to make a Live call."],
    ] as const) {
      resetLiveMedia();
      fixture.cloudHome = cloudHome;
      configureLiveMedia({
        getUserMedia: async () => { throw new DOMException("denied", "NotAllowedError"); },
        capabilities: () => ({ dictation: { available: false, engine: "none", onDevice: false, reasonCode: "remote-server" } }) as DesktopCapabilities,
      });
      setCallMode("live");
      pressPhone(vi.fn());
      await vi.waitFor(() => expect(liveMedia().phase).toBe("failed"));
      expect(liveMedia().notice, String(cloudHome)).toContain(notice);
    }
  });

  it("keeps Take turns as it was: the overlay's call, no Live media", () => {
    setCallMode("turns");
    const onStart = vi.fn();
    pressPhone(onStart);
    expect(currentCall()).toBe("atlas");
    expect(liveMedia().phase).toBe("idle");
    expect(onStart).toHaveBeenCalledWith("turns");
  });
});

describe("the call mode menu", () => {
  it("opens upward from the composer and downward from the header", () => {
    const props = { id: "m", mode: "live" as const, onChoose: vi.fn(), onClose: vi.fn() };
    expect(renderToStaticMarkup(createElement(CallModeMenu, { ...props, placement: "composer" }))).toContain("bottom-full");
    expect(renderToStaticMarkup(createElement(CallModeMenu, props))).toContain("top-full");
  });

  it("offers both modes as radio items, the current one checked", () => {
    const markup = renderToStaticMarkup(createElement(CallModeMenu, { id: "m", mode: "live", onChoose: vi.fn(), onClose: vi.fn() }));
    expect(markup).toContain('role="menu"');
    expect(markup).toContain('aria-label="Call mode"');
    const items = markup.split('role="menuitemradio"').slice(1);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain(">Take turns<");
    expect(items[0]).toMatch(/^ aria-checked="false"/);
    expect(items[1]).toContain(">Live<");
    expect(items[1]).toMatch(/^ aria-checked="true"/);
  });

  it("says where the OpenAI key stays: this computer, or the person's Cloud", () => {
    const props = { id: "m", mode: "live" as const, onChoose: vi.fn(), onClose: vi.fn() };
    expect(renderToStaticMarkup(createElement(CallModeMenu, props))).toContain("The OpenAI key stays on your computer.");
    const cloud = renderToStaticMarkup(createElement(CallModeMenu, { ...props, cloudHome: true }));
    expect(cloud).toContain("The OpenAI key stays on your Cloud.");
    expect(cloud).not.toContain("stays on your computer");
  });

  it("reports the chosen mode", () => {
    const onChoose = vi.fn();
    let tree: ReactNode = null;
    function Capture() {
      tree = CallModeMenu({ id: "m", mode: "live", onChoose, onClose: vi.fn() });
      return tree;
    }
    renderToStaticMarkup(createElement(Capture));
    findElement(tree, (props) => props.role === "menuitemradio" && props["aria-checked"] === false)?.props.onClick?.();
    expect(onChoose).toHaveBeenCalledWith("turns");
  });
});
