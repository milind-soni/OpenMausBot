// The v1 live view (server-sent events, one POST per action) behind the v2 stream client's interface, so one panel
// speaks both: v1 is what agent-browser serves, and what an older server or companion still offers.
import type { ControlTransport } from "./browser-control";
import { createInputDropReport, type InputDropReason } from "./browser-input-drops";
import { delta, liveAction } from "./browser-live-action";
import { t } from "./i18n";
import { withBrowserScope } from "./team-browser";
import type { PreviewStreamClient, PreviewStreamControl, PreviewStreamEvents, PreviewStreamInput } from "./browser-stream-client";

type Body = Record<string, unknown>;
export { liveAction };
export type LivePost = (body: Body, viewerId: string) => Promise<unknown>;

export interface LiveStreamClient extends PreviewStreamClient {
  readonly transport: ControlTransport;
}

/** The view a panel had when its stream dropped. The server gives that view's hold back to the panel's next view only. */
export interface LiveResume { viewer: string }

const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000];
// The server sends a heartbeat every 10 s: a view that heard nothing for longer lost its stream without an error.
const SILENT_MS = 25_000;
const SILENCE_CHECK_MS = 5_000;
const QUEUE_LIMIT = 32;
/** Under the 32 KB the server reads of one action's body. */
const BATCH_BYTES = 24_000;

/** Frame metadata can describe the window, not the page: headless Chrome reports 1280×720 for a 1280×577 page. */
export function browserFrameSize(imageWidth: number, imageHeight: number, width: number, height: number) {
  const depicted = imageHeight * width / imageWidth;
  return Math.abs(depicted - height) <= Math.max(1, width / imageWidth) ? { width, height } : { width, height: Math.round(depicted) };
}

/** Width and height from a JPEG's start-of-frame segment. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  for (let at = 2; at + 9 < bytes.length;) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xc2) return { height: (bytes[at + 5]! << 8) | bytes[at + 6]!, width: (bytes[at + 7]! << 8) | bytes[at + 8]! };
    at += 2 + ((bytes[at + 2]! << 8) | bytes[at + 3]!);
  }
  return null;
}

const movement = (body: Body) => body.type === "input_mouse" && (body.eventType === "mouseMoved" || body.eventType === "mouseWheel");
const batchable = (body: Body) => body.type === "input_mouse" || body.type === "input_keyboard";
const releases = (body: Body) => (body.type === "input_mouse" && body.eventType === "mouseReleased") || (body.type === "input_keyboard" && body.eventType === "keyUp");
/** What still goes once input has halted: releases, so nothing stays held, and toolbar actions. */
const afterHalt = (body: Body) => releases(body) || !batchable(body);

/** Waits before each repeat of a request whose answer was lost or that the server asked to wait: about 8 s in all. */
export const LIVE_RETRY_DELAYS = [250, 500, 1_000, 2_000, 4_000];

/** A failure worth repeating the same request for: no answer at all (the connection dropped or timed out), the server busy
 * with too many of this view's actions, or a proxy in front of it failing. The server runs a numbered request once. */
export function transientFailure(cause: unknown): boolean {
  const status = (cause as { status?: unknown } | null)?.status;
  return status === undefined || status === 429 || status === 502 || status === 504;
}

/**
 * One request at a time: key and button order is kept, movement coalesced, and a reconnect never replays old input. Where
 * the server takes batches (`batchLimit` above 1), every input queued behind a request goes in the next one. Each request
 * carries a number, and a transient failure repeats it, head of line, under the same number. A failure that stays halts
 * input (releases and toolbar actions still go) and says so through `onHalted`, until a request gets through again or
 * `resume` is called once the person holds the browser again.
 */
