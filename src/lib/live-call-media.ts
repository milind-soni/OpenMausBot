// The desktop half of a Live call: microphone, speaker and captions over
// WebRTC, straight to OpenAI. It lives at app level (not in a chat view), so
// switching chats keeps the call. Everything else about the call — what the
// bot is asked, what the voice is told, approvals, idle hang-up — runs on the
// harness (server/live-call-controller.ts). This module never sends appends:
// its data channel may only send session.close.
import { useSyncExternalStore } from "react";
import type { LiveCallState, LiveEndReason } from "../../shared/wire";
import { api, ApiError } from "@/state/store";
import { endCall, startCall } from "./call";
import { t } from "./i18n";

export type LiveMediaPhase = "idle" | "starting" | "live" | "ending" | "ended" | "failed";

/** A call is running in this window: the microphone is (or is about to be) open. */
export function isLiveCallRunning(phase: LiveMediaPhase): boolean {
  return phase === "starting" || phase === "live" || phase === "ending";
}

export interface LiveMediaState {
  phase: LiveMediaPhase;
  callId: string | null;
  botId: string | null;
  threadId: string | null;
  startedAt: number | null;
  muted: boolean;
  /** the voice's words, last 240 characters */
  caption: string;
  /** the person's words while they speak, last 160 characters */
  heard: string;
  /** why the call ended or failed, or a hint */
  notice: string | null;
  /** the server has no OpenAI key; show the key form */
  needsKey: boolean;
  busyWith: LiveCallState | null;
  /** a stopped call's notice offers Try again: only where a retry can help
   * (never for a busy line, a blocked microphone, a window without WebRTC
   * or a sign-in that ended) */
  canRetry: boolean;
  /** this window's Hang up asked for the end, and the computer has not
   * confirmed it yet: the bar says "Hanging up…" and the end is quiet. Any
   * other end (another device hung up, the computer ended the call) keeps
   * the call's title while it ends, then says why. */
  hangingUp: boolean;
}

export interface LiveMediaDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createPeer(): RTCPeerConnection;
  request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T>;
  playRemote(track: MediaStreamTrack): Promise<void> | void;
  stopRemote(): void;
  iceTimeoutMs: number;
}

const IDLE: LiveMediaState = {
  phase: "idle", callId: null, botId: null, threadId: null, startedAt: null, muted: false,
  caption: "", heard: "", notice: null, needsKey: false, busyWith: null, canRetry: false, hangingUp: false,
};
const CAPTION_CHARS = 240;
const HEARD_CHARS = 160;
const HEARD_CLEAR_MS = 2_500;
const ENDED_NOTICE_MS = 4_000;
const SERVER_CLOSE_GRACE_MS = 3_000;
/** How long the audio may take to connect once OpenAI's answer is applied. */
export const MEDIA_CONNECT_TIMEOUT_MS = 20_000;

/** This window has no microphone or WebRTC: trying again cannot help. */
class LiveUnsupportedError extends Error {}

let audio: HTMLAudioElement | null = null;
const defaults: LiveMediaDeps = {
  getUserMedia: (constraints) => {
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) return Promise.reject(new LiveUnsupportedError(t("call.live.unsupported")));
    return navigator.mediaDevices.getUserMedia(constraints);
  },
  createPeer: () => {
    if (typeof RTCPeerConnection === "undefined") throw new LiveUnsupportedError(t("call.live.unsupported"));
    return new RTCPeerConnection();
  },
  request: (path, init) => api(path, init),
  playRemote: async (track) => {
    audio ??= Object.assign(document.createElement("audio"), { autoplay: true });
    audio.srcObject = new MediaStream([track]);
    await audio.play();
  },
  stopRemote: () => {
    if (audio) audio.srcObject = null;
  },
  iceTimeoutMs: 10_000,
};
let deps: LiveMediaDeps = defaults;

let state: LiveMediaState = IDLE;
let generation = 0;
let microphone: MediaStream | null = null;
let peer: RTCPeerConnection | null = null;
let channel: RTCDataChannel | null = null;
let heardTimer: ReturnType<typeof setTimeout> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
/** Stops waiting for the click that lets blocked audio play. */
let stopGestureWait: (() => void) | null = null;
/** The last call state the harness reported, even before this window knew the call's id. */
let serverCall: LiveCallState | null = null;
/** The harness reported this window's call attached: any status but
 * "connecting" and "ended". */
