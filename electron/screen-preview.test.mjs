import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createDisplayMediaGuard, invokeDisplayMediaCallback, selectCaptureSource } = require(
  "./screen-preview.cjs",
);

const frame = { processId: 10, routingId: 20 };
const validRequest = {
  frame,
  securityOrigin: "http://127.0.0.1:8799",
  videoRequested: true,
  audioRequested: false,
  userGesture: true,
};

describe("display media request guard", () => {
  it("allows one trusted, video-only request from the frame that declared intent", () => {
    const guard = createDisplayMediaGuard({ now: () => 1_000 });

    expect(guard.begin(frame)).toBe(true);
    expect(guard.consume(validRequest, "http://127.0.0.1:8799/")).toBe(true);
    expect(guard.consume(validRequest, "http://127.0.0.1:8799/")).toBe(false);
  });

  it.each([
    ["missing user gesture", { userGesture: false }],
    ["audio capture", { audioRequested: true }],
    ["missing video", { videoRequested: false }],
    ["untrusted origin", { securityOrigin: "https://example.com" }],
    ["unparseable origin", { securityOrigin: "not a URL" }],
    ["different frame", { frame: { processId: 10, routingId: 21 } }],
  ])("rejects %s", (_name, change) => {
    const guard = createDisplayMediaGuard({ now: () => 1_000 });
    guard.begin(frame);

    expect(
      guard.consume({ ...validRequest, ...change }, "http://127.0.0.1:8799"),
    ).toBe(false);
  });

  it("rejects an expired intent", () => {
    let current = 1_000;
    const guard = createDisplayMediaGuard({ now: () => current, ttlMs: 500 });
    guard.begin(frame);
    current = 1_501;

    expect(guard.consume(validRequest, "http://127.0.0.1:8799")).toBe(false);
  });

  it("rejects a request when both origins are missing or invalid", () => {
    const guard = createDisplayMediaGuard({ now: () => 1_000 });
    guard.begin(frame);
    expect(guard.consume({ ...validRequest, securityOrigin: undefined }, undefined)).toBe(false);
  });
});

describe("display source selection", () => {
  const sources = [
    { id: "first", display_id: "41" },
    { id: "primary", display_id: "42" },
  ];

  it("matches the Xorg primary display instead of choosing the first source", () => {
    expect(selectCaptureSource({ sources, host: "x11", primaryDisplayId: 42 })).toEqual(
      sources[1],
    );
    expect(selectCaptureSource({ sources, host: "x11", primaryDisplayId: 99 })).toBeNull();
  });

  it("uses an unambiguous Xorg source when display_id is absent or mismatched", () => {
    const onlySource = { id: "only", display_id: "" };
    expect(
      selectCaptureSource({ sources: [onlySource], host: "x11", primaryDisplayId: 42 }),
    ).toEqual(onlySource);
    expect(selectCaptureSource({ sources: [], host: "x11", primaryDisplayId: 42 })).toBeNull();
    expect(
      selectCaptureSource({
        sources: [{ id: "first" }, { id: "second" }],
        host: "x11",
        primaryDisplayId: undefined,
      }),
    ).toBeNull();
  });

  it("accepts only the single portal-selected Wayland source", () => {
    expect(
      selectCaptureSource({ sources: [sources[0]], host: "wayland", primaryDisplayId: 42 }),
    ).toEqual(sources[0]);
    expect(selectCaptureSource({ sources, host: "wayland", primaryDisplayId: 42 })).toBeNull();
  });
});

describe("display media callback", () => {
  it("contains Electron's synchronous rejection for an empty portal response", () => {
    const rejection = new TypeError("Video was requested, but no video stream was provided");
    const callback = () => {
      throw rejection;
    };

    expect(() => invokeDisplayMediaCallback(callback, {})).not.toThrow();
    expect(invokeDisplayMediaCallback(callback, {})).toBe(rejection);
  });

  it("returns null after delivering a selected source", () => {
    expect(invokeDisplayMediaCallback(() => {}, { video: { id: "screen:0" } })).toBeNull();
  });
});