export function createLiveInputQueue(send: (body: Body, requestId: number) => Promise<unknown>, onError: (cause: unknown) => void, batchLimit: () => number = () => 1, onDrop: (reason: InputDropReason) => void = () => {}, options: { onHalted?: (halted: boolean) => void; delays?: readonly number[] } = {}) {
  const delays = options.delays ?? LIVE_RETRY_DELAYS;
  let queue: Body[] = [];
  let active: Promise<void> | null = null;
  let generation = 0;
  let requests = 0;
  let stopped = false;
  const halt = (cause: unknown) => {
    for (const body of queue) if (!afterHalt(body) && !movement(body)) onDrop("queue_halted");
    queue = queue.filter(afterHalt);
    if (stopped) return;
    stopped = true;
    onError(cause);
    options.onHalted?.(true);
  };
  const resume = () => {
    if (!stopped) return;
    stopped = false;
    options.onHalted?.(false);
  };
  const next = (): Body[] => {
    const taken = [queue.shift()!];
    const limit = stopped ? 1 : batchLimit();
    let bytes = JSON.stringify(taken[0]).length;
    while (batchable(taken[0]!) && taken.length < limit && queue.length && batchable(queue[0]!)) {
      const size = JSON.stringify(queue[0]).length;
      if (bytes + size > BATCH_BYTES) break;
      bytes += size;
      taken.push(queue.shift()!);
    }
    return taken;
  };
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** The request, repeated under its number while it fails transiently; rejects with the failure that stayed. */
  const deliver = async (body: Body, current: number) => {
    const requestId = ++requests;
    for (let attempt = 0; ; attempt++) {
      try { return await send(body, requestId); }
      catch (cause) {
        if (current !== generation || attempt >= delays.length || !transientFailure(cause)) throw cause;
      }
      await wait(delays[attempt]!);
      if (current !== generation) return;
    }
  };
  const run = () => {
    if (active || !queue.length) return;
    const current = generation;
    active = (async () => {
      while (current === generation && queue.length) {
        const taken = next();
        try {
          await deliver(taken.length === 1 ? taken[0]! : { type: "input_batch", events: taken }, current);
          if (current === generation) resume();
        } catch (cause) {
          if (current !== generation) continue;
          // The server stops a batch at its first failure, so its later releases may never have been sent.
          if (taken.length > 1) queue.unshift(...taken.slice(1).filter(releases));
          onDrop("send_failed");
          halt(cause);
        }
      }
    })().finally(() => { active = null; run(); });
  };
  return {
    enqueue(body: Body) {
      if (stopped && !afterHalt(body)) {
        if (!movement(body)) onDrop("queue_halted");
        return;
      }
      const last = queue.at(-1);
      if (last && movement(body) && last.type === body.type && last.eventType === body.eventType && last.modifiers === body.modifiers && last.button === body.button) {
        queue[queue.length - 1] = body.eventType === "mouseWheel"
          ? { ...body, deltaX: delta(Number(last.deltaX ?? 0) + Number(body.deltaX ?? 0)), deltaY: delta(Number(last.deltaY ?? 0) + Number(body.deltaY ?? 0)) }
          : { ...body };
        return;
      }
      if (queue.length >= QUEUE_LIMIT) {
        if (movement(body)) return;
        const replaceable = queue.findIndex(movement);
        if (replaceable >= 0) queue.splice(replaceable, 1);
        else {
          halt(new Error(t("browser.input.tooSlow")));
          if (!afterHalt(body) || queue.length >= QUEUE_LIMIT) {
            onDrop("queue_full");
            return;
          }
        }
      }
      queue.push({ ...body });
      run();
    },
    async drain() {
      queue = queue.filter((body) => !movement(body));
      while (active || queue.length) { run(); await active; }
    },
    async settle() { while (active || queue.length) { run(); await active; } },
    size: () => queue.length + (active ? 1 : 0),
    stopped: () => stopped,
    /** The person holds the browser again: input goes to it again. */
    resume,
    clear() { generation++; queue = []; resume(); },
  };
}

