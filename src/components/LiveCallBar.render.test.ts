import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BotEditorStore, initialState, StoreProvider, type AppState, type Bot } from "@/state/store";
import { endCall } from "@/lib/call";
import { configureLiveMedia, resetLiveMedia, startLiveCall } from "@/lib/live-call-media";
import { LiveCallBar } from "./LiveCallBar";
import { LiveCallSettings } from "./LiveCallSettings";
import { LiveKeySetup } from "./LiveKeySetup";

const bot: Bot = {
  id: "atlas",
  threadId: "thread-atlas",
  name: "Atlas",
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "test" },
  messages: [],
};

const render = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(StoreProvider, null, element));
/** Rendered by the person's own Cloud (its config answers `cloudHome`). */
const renderOnCloud = (element: ReturnType<typeof createElement>) => {
  const config = { cloudHome: true, live: { configured: true, voice: "marin", readTypedReplies: true, idleMinutes: 5 } } as AppState["config"];
  const value = { state: { ...initialState, config }, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  return renderToStaticMarkup(createElement(BotEditorStore, { value, children: element }));
};
const CLOUD_DISCLOSURE = `A Live call sends your voice to OpenAI, along with the chat&#x27;s recent messages, the bot&#x27;s answers and the details of any approval it asks for. The OpenAI key stays on My Cloud.`;

afterEach(() => {
  resetLiveMedia();
  endCall();
  vi.unstubAllGlobals();
});

describe("LiveCallBar", () => {
  it("renders nothing without a call", () => {
    expect(render(createElement(LiveCallBar, { bot }))).toBe("");
  });

  it("shows the hint when the window blocked the call's audio", async () => {
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    const track = { enabled: true, stop: () => {} };
    const peer = {
      ontrack: null as ((event: { track: unknown }) => void) | null,
      localDescription: { sdp: "v=0\r\n" },
      iceGatheringState: "complete",
      addTrack: () => {},
      createDataChannel: () => ({ readyState: "connecting", close: () => {} }),
      createOffer: async () => ({ type: "offer", sdp: "v=0\r\n" }),
      setLocalDescription: async () => {},
      close: () => {},
    };
    configureLiveMedia({
      getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) as unknown as MediaStream,
      createPeer: () => peer as unknown as RTCPeerConnection,
      // the session answer never comes: the call stays connecting
      request: () => new Promise(() => {}),
      playRemote: async () => { throw new Error("autoplay blocked"); },
    });
    void startLiveCall({ botId: bot.id, threadId: bot.threadId });
    await vi.waitFor(() => expect(peer.ontrack).not.toBeNull());
    peer.ontrack!({ track: {} });
    await vi.waitFor(() => expect(render(createElement(LiveCallBar, { bot }))).toContain("Click anywhere in the window to hear the call."));
  });

  it("shows the call's controls while this window connects", () => {
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    configureLiveMedia({ getUserMedia: () => new Promise<MediaStream>(() => {}) });
    void startLiveCall({ botId: bot.id, threadId: bot.threadId });
    const markup = render(createElement(LiveCallBar, { bot }));
    expect(markup).toContain("Live with Atlas · Connecting…");
    expect(markup).toContain('aria-label="Call settings"');
    expect(markup).toContain('aria-label="Mute"');
    expect(markup).toContain('aria-label="Hang up"');
  });

  it("takes clicks itself, inside the composer dock that lets them through", () => {
    // ChatView's composer dock is pointer-events-none so a blank band beside
    // its cards reaches the transcript; without its own auto the bar's
    // buttons would never receive a click.
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    configureLiveMedia({ getUserMedia: () => new Promise<MediaStream>(() => {}) });
    void startLiveCall({ botId: bot.id, threadId: bot.threadId });
    const markup = render(createElement(LiveCallBar, { bot }));
    expect(markup).toMatch(/^<div role="region"[^>]* class="pointer-events-auto /);
  });

  // A blocked microphone's notice carries one action: Open in browser where
  // this app refused the page, Try again where the person can allow it.
  it.each([
    ["refused", "The app didn&#x27;t let this page use the microphone. Open it in your web browser to make the Live call.", "Open in browser", "Try again"],
    ["allowed", "Allow microphone access for this app in your computer&#x27;s privacy settings, then try again.", "Try again", "Open in browser"],
  ] as const)("shows a microphone the app %s with its one action", async (pageMic, text, action, other) => {
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    configureLiveMedia({
      getUserMedia: async () => { throw new DOMException("denied", "NotAllowedError"); },
      capabilities: () => ({ dictation: { available: false, engine: "none", onDevice: false, reasonCode: "remote-server" } }) as DesktopCapabilities,
      pageMicrophone: async () => pageMic,
    });
    await startLiveCall({ botId: bot.id, threadId: bot.threadId });
    const markup = render(createElement(LiveCallBar, { bot }));
    expect(markup).toContain(text);
    expect(markup).toContain(`aria-label="${action}"`);
    expect(markup).not.toContain(`aria-label="${other}"`);
  });

  it("names the keyboard chords on the mute and hang-up buttons", () => {
    vi.stubGlobal("window", { ogb: { platform: "darwin", speechStop: vi.fn(async () => {}) } });
    configureLiveMedia({ getUserMedia: () => new Promise<MediaStream>(() => {}) });
    void startLiveCall({ botId: bot.id, threadId: bot.threadId });
    const markup = render(createElement(LiveCallBar, { bot }));
    expect(markup).toContain('title="Mute (⌘⇧M)"');
    expect(markup).toContain('aria-keyshortcuts="Meta+Shift+M"');
    expect(markup).toContain('title="Hang up (⌘⇧H)"');
    expect(markup).toContain('aria-keyshortcuts="Meta+Shift+H"');
  });
});

describe("LiveCallSettings", () => {
  it("offers voice, typed replies, idle minutes and the key, defaulting to 5 minutes", () => {
    const markup = render(createElement(LiveCallSettings, { onClose: vi.fn() }));
    expect(markup).toContain('aria-label="Call settings"');
    expect(markup).toContain("Marin (default)");
    expect(markup).toContain("Read replies to typed messages");
    expect(markup).toContain(`When this is off, messages you type during a call and the bot&#x27;s answers to them are not sent to OpenAI.`);
    expect(markup).toContain(`A Live call sends your voice to OpenAI, along with the chat&#x27;s recent messages, the bot&#x27;s answers and the details of any approval it asks for. The OpenAI key stays on your computer.`);
    expect(markup).toMatch(/<option value="5" selected="">5<\/option>/);
    expect(markup).toContain("Change key");
    // nothing to remove without a key
    expect(markup).not.toContain("Remove key");
    expect(markup).toMatch(/role="dialog" tabindex="-1"/);
  });

  it("says the key stays on the Cloud when the chat is on the person's Cloud", () => {
    const markup = renderOnCloud(createElement(LiveCallSettings, { onClose: vi.fn() }));
    expect(markup).toContain(CLOUD_DISCLOSURE);
    expect(markup).not.toContain("stays on your computer");
  });

  it("takes focus when it opens, so Escape closes it", () => {
    const onClose = vi.fn();
    let tree!: ReactElement<{ ref: (node: unknown) => void; onKeyDown: (event: unknown) => void }>;
    function Capture() {
      tree = LiveCallSettings({ onClose }) as typeof tree;
      return tree;
    }
    render(createElement(Capture));
    const first = { focus: vi.fn() };
    const querySelector = vi.fn(() => first);
    tree.props.ref({ querySelector });
    expect(querySelector).toHaveBeenCalledWith("select, input, button");
    expect(first.focus).toHaveBeenCalledOnce();
    const stopPropagation = vi.fn();
    tree.props.onKeyDown({ key: "Escape", stopPropagation });
    expect(onClose).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });
});

describe("LiveKeySetup", () => {
  it("says what the key is for, in the app's language", () => {
    const markup = render(createElement(LiveKeySetup, { onSaved: vi.fn() }));
    expect(markup).toContain("Live calls use OpenAI GPT-Live");
    // what leaves the computer, where Live is set up
    expect(markup).toContain(`A Live call sends your voice to OpenAI, along with the chat&#x27;s recent messages, the bot&#x27;s answers and the details of any approval it asks for. The OpenAI key stays on your computer.`);
    expect(markup).toContain('aria-label="OpenAI API key for Live calls"');
    expect(markup).toContain("Save and start the call");
    expect(render(createElement(LiveKeySetup, { onSaved: vi.fn(), compact: true }))).toContain(">Save<");
  });

  // Pasted on the Cloud's page, the key is saved on the Cloud.
  it("says the key stays on the Cloud when the chat is on the person's Cloud", () => {
    const markup = renderOnCloud(createElement(LiveKeySetup, { onSaved: vi.fn() }));
    expect(markup).toContain(CLOUD_DISCLOSURE);
    expect(markup).not.toContain("stays on your computer");
  });
});
