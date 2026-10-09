import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const atlas: Bot = {
  id: "atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "", notifications: true,
  color: "green", unread: false, messages: [], modelSelection: { instanceId: "claude", model: "test" },
};
const fixture = vi.hoisted(() => ({ bots: [] as Bot[] }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, bots: fixture.bots }, dispatch: vi.fn() }) };
});

import { endCall } from "@/lib/call";
import { configureLiveMedia, liveMedia, resetLiveMedia, startLiveCall } from "@/lib/live-call-media";
import { LiveCallChip, LiveCallPill } from "./LiveCallPill";

type ElementProps = { children?: ReactNode; onClick?: () => void; [key: string]: unknown };
function findElement(tree: ReactNode, match: (props: ElementProps) => boolean): ReactElement<ElementProps> | undefined {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<ElementProps>(child)) continue;
    if (match(child.props)) return child;
    const found = findElement(child.props.children, match);
    if (found) return found;
  }
}

/** Render, and keep the element tree so a test can press its buttons. */
function renderPill(props: Parameters<typeof LiveCallPill>[0]) {
  let tree: ReactNode = null;
  function Capture() {
    tree = LiveCallPill(props);
    return tree;
  }
  return { markup: renderToStaticMarkup(createElement(Capture)), tree: () => tree };
}

function callAtlas() {
  // the microphone prompt never answers: the call stays "starting"
  configureLiveMedia({ getUserMedia: () => new Promise<MediaStream>(() => {}) });
  void startLiveCall({ botId: "atlas", threadId: "thread-atlas" });
}

beforeEach(() => {
  fixture.bots = [atlas];
  vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
});
afterEach(() => {
  resetLiveMedia();
  endCall();
  vi.unstubAllGlobals();
});

describe("LiveCallPill", () => {
  it("shows nothing without a call from this window", () => {
    expect(renderPill({ onOpen: vi.fn(), currentBotId: null }).markup).toBe("");
  });

  it("shows the call, with mute and hang up, while another chat is open", () => {
    callAtlas();
    const onOpen = vi.fn();
    const { markup, tree } = renderPill({ onOpen, currentBotId: "juniper" });
    expect(markup).toContain("On a Live call with Atlas");
    expect(markup).toContain('title="Back to the call"');
    expect(markup).toContain('aria-label="Mute"');
    expect(markup).toContain('aria-label="Hang up"');

    findElement(tree(), (props) => props.title === "Back to the call")?.props.onClick?.();
    expect(onOpen).toHaveBeenCalledWith("atlas", "thread-atlas");

    findElement(tree(), (props) => props["aria-label"] === "Mute")?.props.onClick?.();
    expect(liveMedia().muted).toBe(true);
    // hung up before the harness knew the call: nothing to wait for
    findElement(tree(), (props) => props["aria-label"] === "Hang up")?.props.onClick?.();
    expect(liveMedia().phase).toBe("idle");
  });

  it("stays out of the way while the call's own chat is on screen", () => {
    callAtlas();
    expect(renderPill({ onOpen: vi.fn(), currentBotId: "atlas" }).markup).toBe("");
    // the same bot showing another of its threads is elsewhere
    fixture.bots = [{ ...atlas, threadId: "thread-other" }];
    expect(renderPill({ onOpen: vi.fn(), currentBotId: "atlas" }).markup).toContain("On a Live call with Atlas");
  });

  it("fits the icons-only sidebar as round buttons", () => {
    callAtlas();
    const { markup } = renderPill({ onOpen: vi.fn(), currentBotId: null, iconOnly: true });
    expect(markup).toContain('aria-label="On a Live call with Atlas"');
    expect(markup).toContain('aria-label="Hang up"');
    expect(markup).not.toContain('<span class="truncate">');
  });
});

describe("LiveCallChip", () => {
  it("takes the narrow window back to the call, and hides from md up", () => {
    expect(renderToStaticMarkup(createElement(LiveCallChip, { currentBotId: "juniper", onOpen: vi.fn() }))).toBe("");
    callAtlas();
    const markup = renderToStaticMarkup(createElement(LiveCallChip, { currentBotId: "juniper", onOpen: vi.fn() }));
    expect(markup).toContain("Back to the call");
    expect(markup).toContain("md:hidden");
    expect(renderToStaticMarkup(createElement(LiveCallChip, { currentBotId: "atlas", onOpen: vi.fn() }))).toBe("");
  });
});
