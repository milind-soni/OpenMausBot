import { describe, expect, it, vi } from "vitest";
import { hangUpRemoteCall, liveCallBarView, liveLineHeldElsewhere } from "./LiveCallBar";
import type { LiveMediaState } from "@/lib/live-call-media";

const bot = { id: "b1", threadId: "t1", name: "Ada" };
const idle: LiveMediaState = { phase: "idle", callId: null, botId: null, threadId: null, startedAt: null, muted: false, caption: "", heard: "", notice: null, needsKey: false, needsPro: false, busyWith: null, action: null, hangingUp: false };

describe("liveCallBarView", () => {
  it("shows nothing without a call on this chat", () => {
    expect(liveCallBarView({ bot, media: idle, server: null, now: 0 })).toBeNull();
    expect(liveCallBarView({ bot, media: { ...idle, phase: "live", callId: "c", botId: "b2", threadId: "t2", startedAt: 0 }, server: null, now: 0 })).toBeNull();
  });
  it("shows the timer, caption and mute state for this window's call", () => {
    const view = liveCallBarView({ bot, media: { ...idle, phase: "live", callId: "c", botId: "b1", threadId: "t1", startedAt: 1_000, caption: "Hello there", heard: "hi", muted: true }, server: null, now: 66_000 });
    expect(view).toEqual({ kind: "local", title: "Live with Ada · 1:05", caption: "Hello there", heard: "hi", muted: true, ending: false, hint: null });
  });
  it("shows a hint while the call runs, when the window blocked its audio", () => {
    const media: LiveMediaState = { ...idle, phase: "live", callId: "c", botId: "b1", threadId: "t1", startedAt: 0, notice: "Click anywhere in the window to hear the call." };
    expect(liveCallBarView({ bot, media, server: null, now: 0 })).toMatchObject({ kind: "local", hint: "Click anywhere in the window to hear the call." });
  });
  it("says it is hanging up until the computer confirms the end", () => {
    const media: LiveMediaState = { ...idle, phase: "ending", callId: "c", botId: "b1", threadId: "t1", startedAt: 0, hangingUp: true };
    expect(liveCallBarView({ bot, media, server: null, now: 5_000 })).toMatchObject({ kind: "local", title: "Hanging up…", ending: true });
  });
  // Nobody here pressed Hang up: another device hung up, or the computer
  // ends the call (idle, a deleted chat). The bar keeps the call's title
  // until the end, whose words then say why.
  it("keeps the call's title while it ends for any other reason", () => {
    const media: LiveMediaState = { ...idle, phase: "ending", callId: "c", botId: "b1", threadId: "t1", startedAt: 1_000 };
    expect(liveCallBarView({ bot, media, server: null, now: 66_000 })).toMatchObject({ kind: "local", title: "Live with Ada · 1:05", ending: true });
    // one that ends before it went live still says it is connecting
    expect(liveCallBarView({ bot, media: { ...media, startedAt: null }, server: null, now: 0 })).toMatchObject({ title: "Live with Ada · Connecting…" });
  });
  it("says connecting before the call is live", () => {
    expect(liveCallBarView({ bot, media: { ...idle, phase: "starting", botId: "b1", threadId: "t1" }, server: null, now: 0 })).toMatchObject({ kind: "local", title: "Live with Ada · Connecting…" });
  });
  it("shows a phone's call on this chat", () => {
    const server = { callId: "c9", botId: "b1", threadId: "t1", client: "ios", voice: "marin", startedAt: 0, status: "live" } as const;
    expect(liveCallBarView({ bot, media: idle, server, now: 0 })).toEqual({ kind: "remote", title: "Ada is on a Live call from an iPhone", callId: "c9" });
  });
  it("shows a web browser's call on this chat", () => {
    const server = { callId: "c9", botId: "b1", threadId: "t1", client: "web", voice: "marin", startedAt: 0, status: "live" } as const;
    expect(liveCallBarView({ bot, media: idle, server, now: 0 })).toEqual({ kind: "remote", title: "Ada is on a Live call from a web browser", callId: "c9" });
  });
  it("hides a phone's call while it ends, and shows one in a status it does not know, so it can be hung up", () => {
    const server = { callId: "c9", botId: "b1", threadId: "t1", client: "ios", voice: "marin", startedAt: 0, status: "live" } as const;
    expect(liveCallBarView({ bot, media: idle, server: { ...server, status: "ending" }, now: 0 })).toBeNull();
    expect(liveCallBarView({ bot, media: idle, server: { ...server, status: "ended" }, now: 0 })).toBeNull();
    const unknown = { ...server, status: "on-hold" } as unknown as typeof server;
    expect(liveCallBarView({ bot, media: idle, server: unknown, now: 0 })).toMatchObject({ kind: "remote", callId: "c9" });
  });
  it("shows why a call stopped, with the one action that helps", () => {
    expect(liveCallBarView({ bot, media: { ...idle, phase: "failed", botId: "b1", threadId: "t1", notice: "Call dropped.", action: "retry" }, server: null, now: 0 })).toEqual({ kind: "notice", text: "Call dropped.", action: "retry" });
    expect(liveCallBarView({ bot, media: { ...idle, phase: "failed", botId: "b1", threadId: "t1", notice: "The app didn't let this page use the microphone.", action: "open-in-browser" }, server: null, now: 0 })).toEqual({ kind: "notice", text: "The app didn't let this page use the microphone.", action: "open-in-browser" });
    expect(liveCallBarView({ bot, media: { ...idle, phase: "failed", botId: "b1", threadId: "t1", notice: "Another Live call is running.", action: null }, server: null, now: 0 })).toEqual({ kind: "notice", text: "Another Live call is running.", action: null });
    // a call that ended by itself needs nothing done
    expect(liveCallBarView({ bot, media: { ...idle, phase: "ended", botId: "b1", threadId: "t1", notice: "Call ended.", action: "retry" }, server: null, now: 0 })).toEqual({ kind: "notice", text: "Call ended.", action: null });
  });
});

