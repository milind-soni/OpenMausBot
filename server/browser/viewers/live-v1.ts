// The v1 live view the phone apps and the companion speak (GET …/browser/live as server-sent events, POST
// …/browser/action), served from the new browser. Its events and actions are frozen: the same names, fields and limits
// as the agent-browser engine's, so a phone built against that keeps working unchanged.
import type { ServerResponse } from "node:http";

import { BROWSER_HELD_ELSEWHERE } from "../../../shared/browser-held.ts";
import { BROWSER_ASLEEP_ERROR, BROWSER_WAITING, BrowserLiveError, parseBrowserLiveAction } from "../../browser-live.ts";
import type { BrowserService, BrowserTarget } from "../service.ts";
import type { Viewer, ViewerOutput } from "./core.ts";

const MAX_FRAME = 3 * 1024 * 1024;
const MAX_BUFFER = 4 * 1024 * 1024;
const HEARTBEAT_MS = 10_000;
const VIEWERS_TOTAL = 8;
const VIEWERS_PER_SESSION = 2;
/** The v1 viewer's frames: at most 1280 pixels wide, as before, whatever the screen's scale. */
const LO_TIER = { maxWidth: 1280, maxHeight: 1280, quality: 70 } as const;
/** A start this slow (a first Chrome download) tells the viewer it waits, as a busy browser did. */
const WAITING_AFTER_MS = 5_000;
const RESTART_NEEDED = "A browser action was interrupted. Choose Restart browser… in the browser menu before continuing.";

type ObjectValue = Record<string, unknown>;

export interface LiveOpenOptions {
  botId: string;
  session: string;
  owner: string;
  /** The person watching, whose hold this view shares on any device; the owner when unset. */
  person?: string;
  isCurrent: () => boolean;
  res: ServerResponse;
  /** The panel's size in CSS pixels, which the page fills from the start. */
  size?: { width: number; height: number } | null;
}

interface V1Viewer {
  readonly id: string;
  readonly botId: string;
  readonly session: string;
  readonly owner: string;
  readonly person: string;
  readonly isCurrent: () => boolean;
  readonly res: ServerResponse;
  core: Viewer | null;
  closed: boolean;
  blocked: boolean;
  ready: boolean;
  seq: number;
  /** The frame the client has and has not acknowledged yet. */
  sent: { seq: number; ack: () => void; at: number } | null;
  /** The newest frame waiting for the client to acknowledge the one it has. */
  pending: Extract<ViewerOutput, { type: "frame" }> | null;
  heartbeat?: ReturnType<typeof setInterval>;
  drainTimer?: ReturnType<typeof setTimeout>;
  pendingActions: number;
  restarting: boolean;
}

/** An address a viewer may show: a web page's, never its credentials. */
export function displayUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:", "about:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return "";
  }
}

export class LiveV1 {
  readonly #service: BrowserService;
  readonly #target: (session: string) => BrowserTarget | null;
  readonly #viewers = new Map<string, V1Viewer>();

  constructor({ service, target }: { service: BrowserService; target: (session: string) => BrowserTarget | null }) {
    this.#service = service;
    this.#target = target;
  }

