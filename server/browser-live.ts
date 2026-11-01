import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { promisify } from "node:util";
import type { PageSize } from "./browser-page-size.ts";
import { attachesToChrome, browserRuntimeEnv, type BrowserRuntime } from "./browser-runtime.ts";
import { requestedSize } from "./browser/viewers/viewport.ts";
import { closeBrowserSession } from "./browser-engine.ts";
import { DialogWatch, localDevToolsUrl } from "./browser-dialogs.ts";
import type { Cdp, CdpListeners } from "./browser-sites.ts";
import { relay } from "./browser-relay.ts";
import { HOLD_LIMITS, HoldClock, type HoldLimits } from "./browser/hold.ts";
import { BROWSER_HELD_ELSEWHERE } from "../shared/browser-held.ts";

const execute = promisify(execFile);
/** A frame of the largest page the view sizes (MAX_PAGE_PIXELS) is up to about 2.8 MB of base64 for a page of noise, and two
 * may be on their way to a view at once. */
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_BUFFER = 8 * 1024 * 1024;
const HEARTBEAT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;
const STATUS_PROBE_MS = 10_000;
const BUSY_RETRY_MS = [1_000, 2_000, 5_000];
const BUSY_LIMIT_MS = 10 * 60_000;
// agent-browser's native press resolver supplies the virtual key codes and Enter/Tab text its raw input_keyboard relay omits.
const DISCRETE_KEYS = new Set(["Backspace", "Enter", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
const RESTART_NEEDED = "A browser action was interrupted. Choose Restart browser… in the browser menu before continuing.";
const restartedNote = (keepsSignIns: boolean) => `The page stopped responding, so the browser was restarted. ${keepsSignIns ? "Your sign-ins are kept; open" : "It is a temporary browser, so its sign-ins are gone; open"} the page again.`;
const INPUT_RELAY = { timeoutMs: 30_000, maxBytes: 65_536 };
/** Frames a view may have on its way without acknowledging them: over a slow link one acknowledgement round trip per frame
 * held a Cloud's panel to a few frames a second. */
const FRAME_WINDOW = 2;
/** Inputs one request may carry, so a remote panel's typing does not wait a round trip per key. */
export const INPUT_BATCH_LIMIT = 64;
const ENDED_PROBE = { timeoutMs: 5_000, maxBytes: 65_536 };
/** What a view hears when its browser closed unused: it stops, where reconnecting would start the browser again. */
export const BROWSER_ASLEEP_ERROR = { type: "error", retryable: false, asleep: true, message: "This browser closed after it sat unused, to save memory. Reconnect to open it again." };
/** What a view hears while its browser cannot show it yet; it keeps waiting. */
export const BROWSER_WAITING = { type: "waiting", reason: "busy" };

export class BrowserLiveError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = "BrowserLiveError"; this.status = status; }
}

export class BrowserActionFailedError extends BrowserLiveError {
  readonly settled = true;
  constructor(args: readonly string[]) {
    const opening = args[0] === "open" || (args[0] === "tab" && args[1] === "new" && args.length > 2);
    super(opening ? "This page could not be opened. Check the address and try again." : "The browser could not do that. Try again.", 422);
    this.name = "BrowserActionFailedError";
  }
}

/** Another command, usually the bot's own, holds the session; not a missing engine. */
export class BrowserBusyError extends BrowserLiveError {
  constructor(message = "The browser is busy with another action and did not answer in time. Try again shortly.") {
    super(message, 503); this.name = "BrowserBusyError";
  }
}

/** The engine left a status read unanswered with no bot or person working in it: it hung, and its session is being reset. */
class BrowserUnresponsiveError extends BrowserLiveError {
  constructor() { super("The browser stopped responding, so it is being restarted. The live view reconnects by itself.", 503); this.name = "BrowserUnresponsiveError"; }
}

/** A person's input or command went unanswered, but the engine answered a read queued behind it, so it has ended. */
export class BrowserSlowActionError extends BrowserLiveError {
  readonly settled = true;
  constructor() { super("The browser was slow to take that. Check the page before you repeat it.", 409); this.name = "BrowserSlowActionError"; }
}

/** The browser answered that it did not take an input, which therefore had no effect. */
class BrowserInputRefusedError extends Error {}
const INPUT_REFUSED = "The page did not take some of your input. Check the page, then try again.";

/** An input, or the release of a key or button, the browser never confirmed: its state in the page is unknown. */
class BrowserInputUnconfirmedError extends BrowserLiveError {
  constructor() { super("The browser could not confirm this input. Choose Restart browser… in the browser menu before continuing.", 503); this.name = "BrowserInputUnconfirmedError"; }
}

/** execFile's own timeout killed a command that had not exited (not a missing binary, a failure, an abort or an overflow). */
function timedOut(error: unknown): boolean {
  const failure = error as { killed?: unknown; signal?: unknown; code?: unknown } | null;
  return failure?.killed === true && failure.signal === "SIGKILL" && failure.code == null;
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}
function number(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function integer(value: unknown, min: number, max: number): value is number {
  return number(value, min, max) && Number.isSafeInteger(value);
}
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length <= max; }

function displayUrl(value: unknown): string {
  if (!text(value, 8192)) return "";
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'about:'].includes(url.protocol)) return "";
    url.username = ""; url.password = "";
    return url.href;
  } catch { return ""; }
}

/** The engine's JSON answer says the command failed, so it ran to the end; a timeout, abort or crash stays an interrupted action. */
function engineAnsweredFailure(error: unknown): boolean {
  const stdout = (error as { stdout?: unknown } | null)?.stdout;
  if (typeof stdout !== "string" || !stdout.trim()) return false;
  try { return object(JSON.parse(stdout))?.success === false; } catch { return false; }
}

function browserLaunchFailure(error: unknown): boolean {
  const detail = [
    (error as { stderr?: unknown })?.stderr,
    (error as { stdout?: unknown })?.stdout,
    error instanceof Error ? error.message : String(error),
  ].filter((part): part is string => typeof part === "string").join("\n");
  return /missing x server|\$DISPLAY|devtoolsactiveport|chrome exited|could not launch|failed to launch|browser launch failed/iu.test(detail);
}