describe("hangUpRemoteCall", () => {
  it("leaves the bar to the harness's end frame when the hang-up goes through", async () => {
    const request = vi.fn(async () => ({ call: { status: "ended" } }));
    const dispatch = vi.fn();
    await hangUpRemoteCall("c9", 3, dispatch, request as never);
    expect(request).toHaveBeenCalledWith("/api/live/call/end", { method: "POST", body: JSON.stringify({ callId: "c9" }) });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("takes the harness's real state when it no longer knows the call, unless a newer frame landed meanwhile", async () => {
    const request = vi.fn(async (path: string) => {
      if (path === "/api/live/call/end") throw new Error("That call is not running.");
      return { call: null };
    });
    const dispatch = vi.fn();
    await hangUpRemoteCall("c9", 3, dispatch, request as never);
    expect(request).toHaveBeenLastCalledWith("/api/live/call");
    // the store drops it if a live.call frame moved the line past version 3
    expect(dispatch).toHaveBeenCalledWith({ type: "liveCallLookup", call: null, since: 3, seq: expect.any(Number) });
  });
  it("stays quiet when the harness cannot be reached at all", async () => {
    const dispatch = vi.fn();
    await expect(hangUpRemoteCall("c9", 3, dispatch, (async () => { throw new Error("offline"); }) as never)).resolves.toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

// The call button is hidden while another device holds the line (the
// iPhone's rule): a second Live call cannot start, and pressing it only
// earned a "busy" refusal.
describe("liveLineHeldElsewhere", () => {
  const phone = { callId: "c9", botId: "b2", threadId: "t2", client: "ios", voice: "marin", startedAt: 0, status: "live" } as const;
  it("is true while another device's call runs, on any bot, until it has ended", () => {
    expect(liveLineHeldElsewhere(idle, phone)).toBe(true);
    expect(liveLineHeldElsewhere(idle, { ...phone, status: "connecting" })).toBe(true);
    expect(liveLineHeldElsewhere(idle, { ...phone, status: "ending" })).toBe(true);
    expect(liveLineHeldElsewhere(idle, { ...(phone as object), status: "on-hold" } as unknown as typeof phone)).toBe(true);
    expect(liveLineHeldElsewhere(idle, { ...phone, status: "ended" })).toBe(false);
    expect(liveLineHeldElsewhere(idle, null)).toBe(false);
  });
  it("is false while this window holds a call: its own button rules apply", () => {
    const calling: LiveMediaState = { ...idle, phase: "starting", botId: "b1", threadId: "t1" };
    expect(liveLineHeldElsewhere(calling, phone)).toBe(false);
    expect(liveLineHeldElsewhere({ ...calling, phase: "live", callId: "c9" }, phone)).toBe(false);
  });
});
