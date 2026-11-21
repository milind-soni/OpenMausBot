import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { concat, utf8 } from "./bytes.ts";
import {
  decodeFrame,
  encodeFrame,
  GO_AWAY,
  goAwayFrame,
  INITIAL_WINDOW,
  MAX_DATA_PAYLOAD,
  Mux,
  STREAM_WINDOW,
  YamuxError,
  type Frame,
  type MuxEvents,
  type Role,
} from "./yamux.ts";

const v = JSON.parse(readFileSync(new URL("../../../companion/src/e2e/vectors/v1.json", import.meta.url), "utf8"));
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (data: Uint8Array) => Buffer.from(data).toString("hex");

describe("V5 yamux codec, browser", () => {
  it.each(v.V5 as Array<{ name: string; type: number; flags: number; streamId: number; length: number; hex: string }>)("$name: decodes and encodes byte for byte", (frame) => {
    const decoded = decodeFrame(bytes(frame.hex));
    expect({ type: decoded.type, flags: decoded.flags, streamId: decoded.streamId, length: decoded.length }).toEqual({
      type: frame.type,
      flags: frame.flags,
      streamId: frame.streamId,
      length: frame.length,
    });
    expect(hex(encodeFrame(decoded))).toBe(frame.hex);
  });

  it("encodes into a plain ArrayBuffer-backed array, which WebCrypto takes", () => {
    const encoded = encodeFrame({ type: 0, flags: 0, streamId: 1, length: 3, data: utf8("abc") });
    expect(encoded.buffer).toBeInstanceOf(ArrayBuffer);
    expect(encoded.byteOffset).toBe(0);
    expect(encoded.byteLength).toBe(15);
  });

  it("refuses to encode data whose length field disagrees with the payload, or a payload over the cap", () => {
    expect(() => encodeFrame({ type: 0, flags: 0, streamId: 1, length: 2, data: utf8("abc") })).toThrow(YamuxError);
    const big = new Uint8Array(MAX_DATA_PAYLOAD + 1);
    expect(() => encodeFrame({ type: 0, flags: 0, streamId: 1, length: big.length, data: big })).toThrow(YamuxError);
  });

  it("decodes a frame that sits at an offset inside a larger buffer", () => {
    const frame = bytes(v.V5[0].hex);
    const inner = concat(Uint8Array.of(9, 9, 9), frame, Uint8Array.of(9)).subarray(3, 3 + frame.length);
    expect(hex(encodeFrame(decodeFrame(inner)))).toBe(v.V5[0].hex);
  });
});

type ScriptStep = { open: true } | { consume: { stream: number; bytes: number } } | { in: { header: string; payload?: string; fill?: number } };

/** Reads the script exactly as a phone implementation would, from the JSON alone. */
function runScript(role: Role, accept: string | undefined, steps: ScriptStep[]) {
  const sent: string[] = [];
  const mux: Mux = new Mux(role, {
    send: (frame: Frame) => sent.push(hex(encodeFrame(frame))),
    opened: (id) => (accept === "never" ? undefined : mux.accept(id)),
    data: () => {},
    ended: () => {},
    reset: () => {},
    writable: () => {},
  });
  for (const [index, step] of steps.entries()) {
    try {
      if ("open" in step) mux.open();
      else if ("consume" in step) mux.consumed(step.consume.stream, step.consume.bytes);
      else {
        const header = bytes(step.in.header);
        const length = new DataView(header.buffer).getUint32(8);
        const payload = step.in.fill !== undefined ? new Uint8Array(length).fill(step.in.fill) : bytes(step.in.payload ?? "");
        mux.receive(decodeFrame(concat(header, payload)));
      }
    } catch (error) {
      if (!(error instanceof YamuxError)) throw error;
      return { errorAt: index };
    }
  }
  return { sent };
}

describe("V6 must fail, yamux, browser", () => {
  it.each(v.V6.frames as Array<{ name: string; hex: string }>)("frame: $name", (c) => {
    expect(() => decodeFrame(bytes(c.hex))).toThrow(YamuxError);
  });

  it.each(v.V6.sessions as Array<{ name: string; role: Role; accept?: string; steps: ScriptStep[]; expect: { errorAt?: number; sent?: string[] } }>)(
    "session: $name",
    (c) => {
      expect(runScript(c.role, c.accept, c.steps)).toEqual(c.expect);
    },
  );
});

