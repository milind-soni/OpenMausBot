// @vitest-environment happy-dom
// A blocked microphone's notice: its one button does what it says when the
// person clicks it. Open in browser opens this page in the web browser; Try
// again starts the call again.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { endCall } from "@/lib/call";
import { configureLiveMedia, resetLiveMedia, startLiveCall } from "@/lib/live-call-media";
import { StoreProvider, type Bot } from "@/state/store";
import { LiveCallBar } from "./LiveCallBar";

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
const call = { callId: "c1", botId: bot.id, threadId: bot.threadId, client: "desktop", voice: "marin", startedAt: 5, status: "connecting" } as const;
const onServerPage = () => ({ dictation: { available: false, engine: "none", onDevice: false, reasonCode: "remote-server" } }) as DesktopCapabilities;
const blocked = async (): Promise<MediaStream> => { throw new DOMException("denied", "NotAllowedError"); };
const track = { enabled: true, stop: () => {} };
const microphone = async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) as unknown as MediaStream;
const peer = () => ({
  ontrack: null,
  localDescription: { sdp: "v=0\r\n" },
  iceGatheringState: "complete",
  connectionState: "new",
  addTrack: () => {},
  createDataChannel: () => ({ readyState: "connecting", close: () => {} }),
  createOffer: async () => ({ type: "offer", sdp: "v=0\r\n" }),
  setLocalDescription: async () => {},
  setRemoteDescription: async () => {},
  close: () => {},
}) as unknown as RTCPeerConnection;

let host: HTMLDivElement;
let root: Root;
const render = () => flushSync(() => root.render(createElement(StoreProvider, null, createElement(LiveCallBar, { bot }))));
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  resetLiveMedia();
  endCall();
});

describe("LiveCallBar's notice button", () => {
  it("Open in browser opens this page in the web browser", async () => {
    const openInBrowser = vi.fn();
    const request = vi.fn();
    configureLiveMedia({ getUserMedia: blocked, capabilities: onServerPage, pageMicrophone: async () => "refused", openInBrowser, request: request as never });
    await startLiveCall({ botId: bot.id, threadId: bot.threadId });
    render();
    const open = button("Open in browser");
    expect(open).not.toBeNull();
    open!.click();
    expect(openInBrowser).toHaveBeenCalledExactlyOnceWith(location.href);
    expect(request).not.toHaveBeenCalled();
  });

  it("Try again starts the call again", async () => {
    let allowed = false;
    const request = vi.fn(async (path: string) => {
      if (path === "/api/live/session") return { call, transport: { type: "webrtc", sdp: "answer" } };
      throw new Error(`unexpected ${path}`);
    });
    const openInBrowser = vi.fn();
    configureLiveMedia({
      // refused the first time; the person then allows it in the computer's settings
      getUserMedia: () => (allowed ? microphone() : blocked()),
      createPeer: peer,
      request: request as never,
      iceTimeoutMs: 50,
      capabilities: onServerPage,
      pageMicrophone: async () => "allowed",
      openInBrowser,
    });
    await startLiveCall({ botId: bot.id, threadId: bot.threadId });
    render();
    const retry = button("Try again");
    expect(retry).not.toBeNull();
    allowed = true;
    retry!.click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("/api/live/session", expect.objectContaining({ method: "POST" })));
    expect(openInBrowser).not.toHaveBeenCalled();
  });
});
