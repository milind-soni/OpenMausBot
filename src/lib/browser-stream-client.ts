// Adapted from pingdotgg/t3code@00cdceb1 packages/client-runtime/src/preview/serverBrowserStream.ts, MIT License,
// Copyright (c) 2026 T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified: OpenMausBot's routes and
// access, a viewer that may operate sizes the page while it only watches, a larger frame cap is sent in place and a
// reconnect opens with the newest size and cap, and OpenMausBot's own messages are passed on.

/** The browser's host cannot run Chrome until it is set up; the close reason names the fix. */
export const PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE = 4503;
export const PREVIEW_STREAM_TAB_GONE_CODE = 4404;

export interface PreviewStreamHostSetup {
  readonly need: "sandbox" | "libraries";
  readonly command: string;
}

export type PreviewViewportSetting =
  | { readonly mode: "fill" }
  | { readonly mode: "preset"; readonly preset: "desktop" | "tablet" | "phone"; readonly landscape?: boolean };

/** Where a bot's browser is served: `httpBase` and `wsBase` end in `/api/bots/<id>/browser`. */
export interface PreviewStreamAccess {
  readonly httpBase: string;
  readonly wsBase: string;
  /** Empty for cookie and desktop sessions; a short-lived ticket otherwise. */
  readonly query: Readonly<Record<string, string>>;
  /** Whether requests must include session cookies. */
  readonly credentials: boolean;
}

export const withAccessQuery = (url: string, access: PreviewStreamAccess): string => {
  const entries = Object.entries(access.query);
  if (entries.length === 0) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${new URLSearchParams(entries).toString()}`;
};

/** The same origin's routes for a bot's browser. */
export function browserStreamAccess(botId: string, location: Pick<Location, "protocol" | "host"> = window.location, scope: Readonly<Record<string, string>> = {}): PreviewStreamAccess {
  const path = `/api/bots/${encodeURIComponent(botId)}/browser`;
  return {
    httpBase: `${location.protocol}//${location.host}${path}`,
    wsBase: `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${path}`,
    query: { ...scope },
    credentials: true,
  };
}

export interface PreviewStreamViewport {
  readonly width: number;
  readonly height: number;
}

export type PreviewStreamMouseButton = "none" | "left" | "middle" | "right";

export interface PreviewStreamControl {
  readonly canOperate: boolean;
  readonly controller: "agent" | "you" | "another-viewer" | "unclaimed";
  readonly generation: number;
  readonly dialog: null | {
    readonly type: string;
    readonly message: string;
    readonly defaultValue: string;
  };
  /** The bot's work outlasted the person's takeover and was cut off. */
  readonly stale?: boolean;
  /** The person watching holds the browser, from this view or another of theirs: they may hand it back from here. */
  readonly owned?: boolean;
}

/** Status line shown above a viewer; `null` control means the socket is not connected. */
export const previewStreamControlLabel = (control: PreviewStreamControl | null): string =>
  !control
    ? "Connecting..."
    : !control.canOperate
      ? "Read-only"
      : control.controller === "you"
        ? "You have control"
        : control.controller === "agent"
          ? "Bot has control"
          : control.controller === "another-viewer"
            ? "Another viewer has control"
            : "Watching";

const isPreviewStreamDialog = (value: unknown): value is PreviewStreamControl["dialog"] =>
  value === null ||
  (typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "defaultValue" in value &&
    typeof value.defaultValue === "string");

/** Client-to-server messages. Coordinates are page CSS px. */
export type PreviewStreamInput =
  | { readonly type: "takeControl" }
  | { readonly type: "releaseControl" }
  | { readonly type: "dialog"; readonly accept: boolean; readonly promptText?: string }
  | { readonly type: "viewport"; readonly setting: PreviewViewportSetting }
  | { readonly type: "zoom"; readonly factor: number }
  | {
      readonly type: "mouse";
      readonly action: "move" | "down" | "up";
      readonly x: number;
      readonly y: number;
      readonly button: PreviewStreamMouseButton;
      /** Pressed buttons: left 1, right 2, middle 4. */
      readonly buttons: number;
      readonly clickCount: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "key";
      readonly action: "down" | "up";
      readonly key: string;
      readonly code: string;
      /** Windows virtual key code (DOM `keyCode`); Enter, Backspace, and arrows need it. */
      readonly keyCode?: number;
      /** Only for printable keys without Ctrl or Meta. */
      readonly text?: string;
      readonly modifiers: number;
    }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  /** The viewer can show larger frames now: the screencast restarts at the new cap without reconnecting. */
  | { readonly type: "frameCap"; readonly maxWidth: number; readonly maxHeight: number }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "history"; readonly delta: -1 | 1 }
  | { readonly type: "reload"; readonly ignoreCache?: boolean }
  /** Asks whether the page point takes text. Touch viewers send it on touch start. */
  | { readonly type: "probe"; readonly x: number; readonly y: number }
  | { readonly type: "tabSelect"; readonly tabId: string }
  | { readonly type: "tabNew"; readonly url?: string }
  | { readonly type: "tabClose"; readonly tabId: string }
  | { readonly type: "selectChoose"; readonly id: string; readonly index: number }
  /** Answers the sign-in prompt `id` of tab `tabId`, as it was shown; without a username and password it cancels it. */
  | { readonly type: "authAnswer"; readonly tabId: string; readonly id: string; readonly username?: string; readonly password?: string }
  | { readonly type: "restart" }
  /** Starts the browser again after it closed unused (the server sent `asleep`); `awake` follows once it runs. */
  | { readonly type: "wake" };