/** Project only the viewer protocol. Never relay engine commands, results or console output. */
export function normalizeBrowserLiveMessage(value: unknown): ObjectValue | null {
  const message = object(value);
  if (!message) return null;
  if (message.type === "error") return { type: "error", retryable: true, message: "The browser stream was interrupted." };
  if (message.type === "url") return { type: "url", url: displayUrl(message.url) };
  if (message.type === "tabs" && Array.isArray(message.tabs) && message.tabs.length <= 100) {
    return { type: "tabs", tabs: message.tabs.flatMap((value) => {
      const tab = object(value);
      if (!tab || typeof tab.tabId !== "string" || !/^t[1-9]\d{0,8}$/.test(tab.tabId)) return [];
      return [{ tabId: tab.tabId, title: text(tab.title, 512) ? tab.title : "", url: displayUrl(tab.url), active: tab.active === true }];
    }) };
  }
  if (message.type === "status" && typeof message.connected === "boolean") {
    return { type: "status", connected: message.connected, screencasting: message.screencasting === true,
      viewportWidth: integer(message.viewportWidth, 1, 8192) ? message.viewportWidth : 1280,
      viewportHeight: integer(message.viewportHeight, 1, 8192) ? message.viewportHeight : 720 };
  }
  if (message.type !== "frame" || !integer(message.seq, 1, Number.MAX_SAFE_INTEGER)
      || !text(message.data, MAX_FRAME) || !/^(?:\/9j\/|iVBORw0KGgo)/.test(message.data)
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)) return null;
  const meta = object(message.metadata);
  if (!meta || !integer(meta.deviceWidth, 1, 8192) || !integer(meta.deviceHeight, 1, 8192)
      || meta.deviceWidth * meta.deviceHeight > 16_777_216) return null;
  return { type: "frame", seq: message.seq, data: message.data, format: message.data.startsWith("/9j/") ? "jpeg" : "png",
    metadata: { deviceWidth: meta.deviceWidth, deviceHeight: meta.deviceHeight,
      offsetTop: number(meta.offsetTop, 0, 8192) ? meta.offsetTop : 0,
      pageScaleFactor: number(meta.pageScaleFactor, 0.01, 100) ? meta.pageScaleFactor : 1,
      scrollOffsetX: number(meta.scrollOffsetX, -1e8, 1e8) ? meta.scrollOffsetX : 0,
      scrollOffsetY: number(meta.scrollOffsetY, -1e8, 1e8) ? meta.scrollOffsetY : 0,
      timestamp: number(meta.timestamp, 0, Number.MAX_SAFE_INTEGER) ? meta.timestamp : 0 } };
}

export function browserStreamPort(value: unknown): number {
  const data = object(value);
  if (!data || data.enabled !== true || !integer(data.port, 1, 65535)) {
    throw new BrowserLiveError("The browser did not provide a valid local stream. Update or reinstall the browser engine.", 503);
  }
  return data.port;
}

/** A restart closes the tabs of every bot on the profile, so a busy one blocks it, unless the browser no longer answers it anyway
 * or the bot is waiting on the person in this browser (an open sign-in card). */
export function browserRestartRefusal(interrupted: boolean, busyBots: ReadonlyArray<{ waitingOnBrowser: boolean }>): string | null {
  return !interrupted && busyBots.some((bot) => !bot.waitingOnBrowser) ? "Stop every bot using this profile before restarting its browser." : null;
}

type Action = { type: "take" | "release" | "restart" } | { type: "ack"; seq: number }
  | { type: "command"; args: string[] } | { type: "input"; message: ObjectValue } | { type: "inputs"; messages: ObjectValue[] }
  | { type: "dialog"; accept: boolean; promptText?: string }
  /** The panel's size in CSS pixels, which the page fills; null for a collapsed panel, which leaves the page as it is. */
  | { type: "resize"; size: PageSize | null };

/** A move the next one replaces changes nothing the page keeps. */
function withoutReplacedMoves(messages: ObjectValue[]): ObjectValue[] {
  return messages.filter((message, at) => {
    const next = messages[at + 1];
    return !(message.eventType === "mouseMoved" && next?.eventType === "mouseMoved" && next.button === message.button && next.modifiers === message.modifiers);
  });
}

