import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  allowScreenFrameRequest,
  captureScreenFrame,
  createDisplayMediaGuard,
  invokeDisplayMediaCallback,
  isTrustedMainRenderer,
  selectCaptureSource,
} = require("./screen-preview.cjs");

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

describe("screen frame IPC boundary", () => {
  const mainFrame = {};
  const webContents = { mainFrame };
  const mainWindow = { webContents, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: mainFrame };

  it("accepts only the live main app renderer and an empty payload", () => {
    expect(isTrustedMainRenderer({ event, mainWindow })).toBe(true);
    expect(allowScreenFrameRequest({ event, mainWindow, payload: [] })).toBe(true);
    expect(allowScreenFrameRequest({ event, mainWindow, payload: ["screen:0"] })).toBe(false);
  });

  it.each([
    ["a child renderer", { event: { sender: webContents, senderFrame: {} } }],
    ["a destroyed window", { mainWindow: { webContents, isDestroyed: () => true } }],
    ["a missing payload array", { payload: undefined }],
  ])("rejects %s", (_name, change) => {
    expect(allowScreenFrameRequest({ event, mainWindow, payload: [], ...change })).toBe(false);
  });
});

describe("Electron screen frame capture", () => {
  it("uses the existing screen thumbnail substrate for the Windows primary display", async () => {
    const calls = [];
    const source = {
      id: "screen:primary:0",
      display_id: "42",
      thumbnail: { toDataURL: () => "data:image/png;base64,windows-frame" },
    };
    await expect(
      captureScreenFrame({
        platform: "win32",
        getSources: async (options) => {
          calls.push(options);
          return [
            { id: "screen:secondary:0", display_id: "41", thumbnail: { toDataURL: () => "wrong" } },
            source,
          ];
        },
        getPrimaryDisplay: () => ({ id: 42 }),
      }),
    ).resolves.toBe("data:image/png;base64,windows-frame");
    expect(calls).toEqual([{ types: ["screen"], thumbnailSize: { width: 1280, height: 800 } }]);
  });

  it("returns no frame when the Windows desktop has no display source", async () => {
    const getPrimaryDisplay = () => {
      throw new Error("must not inspect a display when no source exists");
    };
    await expect(
      captureScreenFrame({ platform: "win32", getSources: async () => [], getPrimaryDisplay }),
    ).resolves.toBeNull();
  });

  it("keeps the local thumbnail path disabled on Linux", async () => {
    const getSources = async () => {
      throw new Error("Linux uses the explicit display-media preview");
    };
    await expect(
      captureScreenFrame({ platform: "linux", getSources, getPrimaryDisplay: () => ({ id: 1 }) }),
    ).resolves.toBeNull();
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

  it("matches the Windows primary display and fails closed when displays are ambiguous", () => {
    expect(selectCaptureSource({ sources, host: "win32", primaryDisplayId: 42 })).toEqual(sources[1]);
    expect(selectCaptureSource({ sources, host: "win32", primaryDisplayId: 99 })).toBeNull();
    expect(
      selectCaptureSource({
        sources: [{ id: "only", display_id: "" }],
        host: "win32",
        primaryDisplayId: 42,
      }),
    ).toEqual({ id: "only", display_id: "" });
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
