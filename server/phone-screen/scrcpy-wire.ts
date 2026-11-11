// scrcpy's protocol is private to each release (https://github.com/Genymobile/scrcpy/blob/master/doc/develop.md):
// the arguments and stream layout here match scrcpy-server 5.0.1 and no other version.

export const SCRCPY_SERVER = {
  version: "5.0.1",
  sha256: "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536",
  url: "https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1",
};

const scidHex = (scid: number) => scid.toString(16).padStart(8, "0");

export const deviceSocket = (scid: number) => `localabstract:scrcpy_${scidHex(scid)}`;

export const deviceDir = (scid: number) => `/data/local/tmp/openmausbot-scrcpy-${scidHex(scid)}`;

/** The arguments after `com.genymobile.scrcpy.Server`. `scid` is a 31-bit number. */
export function serverArgs(scid: number): string[] {
  return [
    SCRCPY_SERVER.version,
    `scid=${scidHex(scid)}`,
    "log_level=error",
    "tunnel_forward=true",
    "audio=false",
    "control=true",
    "send_device_meta=false",
    "clipboard_autosync=false",
    "power_on=false",
    "max_size=1280",
    "max_fps=30",
    "video_bit_rate=4000000",
  ];
}

/** Android key codes, under the names the Android panel and the phone tool give the keys. */
export const KEYCODES = {
  back: 4,
  home: 3,
  recent: 187,
  enter: 66,
  delete: 67,
  tab: 61,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  wakeup: 224,
} as const;

const INJECT_KEYCODE = 0;
const INJECT_TEXT = 1;
const INJECT_TOUCH_EVENT = 2;
const SET_CLIPBOARD = 9;
const KEY_DOWN = 0;
const KEY_UP = 1;
const PASTE = 1;
const TOUCH_ACTIONS = { down: 0, up: 1, move: 2 };
// scrcpy's SC_POINTER_ID_GENERIC_FINGER, -2.
const GENERIC_FINGER = 0xffff_ffff_ffff_fffen;
const FULL_PRESSURE = 0xffff;
// scrcpy's SC_CONTROL_MSG_INJECT_TEXT_MAX_LENGTH.
const INJECT_TEXT_MAX_BYTES = 300;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function keyEvent(action: number, keycode: number): Buffer {
  const message = Buffer.alloc(14);
  message[0] = INJECT_KEYCODE;
  message[1] = action;
  message.writeUInt32BE(keycode, 2);
  return message;
}

function withText(head: Buffer, text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([head, length, bytes]);
}

/** Messages for the control socket. Coordinates are video pixels; `width` and `height` are the video's size. */
export const control = {
  touch(action: "down" | "up" | "move", x: number, y: number, width: number, height: number): Buffer {
    const message = Buffer.alloc(32);
    message[0] = INJECT_TOUCH_EVENT;
    message[1] = TOUCH_ACTIONS[action];
    message.writeBigUInt64BE(GENERIC_FINGER, 2);
    message.writeUInt32BE(x, 10);
    message.writeUInt32BE(y, 14);
    message.writeUInt16BE(width, 18);
    message.writeUInt16BE(height, 20);
    message.writeUInt16BE(action === "up" ? 0 : FULL_PRESSURE, 22);
    return message;
  },

  /** The key pressed, then released. */
  key(keycode: number): Buffer {
    return Buffer.concat([keyEvent(KEY_DOWN, keycode), keyEvent(KEY_UP, keycode)]);
  },

  /** scrcpy types this as key events, which it can only for printable ASCII of at most 300 bytes. */
  text(ascii: string): Buffer {
    return withText(Buffer.from([INJECT_TEXT]), ascii);
  },

  /** Replaces the phone's clipboard with `text` and pastes it. */
  paste(text: string): Buffer {
    // Bytes 1 to 8 are a sequence number: scrcpy acknowledges only one other than 0.
    const head = Buffer.alloc(10);
    head[0] = SET_CLIPBOARD;
    head[9] = PASTE;
    return withText(head, text);
  },
};

/** The message that enters `text` on the phone. */
export function textMessage(text: string): Buffer {
  return PRINTABLE_ASCII.test(text) && text.length <= INJECT_TEXT_MAX_BYTES ? control.text(text) : control.paste(text);
}

export type VideoPacket =
  | { kind: "session"; width: number; height: number }
  | { kind: "config" | "key" | "delta"; data: Buffer };

export class ScrcpyProtocolError extends Error {}

const CODEC_H264 = Buffer.from("h264");
const PREAMBLE_BYTES = 1 + CODEC_H264.length;
const HEADER_BYTES = 12;
const SESSION_FLAG = 0x80;
const CONFIG_FLAG = 0x40;
const KEY_FRAME_FLAG = 0x20;
// Security: a corrupt length field must not make the server buffer without bound.
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Splits the video socket's bytes into packets, however the bytes were chunked. `data` is H.264 Annex B. */
export class VideoReader {
  #pending: Buffer = Buffer.alloc(0);
  #preambleRead = false;

  push(chunk: Buffer): VideoPacket[] {
    let rest = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
    this.#pending = rest;
    if (!this.#preambleRead) {
      if (rest.length > 0 && rest[0] !== 0) throw new ScrcpyProtocolError("The phone's video stream did not start as scrcpy 5.0.1 starts it.");
      if (rest.length < PREAMBLE_BYTES) return [];
      if (!rest.subarray(1, PREAMBLE_BYTES).equals(CODEC_H264)) throw new ScrcpyProtocolError("The phone did not send H.264 video.");
      rest = rest.subarray(PREAMBLE_BYTES);
      this.#preambleRead = true;
    }
    const packets: VideoPacket[] = [];
    while (rest.length >= HEADER_BYTES) {
      const flags = rest[0];
      let end = HEADER_BYTES;
      if (flags & SESSION_FLAG) {
        packets.push({ kind: "session", width: rest.readUInt32BE(4), height: rest.readUInt32BE(8) });
      } else {
        const size = rest.readUInt32BE(8);
        if (size > MAX_PAYLOAD_BYTES) throw new ScrcpyProtocolError("The phone's video stream announced a frame over 8 MiB.");
        end += size;
        if (rest.length < end) break;
        const kind = flags & CONFIG_FLAG ? "config" : flags & KEY_FRAME_FLAG ? "key" : "delta";
        packets.push({ kind, data: rest.subarray(HEADER_BYTES, end) });
      }
      rest = rest.subarray(end);
    }
    this.#pending = rest;
    return packets;
  }
}