/** HTTP bodies can select a fixed action, never a CLI command, flag, port or CDP method. */
export function parseBrowserLiveAction(value: unknown): Action {
  const body = object(value);
  const invalid = () => new BrowserLiveError("Invalid browser action.");
  if (!body) throw invalid();
  if (body.type === "take" || body.type === "release" || body.type === "restart") return { type: body.type };
  if (body.type === "ack" && integer(body.seq, 1, Number.MAX_SAFE_INTEGER)) return { type: "ack", seq: body.seq };
  if (body.type === "resize") {
    if (!number(body.width, 0, 100_000) || !number(body.height, 0, 100_000)) throw invalid();
    return { type: "resize", size: requestedSize(body.width, body.height) };
  }
  if (body.type === "dialog") {
    if (typeof body.accept !== "boolean" || (body.promptText !== undefined && !text(body.promptText, 4096))) throw invalid();
    return { type: "dialog", accept: body.accept, ...(body.promptText === undefined ? {} : { promptText: body.promptText }) };
  }
  if (body.type === "input_batch") {
    if (!Array.isArray(body.events) || !body.events.length || body.events.length > INPUT_BATCH_LIMIT) throw invalid();
    const messages = body.events.map((event: unknown) => {
      const parsed = parseBrowserLiveAction(event);
      if (parsed.type !== "input") throw invalid();
      return parsed.message;
    });
    return { type: "inputs", messages: withoutReplacedMoves(messages) };
  }
  if (body.type === "back" || body.type === "forward" || body.type === "reload") return { type: "command", args: [body.type] };
  if (body.type === "navigate" || body.type === "tab-new") {
    if (body.type === "tab-new" && body.url === undefined) return { type: "command", args: ["tab", "new"] };
    // eslint-disable-next-line no-control-regex -- Reject control characters before URL parsing normalizes them.
    if (!text(body.url, 8192) || !body.url || /[\u0000-\u0020\u007f\\]/u.test(body.url)) throw invalid();
    let url: URL;
    try { url = new URL(body.url); } catch { throw invalid(); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw invalid();
    return { type: "command", args: body.type === "navigate" ? ["open", url.href] : ["tab", "new", url.href] };
  }
  if (body.type === "tab-select" || body.type === "tab-close") {
    if (typeof body.tabId !== "string" || !/^t[1-9]\d{0,8}$/.test(body.tabId)) throw invalid();
    return { type: "command", args: body.type === "tab-select" ? ["tab", body.tabId] : ["tab", "close", body.tabId] };
  }
  if (body.type === "input_mouse") {
    if (!["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"].includes(String(body.eventType))
        || !number(body.x, 0, 8192) || !number(body.y, 0, 8192)) throw invalid();
    const button = body.button ?? "none";
    const clickCount = body.clickCount ?? 0, modifiers = body.modifiers ?? 0;
    const deltaX = body.deltaX ?? 0, deltaY = body.deltaY ?? 0;
    if (!["none", "left", "middle", "right"].includes(String(button)) || !integer(clickCount, 0, 3)
        || !integer(modifiers, 0, 15) || !number(deltaX, -10000, 10000) || !number(deltaY, -10000, 10000)) throw invalid();
    return { type: "input", message: { type: "input_mouse", eventType: body.eventType, x: body.x, y: body.y, button, clickCount, modifiers, deltaX, deltaY } };
  }
  if (body.type === "input_keyboard") {
    if (body.eventType === "char") {
      if (!text(body.text, 4096) || !body.text) throw invalid();
      return { type: "input", message: { type: "input_keyboard", eventType: "char", text: body.text } };
    }
    if (!["keyDown", "keyUp"].includes(String(body.eventType)) || !text(body.key, 64) || !body.key) throw invalid();
    const modifiers = body.modifiers ?? 0, keyCode = body.windowsVirtualKeyCode ?? 0;
    if (!integer(modifiers, 0, 15) || !integer(keyCode, 0, 255)
        || (body.code !== undefined && !text(body.code, 64)) || (body.text !== undefined && !text(body.text, 4096))) throw invalid();
    return { type: "input", message: { type: "input_keyboard", eventType: body.eventType, key: body.key,
      modifiers, windowsVirtualKeyCode: keyCode, ...(body.code === undefined ? {} : { code: body.code }), ...(body.text === undefined ? {} : { text: body.text }) } };
  }
  throw invalid();
}

interface OpenOptions {
  botId: string;
  session: string;
  spec: { command: string; args?: readonly string[]; env?: NodeJS.ProcessEnv };
  /** The session the view was opened with, or local-owner. */
  owner: string;
  /** The person watching: whose hold this view shares. Their account's key; the owner when there is none. */
  person?: string;
  isCurrent: () => boolean;
  res: ServerResponse;
  /** The id of the view this panel had before its stream dropped: that view, if the server still has it open, is replaced. */
  resume?: string | null;
  /** The panel's size in CSS pixels, which the page fills from the start. */
  size?: PageSize | null;
}
interface Viewer extends OpenOptions {
  id: string;
  person: string;
  socket?: WebSocket;
  closed: boolean;
  blocked: boolean;
  heartbeat?: NodeJS.Timeout;
  drainTimer?: NodeJS.Timeout;
  /** A frame upstream still waits on: acknowledged once the view has fewer than FRAME_WINDOW frames on their way. */
  frameSeq?: number;
  /** Frames sent to the view that it has not acknowledged yet, by sequence, with when each was sent. */
  unacked: Map<number, number>;
  hiddenFrame?: ObjectValue;
  pendingFrame?: ObjectValue;
  pendingActions: number;
  /** Raw keys down in the page, by code (or key) to the key name a key-up needs. */
  pressedKeys: Map<string, string>;
  pressedButtons: Set<string>;
  pointer: { x: number; y: number };
  port?: number;
  restarting: boolean;
  waiting: boolean;
  abort: AbortController;
  unwatch: () => void;
  /** Set once its stream dropped: runs when its last in-flight action has finished. */
  idle?: () => void;
  /** The panel size this view asked for last, and when, among all views. */
  requested?: PageSize & { order: number };
}
/** The view a person's hold was used from, gone with its stream dropped. Its late hand-back still counts, and the view of
 * theirs that carries on with the hold waits until what it pressed is let go. */
interface Left {
  viewer: Viewer;
  /** Resolves once its in-flight input finished and the keys and buttons it held are let go. */
  settled: Promise<void>;
  done: boolean;
}

/** How a view reaches its browser's DevTools, to watch the page's own dialogs: without it, they are not watched. */
export interface BrowserLiveDevTools {
  /** The browser's DevTools address, from its daemon's stream port. */
  url(port: number): Promise<unknown>;
  connect?: (url: string, timeoutMs: number, listeners: CdpListeners) => Promise<Cdp>;
}

export class BrowserLive {
  private readonly runtime: BrowserRuntime;
  private readonly viewers = new Map<string, Viewer>();
  /** By browser session: the person's view their hold is used from. Their other views watch it; any may take it over. */
  private readonly drivers = new Map<string, string>();
  private readonly left = new Map<string, Left>();
  private readonly clocks = new Map<string, HoldClock>();
  private readonly holdLimits: HoldLimits;
  private readonly sessionResets = new Map<string, Promise<boolean>>();
  /** Each watched browser's page dialogs, and the views that watch them. */
  private readonly dialogs = new Map<string, { watch: DialogWatch; views: Set<string> }>();
  private readonly devTools?: BrowserLiveDevTools;
  private order = 0;
  constructor({ runtime, devTools, holdLimits = HOLD_LIMITS }: { runtime: BrowserRuntime; devTools?: BrowserLiveDevTools; holdLimits?: HoldLimits }) {
    this.runtime = runtime;
    this.devTools = devTools;
    this.holdLimits = holdLimits;
    runtime.onIdleClose((session) => this.asleep(session));
  }

  private current(viewer: Viewer): boolean {
    try { return !viewer.closed && !viewer.res.destroyed && !viewer.res.writableEnded && viewer.isCurrent(); } catch { return false; }
  }

  private send(viewer: Viewer, message: ObjectValue): void {
    if (!this.current(viewer)) { this.close(viewer, true, true); return; }
    if (!viewer.res.headersSent) return;
    if (viewer.waiting && message.type !== "waiting" && message.type !== "error") return;
    if (viewer.res.writableLength > MAX_BUFFER) { this.close(viewer, true, true); return; }
    if (viewer.blocked) return;
    const { type, ...data } = message;
    let written: boolean;
    try { written = viewer.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch { this.close(viewer, true, true); return; }
    if (!written) {
      viewer.blocked = true;
      viewer.drainTimer = setTimeout(() => this.close(viewer, true, true), HEARTBEAT_MS);
      viewer.drainTimer.unref();
      viewer.res.once("drain", () => {
        viewer.blocked = false; clearTimeout(viewer.drainTimer);
        this.control(viewer.session);
        const pending = viewer.pendingFrame; viewer.pendingFrame = undefined;
        if (pending) this.frame(viewer, pending);
      });
    }
  }

  /** Every view hears who holds the browser: `owned` when its person does, from this view or another of theirs, and
   * `controlling` when it is the view their hold is used from and their input runs now. */
  private control(session: string): void {
    const holder = this.runtime.heldBy(session) ?? null;
    // A hold that ended, whichever way, leaves nothing behind for the next one.
    if (holder === null) this.forgetHold(session);
    for (const viewer of this.viewers.values()) {
      if (viewer.session !== session) continue;
      const hidden = holder !== null && holder !== viewer.person;
      if (hidden && (viewer.frameSeq || viewer.unacked.size)) {
        viewer.unacked.clear();
        try { this.release(viewer); } catch { this.close(viewer); continue; }
      }
      if (hidden && viewer.pendingFrame) {
        const pending = viewer.pendingFrame; viewer.pendingFrame = undefined;
        this.frame(viewer, pending);
      }
      // Like its frames, the page's question is withheld from views while another person holds the browser.
      const dialog = hidden ? null : this.dialogs.get(session)?.watch.dialog ?? null;
      this.send(viewer, { type: "control", held: holder !== null, owned: holder !== null && !hidden, controlling: this.controlling(viewer), ...(dialog ? { dialog } : {}) });
      if (!hidden && viewer.hiddenFrame) {
        const frame = viewer.hiddenFrame; viewer.hiddenFrame = undefined;
        this.frame(viewer, frame);
      }
    }
  }

  private frame(viewer: Viewer, frame: ObjectValue): void {
    if (!this.current(viewer)) { this.close(viewer, true, true); return; }
    const holder = this.runtime.heldBy(viewer.session);
    if (holder && holder !== viewer.person) {
      viewer.hiddenFrame = frame;
      try { this.sendSocket(viewer, { type: "ack", seq: frame.seq }); } catch { this.close(viewer); }
      return;
    }
    // ACKs can arrive before the SSE transport drains: keep the newest frame rather than wait for an ACK the viewer cannot send.
    if (viewer.blocked) { viewer.pendingFrame = frame; return; }
    viewer.pendingFrame = undefined;
    viewer.unacked.set(frame.seq as number, Date.now());
    viewer.frameSeq = frame.seq as number;
    this.send(viewer, frame);
    if (viewer.closed) return;
    try { this.release(viewer); } catch { this.close(viewer); }
  }

  /** Lets upstream send its next frame while the view has room for it. */
  private release(viewer: Viewer): void {
    if (viewer.frameSeq === undefined || viewer.unacked.size >= FRAME_WINDOW) return;
    this.sendSocket(viewer, { type: "ack", seq: viewer.frameSeq });
    viewer.frameSeq = undefined;
  }

  /** The view rendered `seq`, and every frame sent before it. */
  private rendered(viewer: Viewer, seq: number): void {
    if (!viewer.unacked.has(seq)) return;
    for (const sent of viewer.unacked.keys()) {
      viewer.unacked.delete(sent);
      if (sent === seq) break;
    }
    this.release(viewer);
  }

  private sendSocket(viewer: Viewer, message: ObjectValue): void {
    if (viewer.socket?.readyState !== WebSocket.OPEN || viewer.socket.bufferedAmount > 64 * 1024) {
      throw new BrowserLiveError("The browser connection closed. Reopen the browser panel.", 409);
    }
    viewer.socket.send(JSON.stringify(message));
  }

  /** `dropped`: the person's stream was lost, not closed on purpose, so a hold they have waits for their panel to reconnect. */
  private close(viewer: Viewer, endResponse = true, dropped = false): void {
    if (viewer.closed) return;
    viewer.closed = true;
    viewer.abort.abort();
    viewer.unwatch();
    this.viewers.delete(viewer.id);
    if (viewer.requested) this.fit(viewer.session);
    clearTimeout(viewer.heartbeat); clearTimeout(viewer.drainTimer);
    viewer.socket?.close();
    viewer.hiddenFrame = undefined; viewer.pendingFrame = undefined; viewer.unacked.clear();
    this.unwatchDialogs(viewer);
    if (!viewer.restarting) this.leave(viewer, dropped);
    if (endResponse && !viewer.res.writableEnded && !viewer.res.destroyed) {
      if (viewer.blocked || viewer.res.writableLength > MAX_BUFFER) viewer.res.destroy();
      else viewer.res.end();
    }
    this.control(viewer.session);
  }

  /** The page fills the panel of the view that asked last, once the bot's running call ends; with no view left, the bot's next call gives it the standard size. */
  private fit(session: string, fresh = false): void {
    const latest = [...this.viewers.values()].filter((viewer) => viewer.session === session && viewer.requested)
      .sort((a, b) => b.requested!.order - a.requested!.order)[0]?.requested;
    void this.runtime.pageSizes.resize(session, latest ? { width: latest.width, height: latest.height } : null, fresh).catch(() => undefined);
  }

  /** Its person holds the browser, from this view or another of theirs. */
  private ownedBy(viewer: Viewer): boolean {
    return this.runtime.heldBy(viewer.session) === viewer.person;
  }

  /** It is the view its person's hold is used from, and their input runs now. */
  private controlling(viewer: Viewer): boolean {
    return this.drivers.get(viewer.session) === viewer.id && this.runtime.canControl(viewer.session, viewer.person);
  }

  private viewsOf(session: string, person: string): Viewer[] {
    return [...this.viewers.values()].filter((viewer) => viewer.session === session && viewer.person === person);
  }

  private clock(session: string): HoldClock {
    let clock = this.clocks.get(session);
    if (!clock) {
      clock = new HoldClock(() => {
        const person = this.runtime.heldBy(session);
        if (person) this.end(session, person);
      }, this.holdLimits);
      this.clocks.set(session, clock);
    }
    return clock;
  }

  /**
   * A view of the person holding the browser went. What it pressed is let go once its input on the way has run. If its
   * stream dropped while it was still theirs, the hold carries on in their other views, or waits the grace for their next
   * one. A view closed on purpose, or no longer theirs (signed out, switched away), ends a hold no view of theirs has.
   */
  private leave(viewer: Viewer, dropped: boolean): void {
    const session = viewer.session;
    const used = this.drivers.get(session) === viewer.id;
    if (used) this.drivers.delete(session);
    if (!this.ownedBy(viewer)) return;
    const open = this.viewsOf(session, viewer.person).length > 0;
    let theirs = false;
    try { theirs = dropped && viewer.isCurrent(); } catch {}
    if (!theirs) {
      this.abandonPressedInput(viewer);
      if (!open) this.end(session, viewer.person);
      return;
    }
    let finish!: () => void;
    const left: Left = { viewer, settled: new Promise<void>((resolve) => { finish = resolve; }), done: false };
    if (used) this.left.set(session, left);
    viewer.idle = () => {
      viewer.idle = undefined;
      void this.releaseHeld(viewer).finally(() => { left.done = true; finish(); });
    };
    if (viewer.pendingActions === 0) viewer.idle();
    this.clock(session).watched(open);
  }

  /** The person's hold ends as a hand-back does, once what their view that dropped pressed is let go. */
  private end(session: string, person: string): void {
    const left = this.left.get(session);
    const finish = () => {
      if (this.runtime.heldBy(session) !== person) return;
      for (const viewer of this.viewsOf(session, person)) this.abandonPressedInput(viewer);
      this.runtime.release(session, person);
      this.control(session);
    };
    if (left && !left.done) void left.settled.then(finish); else finish();
  }

  private forgetHold(session: string): void {
    this.drivers.delete(session);
    this.left.delete(session);
    this.clocks.get(session)?.stop();
  }

  /** Its person holds the browser and none of their views uses it: this one carries on with their hold, but never before
   * what the view they used pressed is let go, nor replays that view's input. */
  private async carryOn(viewer: Viewer): Promise<void> {
    const session = viewer.session;
    const free = () => this.ownedBy(viewer) && !this.viewers.has(this.drivers.get(session) ?? "");
    if (!free()) return;
    await this.left.get(session)?.settled;
    if (!this.current(viewer) || !free()) return;
    this.drivers.set(session, viewer.id);
    this.left.delete(session);
  }

  /** Lets go in the page of keys and buttons a dropped view still held, as the panel does when its window loses focus.
   * Only a release the browser does not confirm keeps the restart barrier. */
  private async releaseHeld(viewer: Viewer): Promise<void> {
    if (!viewer.pressedKeys.size && !viewer.pressedButtons.size) return;
    const port = viewer.port;
    if (!port || !this.runtime.canControl(viewer.session, viewer.person)) { this.abandonPressedInput(viewer); return; }
    await this.runtime.withHumanAction(viewer.session, viewer.person, async () => {
      const unconfirmed = () => new BrowserInputUnconfirmedError();
      for (const [code, key] of viewer.pressedKeys) {
        if (!await this.sendInput(viewer, port, { action: "input_keyboard", type: "keyUp", key, ...(code === key ? {} : { code }) }, true)) throw unconfirmed();
        viewer.pressedKeys.delete(code);
      }
      for (const button of viewer.pressedButtons) {
        const release = { action: "input_mouse", type: "mouseReleased", ...viewer.pointer, button, clickCount: 1, modifiers: 0, deltaX: 0, deltaY: 0 };
        if (!await this.sendInput(viewer, port, release, true)) throw unconfirmed();
        viewer.pressedButtons.delete(button);
      }
    }).catch(() => undefined);
  }

  private abandonPressedInput(viewer: Viewer): void {
    // A disconnect may lose the matching key-up/mouse-up; an agent must never inherit held input.
    if (viewer.pressedKeys.size || viewer.pressedButtons.size) this.runtime.abandonHumanInput(viewer.session, viewer.person);
  }

  private async command(viewer: Viewer, args: string[], timeout = COMMAND_TIMEOUT_MS, person = false): Promise<ObjectValue> {
    if (!this.current(viewer)) throw new BrowserLiveError("This browser view is no longer available.", 409);
    const env = browserRuntimeEnv({ ...viewer.spec.env, AGENT_BROWSER_SESSION: viewer.session });
    try {
      const { stdout } = await execute(viewer.spec.command, [...args, "--json", "--no-webmcp"], {
        env, timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true,
        signal: viewer.abort.signal,
      });
      if (!this.current(viewer)) throw new Error("stale viewer");
      const result = object(JSON.parse(stdout));
      const data = object(result?.data);
      if (result?.success !== true || !data) {
        // The engine's own error stays internal (logged, never sent).
        const detail = [result?.error, result?.message].filter((part): part is string => typeof part === "string").join(" ");
        throw Object.assign(new Error(detail ? `browser command failed: ${detail}` : "browser command failed"), { stdout });
      }
      return data;
    } catch (error) {
      if (timedOut(error)) throw new BrowserBusyError();
      console.warn("browser-live:", error);
      if (browserLaunchFailure(error)) {
        // A daemon holding a launch config Chrome cannot satisfy here (headed, no display) fails every command until killed, so discard the session once.
        this.resetSession(viewer, "a failed browser launch");
        throw new BrowserLiveError("The browser could not start on this server. Reconnect to retry with a fresh browser session.", 503);
      }
      if (person && engineAnsweredFailure(error)) throw new BrowserActionFailedError(args);
      throw new BrowserLiveError("The browser could not complete this action. Check that the browser engine is installed, then reconnect.", 503);
    }
  }

  /** Discards the session's daemon once; connecting waits for it, then starts a fresh one. */
  private resetSession(viewer: Viewer, why: string): void {
    if (this.sessionResets.has(viewer.session)) return;
    const env = browserRuntimeEnv({ ...viewer.spec.env, AGENT_BROWSER_SESSION: viewer.session });
    const reset = closeBrowserSession(viewer.spec.command, env).then((closed) => {
      if (closed) console.warn(`browser-live: reset ${viewer.session} after ${why}; reconnecting starts a fresh session`);
      else console.warn(`browser-live: reset of ${viewer.session} after ${why} did not finish; the next command retries it`);
      return closed;
    }, () => false);
    this.sessionResets.set(viewer.session, reset);
    void reset.finally(() => { if (this.sessionResets.get(viewer.session) === reset) this.sessionResets.delete(viewer.session); });
  }

  private async connect(viewer: Viewer): Promise<number> {
    // Wait out a reset or idle close in progress, so the probe meets a fresh daemon; checked on every attempt.
    const resetting = this.sessionResets.get(viewer.session);
    if (resetting) await resetting;
    await this.runtime.settled(viewer.session);
    await this.runtime.launchReady(viewer.spec).catch((error: unknown) => {
      throw new BrowserLiveError(error instanceof Error ? error.message : "The browser is not ready yet.", 503);
    });
    let status: ObjectValue;
    try { status = await this.command(viewer, ["stream", "status"], STATUS_PROBE_MS); }
    catch (error) {
      // Only a bot call or a person's action can hold the engine past this read; with neither, it has hung.
      if (!(error instanceof BrowserBusyError) || this.runtime.working(viewer.session)) throw error;
      this.resetSession(viewer, "a status read the browser never answered");
      throw new BrowserUnresponsiveError();
    }
    if (status.enabled !== true) {
      try { status = await this.command(viewer, ["stream", "enable"]); }
      catch (error) {
        if (error instanceof BrowserBusyError) throw error;
        status = await this.command(viewer, ["stream", "status"]);
      }
    }
    const port = browserStreamPort(status);
    // `open` without a URL is an idempotent launch, never navigation away from the bot's page.
    if (status.connected !== true) await this.command(viewer, ["open"]);
    await this.runtime.launched(viewer.session, viewer.spec);
    return port;
  }

  private async connectWhenFree(viewer: Viewer): Promise<number> {
    const deadline = Date.now() + BUSY_LIMIT_MS;
    for (let attempt = 0; ; attempt++) {
      try { return await this.connect(viewer); }
      catch (error) {
        if (!(error instanceof BrowserBusyError) || !this.current(viewer)) throw error;
        if (Date.now() >= deadline) throw new BrowserBusyError("The bot is still using this browser. Reconnect when it has finished.");
      }
      viewer.waiting = true;
      this.startEvents(viewer);
      this.send(viewer, BROWSER_WAITING);
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); viewer.abort.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, BUSY_RETRY_MS[Math.min(attempt, BUSY_RETRY_MS.length - 1)]);
        timer.unref?.();
        viewer.abort.signal.addEventListener("abort", done, { once: true });
      });
      if (!this.current(viewer)) throw new BrowserLiveError("This browser view is no longer available.", 409);
    }
  }

  private startEvents(viewer: Viewer): void {
    if (viewer.res.headersSent) return;
    viewer.res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
    viewer.res.flushHeaders();
  }

  private async input(viewer: Viewer, message: ObjectValue): Promise<void> {
    if (!viewer.port) throw new BrowserLiveError("The browser stream is not connected.", 409);
    let command: ObjectValue;
    const { type, eventType, ...fields } = message;
    const key = String(fields.code || fields.key);
    const shortcut = Number(fields.modifiers) > 0 && !["Alt", "Control", "Meta", "Shift"].includes(String(fields.key))
      && !(fields.modifiers === 8 && text(fields.key, 64) && [...fields.key].length === 1);
    // press already released the key: match raw held keys, not keyUp modifiers, which may have changed or be zero after blur.
    if (type === "input_keyboard" && eventType === "keyUp" && !viewer.pressedKeys.has(key)) return;
    if (type === "input_mouse") command = { action: "input_mouse", type: eventType, ...fields };
    else if (eventType === "char") command = { action: "keyboard", subaction: "insertText", text: fields.text };
    else if (eventType === "keyDown" && (shortcut || DISCRETE_KEYS.has(String(fields.key)))) {
      // press resolves virtual key codes, text and modifiers, and acknowledges the whole key-down/up pair before hand-back.
      const modifiers = fields.modifiers as number;
      const chord = [[1, "Alt"], [2, "Control"], [4, "Meta"], [8, "Shift"]] as const;
      command = { action: "press", key: [...chord.filter(([bit]) => modifiers & bit).map(([, key]) => key), fields.key].join("+") };
    } else command = { action: "input_keyboard", type: eventType, key: fields.key,
      ...(fields.code === undefined ? {} : { code: fields.code }), ...(fields.text === undefined ? {} : { text: fields.text }) };
    if (command.action === "input_keyboard" && eventType === "keyDown") {
      if (viewer.pressedKeys.size >= 64 && !viewer.pressedKeys.has(key)) throw new BrowserLiveError("Too many keys are held. Restart the browser before continuing.", 409);
      viewer.pressedKeys.set(key, String(fields.key));
    }
    if (type === "input_mouse") viewer.pointer = { x: fields.x as number, y: fields.y as number };
    if (type === "input_mouse" && eventType === "mousePressed") viewer.pressedButtons.add(String(fields.button));
    const releases = (command.action === "input_keyboard" && eventType === "keyUp") || (type === "input_mouse" && eventType === "mouseReleased");
    let confirmed: boolean;
    try { confirmed = await this.sendInput(viewer, viewer.port, command, releases); }
    catch (error) {
      if (error instanceof BrowserInputRefusedError) {
        if (command.action === "input_keyboard" && eventType === "keyDown") viewer.pressedKeys.delete(key);
        if (type === "input_mouse" && eventType === "mousePressed") viewer.pressedButtons.delete(String(fields.button));
      }
      throw error;
    }
    if (!confirmed) throw new BrowserInputUnconfirmedError();
    if (command.action === "press" || (command.action === "input_keyboard" && eventType === "keyUp")) viewer.pressedKeys.delete(key);
    if (type === "input_mouse" && eventType === "mouseReleased") viewer.pressedButtons.delete(String(fields.button));
  }

  /** The relay awaits the daemon's CDP reply; a WS send is only an enqueue and cannot serve as the hand-back barrier. A single CDP
   * event the daemon refused had no effect, and a release may repeat, so each is sent once more; a press is two events. Chrome
   * holds an input that opened the page's own question until it is answered, then delivers it. */
  private async sendInput(viewer: Viewer, port: number, command: ObjectValue, releases: boolean): Promise<boolean> {
    const send = () => relay(port, command, INPUT_RELAY).then((answer) => answer.success);
    const watch = this.dialogs.get(viewer.session)?.watch;
    const before = watch?.opened ?? 0;
    const asked = () => !!watch && (watch.dialog !== null || watch.opened !== before);
    const answered = async () => { await watch!.settled(viewer.abort.signal); return !viewer.abort.signal.aborted; };
    try {
      if (await send()) return true;
      if (asked()) return await answered();
      if (command.action !== "press" && await send()) return true;
    } catch {
      if (asked()) return await answered();
      if (!await this.ended(port)) return false;
      if (!releases) throw new BrowserSlowActionError();
      return send().catch(() => false);
    }
    // A press is a key-down and key-up in one command: refused, its key may still be down.
    if (releases || command.action === "press") return false;
    throw new BrowserInputRefusedError();
  }

  private async watchDialogs(viewer: Viewer): Promise<void> {
    if (!this.devTools || !viewer.port || attachesToChrome(viewer.spec.env ?? {})) return;
    const devTools = this.devTools;
    const port = viewer.port;
    const join = () => {
      const entry = this.dialogs.get(viewer.session);
      if (!entry || entry.watch.closed) return false;
      if (this.current(viewer)) entry.views.add(viewer.id);
      return true;
    };
    if (join()) return;
    const url = localDevToolsUrl(await devTools.url(port).catch(() => null));
    if (join() || !url || !this.current(viewer)) return;
    const session = viewer.session;
    const watch = new DialogWatch(() => this.control(session));
    this.dialogs.set(session, { watch, views: new Set([viewer.id]) });
    await watch.start(url, devTools.connect).catch(() => watch.close());
  }

  private unwatchDialogs(viewer: Viewer): void {
    const entry = this.dialogs.get(viewer.session);
    if (!entry?.views.delete(viewer.id) || entry.views.size) return;
    entry.watch.close();
    this.dialogs.delete(viewer.session);
  }

  /** The person's browser stopped answering an input: restarted for them, on the same profile, and every view reconnects. */
  private async restartUnresponsive(viewer: Viewer): Promise<boolean> {
    if (viewer.restarting) return false;
    viewer.restarting = true;
    try {
      await this.runtime.restart(viewer.session, viewer.person, async () => {
        const env = browserRuntimeEnv({ ...viewer.spec.env, AGENT_BROWSER_SESSION: viewer.session });
        if (!await closeBrowserSession(viewer.spec.command, env)) throw new Error("browser close failed");
      });
      const note = { type: "error", retryable: true, message: restartedNote(viewer.spec.env?.AGENT_BROWSER_RESTORE_SAVE !== "never") };
      for (const other of this.viewers.values()) if (other.session === viewer.session) this.send(other, note);
      this.closeForSession(viewer.session);
      return true;
    } catch { return false; }
    finally { viewer.restarting = false; if (viewer.closed) this.runtime.release(viewer.session, viewer.person); this.control(viewer.session); }
  }

  /** The daemon runs one command per session at a time, so an answer to a read sent after an unanswered command proves it ended. */
  private ended(port: number): Promise<boolean> {
    return relay(port, { action: "stream_status" }, ENDED_PROBE).then((answer) => answer.success, () => false);
  }

  async open(options: OpenOptions): Promise<void> {
    // The view this panel had before its stream dropped, if the server still has it open, never comes back.
    const replaced = options.resume ? this.viewers.get(options.resume) : undefined;
    if (replaced && replaced.owner === options.owner && replaced.botId === options.botId) this.close(replaced, true, true);
    if (this.viewers.size >= 8 || [...this.viewers.values()].filter((v) => v.session === options.session).length >= 2) {
      throw new BrowserLiveError("Too many browser views are open. Close another browser panel first.", 429);
    }
    const viewer: Viewer = { ...options, id: randomUUID(), person: options.person ?? options.owner, closed: false, blocked: false, pendingActions: 0, restarting: false, pressedKeys: new Map(), pressedButtons: new Set(), pointer: { x: 0, y: 0 }, unacked: new Map(), waiting: false, abort: new AbortController(), unwatch: () => {} };
    if (!this.current(viewer)) throw new BrowserLiveError("This browser view is no longer available.", 409);
    // A view that opens while another holds the browser leaves the holder's page as it is.
    if (options.size && !this.runtime.heldBy(options.session)) viewer.requested = { ...options.size, order: ++this.order };
    viewer.unwatch = this.runtime.watch(viewer.session, viewer.spec);
    this.viewers.set(viewer.id, viewer);
    if (this.ownedBy(viewer)) this.clock(viewer.session).watched(true);
    options.res.once("close", () => this.close(viewer, true, true));
    options.res.once("error", () => this.close(viewer, true, true));
    try {
      const port = await this.connectWhenFree(viewer);
      if (!this.current(viewer)) throw new BrowserLiveError("This browser view is no longer available.", 409);
      // Before its frames flow: the person's next view carries on with their hold, after a dropped stream or a reopened app.
      await this.carryOn(viewer);
      if (!this.current(viewer)) throw new BrowserLiveError("This browser view is no longer available.", 409);
      viewer.port = port;
      this.fit(viewer.session, true);
      await this.watchDialogs(viewer);
      if (!this.current(viewer)) throw new BrowserLiveError("This browser view is no longer available.", 409);
      const socket = new WebSocket(`ws://127.0.0.1:${port}/?pacing=ack&maxFps=15`);
      viewer.socket = socket;
      this.startEvents(viewer);
      viewer.waiting = false;
      this.send(viewer, { type: "ready", viewerId: viewer.id, inputBatch: INPUT_BATCH_LIMIT });
      this.control(viewer.session);
      socket.addEventListener("message", (event) => {
        if (!this.current(viewer)) { this.close(viewer, true, true); return; }
        if (typeof event.data !== "string" || event.data.length > MAX_BUFFER) { this.close(viewer); return; }
        let message: ObjectValue | null;
        let raw: ObjectValue | null;
        try { raw = object(JSON.parse(event.data)); message = normalizeBrowserLiveMessage(raw); } catch { this.close(viewer); return; }
        if (!message) { if (raw?.type === "frame") this.close(viewer); return; }
        const heldBy = this.runtime.heldBy(viewer.session);
        if (heldBy && heldBy !== viewer.person && ["tabs", "url"].includes(String(message.type))) return;
        if (message.type === "frame") this.frame(viewer, message);
        else this.send(viewer, message);
      });
      socket.addEventListener("error", () => { if (!viewer.restarting) { this.send(viewer, { type: "error", retryable: true, message: "The browser stream disconnected." }); this.close(viewer); } });
      socket.addEventListener("close", () => { if (!viewer.restarting) this.close(viewer); });
      // Handlers go on before awaiting the upgrade: upstream sends its cached status, tabs and first frame right after opening.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new BrowserLiveError("The browser stream did not connect. Reopen the browser panel.", 503)), 10_000);
        const failed = () => { clearTimeout(timer); reject(new BrowserLiveError("The browser stream did not connect. Reopen the browser panel.", 503)); };
        socket.addEventListener("error", failed, { once: true });
        socket.addEventListener("close", failed, { once: true });
        socket.addEventListener("open", () => { clearTimeout(timer); socket.removeEventListener("error", failed); socket.removeEventListener("close", failed); resolve(); }, { once: true });
      });
      if (!this.current(viewer)) { this.close(viewer); return; }
      viewer.heartbeat = setInterval(() => {
        const oldest = viewer.unacked.values().next().value;
        if (!this.current(viewer) || (oldest !== undefined && Date.now() - oldest > 2 * HEARTBEAT_MS)) { this.close(viewer, true, true); return; }
        this.control(viewer.session);
        this.send(viewer, { type: "heartbeat" });
      }, HEARTBEAT_MS);
      viewer.heartbeat.unref();
    } catch (error) {
      console.warn("browser-live:", error);
      if (error instanceof BrowserUnresponsiveError) this.startEvents(viewer);
      if (options.res.headersSent) {
        const busy = error instanceof BrowserBusyError;
        const explained = busy || error instanceof BrowserUnresponsiveError;
        this.send(viewer, { type: "error", retryable: !busy, message: explained ? error.message : "The browser stream could not start." });
        this.close(viewer); return;
      }
      this.close(viewer, options.res.headersSent);
      throw error instanceof BrowserLiveError ? error : new BrowserLiveError("The browser stream could not start. Reopen the browser panel.", 503);
    }
  }

  async action({ viewerId, botId, owner, body }: { viewerId: string; botId: string; owner: string; body: unknown }): Promise<unknown> {
    const viewer = this.viewers.get(viewerId);
    if (!viewer || viewer.botId !== botId || viewer.owner !== owner || !this.current(viewer)) {
      if (viewer && viewer.botId === botId && viewer.owner === owner) this.close(viewer, true, true);
      // A hand-back sent as its own stream dropped still hands back.
      const left = [...this.left.values()].find((entry) => entry.viewer.id === viewerId);
      if (left && left.viewer.botId === botId && left.viewer.owner === owner && object(body)?.type === "release") {
        this.end(left.viewer.session, left.viewer.person);
        return { ok: true };
      }
      throw new BrowserLiveError("This browser view is no longer available. Reopen the browser panel.", 404);
    }
    const action = parseBrowserLiveAction(body);
    if (action.type === "restart") {
      if (viewer.restarting) throw new BrowserLiveError("The browser is already restarting.", 409);
      viewer.restarting = true;
      try {
        const restarting = this.runtime.restart(viewer.session, viewer.person, async () => {
          if (!this.current(viewer)) throw new Error("stale viewer");
          const env = browserRuntimeEnv({ ...viewer.spec.env, AGENT_BROWSER_SESSION: viewer.session });
          if (!await closeBrowserSession(viewer.spec.command, env)) throw new Error("browser close failed");
        });
        this.control(viewer.session);
        await restarting;
        this.closeForSession(viewer.session);
        return { ok: true };
      } catch { throw new BrowserLiveError("The browser could not restart. Wait for active work to finish and try again.", 409); }
      finally { viewer.restarting = false; if (viewer.closed) this.runtime.release(viewer.session, viewer.person); this.control(viewer.session); }
    }
    if (action.type === "ack") {
      this.rendered(viewer, action.seq);
      return { ok: true };
    }
    if (action.type === "resize") {
      const holder = this.runtime.heldBy(viewer.session);
      if (action.size && (!holder || (holder === viewer.person && this.drivers.get(viewer.session) === viewer.id))) {
        viewer.requested = { ...action.size, order: ++this.order };
        this.fit(viewer.session);
      }
      return { ok: true };
    }
    // Any view of the person hands their hold back, whichever of their views it is used from.
    if (action.type === "release") {
      this.end(viewer.session, viewer.person);
      return { ok: true };
    }
    if (action.type === "take") {
      try {
        const taking = this.runtime.take(viewer.session, viewer.person);
        this.control(viewer.session);
        // The bot's own action finished first, so input aimed before the grant may no longer fit the page.
        const waited = await taking;
        // Taken over from another view of theirs: what that view pressed is let go first, and never replayed here.
        const before = this.viewers.get(this.drivers.get(viewer.session) ?? "");
        if (before && before !== viewer) await this.releaseHeld(before);
        await this.left.get(viewer.session)?.settled;
        if (!this.current(viewer)) { this.close(viewer, true, true); throw new BrowserLiveError("This browser view closed.", 409); }
        if (this.ownedBy(viewer)) {
          this.drivers.set(viewer.session, viewer.id);
          this.left.delete(viewer.session);
          this.clock(viewer.session).used();
          this.clock(viewer.session).watched(true);
        }
        return { ok: true, waited: waited === true };
      } catch { throw this.refusal(viewer, "Another browser view or bot action is using this browser. Try again shortly."); }
      finally { this.control(viewer.session); }
    }
    if (!this.controlling(viewer)) throw this.refusal(viewer, "Browser control changed. Try again.");
    this.clock(viewer.session).used();
    if (action.type === "dialog") {
      const watch = this.dialogs.get(viewer.session)?.watch;
      if (!watch?.dialog) throw new BrowserLiveError("The page's question is no longer open.", 409);
      if (!await watch.answer(action.accept, action.promptText)) throw new BrowserLiveError("The page did not take that answer. Try again.", 503);
      return { ok: true };
    }
    if (viewer.pendingActions >= 32) throw new BrowserLiveError("Too many browser actions are pending. Try again shortly.", 429);
    viewer.pendingActions += 1;
    let refused = false;
    try {
      await this.runtime.withHumanAction(viewer.session, viewer.person, async () => {
        if (!this.current(viewer)) throw new BrowserLiveError("This browser view closed.", 409);
        const take = async (message: ObjectValue) => {
          try { await this.input(viewer, message); }
          catch (error) { if (!(error instanceof BrowserInputRefusedError)) throw error; refused = true; }
        };
        if (action.type === "input") await take(action.message);
        else if (action.type === "inputs") { for (const message of action.messages) await take(message); }
        else if (action.type === "command") await this.command(viewer, action.args, COMMAND_TIMEOUT_MS, true).catch(async (error: unknown) => {
          throw error instanceof BrowserBusyError && viewer.port && await this.ended(viewer.port) ? new BrowserSlowActionError() : error;
        });
      });
      return refused ? { ok: true, notice: INPUT_REFUSED } : { ok: true };
    } catch (error) {
      if (error instanceof BrowserInputUnconfirmedError && viewer.pendingActions === 1 && await this.restartUnresponsive(viewer)) {
        throw new BrowserLiveError(restartedNote(viewer.spec.env?.AGENT_BROWSER_RESTORE_SAVE !== "never"), 503);
      }
      throw error instanceof BrowserLiveError ? error : this.refusal(viewer, "Browser control changed. Try again.");
    }
    finally {
      viewer.pendingActions -= 1;
      if (viewer.closed && viewer.pendingActions === 0) viewer.idle?.();
      this.control(viewer.session);
    }
  }

  private refusal(viewer: Viewer, otherwise: string): BrowserLiveError {
    const holder = this.runtime.heldBy(viewer.session);
    if (holder && holder !== viewer.person) return new BrowserLiveError(BROWSER_HELD_ELSEWHERE, 409);
    return new BrowserLiveError(this.runtime.interrupted(viewer.session) ? RESTART_NEEDED : otherwise, 409);
  }

  /** Done on a sign-in card, from any window or device: whoever holds this browser hands it back. */
  handBack(session: string): void {
    const person = this.runtime.heldBy(session);
    if (person) this.end(session, person);
  }

  /** Every view of a browser about to close unused stops, while its stream still answers. */
  private asleep(session: string): void {
    for (const viewer of this.viewers.values()) {
      if (viewer.session !== session) continue;
      this.send(viewer, BROWSER_ASLEEP_ERROR);
      this.close(viewer);
    }
  }

  closeForSession(session: string): void { this.closeWhere((viewer) => viewer.session === session); }
  closeForOwner(owner: string): void { this.closeWhere((viewer) => viewer.owner === owner); }
  closeForBot(botId: string): void { this.closeWhere((viewer) => viewer.botId === botId); }
  closeAll(): void { this.closeWhere(() => true); }

  /** Closed on purpose: a hold none of its person's views still has ends now, a dropped view's included. */
  private closeWhere(match: (viewer: Viewer) => boolean): void {
    for (const viewer of this.viewers.values()) if (match(viewer)) this.close(viewer);
    for (const { viewer } of this.left.values()) {
      if (match(viewer) && !this.viewsOf(viewer.session, viewer.person).length) this.end(viewer.session, viewer.person);
    }
  }
}
