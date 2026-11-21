// People's remote-desktop views of a bot's browser window on its private display: the display's RFB stream spliced into
// a WebSocket that noVNC reads. The v2 stream stays open beside it and carries the hold, the tabs and the prompts; this
// view only carries pixels one way and, from the person holding the browser, input the other.
//
// Security: the hold is enforced here, at the byte level. A viewer whose person does not hold the browser sends no input
// to the display, and while another person holds it, sees nothing: that person may be typing a password.
import type { IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import { WebSocketServer, type RawData, type WebSocket } from "ws";

import type { ProfileControl } from "../control.ts";
import type { BrowserTarget } from "../service.ts";
import { RfbClientFilter, RfbProtocolError } from "./rfb-filter.ts";

/** Close codes the desktop view acts on. */
export const DESKTOP_CLOSE = {
  /** The view is no longer the person's to see, or the browser is not running: the panel reconnects once the v2 view
   * shows it running again. */
  gone: 4404,
  /** This browser runs without a display: the panel shows the picture view. */
  pictures: 4415,
  /** Another person holds the browser. */
  heldElsewhere: 4409,
  /** Too many views are open. */
  busy: 1013,
  /** The display or the browser could not start. */
  failed: 1011,
  /** The client sent something that is not RFB. */
  protocol: 1003,
} as const;

const RECHECK_MS = 5_000;
const PING_MS = 15_000;
const INPUT_NOTICE_MS = 1_000;
const HIGH_WATER_BYTES = 4 * 1024 * 1024;
const LOW_WATER_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 512 * 1024;
const VIEWS_PER_PROFILE = 4;
const VIEWS_TOTAL = 16;
const CLOSE_GRACE_MS = 2_000;

/** What a view needs of the browser it shows. */
export interface DesktopTarget {
  /** The display's RFB socket. */
  readonly socket: string;
  readonly control: Pick<ProfileControl, "owner" | "canControl" | "onChange">;
  /** A person sent input: the browser's idle time and their hold's start again. */
  used(): void;
  /** The person resized the display: the browser's window fills it again. */
  resized(width: number, height: number): void;
}

export interface DesktopLink {
  /** "gone" once the viewer may no longer see this browser, "held" while another person holds it. */
  watch(): "ok" | "gone" | "held";
  allowInput(): boolean;
  onInput(): void;
  onResize?(width: number, height: number): void;
}

export interface Splice {
  /** Applies a change of who may see or drive the browser now. */
  recheck(): void;
  close(code: number, reason: string): void;
  readonly closed: Promise<void>;
}

const bytesOf = (data: RawData): Buffer => (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));

/** Carries one viewer's RFB stream between its WebSocket and the display, through the input gate. */
export function spliceDesktop(ws: WebSocket, upstream: Duplex, link: DesktopLink): Splice {
  const filter = new RfbClientFilter({ allowInput: () => link.allowInput(), onInput: () => link.onInput(), onResize: (width, height) => link.onResize?.(width, height) });
  let ended = false;
  let finished!: () => void;
  const closed = new Promise<void>((resolve) => { finished = resolve; });
  const end = () => {
    if (ended) return;
    ended = true;
    const release = filter.release();
    if (release.length && !upstream.destroyed) upstream.end(release);
    else upstream.end();
    setTimeout(() => upstream.destroy(), CLOSE_GRACE_MS).unref();
    finished();
  };
  const close = (code: number, reason: string) => {
    if (ended) return;
    end();
    try { ws.close(code, reason.slice(0, 120)); } catch {}
    setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
  };
  const allowedToWatch = (): boolean => {
    const state = link.watch();
    if (state === "ok") return true;
    close(state === "held" ? DESKTOP_CLOSE.heldElsewhere : DESKTOP_CLOSE.gone, state === "held" ? "Another person controls this browser." : "This browser view is no longer available.");
    return false;
  };
  ws.on("message", (data, binary) => {
    if (ended) return;
    if (!binary) return close(DESKTOP_CLOSE.protocol, "The desktop view speaks RFB only.");
    if (!allowedToWatch()) return;
    let forward: Buffer;
    try {
      forward = filter.feed(bytesOf(data));
    } catch (error) {
      return close(DESKTOP_CLOSE.protocol, error instanceof RfbProtocolError ? error.message : "The desktop view sent something it cannot.");
    }
    if (forward.length && !upstream.write(forward)) {
      ws.pause();
      upstream.once("drain", () => ws.resume());
    }
  });
  upstream.on("data", (chunk: Buffer) => {
    if (ended || !allowedToWatch()) return;
    ws.send(chunk, { binary: true }, () => {
      if (upstream.isPaused() && ws.bufferedAmount < LOW_WATER_BYTES) upstream.resume();
    });
    if (ws.bufferedAmount > HIGH_WATER_BYTES) upstream.pause();
  });
  upstream.once("close", () => close(DESKTOP_CLOSE.gone, "The browser closed."));
  upstream.on("error", () => close(DESKTOP_CLOSE.gone, "The browser closed."));
  ws.once("close", end);
  ws.on("error", end);
  return {
    recheck() {
      if (ended || !allowedToWatch()) return;
      if (!link.allowInput() && filter.holding) upstream.write(filter.release());
    },
    close,
    closed,
  };
}

