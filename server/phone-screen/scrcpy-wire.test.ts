import { isDeepStrictEqual } from "node:util";

import { describe, expect, it } from "vitest";

import { SCRCPY_VIDEO, SCRCPY_VIDEO_PACKETS } from "../testing/scrcpy-video.ts";
import { deviceSocket, SCRCPY_SERVER, ScrcpyProtocolError, serverArgs, VideoReader, type VideoPacket } from "./scrcpy-wire.ts";

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

  it("starts view-only, without waking the phone, syncing its clipboard or logging below errors", () => {
    expect(serverArgs(0x1a2b3c)).toEqual([
      "5.0.1",
      "scid=001a2b3c",
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
    ]);
    expect(serverArgs(0x7fffffff)[1]).toBe("scid=7fffffff");
  });

  it("listens on the phone under the same scid", () => {
    expect(deviceSocket(0x1a2b3c)).toBe("localabstract:scrcpy_001a2b3c");
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
