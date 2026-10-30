// The v1 live view (server-sent events, one POST per action) behind the v2 stream client's interface, so one panel
// speaks both: v1 is what agent-browser serves, and what an older server or companion still offers.
import type { ControlTransport } from "./browser-control";
import { t } from "./i18n";
import { withBrowserScope } from "./team-browser";
import type { PreviewStreamClient, PreviewStreamControl, PreviewStreamEvents, PreviewStreamInput } from "./browser-stream-client";

type Body = Record<string, unknown>;
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
const CHAR_LIMIT = 4_096;
/** Under the 32 KB the server reads of one action's body. */
const BATCH_BYTES = 24_000;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, Number.isFinite(value) ? value : 0));
const delta = (value: number) => clamp(value, -10_000, 10_000);

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

/** A v2 message as the v1 action it stands for; null for what v1 has no action for. */
export function liveAction(input: PreviewStreamInput): Body | Body[] | null {
  switch (input.type) {
    case "mouse":
      return {
        type: "input_mouse", eventType: input.action === "down" ? "mousePressed" : input.action === "up" ? "mouseReleased" : "mouseMoved",
        x: clamp(input.x, 0, 8192), y: clamp(input.y, 0, 8192), button: input.button,
        clickCount: Math.round(clamp(input.clickCount, 0, 3)), modifiers: input.modifiers,
      };
    case "wheel":
      return { type: "input_mouse", eventType: "mouseWheel", x: clamp(input.x, 0, 8192), y: clamp(input.y, 0, 8192), button: "none", deltaX: delta(input.deltaX), deltaY: delta(input.deltaY), modifiers: input.modifiers };
    case "key":
      if (!input.key) return null;
      return {
        type: "input_keyboard", eventType: input.action === "up" ? "keyUp" : "keyDown", key: input.key.slice(0, 64), code: input.code.slice(0, 64),
        windowsVirtualKeyCode: Math.round(clamp(input.keyCode ?? 0, 0, 255)), modifiers: input.modifiers,
        ...(input.text !== undefined ? { text: input.text } : {}),
      };
    case "text": {
      const chunks: Body[] = [];
      for (let at = 0; at < input.text.length; at += CHAR_LIMIT) chunks.push({ type: "input_keyboard", eventType: "char", text: input.text.slice(at, at + CHAR_LIMIT) });
      return chunks;
    }
    case "navigate": return { type: "navigate", url: input.url };
    case "history": return { type: input.delta < 0 ? "back" : "forward" };
    case "reload": return { type: "reload" };
    case "tabSelect": return { type: "tab-select", tabId: input.tabId };
    case "tabClose": return { type: "tab-close", tabId: input.tabId };
    case "tabNew": return input.url ? { type: "tab-new", url: input.url } : { type: "tab-new" };
    case "restart": return { type: "restart" };
    case "dialog": return { type: "dialog", accept: input.accept, ...(input.promptText !== undefined ? { promptText: input.promptText.slice(0, 4_096) } : {}) };
    default: return null;
  }
}

const movement = (body: Body) => body.type === "input_mouse" && (body.eventType === "mouseMoved" || body.eventType === "mouseWheel");
const batchable = (body: Body) => body.type === "input_mouse" || body.type === "input_keyboard";
const releases = (body: Body) => (body.type === "input_mouse" && body.eventType === "mouseReleased") || (body.type === "input_keyboard" && body.eventType === "keyUp");
/** What still goes once input has halted: releases, so nothing stays held, and toolbar actions. */
const afterHalt = (body: Body) => releases(body) || !batchable(body);

/** One request at a time: key and button order is kept, movement coalesced, and a reconnect never replays old input. Where
 * the server takes batches (`batchLimit` above 1), every input queued behind a request goes in the next one. */
export function createLiveInputQueue(send: (body: Body) => Promise<unknown>, onError: (cause: unknown) => void, batchLimit: () => number = () => 1) {
  let queue: Body[] = [];
  let active: Promise<void> | null = null;
  let generation = 0;
  let stopped = false;
  const halt = (cause: unknown) => {
    queue = queue.filter(afterHalt);
    if (!stopped) { stopped = true; onError(cause); }
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
  const run = () => {
    if (active || !queue.length) return;
    const current = generation;
    active = (async () => {
      while (current === generation && queue.length) {
        const taken = next();
        try { await send(taken.length === 1 ? taken[0]! : { type: "input_batch", events: taken }); }
        catch (cause) {
          if (current !== generation) continue;
          // The server stops a batch at its first failure, so its later releases may never have been sent.
          if (taken.length > 1) queue.unshift(...taken.slice(1).filter(releases));
          halt(cause);
        }
      }
    })().finally(() => { active = null; run(); });
  };
  return {
    enqueue(body: Body) {
      if (stopped && !afterHalt(body)) return;
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
          if (!afterHalt(body) || queue.length >= QUEUE_LIMIT) return;
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
    clear() { generation++; queue = []; stopped = false; },
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
  const queue = createLiveInputQueue((body) => (viewerId ? postTo(body, viewerId).then(noticed) : Promise.reject(new Error("Open the browser connection first."))), (cause) => {
    notice(cause instanceof Error ? cause.message : String(cause));
  }, () => inputBatch);

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
    listen("waiting", () => events.onMessage?.({ type: "starting" }));
    listen("ready", (data) => {
      if (typeof data.viewerId !== "string" || !data.viewerId) return;
      viewerId = data.viewerId;
      inputBatch = Number.isSafeInteger(data.inputBatch) ? Math.max(1, Math.min(Number(data.inputBatch), 64)) : 1;
      resume.viewer = "";
      events.onConnectedChange(true);
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
    listen("status", (data) => {
      if (viewport || !(Number(data.viewportWidth) > 0 && Number(data.viewportHeight) > 0)) return;
      viewport = { width: Number(data.viewportWidth), height: Number(data.viewportHeight) };
      events.onViewport(viewport);
    });
    listen("control", (data) => {
      const next = liveControl(data, generation);
      if (control && next.controller === control.controller && next.owned === control.owned && JSON.stringify(next.dialog) === JSON.stringify(control.dialog)) return;
      control = next.controller === control?.controller ? next : liveControl(data, ++generation);
      events.onControl?.(control);
    });
    live.addEventListener("error", (event) => {
      if (source !== live) return;
      let retryable = !(event instanceof MessageEvent);
      if (event instanceof MessageEvent) {
        try {
          const data = JSON.parse(event.data) as { retryable?: unknown; message?: unknown; asleep?: unknown };
          retryable = data.retryable === true;
          if (data.asleep === true) events.onMessage?.({ type: "asleep" });
          else if (typeof data.message === "string") events.onMessage?.({ type: "notice", message: data.message });
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
    },
    transport: {
      send: (input) => {
        const action = viewerId ? liveAction(input) : null;
        if (action) for (const body of Array.isArray(action) ? action : [action]) queue.enqueue(body);
      },
      drain: () => queue.drain(),
      settle: () => queue.settle(),
      size: () => queue.size(),
      stopped: () => queue.stopped(),
      take: async () => {
        if (!viewerId) throw new Error("The browser view is not connected. Reconnect it, then try again.");
        const reply = await postTo({ type: "take" }, viewerId) as { waited?: unknown } | null;
        return { waited: reply?.waited === true };
      },
      release: async () => { if (viewerId) await postTo({ type: "release" }, viewerId); },
    },
  };
}
