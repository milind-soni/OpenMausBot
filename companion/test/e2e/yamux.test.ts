import { describe, expect, it } from "vitest";

import {
  decodeFrame,
  encodeFrame,
  INITIAL_WINDOW,
  MAX_DATA_PAYLOAD,
  Mux,
  STREAM_WINDOW,
  YamuxError,
  type Frame,
  type MuxEvents,
} from "../../src/e2e/yamux.ts";

/** A phone and a computer wired back to back through the real codec. */
function pair(options: { autoAccept?: boolean } = {}) {
  const log: string[] = [];
  const received = new Map<number, Buffer[]>();
  const events = (side: "phone" | "computer", deliver: (frame: Frame) => void): MuxEvents => ({
    send: (frame) => deliver(decodeFrame(encodeFrame(frame))),
    opened: (id) => {
      log.push(`${side} opened ${id}`);
      if (options.autoAccept !== false) computer.accept(id);
    },
    accepted: (id) => log.push(`${side} accepted ${id}`),
    data: (id, data) => received.set(id, [...(received.get(id) ?? []), Buffer.from(data)]),
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

describe("the mux", () => {
  it("opens, carries both ways, half-closes each side and forgets the stream", () => {
    const { phone, computer, log, received } = pair();
    const id = phone.open();
    expect(id).toBe(1);
    expect(phone.write(id, Buffer.from("request"))).toBe(7);
    expect(computer.write(id, Buffer.from("response"))).toBe(8);
    phone.finish(id);
    expect(computer.has(id)).toBe(true);
    computer.finish(id);
    expect(log).toEqual(["computer opened 1", "phone accepted 1", "computer ended 1", "phone ended 1"]);
    expect(Buffer.concat(received.get(1)!).toString()).toBe("requestresponse");
    expect(phone.has(id)).toBe(false);
    expect(computer.has(id)).toBe(false);
  });

  it("lets the phone send only 256 KiB before the accept, then 2 MiB", () => {
    const { phone, computer } = pair({ autoAccept: false });
    const id = phone.open();
    let sent = 0;
    for (let taken = 1; taken > 0; sent += taken) taken = phone.write(id, Buffer.alloc(MAX_DATA_PAYLOAD));
    expect(sent).toBe(INITIAL_WINDOW);
    computer.accept(id);
    expect(phone.sendWindow(id)).toBe(STREAM_WINDOW - INITIAL_WINDOW);
  });

  it("grants window back only as the receiver consumes", () => {
    const { phone, computer } = pair();
    const id = phone.open();
    while (phone.write(id, Buffer.alloc(MAX_DATA_PAYLOAD)) > 0);
    expect(phone.sendWindow(id)).toBe(0);
    computer.consumed(id, 1024 * 1024 - 1);
    expect(phone.sendWindow(id)).toBe(0);
    computer.consumed(id, 1);
    expect(phone.sendWindow(id)).toBe(1024 * 1024);
  });

  it("keeps the computer from sending before it accepts", () => {
    const { phone, computer } = pair({ autoAccept: false });
    const id = phone.open();
    expect(computer.write(id, Buffer.from("early"))).toBe(0);
  });

  it("resets: the RST reaches the other side and later frames for the stream are ignored", () => {
    const { phone, computer, log } = pair();
    const id = phone.open();
    computer.reset(id);
    expect(log).toContain("phone reset 1");
    expect(phone.write(id, Buffer.from("late"))).toBe(0);
    expect(() => computer.receive({ type: 0, flags: 0, streamId: 1, length: 1, data: Buffer.from("x") })).not.toThrow();
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

  it("never opens a stream from the computer", () => {
    const { computer } = pair();
    expect(() => computer.open()).toThrow(YamuxError);
  });
});