let serverAttached = false;
const watchers = new Set<() => void>();

function set(patch: Partial<LiveMediaState>) {
  state = { ...state, ...patch };
  for (const watcher of Array.from(watchers)) watcher();
}

export function liveMedia(): LiveMediaState {
  return state;
}

/** Watch every change; returns the unsubscribe. One function for every
 * consumer, so useSyncExternalStore never resubscribes on a render. */
export function subscribeLiveMedia(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

export function useLiveMedia(): LiveMediaState {
  return useSyncExternalStore(subscribeLiveMedia, liveMedia, liveMedia);
}

export function configureLiveMedia(overrides: Partial<LiveMediaDeps>): void {
  deps = { ...defaults, ...overrides };
}

export function resetLiveMedia(): void {
  release();
  generation += 1;
  deps = defaults;
  state = IDLE;
  serverCall = null;
  serverAttached = false;
}

export function applyCaption(current: { caption: string; heard: string }, event: { type?: unknown; delta?: unknown }): { caption: string; heard: string } {
  const delta = typeof event.delta === "string" ? event.delta : "";
  if (event.type === "session.output_transcript.delta") return { caption: (current.caption + delta).slice(-CAPTION_CHARS), heard: "" };
  if (event.type === "session.input_transcript.delta") return { caption: current.caption, heard: (current.heard + delta).slice(-HEARD_CHARS) };
  return current;
}

export function endNotice(reason: LiveEndReason | undefined): { text: string; dropped: boolean } {
  switch (reason) {
    case "idle": return { text: t("call.live.endedIdle"), dropped: false };
    case "expired": return { text: t("call.live.endedExpired"), dropped: false };
    case "content": return { text: t("call.live.endedContent"), dropped: false };
    case "deleted": return { text: t("call.live.endedDeleted"), dropped: false };
    case "shutdown": return { text: t("call.live.endedShutdown"), dropped: false };
    case "signed-out": return { text: t("call.live.endedSignedOut"), dropped: false };
    case "remote-hangup":
    case "connection-lost":
    case "sideband-lost":
    case "error": return { text: t("call.live.dropped"), dropped: true };
    default: return { text: t("call.live.ended"), dropped: false };
  }
}

export async function startLiveCall(target: { botId: string; threadId: string }): Promise<void> {
  if (isLiveCallRunning(state.phase)) return;
  release();
  const mine = ++generation;
  serverAttached = false;
  set({ ...IDLE, phase: "starting", botId: target.botId, threadId: target.threadId });
  startCall(target.botId);
  try {
    const stream = await deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (mine !== generation) return void stream.getTracks().forEach((track) => track.stop());
    microphone = stream;
    // Mute can be pressed while the call connects.
    for (const track of stream.getAudioTracks()) track.enabled = !state.muted;
    const connection = deps.createPeer();
    peer = connection;
    connection.ontrack = (event) => {
      if (mine !== generation) return;
      void Promise.resolve(deps.playRemote(event.track)).catch(() => {
        if (mine !== generation) return;
        set({ notice: t("call.live.clickToHear") });
        playOnGesture(mine, event.track);
      });
    };
    connection.onconnectionstatechange = () => {
      if (mine !== generation) return;
      if (connection.connectionState === "connected") stopConnectWait();
      else if (connection.connectionState === "failed") void dropped(t("call.live.dropped"));
    };
    for (const track of stream.getAudioTracks()) connection.addTrack(track, stream);
    // the event channel must exist before the offer is created
    const events = connection.createDataChannel("oai-events");
    channel = events;
    events.onopen = () => {
      if (mine === generation) goLiveWhenReady();
    };
    events.onmessage = (event) => {
      if (mine === generation) onChannelMessage(event.data);
    };
    await connection.setLocalDescription(await connection.createOffer());
    await iceGathered(connection, deps.iceTimeoutMs);
    // hung up while the offer was gathering: never create the session
    if (mine !== generation) return;
    const sdp = connection.localDescription?.sdp;
    if (!sdp) throw new Error(t("call.live.noOffer"));
    const result = await deps.request<{ call: LiveCallState; transport: { sdp: string } }>("/api/live/session", {
      method: "POST",
      body: JSON.stringify({ botId: target.botId, threadId: target.threadId, sdp, client: "desktop" }),
      timeoutMs: 35_000,
    });
    if (mine !== generation) {
      // hung up while the server was creating the session
      void endOnServer(result.call.callId);
      return;
    }
    const seen = serverCall;
    // the clock starts when the call goes live, on this computer's clock
    set({ callId: result.call.callId });
    applyServerCall(result.call);
    // The SSE frame can overtake this response (the call already live, or
    // already ended); it was ignored then because the id was not known yet.
    if (seen?.callId === result.call.callId) applyServerCall(seen);
    if (mine !== generation) return;
    await connection.setRemoteDescription({ type: "answer", sdp: result.transport.sdp });
    // hung up (or a newer call began) while the answer was applied: its wait is not ours
    if (mine !== generation) return;
    // Audio that never gets through would leave the call "connecting", or a
    // silent clock, until the idle hang-up while OpenAI bills every second.
    if (connection.connectionState !== "connected") {
      connectTimer = setTimeout(() => {
        if (mine === generation) void dropped(t("call.live.droppedNoAudio"));
      }, MEDIA_CONNECT_TIMEOUT_MS);
    }
  } catch (error) {
    if (mine !== generation) return;
    const body = error instanceof ApiError ? (error.body as { needsKey?: boolean; activeCall?: LiveCallState } | undefined) : undefined;
    // the session exists but this window cannot join it: free the harness's one call
    if (state.callId) void endOnServer(state.callId);
    release();
    if (body?.needsKey) return set({ ...IDLE, needsKey: true, botId: target.botId, threadId: target.threadId });
    if (body?.activeCall) return set({ ...IDLE, phase: "failed", botId: target.botId, threadId: target.threadId, busyWith: body.activeCall, notice: busyText(body.activeCall) });
    const blocked = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "NotFoundError");
    // Trying again cannot help a blocked microphone, a window without
    // WebRTC or a refused sign-in: each needs a person to change something.
    const hopeless = blocked || error instanceof LiveUnsupportedError || (error instanceof ApiError && error.status === 401);
    set({
      ...IDLE, phase: "failed", botId: target.botId, threadId: target.threadId, canRetry: !hopeless,
      notice: blocked ? t("call.live.micBlocked") : error instanceof Error ? error.message : String(error),
    });
  }
}

