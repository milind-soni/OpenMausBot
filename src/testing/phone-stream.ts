import { vi } from "vitest";

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

/** The parameter sets scrcpy-server 5.0.1 sent from a Huawei MHA-AL00 (Android 9): H.264 Constrained Baseline, level 3.2. */
export const PHONE_CONFIG = bytes("000000016742c020da02d028440000000168ca8f20");
/** The first bytes of that recording's key frame and of one frame after it. */
export const PHONE_KEY_FRAME = bytes("0000000165b845");
export const PHONE_DELTA_FRAME = bytes("0000000161");

export class FakePhoneSocket extends EventTarget {
  static readonly OPEN = 1;
  static all: FakePhoneSocket[] = [];
  static get current(): FakePhoneSocket {
    return FakePhoneSocket.all[FakePhoneSocket.all.length - 1];
  }
  readyState = 1;
  binaryType = "";
  readonly sent: unknown[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakePhoneSocket.all.push(this);
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
  }
  packet(tag: number, payload: Uint8Array) {
    const data = new Uint8Array(payload.length + 1);
    data[0] = tag;
    data.set(payload, 1);
    this.dispatchEvent(new MessageEvent("message", { data: data.buffer }));
  }
  control(held: boolean) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "control", held }) }));
  }
  closeWith(code: number, reason = "") {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
}

export class FakeEncodedVideoChunk {
  readonly type: string;
  readonly data: Uint8Array;
  constructor(init: { type: string; data: Uint8Array }) {
    this.type = init.type;
    this.data = init.data;
  }
}

export class FakeVideoDecoder {
  static all: FakeVideoDecoder[] = [];
  /** Codec strings this browser cannot decode. */
  static lacks: string[] = [];
  static isConfigSupported(config: VideoDecoderConfig) {
    return Promise.resolve({ supported: !FakeVideoDecoder.lacks.includes(config.codec), config });
  }
  static get current(): FakeVideoDecoder {
    return FakeVideoDecoder.all[FakeVideoDecoder.all.length - 1];
  }
  state = "unconfigured";
  readonly configured: unknown[] = [];
  readonly chunks: FakeEncodedVideoChunk[] = [];
  readonly #init: VideoDecoderInit;
  constructor(init: VideoDecoderInit) {
    this.#init = init;
    FakeVideoDecoder.all.push(this);
  }
  configure(config: unknown) {
    this.configured.push(config);
    this.state = "configured";
  }
  decode(chunk: FakeEncodedVideoChunk) {
    this.chunks.push(chunk);
  }
  close() {
    this.state = "closed";
  }
  /** Hands the client one decoded frame of this size. */
  frame(width: number, height: number) {
    const frame = { displayWidth: width, displayHeight: height, close: vi.fn() };
    this.#init.output(frame as unknown as VideoFrame);
    return frame;
  }
  fail() {
    this.state = "closed";
    this.#init.error(new DOMException("decode failed", "EncodingError"));
  }
}

/** A secure page whose browser has WebCodecs, with the socket and decoder replaced by the fakes. */
export function fakePhoneStream() {
  FakePhoneSocket.all = [];
  FakeVideoDecoder.all = [];
  FakeVideoDecoder.lacks = [];
  vi.stubGlobal("WebSocket", FakePhoneSocket);
  vi.stubGlobal("VideoDecoder", FakeVideoDecoder);
  vi.stubGlobal("EncodedVideoChunk", FakeEncodedVideoChunk);
  vi.stubGlobal("isSecureContext", true);
}

export function showPage(visible: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: visible ? "visible" : "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
}
