// Adapted from NousResearch/hermes-agent@a3b993b9 tools/bot_desktop/rfb_filter.py, MIT License, Copyright (c) 2025 Nous
// Research (full text in third_party/hermes-agent/LICENSE); modified: written in TypeScript, the handshake is checked
// rather than assumed, and what a viewer pressed is let go when its input stops being allowed.
//
// Security: noVNC's viewOnly is only a hint to the page; anyone holding the socket could still send input. So the
// client's byte stream is parsed (RFC 6143 section 7.5, plus TigerVNC's EnableContinuousUpdates 150, Fence 248 and
// SetDesktopSize 251, and the QEMU Extended KeyEvent 255 noVNC switches to) and an input message reaches the display
// only while its viewer may give input. RFB messages do not align with WebSocket frames, so this is a stateful parser
// fed arbitrary chunks. A message it cannot frame ends the stream: forwarding it blind would let input hide behind it.

import { fillPage } from "../viewers/viewport.ts";

const KEY_EVENT = 4;
const POINTER_EVENT = 5;
const CLIENT_CUT_TEXT = 6;
const SET_ENCODINGS = 2;
const FENCE = 248;
const SET_DESKTOP_SIZE = 251;
const QEMU = 255;
const XK = { f12: 0xffc9, controlLeft: 0xffe3, controlRight: 0xffe4, shiftLeft: 0xffe1, shiftRight: 0xffe2 } as const;

/** A key message's keysym and whether it presses or releases; null for any other message. */
function keyOf(message: Buffer): { keysym: number; down: boolean } | null {
  if (message[0] === KEY_EVENT) return { keysym: message.readUInt32BE(4), down: message[1] !== 0 };
  if (message[0] === QEMU) return { keysym: message.readUInt32BE(4), down: message.readUInt16BE(2) !== 0 };
  return null;
}

const INPUT_TYPES = new Set([KEY_EVENT, POINTER_EVENT, CLIENT_CUT_TEXT, SET_DESKTOP_SIZE, QEMU]);

/** Fixed-length client messages: type to total length, type byte included. */
const FIXED: ReadonlyMap<number, number> = new Map([
  [0, 20], // SetPixelFormat
  [3, 10], // FramebufferUpdateRequest
  [KEY_EVENT, 8],
  [POINTER_EVENT, 6],
  [150, 10], // EnableContinuousUpdates
  [QEMU, 12], // sub-type 0, Extended KeyEvent, the only one noVNC sends
]);

/** The largest display a person's view may ask for. */
export const DESKTOP_SIZE_LIMITS = { maxWidth: 2560, maxHeight: 2560 } as const;

/** The display server is started with the same -MaxCutText: the length is the client's to declare, so without a cap a
 * viewer could make the proxy buffer up to 2 GiB waiting for a payload. */
export const MAX_CUT_TEXT = 256 * 1024;

/** RFB 3.7 and 3.8 clients answer the server's security types with one byte; 3.3 lets the server choose. */
const VERSIONS = new Set(["RFB 003.008\n", "RFB 003.007\n"]);
const SECURITY_NONE = 1;
const HANDSHAKE_BYTES = 12 + 1 + 1;

export class RfbProtocolError extends Error {}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Turns a SetDesktopSize message, each screen in it too, into the size the page takes for a panel of that size, as the
 * picture view's does (viewers/viewport.ts: a narrow panel gets a desktop-width page of its shape), within the limits;
 * answers that size. */
function clampDesktopSize(message: Buffer): [number, number] {
  const limits = DESKTOP_SIZE_LIMITS;
  const panel = { width: Math.max(1, message.readUInt16BE(2)), height: Math.max(1, message.readUInt16BE(4)) };
  const page = fillPage(panel);
  const width = clamp(page.width, 1, limits.maxWidth);
  const height = clamp(page.height, 1, limits.maxHeight);
  message.writeUInt16BE(width, 2);
  message.writeUInt16BE(height, 4);
  for (let screen = 0; screen < message[6]!; screen++) {
    const at = 8 + 16 * screen;
    message.writeUInt16BE(0, at + 4);
    message.writeUInt16BE(0, at + 6);
    message.writeUInt16BE(width, at + 8);
    message.writeUInt16BE(height, at + 10);
  }
  return [width, height];
}

export interface RfbFilterOptions {
  /** Asked for every input message, so a change of hold applies to the very next key or pointer event. */
  allowInput(): boolean;
  /** An input message was let through. */
  onInput?(): void;
  /** A resize of the display was let through, at this size. */
  onResize?(width: number, height: number): void;
}

export class RfbClientFilter {
  readonly #options: RfbFilterOptions;
  #buffer: Buffer = Buffer.alloc(0);
  #handshake: Buffer = Buffer.alloc(0);
  /** Handshake bytes already passed on. */
  #forwarded = 0;
  /** The release message of each key held down, by keysym or QEMU keycode. */
  readonly #keys = new Map<string, Buffer>();
  /** Keys whose press was swallowed, so their release is too. */
  readonly #swallowed = new Set<number>();
  #buttons = 0;
  #pointer: Buffer = Buffer.from([POINTER_EVENT, 0, 0, 0, 0, 0]);

  constructor(options: RfbFilterOptions) {
    this.#options = options;
  }