export async function hangUpLiveCall(): Promise<void> {
  const { callId, phase } = state;
  if (phase === "idle" || phase === "ended" || phase === "failed") return dismissLiveNotice();
  const mine = ++generation;
  set({ phase: "ending", hangingUp: true });
  // Hang up stops capturing now, even if the harness is slow or unreachable.
  // Keep the channel alive until its close command and the end request leave.
  microphone?.getTracks().forEach((track) => track.stop());
  microphone = null;
  sendClose();
  if (callId) await endOnServer(callId);
  // The harness's end frame, or a newer call, got here first: leave it be.
  if (mine !== generation) return;
  release();
  set({ ...IDLE });
}

export function setLiveMuted(muted: boolean): void {
  for (const track of microphone?.getAudioTracks() ?? []) track.enabled = !muted;
  set({ muted });
}

export type LiveCallShortcut = "mute" | "hangUp";

type ChordEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "isComposing" | "defaultPrevented">;

/** ⌘⇧M / Ctrl+Shift+M mutes or unmutes, ⌘⇧H / Ctrl+Shift+H hangs up — the
 * chords video-call apps such as Teams use. Escape stays with popovers and
 * dialogs: a Live call does not end by accident. */
export function liveCallShortcut(event: ChordEvent, isMac: boolean): LiveCallShortcut | null {
  if (event.defaultPrevented || event.isComposing || event.altKey || !event.shiftKey) return null;
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier) return null;
  const key = event.key.toLowerCase();
  return key === "m" ? "mute" : key === "h" ? "hangUp" : null;
}