export interface PreviewStreamDownload {
  readonly fileName: string;
  readonly sizeBytes: number;
  /** Authenticated with the stream's own access; cookie sessions must send credentials. */
  readonly url: string;
}

export interface PreviewStreamFileChooser {
  readonly multiple: boolean;
  /** The input's `accept` attribute, ready for a local `<input type=file>`. */
  readonly accept: string;
  /** POST multipart `file` parts here; an empty form cancels the page's picker. */
  readonly uploadUrl: string;
  /** Cookie sessions must send credentials with the upload. */
  readonly credentials: boolean;
}

const previewStreamUploadUrl = (target: Pick<PreviewStreamTarget, "access">, chooser: string): string =>
  withAccessQuery(`${target.access.httpBase}/upload?${new URLSearchParams({ chooser }).toString()}`, target.access);

/** Sends files to a page's open picker. Rejects when the server refuses them. */
export async function uploadPreviewStreamFiles(
  chooser: PreviewStreamFileChooser,
  files: ReadonlyArray<Blob & { readonly name?: string }>,
): Promise<void> {
  const body = new FormData();
  for (const file of files) body.append("file", file, file.name ?? "file");
  const response = await fetch(chooser.uploadUrl, {
    method: "POST",
    body,
    credentials: chooser.credentials ? "include" : "omit",
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {}
    throw new Error(message || "The upload was refused.");
  }
}

/** A file a bot's browser downloaded, served with the stream's own access. */
export const previewStreamDownloadUrl = (target: Pick<PreviewStreamTarget, "access">, id: string): string =>
  withAccessQuery(`${target.access.httpBase}/download/${encodeURIComponent(id)}`, target.access);

/** Answer to a `probe`, echoing its point. */
export interface PreviewStreamProbe {
  readonly x: number;
  readonly y: number;
  readonly editable: boolean;
}

/** Where an agent action is about to land, in page CSS pixels. */
export interface PreviewStreamPointer {
  readonly phase: "move" | "click";
  readonly x: number;
  readonly y: number;
  readonly sequence: number;
}

/** CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export const previewStreamModifiers = (event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

export interface PreviewStreamTarget {
  readonly access: PreviewStreamAccess;
  /** Viewer backing-store size in device px. The server never sends larger frames. */
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** The panel's size in CSS px, which the page fills from the first frame. */
  readonly width?: number;
  readonly height?: number;
  /** Passive viewers reduce their own access, including automatic control grants. */
  readonly interactive?: boolean;
}

export interface PreviewStreamEvents {
  /** One complete JPEG frame. */
  readonly onFrame: (jpeg: ArrayBuffer) => void;
  readonly onViewport: (viewport: PreviewStreamViewport) => void;
  readonly onProbe?: (probe: PreviewStreamProbe) => void;
  /** The agent's cursor moved to, or clicked at, a page point. */
  readonly onPointer?: (pointer: PreviewStreamPointer) => void;
  readonly onControl?: (control: PreviewStreamControl) => void;
  /** Text the page just copied or cut while this viewer had control. */
  readonly onClipboard?: (text: string) => void;
  /** A file the page downloaded while this viewer had control. */
  readonly onDownload?: (download: PreviewStreamDownload) => void;
  /** The page this viewer controls opened a new tab (a link or `window.open`). */
  readonly onPopup?: (tabId: string) => void;
  /** The page opened a file picker (`null` once answered or replaced). */
  readonly onFileChooser?: (chooser: PreviewStreamFileChooser | null) => void;
  /** OpenMausBot's own messages: tabs, nav, selectPopup, cursor, authPrompt, starting, notice, asleep, awake. */
  readonly onMessage?: (message: Readonly<Record<string, unknown>>) => void;
  /** Input sent while disconnected is dropped. */
  readonly onConnectedChange: (connected: boolean) => void;
  /** The upgrade was refused; refresh access and start a new client. */
  readonly onUnauthorized: () => void;
  /** The browser this view showed is gone. The client has stopped. */
  readonly onGone?: () => void;
  /** The server's browser cannot start until its host is set up. The client has stopped. */
  readonly onHostSetup?: (setup: PreviewStreamHostSetup) => void;
  /** Every close, before the client decides whether to retry. */
  readonly onClose?: (code: number, reason: string) => void;
}