/** A phone and a computer wired back to back through the real codec. */
function pair(options: { autoAccept?: boolean } = {}) {
  const log: string[] = [];
  const received = new Map<number, Uint8Array[]>();
  const events = (side: "phone" | "computer", deliver: (frame: Frame) => void): MuxEvents => ({
    send: (frame) => deliver(decodeFrame(encodeFrame(frame))),
    opened: (id) => {
      log.push(`${side} opened ${id}`);
      if (options.autoAccept !== false) computer.accept(id);
    },
    accepted: (id) => log.push(`${side} accepted ${id}`),
    data: (id, data) => received.set(id, [...(received.get(id) ?? []), data.slice()]),
    ended: (id) => log.push(`${side} ended ${id}`),
    reset: (id) => log.push(`${side} reset ${id}`),
    writable: () => {},
    pong: (value) => log.push(`${side} pong ${value}`),
    goAway: (code) => log.push(`${side} goaway ${code}`),
  });
  const phone: Mux = new Mux("phone", events("phone", (frame) => computer.receive(frame)));
  const computer: Mux = new Mux("computer", events("computer", (frame) => phone.receive(frame)));
  return { phone, computer, log, received };
}

describe("the browser mux", () => {
  it("opens, carries both ways, half-closes each side and forgets the stream", () => {
    const { phone, computer, log, received } = pair();
    const id = phone.open();
    expect(id).toBe(1);
    expect(phone.write(id, utf8("request"))).toBe(7);
    expect(computer.write(id, utf8("response"))).toBe(8);
    phone.finish(id);
    expect(computer.has(id)).toBe(true);
    computer.finish(id);
    expect(log).toEqual(["computer opened 1", "phone accepted 1", "computer ended 1", "phone ended 1"]);
    expect(new TextDecoder().decode(concat(...received.get(1)!))).toBe("requestresponse");
    expect(phone.has(id)).toBe(false);
    expect(computer.has(id)).toBe(false);
  });

  it("opens odd stream IDs in order", () => {
    const { phone } = pair();
    expect([phone.open(), phone.open(), phone.open()]).toEqual([1, 3, 5]);
  });

  it("lets the phone send only 256 KiB before the accept, then 2 MiB", () => {
    const { phone, computer } = pair({ autoAccept: false });
    const id = phone.open();
    let sent = 0;
    for (let taken = 1; taken > 0; sent += taken) taken = phone.write(id, new Uint8Array(MAX_DATA_PAYLOAD));
    expect(sent).toBe(INITIAL_WINDOW);
    computer.accept(id);
    expect(phone.sendWindow(id)).toBe(STREAM_WINDOW - INITIAL_WINDOW);
  });

  it("grants window back only as the receiver consumes", () => {
    const { phone, computer } = pair();
    const id = phone.open();
    while (phone.write(id, new Uint8Array(MAX_DATA_PAYLOAD)) > 0);
    expect(phone.sendWindow(id)).toBe(0);
    computer.consumed(id, 1024 * 1024 - 1);
    expect(phone.sendWindow(id)).toBe(0);
    computer.consumed(id, 1);
    expect(phone.sendWindow(id)).toBe(1024 * 1024);
  });

  it("resets: the RST reaches the other side and later frames for the stream are ignored", () => {
    const { phone, computer, log } = pair();
    const id = phone.open();
    computer.reset(id);
    expect(log).toContain("phone reset 1");
    expect(phone.write(id, utf8("late"))).toBe(0);
    expect(() => computer.receive({ type: 0, flags: 0, streamId: 1, length: 1, data: utf8("x") })).not.toThrow();
  });

  it("answers pings with the same value", () => {
    const { phone, log } = pair();
    phone.ping(42);
    expect(log).toContain("phone pong 42");
  });

  it("stops opening after a GoAway either way", () => {
    const { phone, computer, log } = pair();
    computer.goAway();
    expect(log).toContain("phone goaway 0");
    expect(() => phone.open()).toThrow(YamuxError);
  });

  it("refuses 65 open streams on the phone itself", () => {
    const { phone } = pair();
    for (let index = 0; index < 64; index += 1) phone.open();
    expect(() => phone.open()).toThrow(YamuxError);
  });

  it("treats a stream the computer opens as a protocol error", () => {
    const { phone } = pair();
    expect(() => phone.receive({ type: 1, flags: 1, streamId: 2, length: 0 })).toThrow(YamuxError);
  });
});

