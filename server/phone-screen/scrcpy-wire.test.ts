import { isDeepStrictEqual } from "node:util";

import { describe, expect, it } from "vitest";

import { SCRCPY_VIDEO, SCRCPY_VIDEO_PACKETS } from "../testing/scrcpy-video.ts";
import { control, deviceSocket, KEYCODES, SCRCPY_SERVER, ScrcpyProtocolError, serverArgs, textMessage, VideoReader, type VideoPacket } from "./scrcpy-wire.ts";

const PREAMBLE = Buffer.from("0068323634", "hex");
const hex = (packet: VideoPacket | undefined, bytes: number) =>
  packet && packet.kind !== "session" ? packet.data.subarray(0, bytes).toString("hex") : "";
const size = (packet: VideoPacket | undefined) => (packet && packet.kind !== "session" ? packet.data.length : 0);
const same = (packets: VideoPacket[]) => isDeepStrictEqual(packets, SCRCPY_VIDEO_PACKETS);

describe("the scrcpy server this client is written for", () => {
  it("is release 5.0.1 by digest", () => {
    expect(SCRCPY_SERVER).toEqual({
      version: "5.0.1",
      sha256: "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536",
      url: "https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1",
    });
  });

  it("starts with a control socket, without waking the phone, syncing its clipboard or logging below errors", () => {
    expect(serverArgs(0x1a2b3c)).toEqual([
      "5.0.1",
      "scid=001a2b3c",
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
    ]);
    expect(serverArgs(0x7fffffff)[1]).toBe("scid=7fffffff");
  });

  it("listens on the phone under the same scid", () => {
    expect(deviceSocket(0x1a2b3c)).toBe("localabstract:scrcpy_001a2b3c");
  });
});

// The expected bytes are the arrays in scrcpy v5.0.1's app/tests/test_control_msg_serialize.c, field by field. Where
// a field holds another value than in scrcpy's test, the comment beside it gives scrcpy's.
describe("control messages", () => {
  const sent = (message: Buffer) => message.toString("hex");
  const fields = (...parts: string[]) => parts.join("");
  const ascii = (text: string) => Buffer.from(text, "latin1").toString("hex");
  const NO_SEQUENCE = "0000000000000000";

  it.each([
    ["down", "00", "ffff"],
    ["up", "01", "0000"],
    ["move", "02", "ffff"],
  ] as const)("builds a touch %s of scrcpy's generic finger with no button", (action, actionByte, pressure) => {
    // test_serialize_inject_touch_event, which is the "down" row.
    expect(sent(control.touch(action, 100, 200, 1080, 1920))).toBe(
      fields(
        "02",
        actionByte,
        "fffffffffffffffe", // scrcpy's test: pointer id 1234567887654321
        "00000064",
        "000000c8",
        "0438",
        "0780",
        pressure,
        "00000000", // scrcpy's test: action button 00000001
        "00000000", // scrcpy's test: buttons 00000001
      ),
    );
  });

  it("builds a key as its press, then its release", () => {
    // test_serialize_inject_keycode, which is the release, with repeat 00000005 and metastate 00000041.
    expect(sent(control.key(66))).toBe(
      fields("00", "00", "00000042", "00000000", "00000000") + fields("00", "01", "00000042", "00000000", "00000000"),
    );
  });

  it.each([
    // test_serialize_inject_text
    ["hello, world!", "0000000d"],
    // test_serialize_inject_text_long
    ["a".repeat(300), "0000012c"],
  ])("builds injected text with its length before it", (text, length) => {
    expect(sent(control.text(text))).toBe(fields("01", length, ascii(text)));
  });

  it("builds a clipboard to set and paste", () => {
    // test_serialize_set_clipboard, with sequence 0102030405060708.
    expect(sent(control.paste("hello, world!"))).toBe(fields("09", NO_SEQUENCE, "01", "0000000d", ascii("hello, world!")));
  });

  it.each([
    ["injects", "letters", "abc", fields("01", "00000003", "616263")],
    ["injects", "the first and the last printable character", " ~", fields("01", "00000002", "207e")],
    ["injects", "300 bytes", "a".repeat(300), fields("01", "0000012c", "61".repeat(300))],
    ["pastes", "301 bytes", "a".repeat(301), fields("09", NO_SEQUENCE, "01", "0000012d", "61".repeat(301))],
    ["pastes", "Chinese", "你好", fields("09", NO_SEQUENCE, "01", "00000006", "e4bda0e5a5bd")],
    ["pastes", "a tab", "a\tb", fields("09", NO_SEQUENCE, "01", "00000003", "610962")],
    ["pastes", "the character after the last printable one", "\x7f", fields("09", NO_SEQUENCE, "01", "00000001", "7f")],
    ["pastes", "the character before the first printable one", "\x1f", fields("09", NO_SEQUENCE, "01", "00000001", "1f")],
  ])("%s %s", (_how, _what, text, message) => {
    expect(sent(textMessage(text))).toBe(message);
  });

  it("knows the Android key codes of the phone panel's keys, and no others", () => {
    expect(KEYCODES).toEqual({ back: 4, home: 3, recent: 187, enter: 66, delete: 67, tab: 61, up: 19, down: 20, left: 21, right: 22, wakeup: 224 });
  });
});