/** v1's {held, owned, controlling, dialog} in v2's words. */
export function liveControl(value: { held?: unknown; owned?: unknown; controlling?: unknown; dialog?: unknown }, generation: number): PreviewStreamControl {
  const controller = value.owned === true ? (value.controlling === true ? "you" : "agent") : value.held === true ? "another-viewer" : "unclaimed";
  const dialog = value.dialog as { type?: unknown; message?: unknown; defaultValue?: unknown } | null | undefined;
  const shown = dialog && typeof dialog.type === "string" && typeof dialog.message === "string" && typeof dialog.defaultValue === "string"
    ? { type: dialog.type, message: dialog.message, defaultValue: dialog.defaultValue } : null;
  return { canOperate: true, controller, generation, dialog: shown, ...(value.owned === true ? { owned: true } : {}) };
}

/**
 * Opens the v1 view of a bot's browser. Frames come as base64 JPEG and wait for an acknowledgement each; the view
 * reconnects a few times after a dropped connection, never replaying input, and asks the server for the hold its last
 * view had. It reconnects at once when the window is focused, shown or back online, also after its retries ran out.
 * The panel's size (`initialSize`, then each resize) goes with every connection and to the open view, so the page fills
 * the panel; a server without resizing refuses the action and its page keeps its own size.
 */
