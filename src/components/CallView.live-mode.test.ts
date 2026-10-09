import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, StoreProvider, type Bot } from "@/state/store";

vi.mock("./DesktopCapabilities", () => ({
  // capabilities still loading: a take-turns call cannot start yet
  useDesktopCapabilities: () => ({ capabilities: null, ready: false }),
}));

import { CallButton, CallOverlay, CallTargetButton } from "./CallView";
import { setCallMode } from "@/lib/call-mode";
import { endCall, startCall } from "@/lib/call";
import { configureLiveMedia, dismissStartPrompt, resetLiveMedia, startLiveCall } from "@/lib/live-call-media";

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

afterEach(() => {
  setCallMode("turns");
  resetLiveMedia();
  endCall();
  vi.unstubAllGlobals();
});

describe("call modes", () => {
  it("offers a Live call to one bot without on-device dictation or a configured voice", () => {
    setCallMode("turns");
    expect(render(createElement(CallButton, { bot }))).toContain('aria-label="Checking call availability"');

    setCallMode("live");
    const live = render(createElement(CallButton, { bot }));
    expect(live).toContain('aria-label="Live call with Atlas"');
    expect(live).not.toContain("bg-warning");
  });

  it("keeps group calls on the take-turns path", () => {
    setCallMode("live");
    const group = render(createElement(CallTargetButton, {
      targetId: "room", targetName: "Room", voices: [undefined], requireExplicitVoices: true, onStart: vi.fn(),
    }));
    expect(group).toContain('aria-label="Checking call availability"');
  });

  it("puts a call mode chevron next to a one-to-one call button, not a room's", () => {
    const one = render(createElement(CallButton, { bot }));
    expect(one).toContain('aria-label="Call mode"');
    expect(one).toContain('aria-haspopup="menu"');
    const group = render(createElement(CallTargetButton, {
      targetId: "room", targetName: "Room", voices: [undefined], requireExplicitVoices: true, onStart: vi.fn(),
    }));
    expect(group).not.toContain('aria-label="Call mode"');
  });

  it("hangs up from the call button while this window is on a Live call", () => {
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    setCallMode("live");
    configureLiveMedia({ getUserMedia: () => new Promise<MediaStream>(() => {}) });
    void startLiveCall({ botId: bot.id, threadId: bot.threadId });
    const markup = render(createElement(CallButton, { bot }));
    expect(markup).toContain('aria-label="Hang up on Atlas"');
    // a mode is picked before a call, not during one
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Call mode"/);
  });

  it("blocks other chats' call buttons while this window is on a Live call", () => {
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    configureLiveMedia({ getUserMedia: () => new Promise<MediaStream>(() => {}) });
    void startLiveCall({ botId: bot.id, threadId: bot.threadId });
    for (const mode of ["live", "turns"] as const) {
      setCallMode(mode);
      const other = render(createElement(CallButton, { bot: { ...bot, id: "juniper", name: "Juniper" } }));
      expect(other).toMatch(/<button[^>]*disabled=""[^>]*aria-label="On a Live call"/);
    }
    const room = render(createElement(CallTargetButton, {
      targetId: "room", targetName: "Room", voices: [undefined], requireExplicitVoices: true, onStart: vi.fn(),
    }));
    expect(room).toMatch(/<button[^>]*disabled=""[^>]*aria-label="On a Live call"/);
  });

  it("asks for the OpenAI key under the call button when the harness has none", async () => {
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    const track = { enabled: true, stop: vi.fn() };
    configureLiveMedia({
      getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) as unknown as MediaStream,
      createPeer: () => ({
        iceGatheringState: "complete",
        localDescription: { sdp: "v=0" },
        addTrack() {},
        createDataChannel: () => ({ close() {} }),
        createOffer: async () => ({ type: "offer", sdp: "v=0" }),
        setLocalDescription: async () => {},
        close() {},
      }) as unknown as RTCPeerConnection,
      request: async () => {
        throw new ApiError("Add an OpenAI API key to use Live calls.", 409, { needsKey: true });
      },
      stopRemote: () => {},
    });
    setCallMode("live");
    await startLiveCall({ botId: bot.id, threadId: bot.threadId });
    expect(render(createElement(CallButton, { bot }))).toContain('aria-label="OpenAI API key for Live calls"');
    const composer = render(createElement(CallButton, { bot, placement: "composer" }));
    expect(composer).toContain('aria-label="OpenAI API key for Live calls"');
    expect(composer).toContain("bottom-full");
    expect(render(createElement(CallButton, { bot: { ...bot, id: "juniper" } }))).not.toContain("OpenAI API key");
    // Leaving the chat (or closing the prompt) drops it: it does not open
    // again by itself on a later visit. Another chat leaving keeps it.
    dismissStartPrompt("juniper");
    expect(render(createElement(CallButton, { bot }))).toContain("OpenAI API key");
    dismissStartPrompt(bot.id);
    expect(render(createElement(CallButton, { bot }))).not.toContain("OpenAI API key");
  });

  // Live calls need a Pro plan. The harness says so before it would ask for
  // a key, and the call button shows the Pro card where the key form would be.
  it("shows the Pro card under the call button, never the key form, when Live calls need Pro", async () => {
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    const track = { enabled: true, stop: vi.fn() };
    configureLiveMedia({
      getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) as unknown as MediaStream,
      createPeer: () => ({
        iceGatheringState: "complete",
        localDescription: { sdp: "v=0" },
        addTrack() {},
        createDataChannel: () => ({ close() {} }),
        createOffer: async () => ({ type: "offer", sdp: "v=0" }),
        setLocalDescription: async () => {},
        close() {},
      }) as unknown as RTCPeerConnection,
      request: async () => {
        throw new ApiError("Live calls need a Pro plan.", 402, { needsPro: true });
      },
      stopRemote: () => {},
    });
    setCallMode("live");
    await startLiveCall({ botId: bot.id, threadId: bot.threadId });
    const header = render(createElement(CallButton, { bot }));
    expect(header).toContain("Live calls need a Pro plan");
    // no key form: its field is the one password input
    expect(header).not.toContain('aria-label="OpenAI API key for Live calls"');
    expect(header).not.toContain('type="password"');
    // the call button says its pop-up is open, and which one
    expect(header).toMatch(/aria-expanded="true" aria-controls="[^"]+"[^>]*aria-label="Live call with Atlas"/);
    // The pop-up itself takes focus when it opens: what it offers depends on
    // the plan, which arrives a moment later, so a button focused first could
    // be replaced under the person's focus.
    const popup = /<div id="([^"]+)" tabindex="-1" class="animate-pop-in/.exec(header);
    expect(popup).not.toBeNull();
    expect(header).toContain(`aria-controls="${popup![1]}"`);
    // This window cannot read the plan (no Cloud sign-in bridge): it says
    // what Live calls need and offers nothing to buy.
    expect(header).not.toContain("Get Pro");
    const composer = render(createElement(CallButton, { bot, placement: "composer" }));
    expect(composer).toContain("Live calls need a Pro plan");
    expect(composer).toContain("bottom-full");
    expect(render(createElement(CallButton, { bot: { ...bot, id: "juniper" } }))).not.toContain("Pro plan");
    // Leaving the chat (or closing the prompt) drops it, as it drops the key form.
    dismissStartPrompt("juniper");
    expect(render(createElement(CallButton, { bot }))).toContain("Live calls need a Pro plan");
    dismissStartPrompt(bot.id);
    expect(render(createElement(CallButton, { bot }))).not.toContain("Pro plan");
  });

  it("leaves a Live call to the call bar and covers the chat only for Take turns", async () => {
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    // the microphone prompt never answers: the call stays "starting"
    configureLiveMedia({ getUserMedia: () => new Promise<MediaStream>(() => {}) });
    void startLiveCall({ botId: bot.id, threadId: bot.threadId });
    expect(render(createElement(CallOverlay, { bot }))).toBe("");

    // a failed Live call's notice stays in the bar; a take-turns call still opens
    resetLiveMedia();
    configureLiveMedia({ getUserMedia: () => Promise.reject(new Error("no microphone")) });
    await startLiveCall({ botId: bot.id, threadId: bot.threadId });
    startCall(bot.id);
    expect(render(createElement(CallOverlay, { bot }))).toContain("backdrop-blur-sm");
  });
});