describe("the browser mux, after the peer's FIN and inside callbacks", () => {
  /** A phone mux whose callbacks are recorded, and may act on the mux while it handles a frame. */
  function phoneWith(onEvent: (mux: Mux, event: string, id: number) => void = () => {}) {
    const log: string[] = [];
    const note = (event: string) => (id: number) => {
      log.push(`${event} ${id}`);
      onEvent(mux, event, id);
    };
    const mux: Mux = new Mux("phone", {
      send: () => {},
      accepted: note("accepted"),
      data: note("data"),
      ended: note("ended"),
      reset: note("reset"),
      writable: note("writable"),
    });
    return { mux, log };
  }

  it("refuses an empty Data frame after the peer's FIN, but still takes window for the open local half", () => {
    const { mux } = phoneWith();
    const id = mux.open();
    mux.receive({ type: 1, flags: 2 | 4, streamId: id, length: 0 });
    const window = mux.sendWindow(id);
    mux.receive({ type: 1, flags: 0, streamId: id, length: 10 });
    expect(mux.sendWindow(id)).toBe(window + 10);
    expect(() => mux.receive({ type: 0, flags: 0, streamId: id, length: 0, data: new Uint8Array(0) })).toThrow(YamuxError);
  });

  it("refuses Data on a phone-opened stream before the computer's ACK, and delivers none of it", () => {
    const { mux, log } = phoneWith();
    const id = mux.open();
    expect(() => mux.receive({ type: 0, flags: 0, streamId: id, length: 1, data: new Uint8Array([7]) })).toThrow("data_before_ack");
    expect(log.filter((entry) => entry.startsWith("data"))).toEqual([]);
  });

  it("stops handling a frame once the data callback resets the stream", () => {
    const { mux, log } = phoneWith((m, event, id) => event === "data" && m.reset(id));
    const id = mux.open();
    mux.receive({ type: 1, flags: 2, streamId: id, length: 0 });
    mux.receive({ type: 0, flags: 4, streamId: id, length: 1, data: utf8("x") });
    expect(log).toEqual(["accepted 1", "data 1", "reset 1"]);
  });

  it("stops handling a frame once the accepted or writable callback resets the stream", () => {
    const accepted = phoneWith((m, event, id) => event === "accepted" && m.reset(id));
    const first = accepted.mux.open();
    accepted.mux.receive({ type: 1, flags: 2 | 4, streamId: first, length: 0 });
    expect(accepted.log).toEqual(["accepted 1", "reset 1"]);

    const writable = phoneWith((m, event, id) => event === "writable" && m.reset(id));
    const second = writable.mux.open();
    writable.mux.receive({ type: 1, flags: 2, streamId: second, length: 0 });
    writable.mux.receive({ type: 1, flags: 4, streamId: second, length: 10 });
    expect(writable.log).toEqual(["accepted 1", "writable 1", "reset 1"]);
  });

  it("refuses a second FIN on a WindowUpdate before granting its window", () => {
    const { mux, log } = phoneWith();
    const id = mux.open();
    mux.receive({ type: 1, flags: 2 | 4, streamId: id, length: 0 });
    expect(() => mux.receive({ type: 1, flags: 4, streamId: id, length: 10 })).toThrow(YamuxError);
    expect(log).toEqual(["accepted 1", "ended 1"]);
  });
});

describe("the browser mux, GoAway(removed)", () => {
  const withGoAway = (role: Role) => {
    const codes: number[] = [];
    const mux = new Mux(role, { send: () => {}, data: () => {}, ended: () => {}, reset: () => {}, writable: () => {}, goAway: (code) => codes.push(code) });
    return { mux, codes };
  };

  it("the phone takes GoAway(3) from the computer", () => {
    const { mux, codes } = withGoAway("phone");
    mux.receive({ type: 3, flags: 0, streamId: 0, length: GO_AWAY.removed });
    expect(codes).toEqual([GO_AWAY.removed]);
  });

  it("the computer refuses GoAway(3) from a phone as a protocol error", () => {
    const { mux, codes } = withGoAway("computer");
    expect(() => mux.receive({ type: 3, flags: 0, streamId: 0, length: GO_AWAY.removed })).toThrow(YamuxError);
    expect(codes).toEqual([]);
    mux.receive({ type: 3, flags: 0, streamId: 0, length: GO_AWAY.normal });
    expect(codes).toEqual([GO_AWAY.normal]);
  });

  it("the phone never sends GoAway(3); its other codes and the computer's GoAway(3) still go out", () => {
    const sent = (role: Role, code: number) => {
      const frames: Frame[] = [];
      const mux = new Mux(role, { send: (frame) => frames.push(frame), data: () => {}, ended: () => {}, reset: () => {}, writable: () => {} });
      try {
        mux.goAway(code);
      } catch (error) {
        return { frames, error };
      }
      return { frames, error: undefined };
    };
    const refused = sent("phone", GO_AWAY.removed);
    expect(refused.error).toBeInstanceOf(YamuxError);
    expect(refused.frames).toEqual([]);
    expect(sent("phone", GO_AWAY.normal).frames).toEqual([goAwayFrame(GO_AWAY.normal)]);
    expect(sent("phone", GO_AWAY.protocol).frames).toEqual([goAwayFrame(GO_AWAY.protocol)]);
    expect(sent("computer", GO_AWAY.removed).frames).toEqual([goAwayFrame(GO_AWAY.removed)]);
  });
});
