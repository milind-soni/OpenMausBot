export const PHONE_STREAM_CLOSE = { failed: 1011, busy: 1013, gone: 4404 } as const;

export type PhoneKey = "back" | "home" | "recent" | "enter" | "delete" | "tab" | "up" | "down" | "left" | "right" | "wakeup";
export type PhoneTouchAction = "down" | "move" | "up";

export interface PhoneFrameSize {
  readonly width: number;
  readonly height: number;
}

export type PhoneStreamStatus =
  | { readonly kind: "connecting" | "live" | "unsupported" }
  | { readonly kind: "closed"; readonly code: number; readonly reason: string };

export interface PhoneStreamView {
  readonly status: PhoneStreamStatus;
  /** Video pixels of the frame on the canvas; a rotation changes it. */
  readonly frame: PhoneFrameSize | null;
  /** A person holds the phone, from this view or another. */
  readonly held: boolean;
}

export interface PhoneStreamTarget {
  readonly serial: string;
  readonly canvas: HTMLCanvasElement;
}

/** Input reaches the phone only while it is held; the server drops the rest. */
export interface PhoneStreamClient {
  readonly take: () => void;
  readonly handBack: () => void;
  /** `x` and `y` are video pixels of the frame on the canvas. */
  readonly touch: (action: PhoneTouchAction, x: number, y: number) => void;
  readonly key: (key: PhoneKey) => void;
  readonly text: (text: string) => void;
  readonly stop: () => void;
}

export const phoneStreamUrl = (serial: string, location: Pick<Location, "protocol" | "host"> = window.location): string =>
  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/usb-phones/${encodeURIComponent(serial)}/stream`;

const PACKET = { config: 1, key: 2, delta: 3 } as const;
const TEXT_LIMIT = 300;
const MAX_RETRY_MS = 10_000;
const CONNECTING: PhoneStreamStatus = { kind: "connecting" };

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const joined = (head: Uint8Array, tail: Uint8Array) => {
  const all = new Uint8Array(head.length + tail.length);
  all.set(head);
  all.set(tail, head.length);
  return all;
};

/** The server takes at most 300 characters in one text message; a surrogate pair stays whole. */
function textPieces(text: string): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const character of text) {
    if (piece.length + character.length > TEXT_LIMIT) {
      pieces.push(piece);
      piece = "";
    }
    piece += character;
  }
  if (piece) pieces.push(piece);
  return pieces;
}

export function createPhoneStreamClient(target: PhoneStreamTarget, onChange: (view: PhoneStreamView) => void): PhoneStreamClient {
  // WebCodecs is exposed only in secure contexts: HTTPS or localhost.
  const supported = window.isSecureContext && typeof VideoDecoder === "function";
  const context = target.canvas.getContext("2d");
  let view: PhoneStreamView = { status: supported ? CONNECTING : { kind: "unsupported" }, frame: null, held: false };
  let socket: WebSocket | null = null;
  let decoder: VideoDecoder | null = null;
  let config: Uint8Array | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let ended = !supported;

  const change = (next: Partial<PhoneStreamView>) => {
    view = { ...view, ...next };
    onChange(view);
  };

  const paint = (frame: VideoFrame) => {
    const { displayWidth: width, displayHeight: height } = frame;
    const resized = view.frame?.width !== width || view.frame.height !== height;
    if (resized) {
      target.canvas.width = width;
      target.canvas.height = height;
    }
    context?.drawImage(frame, 0, 0);
    frame.close();
    failures = 0;
    if (resized || view.status.kind !== "live") change({ status: { kind: "live" }, frame: { width, height } });
  };

  const drop = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    const ws = socket;
    socket = null;
    ws?.close();
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = null;
    config = null;
  };

  const reconnect = () => {
    drop();
    change({ status: CONNECTING });
    retryTimer = setTimeout(open, Math.min(500 * 2 ** failures++, MAX_RETRY_MS));
  };

  const cannotDecode = () => {
    if (ended) return;
    ended = true;
    drop();
    change({ status: { kind: "unsupported" } });
  };

  const decode = (packet: Uint8Array) => {
    const kind = packet[0];
    const payload = packet.subarray(1);
    if (kind === PACKET.config) {
      config = payload;
      if (!decoder) {
        const created: VideoDecoder = new VideoDecoder({ output: paint, error: () => { if (decoder === created) reconnect(); } });
        decoder = created;
      }
      // The stream is H.264 Annex B: a config without `description` tells WebCodecs so. The three bytes after the
      // parameter set's NAL header are its profile, constraints and level.
      const settings: VideoDecoderConfig = { codec: `avc1.${hex(payload.subarray(5, 8))}`, optimizeForLatency: true };
      decoder.configure(settings);
      // A decoder configured with a codec the browser lacks only reports an error, as it does for one bad frame.
      void VideoDecoder.isConfigSupported(settings).then(({ supported }) => { if (!supported) cannotDecode(); }, () => {});
    } else if (decoder && config && (kind === PACKET.key || kind === PACKET.delta)) {
      const key = kind === PACKET.key;
      // An Annex B key chunk must carry its parameter sets; the phone's encoder sends them once, apart.
      decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: performance.now() * 1000, data: key ? joined(config, payload) : payload }));
    }
  };

  const control = (data: string) => {
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const { type, held } = message as Record<string, unknown>;
    if (type === "control" && typeof held === "boolean" && held !== view.held) change({ held });
  };

  function open() {
    retryTimer = null;
    if (ended || socket || document.visibilityState !== "visible") return;
    const ws = new WebSocket(phoneStreamUrl(target.serial));
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (typeof event.data === "string") {
        control(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        try {
          decode(new Uint8Array(event.data));
        } catch {
          reconnect();
        }
      }
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      const closed: PhoneStreamStatus = { kind: "closed", code: event.code, reason: event.reason };
      if (event.code === PHONE_STREAM_CLOSE.failed || event.code === PHONE_STREAM_CLOSE.gone) {
        ended = true;
        drop();
        change({ status: closed });
      } else if (event.code === PHONE_STREAM_CLOSE.busy) {
        drop();
        change({ status: closed });
        retryTimer = setTimeout(open, MAX_RETRY_MS);
      } else {
        reconnect();
      }
    });
    ws.addEventListener("error", () => ws.close());
  }

  const onVisibility = () => {
    if (ended) return;
    if (document.visibilityState === "visible") {
      open();
    } else {
      drop();
      failures = 0;
      change({ status: CONNECTING });
    }
  };

  const send = (message: Readonly<Record<string, unknown>>) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  onChange(view);
  if (supported) {
    document.addEventListener("visibilitychange", onVisibility);
    open();
  }

  return {
    take: () => send({ type: "take" }),
    handBack: () => send({ type: "handBack" }),
    touch: (action, x, y) => {
      if (view.frame) send({ type: "touch", action, x, y, w: view.frame.width, h: view.frame.height });
    },
    key: (key) => send({ type: "key", key }),
    text: (text) => {
      for (const piece of textPieces(text)) send({ type: "text", text: piece });
    },
    stop: () => {
      document.removeEventListener("visibilitychange", onVisibility);
      drop();
    },
  };
}