/** The chord as the buttons show it (`title`) and announce it (`aria-keyshortcuts`). */
export function liveCallChord(action: LiveCallShortcut, isMac: boolean): { text: string; aria: string } {
  const letter = action === "mute" ? "M" : "H";
  return isMac ? { text: `⌘⇧${letter}`, aria: `Meta+Shift+${letter}` } : { text: `Ctrl+Shift+${letter}`, aria: `Control+Shift+${letter}` };
}

/** Acts on a chord while this window holds a call; true when it did (the
 * caller then stops the key from reaching anything else). */
export function handleLiveCallKey(event: ChordEvent, isMac: boolean): boolean {
  const action = liveCallShortcut(event, isMac);
  if (!action || !isLiveCallRunning(state.phase)) return false;
  if (action === "mute") setLiveMuted(!state.muted);
  else void hangUpLiveCall();
  return true;
}

/** Drop the key prompt a failed start left for this bot (its chat was left
 * or the prompt closed), so it does not open again by itself later. */
export function dismissKeyPrompt(botId: string): void {
  if (state.needsKey && state.botId === botId) dismissLiveNotice();
}

export function dismissLiveNotice(): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  if (state.phase === "ended" || state.phase === "failed" || state.needsKey) set({ ...IDLE });
}

/** The harness refused this window's sign-in (it was signed out or
 * revoked): hang up at once and say why. The harness ends the call on its
 * side too; this window can no longer ask it to. */
export function endSignedOut(): void {
  if (!isLiveCallRunning(state.phase)) return;
  finish(endNotice("signed-out"));
}

/** Ask the harness whether this window may still reach its call. A refused
 * sign-in (401) hangs up at once; an unreachable harness leaves the call to
 * its own media, which ends it if the connection is really gone. */
export async function checkLiveSignIn(): Promise<void> {
  if (!isLiveCallRunning(state.phase)) return;
  const mine = generation;
  try {
    await deps.request("/api/live/call", { timeoutMs: 8_000 });
  } catch (error) {
    if (mine === generation && error instanceof ApiError && error.status === 401) endSignedOut();
  }
}

/** The app's event stream dropped or came back. A revoked or signed-out
 * sign-in has its stream cut and cannot receive the end frame, so a drop
 * during this window's call checks the sign-in. */
export function onLiveStreamConnected(connected: boolean): void {
  if (!connected) void checkLiveSignIn();
}

/** The harness's view of the call (SSE live.call, or GET /api/live/call on connect). */
export function onServerCall(call: LiveCallState | null): void {
  serverCall = call;
  applyServerCall(call);
}

function applyServerCall(call: LiveCallState | null) {
  if (!state.callId) return;
  if (!call) {
    // the harness restarted or forgot the call
    if (state.phase === "starting" || state.phase === "live") finish({ text: t("call.live.ended"), dropped: false });
    return;
  }
  if (call.callId !== state.callId) return;
  if (call.status === "ended") {
    // Only the hang-up this window asked for ends quietly: one another
    // device made reads "Call ended.", as the reason's words say.
    if (call.endReason === "hung-up" && state.hangingUp) endQuietly();
    else finish(endNotice(call.endReason), call.error);
    return;
  }
  // Any status but connecting and ended means the computer's side reached
  // OpenAI: "live", "ending", or one this window does not know, which counts
  // as a call still running (as on both phones).
  if (call.status !== "connecting") serverAttached = true;
  if (call.status === "ending") {
    if (state.phase !== "ending") set({ phase: "ending" });
    return;
  }
  goLiveWhenReady();
}

/** "Connecting…" becomes live when both halves are up: the harness has
 * attached to the session, and this window's own data channel is open (the
 * iPhone's rule). The clock counts from that moment, on this computer. */
function goLiveWhenReady() {
  if (state.phase !== "starting" || !serverAttached || channel?.readyState !== "open") return;
  set({ phase: "live", startedAt: Date.now() });
}

/** A hang-up this window asked for needs no notice. */
function endQuietly() {
  release();
  generation += 1;
  set({ ...IDLE });
}

/** The call is over. `detail`: the harness's own words for why, shown
 * first (as on the phones); the reason still decides drop and Try again. */