export interface PreviewStreamClient {
  /** False when the socket is not open and the message was dropped. */
  readonly send: (input: PreviewStreamInput) => boolean;
  readonly stop: () => void;
}

/** A viewer that may operate sizes the page while it watches, and may restart or wake it; the person holding the browser
 * hands it back from any of their views; everything else needs control. */
const allowed = (input: PreviewStreamInput, control: PreviewStreamControl): boolean =>
  input.type === "takeControl" || input.type === "resize" || input.type === "frameCap" || input.type === "restart" || input.type === "wake"
  || (input.type === "releaseControl" && control.owned === true) || control.controller === "you";

const ACK_MESSAGE = JSON.stringify({ type: "ack" });
export function createPreviewStreamClient(
  target: PreviewStreamTarget,
  events: PreviewStreamEvents,
): PreviewStreamClient {
  let cap = { width: target.maxWidth, height: target.maxHeight };
  let size = target.width !== undefined && target.height !== undefined ? { width: target.width, height: target.height } : null;
  const streamUrl = () => {
    const query = new URLSearchParams({
      maxWidth: String(Math.max(1, Math.round(cap.width))),
      maxHeight: String(Math.max(1, Math.round(cap.height))),
    });
    if (size) {
      query.set("width", String(Math.round(size.width)));
      query.set("height", String(Math.round(size.height)));
    }
    if (target.interactive === false) query.set("interactive", "false");
    return withAccessQuery(`${target.access.wsBase}/stream?${query.toString()}`, target.access);
  };
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let control: PreviewStreamControl | null = null;
  let fileChooser: string | null = null;

  const connect = () => {
    if (stopped) return;
    const opening = { cap, size };
    const ws = new WebSocket(streamUrl());
    ws.binaryType = "arraybuffer";
    socket = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      events.onConnectedChange(true);
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        failures = 0;
        ws.send(ACK_MESSAGE);
        events.onFrame(event.data);
        return;
      }
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const {
        type,
        x,
        y,
        width,
        height,
        editable,
        canOperate,
        controller,
        generation,
        dialog,
        stale,
        owned,
        text,
        id,
        fileName,
        sizeBytes,
        multiple,
        accept,
        phase,
        sequence,
        tabId,
      } = message as Record<string, unknown>;
      if (
        type === "fileChooser" &&
        typeof id === "string" &&
        typeof multiple === "boolean" &&
        typeof accept === "string"
      ) {
        fileChooser = id;
        events.onFileChooser?.({
          multiple,
          accept,
          uploadUrl: previewStreamUploadUrl(target, id),
          credentials: target.access.credentials,
        });
      } else if (type === "fileChooserClosed" && typeof id === "string") {
        if (fileChooser !== id) return;
        fileChooser = null;
        events.onFileChooser?.(null);
      } else if (
        type === "pointer" &&
        (phase === "move" || phase === "click") &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof sequence === "number"
      ) {
        events.onPointer?.({ phase, x, y, sequence });
      } else if (type === "popup" && typeof tabId === "string") {
        events.onPopup?.(tabId);
      } else if (type === "clipboard" && typeof text === "string") {
        events.onClipboard?.(text);
      } else if (
        type === "download" &&
        typeof id === "string" &&
        typeof fileName === "string" &&
        typeof sizeBytes === "number"
      ) {
        events.onDownload?.({
          fileName,
          sizeBytes,
          url: previewStreamDownloadUrl(target, id),
        });
      } else if (type === "viewport" && typeof width === "number" && typeof height === "number") {
        failures = 0;
        events.onViewport({ width, height });
        events.onMessage?.(message as Record<string, unknown>);
      } else if (
        type === "probe" &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof editable === "boolean"
      ) {
        events.onProbe?.({ x, y, editable });
      } else if (
        type === "control" &&
        typeof canOperate === "boolean" &&
        (controller === "agent" ||
          controller === "you" ||
          controller === "another-viewer" ||
          controller === "unclaimed") &&
        typeof generation === "number" &&
        isPreviewStreamDialog(dialog)
      ) {
        const nextControl: PreviewStreamControl = {
          canOperate,
          controller,
          generation,
          dialog,
          ...(stale === true ? { stale: true } : {}),
          ...(owned === true ? { owned: true } : {}),
        };
        const first = control === null;
        control = nextControl;
        // A size or cap the viewer asked for while this socket was opening reaches the server now.
        if (first && canOperate && cap !== opening.cap) ws.send(JSON.stringify({ type: "frameCap", maxWidth: cap.width, maxHeight: cap.height }));
        if (first && canOperate && size && size !== opening.size) ws.send(JSON.stringify({ type: "resize", ...size }));
        events.onControl?.(nextControl);
      } else if (typeof type === "string") {
        events.onMessage?.(message as Record<string, unknown>);
      }
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      control = null;
      if (opened) events.onConnectedChange(false);
      if (stopped) return;
      events.onClose?.(event.code, event.reason);
      if (event.code === PREVIEW_STREAM_TAB_GONE_CODE) {
        stopped = true;
        events.onGone?.();
        return;
      }
      if (event.code === PREVIEW_STREAM_HOST_SETUP_CLOSE_CODE) {
        stopped = true;
        events.onHostSetup?.(decodeHostSetup(event.reason));
        return;
      }
      // Rejected upgrades surface as 1006 before open for both cookies and tickets.
      if (event.code === 1008 || event.code === 4401 || (!opened && event.code === 1006)) {
        stopped = true;
        events.onUnauthorized();
        return;
      }
      retryTimer = setTimeout(connect, Math.min(500 * 2 ** failures++, 10_000));
    });
    ws.addEventListener("error", () => ws.close());
  };

  connect();

  return {
    send: (input) => {
      if (input.type === "resize") size = { width: input.width, height: input.height };
      else if (input.type === "frameCap") cap = { width: input.maxWidth, height: input.maxHeight };
      if (socket?.readyState !== WebSocket.OPEN) return false;
      if (!control?.canOperate) return false;
      if (!allowed(input, control)) return false;
      socket.send(JSON.stringify(input));
      return true;
    },
    stop: () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      const ws = socket;
      socket = null;
      control = null;
      ws?.close();
    },
  };
}

