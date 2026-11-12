// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakePhoneSocket, FakeVideoDecoder, PHONE_CONFIG, PHONE_DELTA_FRAME, PHONE_KEY_FRAME, fakePhoneStream, showPage } from "@/testing/phone-stream";
import { createPhoneStreamClient, phoneStreamUrl, type PhoneStreamClient, type PhoneStreamView } from "./phone-stream-client";

const clients: PhoneStreamClient[] = [];
const views: PhoneStreamView[] = [];
const view = () => views[views.length - 1];
const start = () => {
  views.length = 0;
  const canvas = document.createElement("canvas");
  const client = createPhoneStreamClient({ serial: "p1", canvas }, (next) => views.push(next));
  clients.push(client);
  return { client, canvas, socket: FakePhoneSocket.current };
};
/** A connected viewer whose first frame, 720 by 1280, is on the canvas. */
const watch = () => {
  const started = start();
  started.socket.packet(1, PHONE_CONFIG);
  started.socket.packet(2, PHONE_KEY_FRAME);
  FakeVideoDecoder.current.frame(720, 1280);
  return started;
};

beforeEach(fakePhoneStream);
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  Reflect.deleteProperty(document, "visibilityState");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the phone stream's address", () => {
  it("is the phone's stream route on the page's own origin", () => {
    expect(phoneStreamUrl("p1", { protocol: "http:", host: "omb.test" })).toBe("ws://omb.test/api/usb-phones/p1/stream");
    expect(phoneStreamUrl("a b", { protocol: "https:", host: "cloud.test" })).toBe("wss://cloud.test/api/usb-phones/a%20b/stream");
  });
});

describe("phone stream video", () => {
  it("configures the decoder once from the phone's parameter sets, then feeds the key frame with them in front and the next frame alone", () => {
    const { socket } = start();
    expect(view().status).toEqual({ kind: "connecting" });
    socket.packet(1, PHONE_CONFIG);
    socket.packet(2, PHONE_KEY_FRAME);
    socket.packet(3, PHONE_DELTA_FRAME);

    expect(socket.binaryType).toBe("arraybuffer");
    expect(FakeVideoDecoder.all).toHaveLength(1);
    const decoder = FakeVideoDecoder.current;
    expect(decoder.configured).toEqual([{ codec: "avc1.42c020", optimizeForLatency: true }]);
    expect(decoder.chunks.map((chunk) => chunk.type)).toEqual(["key", "delta"]);
    expect([...decoder.chunks[0].data]).toEqual([...PHONE_CONFIG, ...PHONE_KEY_FRAME]);
    expect([...decoder.chunks[1].data]).toEqual([...PHONE_DELTA_FRAME]);
  });

  it("sizes the canvas to each decoded frame, closes it, and follows a rotation", () => {
    const { socket, canvas } = start();
    socket.packet(1, PHONE_CONFIG);
    const upright = FakeVideoDecoder.current.frame(720, 1280);
    expect(upright.close).toHaveBeenCalledOnce();
    expect([canvas.width, canvas.height]).toEqual([720, 1280]);
    expect(view()).toMatchObject({ status: { kind: "live" }, frame: { width: 720, height: 1280 } });

    const turned = FakeVideoDecoder.current.frame(1280, 720);
    expect(turned.close).toHaveBeenCalledOnce();
    expect([canvas.width, canvas.height]).toEqual([1280, 720]);
    expect(view().frame).toEqual({ width: 1280, height: 720 });
  });

  it("closes the stream and connects again when the decoder fails", () => {
    vi.useFakeTimers();
    const { socket } = watch();
    FakeVideoDecoder.current.fail();
    expect(socket.readyState).toBe(3);
    expect(view().status).toEqual({ kind: "connecting" });
    vi.advanceTimersByTime(500);
    expect(FakePhoneSocket.all).toHaveLength(2);
  });

  it("closes the stream and connects again when the decoder refuses a frame", () => {
    vi.useFakeTimers();
    const { socket } = watch();
    vi.spyOn(FakeVideoDecoder.current, "decode").mockImplementation(() => {
      throw new DOMException("the decoder is closed", "InvalidStateError");
    });
    socket.packet(3, PHONE_DELTA_FRAME);
    expect(socket.readyState).toBe(3);
    expect(view().status).toEqual({ kind: "connecting" });
    vi.advanceTimersByTime(500);
    expect(FakePhoneSocket.all).toHaveLength(2);
  });
});