describe("VideoReader", () => {
  it("reads a real phone's stream: its size, the encoder's parameters, a key frame, then the frames after it", () => {
    const reader = new VideoReader();
    const packets = reader.push(SCRCPY_VIDEO);

    expect(SCRCPY_VIDEO).toHaveLength(3006);
    expect(packets.map((packet) => packet.kind)).toEqual(["session", "config", "key", ...Array<string>(10).fill("delta")]);
    expect(packets[0]).toEqual({ kind: "session", width: 720, height: 1280 });
    expect([size(packets[1]), hex(packets[1], 8)]).toEqual([21, "000000016742c020"]);
    expect([size(packets[2]), hex(packets[2], 5)]).toEqual([2717, "0000000165"]);
    for (const delta of packets.slice(3)) {
      expect([10, 11]).toContain(size(delta));
      expect(hex(delta, 5)).toBe("0000000161");
    }
    expect(PREAMBLE.length + packets.length * 12 + packets.reduce((bytes, packet) => bytes + size(packet), 0)).toBe(3006);
    expect(packets).toEqual(SCRCPY_VIDEO_PACKETS);
    // Nothing is left over: the reader is at a packet boundary, so the same packets parse again.
    expect(reader.push(SCRCPY_VIDEO.subarray(PREAMBLE.length))).toEqual(SCRCPY_VIDEO_PACKETS);
  });

  it("reads the same packets wherever the stream is cut in two", () => {
    const wrongCuts: number[] = [];
    for (let cut = 0; cut < SCRCPY_VIDEO.length; cut++) {
      const reader = new VideoReader();
      const packets = [...reader.push(SCRCPY_VIDEO.subarray(0, cut)), ...reader.push(SCRCPY_VIDEO.subarray(cut))];
      if (!same(packets)) wrongCuts.push(cut);
    }
    expect(wrongCuts).toEqual([]);
  });

  const header = (payloadBytes: number) => {
    const bytes = Buffer.alloc(12);
    bytes.writeUInt32BE(payloadBytes, 8);
    return bytes;
  };

  it.each([
    ["does not start with scrcpy's dummy byte", Buffer.from([1])],
    ["starts with another byte than 00", Buffer.concat([Buffer.from([1]), SCRCPY_VIDEO.subarray(1)])],
    ["carries another codec than H.264", Buffer.concat([Buffer.from("0068323635", "hex"), SCRCPY_VIDEO.subarray(5)])],
    ["announces a frame over 8 MiB", Buffer.concat([PREAMBLE, header(8 * 1024 * 1024 + 1)])],
  ])("refuses a stream that %s", (_what, stream) => {
    expect(() => new VideoReader().push(stream)).toThrow(ScrcpyProtocolError);
  });

  it("waits for the rest of a frame of exactly 8 MiB", () => {
    expect(new VideoReader().push(Buffer.concat([PREAMBLE, header(8 * 1024 * 1024)]))).toEqual([]);
  });
});