export function createLiveStreamClient(botId: string, events: PreviewStreamEvents, post: LivePost, resume: LiveResume = { viewer: "" }, scope: Readonly<Record<string, string>> = {}, initialSize: { width: number; height: number } | null = null): LiveStreamClient {
  let stopped = false;
  /** Stopped because its retries ran out, not refused for good: coming back to the window tries again. */
  let revivable = false;
  let closed = false;
  let source: EventSource | null = null;
  let viewerId = "";
  let heardAt = 0;
  let attempts = 0;
  let generation = 0;
  let control: PreviewStreamControl | null = null;
  let viewport: { width: number; height: number } | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  /** Inputs one request may carry: what this view's server said, 1 for one that takes no batches. */
  let inputBatch = 1;
  let size = initialSize;
  /** The size on its way to the open view; a newer one waits for its answer. */
  let sizing: { width: number; height: number } | null = null;

  const dropped = (live: EventSource, retryable: boolean) => {
    live.close();
    source = null;
    const wasConnected = viewerId !== "";
    if (wasConnected) resume.viewer = viewerId;
    viewerId = "";
    control = null;
    queue.clear();
    if (wasConnected) events.onConnectedChange(false);
    if (stopped) return;
    const delay = retryable ? RECONNECT_DELAYS[attempts++] : undefined;
    if (delay === undefined) {
      stopped = true;
      revivable = retryable;
      events.onGone?.();
      return;
    }
    retry = setTimeout(connect, delay);
  };
  /** A 404 for this view's input: the server closed the view, so input must go to a new one rather than halt here. */
  const viewGone = (cause: unknown, sentTo: string) => {
    if ((cause as { status?: unknown } | null)?.status !== 404 || !source || !sentTo || viewerId !== sentTo) return false;
    dropped(source, true);
    return true;
  };
  const postTo = (body: Body, sentTo: string) => post(body, sentTo).catch((cause: unknown) => { viewGone(cause, sentTo); throw cause; });
  const notice = (message: string) => events.onMessage?.({ type: "notice", message });
  /** A reply's notice: input the page did not take, which needs no reconnect. */
  const noticed = (reply: unknown) => {
    const message = (reply as { notice?: unknown } | null)?.notice;
    if (typeof message === "string" && message) notice(message);
  };
  const drops = createInputDropReport((counts) => post({ type: "client_drops", counts }, viewerId), () => viewerId !== "");
  const queue = createLiveInputQueue((body, requestId) => (viewerId ? postTo({ ...body, requestId }, viewerId).then(noticed) : Promise.reject(new Error(t("browser.panel.connectionFirst")))), (cause) => {
    notice(cause instanceof Error ? cause.message : String(cause));
  }, () => inputBatch, drops.count, { onHalted: (halted) => events.onMessage?.({ type: "inputHalted", halted }) });

  /** One resize request at a time, the newest size last; a refusal changes nothing. */
  const sendSize = () => {
    const wanted = size;
    const to = viewerId;
    if (sizing || !wanted || !to) return;
    sizing = wanted;
    void post({ type: "resize", width: Math.round(wanted.width), height: Math.round(wanted.height) }, to).catch(() => undefined).finally(() => {
      sizing = null;
      if (size !== wanted && viewerId === to) sendSize();
    });
  };

  const connect = () => {
    retry = null;
    if (stopped) return;
    const params = new URLSearchParams(resume.viewer ? { resume: resume.viewer } : {});
    params.set("selects", "1");
    const opening = size;
    if (size) {
      params.set("width", String(Math.round(size.width)));
      params.set("height", String(Math.round(size.height)));
    }
    const query = withBrowserScope(params.size ? `?${params.toString()}` : "", scope);
    const live = new EventSource(`/api/bots/${encodeURIComponent(botId)}/browser/live${query}`);
    source = live;
    heardAt = Date.now();
    const listen = (name: string, handler: (data: Record<string, unknown>) => void) => live.addEventListener(name, (event) => {
      if (source !== live) return;
      heardAt = Date.now();
      try { handler(JSON.parse((event as MessageEvent).data) as Record<string, unknown>); } catch {}
    });
    // A browser slow to start keeps the view's "opening" wait; any other wait is the bot's.
    listen("waiting", (data) => { if (data.reason !== "starting") events.onMessage?.({ type: "starting" }); });
    listen("ready", (data) => {
      if (typeof data.viewerId !== "string" || !data.viewerId) return;
      viewerId = data.viewerId;
      inputBatch = Number.isSafeInteger(data.inputBatch) ? Math.max(1, Math.min(Number(data.inputBatch), 64)) : 1;
      resume.viewer = "";
      events.onConnectedChange(true);
      drops.kick();
      if (size !== opening) sendSize();
    });
    listen("heartbeat", () => { attempts = 0; });
    listen("frame", (data) => {
      if (!viewerId || typeof data.data !== "string" || typeof data.seq !== "number") return;
      const binary = atob(data.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const metadata = (data.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number };
      const image = jpegSize(bytes);
      if (image && metadata.deviceWidth && metadata.deviceHeight) {
        const size = browserFrameSize(image.width, image.height, metadata.deviceWidth, metadata.deviceHeight);
        if (size.width !== viewport?.width || size.height !== viewport.height) {
          viewport = size;
          events.onViewport(size);
        }
      }
      events.onFrame(bytes.buffer);
      void post({ type: "ack", seq: data.seq }, viewerId).catch(() => undefined);
    });
    listen("tabs", (data) => { if (Array.isArray(data.tabs)) events.onMessage?.({ type: "tabs", tabs: data.tabs }); });
    listen("url", (data) => { if (typeof data.url === "string") events.onMessage?.({ type: "url", url: data.url }); });
    listen("selectPopup", (data) => { if (typeof data.id === "string" && Array.isArray(data.options)) events.onMessage?.({ ...data, type: "selectPopup" }); });
    listen("status", (data) => {
      if (viewport || !(Number(data.viewportWidth) > 0 && Number(data.viewportHeight) > 0)) return;
      viewport = { width: Number(data.viewportWidth), height: Number(data.viewportHeight) };
      events.onViewport(viewport);
    });
    listen("control", (data) => {
      const next = liveControl(data, generation);
      if (control && next.controller === control.controller && next.owned === control.owned && JSON.stringify(next.dialog) === JSON.stringify(control.dialog)) return;
      const regained = next.controller === "you" && control?.controller !== "you";
      control = next.controller === control?.controller ? next : liveControl(data, ++generation);
      if (regained) queue.resume();
      events.onControl?.(control);
    });
    live.addEventListener("error", (event) => {
      if (source !== live) return;
      let retryable = !(event instanceof MessageEvent);
      if (event instanceof MessageEvent) {
        try {
          const data = JSON.parse(event.data) as { retryable?: unknown; message?: unknown; asleep?: unknown; errorKey?: unknown; errorParams?: unknown };
          retryable = data.retryable === true;
          if (data.asleep === true) events.onMessage?.({ type: "asleep" });
          else if (typeof data.message === "string") events.onMessage?.({ type: "notice", message: data.message, ...(typeof data.errorKey === "string" ? { errorKey: data.errorKey, ...(data.errorParams !== undefined ? { errorParams: data.errorParams } : {}) } : {}) });
        } catch {}
      }
      dropped(live, retryable);
    });
  };
  connect();

  // Switching apps, sleep or a network change can drop the stream unnoticed or outlast the retries: check again on return.
  const wake = (focused: boolean) => {
    if (closed) return;
    if (source && viewerId && Date.now() - heardAt > SILENT_MS) dropped(source, true);
    if (!focused || (retry === null && !(stopped && revivable))) return;
    if (retry !== null) clearTimeout(retry);
    stopped = false;
    revivable = false;
    attempts = 0;
    connect();
  };
  const returned = () => { if (document.visibilityState !== "hidden") wake(true); };
  const silence = setInterval(() => wake(false), SILENCE_CHECK_MS);
  const page = typeof window === "undefined" ? null : window;
  page?.addEventListener("focus", returned);
  page?.addEventListener("online", returned);
  if (page) document.addEventListener("visibilitychange", returned);

  const send = (input: PreviewStreamInput) => {
    if (input.type === "resize") {
      size = { width: input.width, height: input.height };
      sendSize();
      return true;
    }
    if (!viewerId || !control?.canOperate) return false;
    if (!["takeControl", "restart"].includes(input.type) && control.controller !== "you") return false;
    const action = liveAction(input);
    if (!action) return false;
    // The page's question holds the input queued behind it, so its answer goes straight to the server.
    if (input.type === "dialog" && !Array.isArray(action)) {
      void postTo(action, viewerId).catch((cause: unknown) => notice(cause instanceof Error ? cause.message : String(cause)));
      return true;
    }
    for (const body of Array.isArray(action) ? action : [action]) queue.enqueue(body);
    return true;
  };

  return {
    send,
    stop: () => {
      stopped = true;
      closed = true;
      clearInterval(silence);
      page?.removeEventListener("focus", returned);
      page?.removeEventListener("online", returned);
      if (page) document.removeEventListener("visibilitychange", returned);
      if (retry !== null) clearTimeout(retry);
      source?.close();
      source = null;
      // A reconnect of the same panel carries on with this view's hold, as one after a dropped stream does.
      if (viewerId) resume.viewer = viewerId;
      viewerId = "";
      queue.clear();
      drops.close();
    },
    transport: {
      send: (input) => {
        const action = viewerId ? liveAction(input) : null;
        if (action) for (const body of Array.isArray(action) ? action : [action]) queue.enqueue(body);
        else if (!viewerId && input.type !== "resize" && !(input.type === "mouse" && input.action === "move")) drops.count("not_connected");
      },
      dropped: drops.count,
      drain: () => queue.drain(),
      settle: () => queue.settle(),
      size: () => queue.size(),
      stopped: () => queue.stopped(),
      take: async () => {
        if (!viewerId) throw new Error(t("browser.panel.notConnected"));
        const reply = await postTo({ type: "take" }, viewerId) as { waited?: unknown } | null;
        queue.resume();
        return { waited: reply?.waited === true };
      },
      release: async () => { if (viewerId) await postTo({ type: "release" }, viewerId); },
    },
  };
}