  #current(viewer: V1Viewer): boolean {
    try { return !viewer.closed && !viewer.res.destroyed && !viewer.res.writableEnded && viewer.isCurrent(); } catch { return false; }
  }

  #startEvents(viewer: V1Viewer): void {
    if (viewer.res.headersSent) return;
    viewer.res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
    viewer.res.flushHeaders();
  }

  #send(viewer: V1Viewer, message: ObjectValue): void {
    if (!this.#current(viewer)) { this.#close(viewer); return; }
    if (!viewer.res.headersSent || viewer.blocked) return;
    if (viewer.res.writableLength > MAX_BUFFER) { this.#close(viewer); return; }
    const { type, ...data } = message;
    let written: boolean;
    try { written = viewer.res.write(`event: ${String(type)}\ndata: ${JSON.stringify(data)}\n\n`); } catch { this.#close(viewer); return; }
    if (!written) {
      viewer.blocked = true;
      viewer.drainTimer = setTimeout(() => this.#close(viewer), HEARTBEAT_MS);
      viewer.drainTimer.unref?.();
      viewer.res.once("drain", () => {
        viewer.blocked = false;
        clearTimeout(viewer.drainTimer);
        this.#flushFrame(viewer);
      });
    }
  }

  /** `owned` when the view's person holds the browser, from this view or another of theirs; `controlling` when their hold is used from this one. */
  #control(viewer: V1Viewer): void {
    const state = viewer.core?.controlState();
    if (!state) return;
    this.#send(viewer, { type: "control", held: state.held, owned: state.owned, controlling: state.controlling });
  }

  #controlAll(session: string): void {
    for (const viewer of this.#viewers.values()) if (viewer.session === session) this.#control(viewer);
  }

  /** One frame at the client at a time: a newer one waits, replacing (and releasing) any it supersedes. */
  #frame(viewer: V1Viewer, frame: Extract<ViewerOutput, { type: "frame" }>): void {
    if (!viewer.ready || frame.data.length * 4 / 3 > MAX_FRAME) { frame.ack(); return; }
    if (viewer.pending) viewer.pending.ack();
    viewer.pending = frame;
    this.#flushFrame(viewer);
  }

  #flushFrame(viewer: V1Viewer): void {
    const frame = viewer.pending;
    if (!frame || viewer.sent || viewer.blocked || !this.#current(viewer)) return;
    viewer.pending = null;
    const seq = ++viewer.seq;
    viewer.sent = { seq, ack: frame.ack, at: Date.now() };
    const metadata = frame.metadata;
    this.#send(viewer, {
      type: "frame",
      seq,
      data: frame.data.toString("base64"),
      format: "jpeg",
      metadata: {
        deviceWidth: Math.round(metadata.deviceWidth), deviceHeight: Math.round(metadata.deviceHeight),
        offsetTop: metadata.offsetTop ?? 0, pageScaleFactor: metadata.pageScaleFactor ?? 1,
        scrollOffsetX: metadata.scrollOffsetX ?? 0, scrollOffsetY: metadata.scrollOffsetY ?? 0, timestamp: metadata.timestamp ?? 0,
      },
    });
  }

  #output(viewer: V1Viewer, output: ViewerOutput): void {
    switch (output.type) {
      case "frame":
        this.#frame(viewer, output);
        return;
      case "tabs":
        this.#send(viewer, { type: "tabs", tabs: output.tabs.slice(0, 100).map((tab) => ({ tabId: tab.tabId, title: tab.title.slice(0, 512), url: displayUrl(tab.url), active: tab.active })) });
        return;
      case "url":
        this.#send(viewer, { type: "url", url: displayUrl(output.url) });
        return;
      case "status":
        this.#send(viewer, { type: "status", connected: output.connected, screencasting: output.screencasting, viewportWidth: output.viewportWidth, viewportHeight: output.viewportHeight });
        return;
      case "control":
        this.#control(viewer);
        return;
      case "gone":
        if (!viewer.restarting) {
          this.#send(viewer, { type: "error", retryable: true, message: "The browser stream disconnected." });
          this.#close(viewer);
        }
        return;
      case "asleep":
        this.#send(viewer, BROWSER_ASLEEP_ERROR);
        this.#close(viewer);
        return;
      default:
        return;
    }
  }

  async open(options: LiveOpenOptions): Promise<void> {
    const sessionViewers = [...this.#viewers.values()].filter((viewer) => viewer.session === options.session).length;
    if (this.#viewers.size >= VIEWERS_TOTAL || sessionViewers >= VIEWERS_PER_SESSION) {
      throw new BrowserLiveError("Too many browser views are open. Close another browser panel first.", 429);
    }
    const target = this.#target(options.session);
    if (!target) throw new BrowserLiveError("The browser could not start on this server. Reconnect to retry with a fresh browser session.", 503);
    const viewer: V1Viewer = { ...options, person: options.person ?? options.owner, id: "", core: null, closed: false, blocked: false, ready: false, seq: 0, sent: null, pending: null, pendingActions: 0, restarting: false };
    if (!this.#current(viewer)) throw new BrowserLiveError("This browser view is no longer available.", 409);
    options.res.once("close", () => this.#close(viewer));
    options.res.once("error", () => this.#close(viewer));
    const waiting = setTimeout(() => {
      if (viewer.ready || viewer.closed) return;
      this.#startEvents(viewer);
      this.#send(viewer, BROWSER_WAITING);
    }, WAITING_AFTER_MS);
    waiting.unref?.();
    try {
      const core = await this.#service.attachViewer(target, { owner: options.owner, person: viewer.person, canOperate: true, ...LO_TIER, pace: "lo", pointer: false, ...(options.size ? { size: options.size } : {}) }, (output) => this.#output(viewer, output));
      (viewer as { id: string }).id = core.id;
      viewer.core = core;
      if (!this.#current(viewer)) {
        // It went while the browser started: what it opened goes too.
        if (viewer.closed) void core.close({ dropped: this.#theirs(viewer) }).catch(() => undefined);
        else this.#close(viewer);
        return;
      }
      this.#viewers.set(viewer.id, viewer);
      this.#startEvents(viewer);
      viewer.ready = true;
      clearTimeout(waiting);
      this.#send(viewer, { type: "ready", viewerId: viewer.id });
      this.#controlAll(viewer.session);
      await core.refresh();
      viewer.heartbeat = setInterval(() => {
        if (!this.#current(viewer) || (viewer.sent && Date.now() - viewer.sent.at > 2 * HEARTBEAT_MS)) { this.#close(viewer); return; }
        this.#control(viewer);
        this.#send(viewer, { type: "heartbeat" });
      }, HEARTBEAT_MS);
      viewer.heartbeat.unref?.();
    } catch (error) {
      clearTimeout(waiting);
      console.warn("browser-live:", error);
      if (options.res.headersSent) {
        this.#send(viewer, { type: "error", retryable: true, message: "The browser stream could not start." });
        this.#close(viewer);
        return;
      }
      this.#close(viewer, false);
      throw error instanceof BrowserLiveError ? error : new BrowserLiveError("The browser stream could not start. Reopen the browser panel.", 503);
    }
  }

  /** Still the view of a person allowed to see this browser: its stream went, not its sign-in. */
  #theirs(viewer: V1Viewer): boolean {
    try { return viewer.isCurrent(); } catch { return false; }
  }

  /** `purposeful`: the server closed it; otherwise a hold of its person waits the grace for their next view. */
  #close(viewer: V1Viewer, endResponse = true, purposeful = false): void {
    if (viewer.closed) return;
    viewer.closed = true;
    if (viewer.id) this.#viewers.delete(viewer.id);
    clearInterval(viewer.heartbeat);
    clearTimeout(viewer.drainTimer);
    viewer.pending?.ack();
    viewer.sent?.ack();
    viewer.pending = null;
    viewer.sent = null;
    void viewer.core?.close({ dropped: !purposeful && this.#theirs(viewer) }).catch(() => undefined).then(() => this.#controlAll(viewer.session));
    if (endResponse && !viewer.res.writableEnded && !viewer.res.destroyed) {
      if (viewer.blocked || viewer.res.writableLength > MAX_BUFFER) viewer.res.destroy();
      else viewer.res.end();
    }
  }

  #refusal(viewer: V1Viewer, otherwise: string): BrowserLiveError {
    const holder = this.#service.heldBy(viewer.session);
    if (holder && holder !== viewer.person) return new BrowserLiveError(BROWSER_HELD_ELSEWHERE, 409);
    return new BrowserLiveError(this.#service.interrupted(viewer.session) ? RESTART_NEEDED : otherwise, 409);
  }

  async action({ viewerId, botId, owner, body }: { viewerId: string; botId: string; owner: string; body: unknown }): Promise<unknown> {
    const viewer = this.#viewers.get(viewerId);
    if (!viewer || viewer.botId !== botId || viewer.owner !== owner || !this.#current(viewer) || !viewer.core) {
      if (viewer && viewer.botId === botId && viewer.owner === owner) this.#close(viewer);
      throw new BrowserLiveError("This browser view is no longer available. Reopen the browser panel.", 404);
    }
    const core = viewer.core;
    const action = parseBrowserLiveAction(body);
    if (action.type === "ack") {
      if (viewer.sent?.seq === action.seq) {
        viewer.sent.ack();
        viewer.sent = null;
        this.#flushFrame(viewer);
      }
      return { ok: true };
    }
    if (action.type === "resize") {
      if (action.size) await core.input({ type: "resize", ...action.size });
      return { ok: true };
    }
    if (action.type === "restart") {
      if (viewer.restarting) throw new BrowserLiveError("The browser is already restarting.", 409);
      viewer.restarting = true;
      try {
        await this.#service.restart(viewer.session, viewer.person);
        this.closeForSession(viewer.session);
        return { ok: true };
      } catch {
        throw new BrowserLiveError("The browser could not restart. Wait for active work to finish and try again.", 409);
      } finally {
        viewer.restarting = false;
      }
    }
    if (action.type === "release") {
      await core.input({ type: "releaseControl" });
      this.#controlAll(viewer.session);
      return { ok: true };
    }
    if (action.type === "take") {
      const before = this.#service.heldBy(viewer.session);
      if (before !== null && before !== viewer.person) throw this.#refusal(viewer, "Another browser view or bot action is using this browser. Try again shortly.");
      const busy = this.#service.profiles().find((profile) => profile.session === viewer.session)?.control.agents ?? 0;
      await core.input({ type: "takeControl" });
      this.#controlAll(viewer.session);
      if (!core.controlState().controlling) throw this.#refusal(viewer, "Another browser view or bot action is using this browser. Try again shortly.");
      if (!this.#current(viewer)) { this.#close(viewer); throw new BrowserLiveError("This browser view closed.", 409); }
      return { ok: true, waited: busy > 0 };
    }
    if (!core.controlState().controlling) throw this.#refusal(viewer, "Browser control changed. Try again.");
    if (viewer.pendingActions >= 32) throw new BrowserLiveError("Too many browser actions are pending. Try again shortly.", 429);
    viewer.pendingActions++;
    try {
      if (action.type === "command") await core.input(commandMessage(action.args));
      else if (action.type === "input") await core.input(inputMessage(action.message));
      if (!core.controlState().controlling) throw this.#refusal(viewer, "Browser control changed. Try again.");
      core.pushTabs();
      return { ok: true };
    } finally {
      viewer.pendingActions--;
      this.#controlAll(viewer.session);
    }
  }

  has(viewerId: string): boolean {
    return this.#viewers.has(viewerId);
  }

  handBack(session: string): void {
    void this.#service.handBack(session).then(() => this.#controlAll(session), () => undefined);
  }

  closeForSession(session: string): void { for (const viewer of this.#viewers.values()) if (viewer.session === session) this.#close(viewer, true, true); }
  closeForOwner(owner: string): void { for (const viewer of this.#viewers.values()) if (viewer.owner === owner) this.#close(viewer, true, true); }
  closeForBot(botId: string): void { for (const viewer of this.#viewers.values()) if (viewer.botId === botId) this.#close(viewer, true, true); }
  closeAll(): void { for (const viewer of this.#viewers.values()) this.#close(viewer, true, true); }
}

/** The fixed v1 verbs, as the viewer messages the new browser takes. */
function commandMessage(args: string[]): ObjectValue {
  const [verb, sub, value] = args;
  if (verb === "back") return { type: "history", delta: -1 };
  if (verb === "forward") return { type: "history", delta: 1 };
  if (verb === "reload") return { type: "reload" };
  if (verb === "open") return { type: "navigate", url: sub };
  if (verb === "tab" && sub === "new") return { type: "tabNew", ...(value ? { url: value } : {}) };
  if (verb === "tab" && sub === "close") return { type: "tabClose", tabId: value };
  if (verb === "tab") return { type: "tabSelect", tabId: sub };
  return { type: "none" };
}

function inputMessage(message: ObjectValue): ObjectValue {
  if (message.type === "input_mouse") {
    if (message.eventType === "mouseWheel") return { type: "wheel", x: message.x, y: message.y, deltaX: message.deltaX, deltaY: message.deltaY, modifiers: message.modifiers };
    const action = message.eventType === "mousePressed" ? "down" : message.eventType === "mouseReleased" ? "up" : "move";
    return { type: "mouse", action, x: message.x, y: message.y, button: message.button, clickCount: message.clickCount, modifiers: message.modifiers };
  }
  if (message.eventType === "char") return { type: "text", text: message.text };
  return {
    type: "key", action: message.eventType === "keyUp" ? "up" : "down", key: message.key, code: message.code ?? "",
    modifiers: message.modifiers, ...(message.windowsVirtualKeyCode ? { keyCode: message.windowsVirtualKeyCode } : {}),
    ...(typeof message.text === "string" ? { text: message.text } : {}),
  };
}