function finish(notice: { text: string; dropped: boolean }, detail?: string) {
  sendClose();
  release();
  generation += 1;
  const { botId, threadId } = state;
  set({
    ...IDLE, phase: notice.dropped ? "failed" : "ended", botId, threadId,
    notice: detail?.trim() || notice.text, canRetry: notice.dropped,
  });
  if (!notice.dropped) {
    noticeTimer = setTimeout(dismissLiveNotice, ENDED_NOTICE_MS);
  }
}

async function dropped(text: string) {
  const { callId } = state;
  finish({ text, dropped: true });
  if (callId) await endOnServer(callId);
}

/** Best effort: the harness also ends the call on its own when OpenAI closes it. */
async function endOnServer(callId: string): Promise<void> {
  await deps.request("/api/live/call/end", { method: "POST", body: JSON.stringify({ callId }), timeoutMs: 8_000 }).catch(() => undefined);
}

function onChannelMessage(raw: unknown) {
  let event: { type?: unknown; delta?: unknown };
  try {
    event = JSON.parse(String(raw)) as { type?: unknown; delta?: unknown };
  } catch {
    return;
  }
  if (event.type === "session.closed") {
    // The harness normally reports the end first; if its sideband is gone,
    // stop anyway. A sign-in that ended has no end frame coming: ask.
    if (!closeTimer) void checkLiveSignIn();
    closeTimer ??= setTimeout(() => finish({ text: t("call.live.ended"), dropped: false }), SERVER_CLOSE_GRACE_MS);
    return;
  }
  const next = applyCaption(state, event);
  if (next.caption === state.caption && next.heard === state.heard) return;
  set(next);
  if (event.type === "session.input_transcript.delta") {
    if (heardTimer) clearTimeout(heardTimer);
    heardTimer = setTimeout(() => set({ heard: "" }), HEARD_CLEAR_MS);
  }
}

/** The window blocked autoplay: the next click or key press in it plays the
 * call's audio (a user gesture allows play()), and the hint goes away. */
function playOnGesture(mine: number, track: MediaStreamTrack) {
  const target = globalThis.document;
  if (!target || stopGestureWait) return;
  const retry = () => {
    stopGestureWait?.();
    stopGestureWait = null;
    if (mine !== generation) return;
    void Promise.resolve(deps.playRemote(track)).then(
      () => {
        if (mine === generation && state.notice === t("call.live.clickToHear")) set({ notice: null });
      },
      () => {
        if (mine === generation) playOnGesture(mine, track);
      },
    );
  };
  target.addEventListener("pointerdown", retry, true);
  target.addEventListener("keydown", retry, true);
  stopGestureWait = () => {
    target.removeEventListener("pointerdown", retry, true);
    target.removeEventListener("keydown", retry, true);
  };
}

function stopConnectWait() {
  if (connectTimer) clearTimeout(connectTimer);
  connectTimer = null;
}

function sendClose() {
  if (channel?.readyState === "open") {
    try { channel.send(JSON.stringify({ type: "session.close" })); } catch { /* closing anyway */ }
  }
}

function release() {
  for (const timer of [heardTimer, closeTimer, noticeTimer, connectTimer]) if (timer) clearTimeout(timer);
  heardTimer = closeTimer = noticeTimer = connectTimer = null;
  stopGestureWait?.();
  stopGestureWait = null;
  microphone?.getTracks().forEach((track) => track.stop());
  microphone = null;
  try { channel?.close(); } catch { /* already closed */ }
  channel = null;
  try { peer?.close(); } catch { /* already closed */ }
  peer = null;
  deps.stopRemote();
  if (state.botId) endCall(state.botId);
}

function busyText(call: LiveCallState): string {
  return t(`call.live.busy.${call.client}`);
}

/** Non-trickle ICE: OpenAI takes one offer. Gathering that runs past
 * `timeoutMs` sends the candidates found so far (as the phones do); a call
 * whose audio then never connects is dropped by the media wait. */
function iceGathered(connection: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      connection.removeEventListener("icegatheringstatechange", onState);
      resolve();
    }, timeoutMs);
    function onState() {
      if (connection.iceGatheringState !== "complete") return;
      clearTimeout(timeout);
      connection.removeEventListener("icegatheringstatechange", onState);
      resolve();
    }
    connection.addEventListener("icegatheringstatechange", onState);
  });
}
