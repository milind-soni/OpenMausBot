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
    "control=false",
    "send_device_meta=false",
    "clipboard_autosync=false",
    "power_on=false",
    "max_size=1280",
    "max_fps=30",
    "video_bit_rate=4000000",
  ];
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