export interface DesktopRequest {
  target: BrowserTarget;
  botId: string;
  owner: string;
  /** Whose hold this view shares. */
  person: string;
  /** False for a passive view: it never sends input. */
  canOperate: boolean;
  req: IncomingMessage;
  socket: Socket;
  head: Buffer;
  /** False once this view no longer shows the bot's current browser to a live sign-in. */
  isCurrent(): boolean;
}

interface View {
  readonly request: DesktopRequest;
  readonly ws: WebSocket;
  splice: Splice | null;
  closed: boolean;
}

/** Every remote-desktop view of the bots' browsers on this server. */
export class DesktopViews {
  readonly #desktop: (target: BrowserTarget) => Promise<DesktopTarget | "pictures" | "stopped">;
  readonly #connect: (socket: string) => Duplex;
  readonly #views = new Set<View>();
  readonly #server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_MESSAGE_BYTES });

  constructor({ desktop, connectSocket = (path) => connect(path) }: { desktop: (target: BrowserTarget) => Promise<DesktopTarget | "pictures" | "stopped">; connectSocket?: (socket: string) => Duplex }) {
    this.#desktop = desktop;
    this.#connect = connectSocket;
  }

  open(request: DesktopRequest): void {
    const perProfile = [...this.#views].filter((view) => view.request.target.key === request.target.key).length;
    const busy = this.#views.size >= VIEWS_TOTAL || perProfile >= VIEWS_PER_PROFILE;
    this.#server.handleUpgrade(request.req, request.socket, request.head, (ws) => {
      if (busy) {
        ws.close(DESKTOP_CLOSE.busy, "Too many browser views are open. Close another browser panel first.");
        return;
      }
      const view: View = { request, ws, splice: null, closed: false };
      this.#views.add(view);
      ws.once("close", () => {
        view.closed = true;
        this.#views.delete(view);
      });
      void this.#serve(view, ws);
    });
  }

  async #serve(view: View, ws: WebSocket): Promise<void> {
    const { request } = view;
    let target: DesktopTarget | "pictures" | "stopped";
    try {
      target = await this.#desktop(request.target);
    } catch {
      ws.close(DESKTOP_CLOSE.failed, "The browser could not start.");
      return;
    }
    if (view.closed) return;
    if (target === "pictures") {
      ws.close(DESKTOP_CLOSE.pictures, "This browser has no desktop view.");
      return;
    }
    if (target === "stopped") {
      ws.close(DESKTOP_CLOSE.gone, "The browser is not running.");
      return;
    }
    const { control } = target;
    let noticed = 0;
    const link: DesktopLink = {
      watch: () => (!request.isCurrent() ? "gone" : control.owner !== null && control.owner !== request.person ? "held" : "ok"),
      allowInput: () => request.canOperate && control.canControl(request.person),
      onInput: () => {
        const now = Date.now();
        if (now - noticed < INPUT_NOTICE_MS) return;
        noticed = now;
        target.used();
      },
      onResize: (width, height) => target.resized(width, height),
    };
    if (link.watch() !== "ok") {
      ws.close(link.watch() === "held" ? DESKTOP_CLOSE.heldElsewhere : DESKTOP_CLOSE.gone, "This browser view is not available now.");
      return;
    }
    const splice = spliceDesktop(ws, this.#connect(target.socket), link);
    view.splice = splice;
    const off = control.onChange(() => splice.recheck());
    let alive = true;
    ws.on("pong", () => { alive = true; });
    const ping = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      try { ws.ping(); } catch {}
    }, PING_MS);
    ping.unref();
    const recheck = setInterval(() => splice.recheck(), RECHECK_MS);
    recheck.unref();
    await splice.closed;
    off();
    clearInterval(ping);
    clearInterval(recheck);
  }

  get size(): number {
    return this.#views.size;
  }

  closeForSession(session: string): void { this.#closeWhere((request) => request.target.session === session); }
  closeForOwner(owner: string): void { this.#closeWhere((request) => request.owner === owner); }
  closeForBot(botId: string): void { this.#closeWhere((request) => request.botId === botId); }
  closeAll(): void { this.#closeWhere(() => true); }
  /** Closes now every view the recheck would close. */
  recheck(): void { for (const view of this.#views) view.splice?.recheck(); }

  #closeWhere(match: (request: DesktopRequest) => boolean): void {
    for (const view of this.#views) {
      if (!match(view.request)) continue;
      if (view.splice) view.splice.close(DESKTOP_CLOSE.gone, "This browser view closed.");
      else view.ws.close(DESKTOP_CLOSE.gone, "This browser view closed.");
    }
  }
}