export interface PreviewFramePainter {
  readonly paint: (jpeg: ArrayBuffer) => void;
  readonly stop: () => void;
}

/** One decode at a time, keeping only the latest waiting frame for slow viewers. */
export function createPreviewFramePainter(
  canvas: HTMLCanvasElement,
  onPainted?: () => void,
): PreviewFramePainter {
  const context = canvas.getContext("2d");
  let stopped = false;
  let decoding = false;
  let waiting: ArrayBuffer | null = null;
  const draw = (jpeg: ArrayBuffer) => {
    decoding = true;
    void createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }))
      .then((bitmap) => {
        if (stopped || !context) {
          bitmap.close();
          return;
        }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        onPainted?.();
      })
      // A frame that fails to decode is skipped; the next one repaints.
      .catch(() => undefined)
      .finally(() => {
        decoding = false;
        const next = waiting;
        waiting = null;
        if (next && !stopped) draw(next);
      });
  };
  return {
    paint: (jpeg) => {
      if (stopped) return;
      if (decoding) waiting = jpeg;
      else draw(jpeg);
    },
    stop: () => {
      stopped = true;
      waiting = null;
    },
  };
}

/** A malformed reason still stops the viewer and offers the usual command. */
const decodeHostSetup = (reason: string): PreviewStreamHostSetup => {
  try {
    const value = JSON.parse(reason) as Partial<PreviewStreamHostSetup>;
    if (
      (value.need === "sandbox" || value.need === "libraries") &&
      typeof value.command === "string"
    ) {
      return { need: value.need, command: value.command };
    }
  } catch {}
  return { need: "sandbox", command: "sudo openmausbot browser setup" };
};

/** What a viewer tells the person; `command` is shown beside it, ready to copy. */
export const previewStreamHostSetupMessage = (setup: PreviewStreamHostSetup) =>
  setup.need === "sandbox"
    ? "This server's host blocks the sandbox its browser runs in. Run this once on the host, then try again:"
    : "This server's host is missing libraries its browser needs. Run this once on the host, then try again:";