describe("phone stream control and input", () => {
  it("follows the server's word on who holds the phone", () => {
    const { socket } = start();
    expect(view().held).toBe(false);
    socket.control(true);
    expect(view().held).toBe(true);
    socket.control(false);
    expect(view().held).toBe(false);
  });

  it("sends take, hand back, touches with the frame's size, keys and text as the server reads them", () => {
    const { client, socket } = watch();
    client.take();
    client.touch("down", 10, 20);
    client.touch("move", 30, 40);
    client.touch("up", 30, 40);
    client.key("back");
    client.key("wakeup");
    client.text("你好");
    client.handBack();
    expect(socket.sent).toEqual([
      { type: "take" },
      { type: "touch", action: "down", x: 10, y: 20, w: 720, h: 1280 },
      { type: "touch", action: "move", x: 30, y: 40, w: 720, h: 1280 },
      { type: "touch", action: "up", x: 30, y: 40, w: 720, h: 1280 },
      { type: "key", key: "back" },
      { type: "key", key: "wakeup" },
      { type: "text", text: "你好" },
      { type: "handBack" },
    ]);

    FakeVideoDecoder.current.frame(1280, 720);
    client.touch("down", 5, 6);
    expect(socket.sent[socket.sent.length - 1]).toEqual({ type: "touch", action: "down", x: 5, y: 6, w: 1280, h: 720 });
  });

  it("splits text over 300 characters into messages of at most 300, keeping an emoji whole", () => {
    const { client, socket } = watch();
    client.text("a".repeat(650));
    expect(socket.sent).toEqual([
      { type: "text", text: "a".repeat(300) },
      { type: "text", text: "a".repeat(300) },
      { type: "text", text: "a".repeat(50) },
    ]);
    socket.sent.length = 0;
    client.text(`${"a".repeat(299)}😀b`);
    expect(socket.sent).toEqual([{ type: "text", text: "a".repeat(299) }, { type: "text", text: "😀b" }]);
  });

  it("drops input while the socket is not open", () => {
    const { client, socket } = watch();
    socket.readyState = 0;
    client.take();
    client.key("home");
    expect(socket.sent).toEqual([]);
  });
});