  /** The bytes of `chunk` (and of earlier partial messages) that may reach the display. */
  feed(chunk: Buffer): Buffer {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    const out: Buffer[] = [];
    if (this.#handshake.length < HANDSHAKE_BYTES) {
      const take = Math.min(HANDSHAKE_BYTES - this.#handshake.length, this.#buffer.length);
      this.#handshake = Buffer.concat([this.#handshake, this.#buffer.subarray(0, take)]);
      this.#buffer = this.#buffer.subarray(take);
      // Each step goes on as soon as it is whole and checked: the server answers it before the client sends the next.
      let checked = 0;
      if (this.#handshake.length >= 12) {
        if (!VERSIONS.has(this.#handshake.subarray(0, 12).toString("latin1"))) throw new RfbProtocolError("unsupported RFB version");
        checked = 12;
      }
      if (this.#handshake.length >= 13) {
        if (this.#handshake[12] !== SECURITY_NONE) throw new RfbProtocolError("unexpected security type");
        checked = 13;
      }
      // ClientInit's shared flag: a viewer never disconnects the others.
      if (this.#handshake.length === HANDSHAKE_BYTES) {
        this.#handshake[HANDSHAKE_BYTES - 1] = 1;
        checked = HANDSHAKE_BYTES;
      }
      out.push(this.#handshake.subarray(this.#forwarded, checked));
      this.#forwarded = Math.max(this.#forwarded, checked);
      if (this.#handshake.length < HANDSHAKE_BYTES) return Buffer.concat(out);
    }
    while (this.#buffer.length) {
      const length = this.#messageLength();
      if (length === null || this.#buffer.length < length) break;
      const message = Buffer.from(this.#buffer.subarray(0, length));
      this.#buffer = this.#buffer.subarray(length);
      if (!INPUT_TYPES.has(message[0]!)) {
        out.push(message);
        continue;
      }
      if (!this.#options.allowInput()) {
        out.push(this.release());
        continue;
      }
      if (this.#swallow(message)) continue;
      this.#track(message);
      if (message[0] === SET_DESKTOP_SIZE) this.#options.onResize?.(...clampDesktopSize(message));
      this.#options.onInput?.();
      out.push(message);
    }
    if (this.#buffer.length) this.#buffer = Buffer.from(this.#buffer);
    return Buffer.concat(out);
  }

  /** Messages that let go of every key and button this viewer holds down; empty when it holds none. */
  release(): Buffer {
    const out = [...this.#keys.values()];
    this.#keys.clear();
    if (this.#buttons !== 0) {
      const up = Buffer.from(this.#pointer);
      up[1] = 0;
      out.push(up);
      this.#buttons = 0;
    }
    return Buffer.concat(out);
  }

  /** Whether a key or button of this viewer is down. */
  get holding(): boolean {
    return this.#keys.size > 0 || this.#buttons !== 0;
  }

  /** A key of one of the keyboard's ways into DevTools or printing (F12, Ctrl+Shift+I or J, Ctrl+P), its release too:
   * without a window manager their windows would sit over the page, and the policy blanks what they would show. */
  #swallow(message: Buffer): boolean {
    const key = keyOf(message);
    if (!key) return false;
    if (!key.down) return this.#swallowed.delete(key.keysym);
    const held = [...this.#keys.values()].map((sent) => keyOf(sent)?.keysym);
    const control = held.some((keysym) => keysym === XK.controlLeft || keysym === XK.controlRight);
    const shift = held.some((keysym) => keysym === XK.shiftLeft || keysym === XK.shiftRight);
    const letter = String.fromCharCode(key.keysym).toLowerCase();
    const blocked = key.keysym === XK.f12 || (control && shift && "ij".includes(letter) && key.keysym < 0x100) || (control && !shift && letter === "p" && key.keysym < 0x100);
    if (blocked) this.#swallowed.add(key.keysym);
    return blocked;
  }

  #track(message: Buffer): void {
    if (message[0] === KEY_EVENT) {
      const key = `k${message.readUInt32BE(4)}`;
      if (message[1]) {
        const up = Buffer.from(message);
        up[1] = 0;
        this.#keys.set(key, up);
      } else {
        this.#keys.delete(key);
      }
    } else if (message[0] === QEMU) {
      const key = `q${message.readUInt32BE(8)}`;
      if (message.readUInt16BE(2)) {
        const up = Buffer.from(message);
        up.writeUInt16BE(0, 2);
        this.#keys.set(key, up);
      } else {
        this.#keys.delete(key);
      }
    } else if (message[0] === POINTER_EVENT) {
      this.#buttons = message[1]!;
      this.#pointer = Buffer.from(message);
    }
  }

  #messageLength(): number | null {
    const buffer = this.#buffer;
    const type = buffer[0]!;
    if (type === QEMU && buffer.length >= 2 && buffer[1] !== 0) throw new RfbProtocolError(`unknown QEMU message ${buffer[1]}`);
    const fixed = FIXED.get(type);
    if (fixed !== undefined) return fixed;
    if (type === SET_ENCODINGS) return buffer.length < 4 ? null : 4 + 4 * buffer.readUInt16BE(2);
    if (type === CLIENT_CUT_TEXT) {
      if (buffer.length < 8) return null;
      // Extended clipboard (TigerVNC): a negative length, its absolute value in bytes follows.
      const length = Math.abs(buffer.readInt32BE(4));
      if (length > MAX_CUT_TEXT) throw new RfbProtocolError("clipboard message too large");
      return 8 + length;
    }
    if (type === FENCE) return buffer.length < 9 ? null : 9 + buffer[8]!;
    if (type === SET_DESKTOP_SIZE) return buffer.length < 8 ? null : 8 + 16 * buffer[6]!;
    throw new RfbProtocolError(`unknown RFB client message ${type}`);
  }
}