describe("phone stream reconnecting", () => {
  it.each([
    [1012, "reconnect", 500],
    [1006, "", 500],
    [1013, "Too many phone views are open.", 10_000],
  ])("connects again after close %i", (code, reason, afterMs) => {
    vi.useFakeTimers();
    const { socket } = watch();
    socket.closeWith(code, reason);
    expect(FakeVideoDecoder.current.state).toBe("closed");
    vi.advanceTimersByTime(afterMs - 1);
    expect(FakePhoneSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakePhoneSocket.all).toHaveLength(2);
    expect(FakePhoneSocket.current.url).toBe(socket.url);
  });

  it("is live again after connecting again, with a frame of the size it had", () => {
    vi.useFakeTimers();
    const { socket } = watch();
    socket.closeWith(1012, "reconnect");
    expect(view().status).toEqual({ kind: "connecting" });
    vi.advanceTimersByTime(500);
    FakePhoneSocket.current.packet(1, PHONE_CONFIG);
    FakeVideoDecoder.current.frame(720, 1280);
    expect(view()).toMatchObject({ status: { kind: "live" }, frame: { width: 720, height: 1280 } });
  });

  it("shows why the server is busy while it waits to try again", () => {
    vi.useFakeTimers();
    const { socket } = watch();
    socket.closeWith(1013, "Too many phone views are open.");
    expect(view().status).toEqual({ kind: "closed", code: 1013, reason: "Too many phone views are open." });
  });

  it("waits longer after each failed attempt, up to ten seconds", () => {
    vi.useFakeTimers();
    start();
    for (const waitMs of [500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]) {
      const before = FakePhoneSocket.all.length;
      FakePhoneSocket.current.closeWith(1006);
      vi.advanceTimersByTime(waitMs - 1);
      expect(FakePhoneSocket.all).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(FakePhoneSocket.all).toHaveLength(before + 1);
    }
  });

  it.each([
    [1011, "The phone's screen could not start."],
    [4404, "gone"],
  ])("stops for good on close %i and keeps the reason", (code, reason) => {
    vi.useFakeTimers();
    const { socket } = watch();
    socket.closeWith(code, reason);
    expect(view().status).toEqual({ kind: "closed", code, reason });
    vi.advanceTimersByTime(60_000);
    showPage(false);
    showPage(true);
    expect(FakePhoneSocket.all).toHaveLength(1);
    expect(view().status).toEqual({ kind: "closed", code, reason });
  });

  it("closes the stream while the page is hidden, held or not, and opens it again when the page shows", () => {
    const { socket } = watch();
    socket.control(true);
    showPage(false);
    expect(socket.readyState).toBe(3);
    expect(FakeVideoDecoder.current.state).toBe("closed");
    expect(view().status).toEqual({ kind: "connecting" });
    expect(FakePhoneSocket.all).toHaveLength(1);

    showPage(true);
    expect(FakePhoneSocket.all).toHaveLength(2);
    expect(FakePhoneSocket.current.readyState).toBe(1);
  });

  it.each([
    ["it starts", () => {
      showPage(false);
      start();
    }, 0],
    ["a retry comes due", () => {
      start();
      FakePhoneSocket.current.closeWith(1012);
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    }, 1],
  ])("opens nothing on a hidden page when %s, and connects once the page shows", (_name, hidden, opened) => {
    vi.useFakeTimers();
    hidden();
    vi.advanceTimersByTime(60_000);
    expect(FakePhoneSocket.all).toHaveLength(opened);

    showPage(true);
    expect(FakePhoneSocket.all).toHaveLength(opened + 1);
  });

  it("opens nothing after it is stopped", () => {
    vi.useFakeTimers();
    const { client, socket } = watch();
    socket.closeWith(1012);
    client.stop();
    vi.advanceTimersByTime(60_000);
    showPage(false);
    showPage(true);
    expect(FakePhoneSocket.all).toHaveLength(1);
  });
});

describe("a browser that cannot show the phone", () => {
  it.each([
    ["has no VideoDecoder", () => vi.stubGlobal("VideoDecoder", undefined)],
    ["is not a secure context", () => vi.stubGlobal("isSecureContext", false)],
  ])("%s: unsupported, and nothing is opened", (_name, lack) => {
    lack();
    const { client } = start();
    expect(view().status).toEqual({ kind: "unsupported" });
    client.take();
    showPage(false);
    showPage(true);
    expect(FakePhoneSocket.all).toHaveLength(0);
    expect(FakeVideoDecoder.all).toHaveLength(0);
  });

  it.each([
    ["after the decoder's own error", true],
    ["before the decoder's own error", false],
  ])("cannot decode the phone's codec, found %s: unsupported, the stream and the decoder closed, and no connecting again", async (_name, errorFirst) => {
    vi.useFakeTimers();
    FakeVideoDecoder.lacks = ["avc1.42c020"];
    const { socket } = start();
    socket.packet(1, PHONE_CONFIG);
    const decoder = FakeVideoDecoder.current;
    if (errorFirst) {
      decoder.fail();
      expect(view().status).toEqual({ kind: "connecting" });
    }

    await Promise.resolve();
    await Promise.resolve();
    expect(view().status).toEqual({ kind: "unsupported" });
    expect(socket.readyState).toBe(3);
    expect(decoder.state).toBe("closed");
    if (!errorFirst) decoder.fail();
    vi.advanceTimersByTime(60_000);
    showPage(false);
    showPage(true);
    expect(FakePhoneSocket.all).toHaveLength(1);
    expect(view().status).toEqual({ kind: "unsupported" });
  });
});
