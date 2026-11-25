// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productName } from "@/lib/brand";
import { FakePhoneSocket, fakePhoneStream } from "@/testing/phone-stream";
import type { AndroidDeviceStatus, AndroidUsbDevice } from "@/types/ogb";
import { AndroidDevicePanel, useAndroidUsbDevices, type AndroidUsbDevicesStatus } from "./AndroidDevicePanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => true }));

const PHONE: AndroidUsbDevice = { serial: "p1", state: "device", connection: "usb", model: "Pixel" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let root: Root | null = null;
let latest: AndroidUsbDevicesStatus;
const bridge = { status: vi.fn(async () => ({ available: true, devices: [] })), frame: vi.fn(async () => ({ serial: "", dataUrl: "" })), input: vi.fn(async () => {}) };

function Probe({ serverPhones = true }: { serverPhones?: boolean }) {
  latest = useAndroidUsbDevices(serverPhones);
  return null;
}

async function draw(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  });
}

/** Answers the server's phone list; the desktop app's bridge is present too, and must stay unused. */
function server(answer: () => Promise<Response>) {
  const fetch = vi.fn((_path: string, _init?: RequestInit) => answer());
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("ogb", { androidDevice: bridge });
  return fetch;
}

beforeEach(() => {
  fakePhoneStream();
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useAndroidUsbDevices asking the server", () => {
  it("reads the server's phone list instead of the desktop app's", async () => {
    const fetch = server(async () => json({ available: true, devices: [PHONE] }));
    await draw(createElement(Probe));
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/api/usb-phones"]);
    expect(bridge.status).not.toHaveBeenCalled();
    expect(latest).toEqual({ available: true, devices: [PHONE], scanned: true });
  });

  it("passes the server's reason on when it has no adb", async () => {
    server(async () => json({ available: false, reasonCode: "adb-unavailable", devices: [] }));
    await draw(createElement(Probe));
    expect(latest).toEqual({ available: false, reasonCode: "adb-unavailable", devices: [], scanned: true });
  });

  it.each([
    ["the feature is off (404)", async () => json({ error: "Not found" }, 404)],
    ["the answer is not a phone list", async () => new Response("<html>", { status: 200 })],
  ])("has no phones, scanned, when %s", async (_name, answer) => {
    server(answer);
    await draw(createElement(Probe));
    expect(latest).toEqual({ available: false, devices: [], scanned: true });
  });

  it.each([
    ["the request does not reach the server", async () => { throw new TypeError("Failed to fetch"); }, "Failed to fetch"],
    ["the server fails", async () => json({ error: "adb timed out" }, 500), "adb timed out"],
  ])("says the check failed, not that no phone is there, when %s", async (_name, answer, message) => {
    server(answer);
    await draw(createElement(Probe));
    expect(latest).toEqual({ available: false, devices: [], reasonCode: "adb-failed", message, scanned: true });
  });

  it("asks again every two seconds and keeps the newest answer when an older one is late", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const answers: Array<(response: Response) => void> = [];
    const fetch = server(() => new Promise((resolve) => answers.push(resolve)));
    await draw(createElement(Probe));
    expect(latest.scanned).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1_999);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      answers[1](json({ available: true, devices: [PHONE] }));
      for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    });
    expect(latest.devices.map((device) => device.serial)).toEqual(["p1"]);

    await act(async () => {
      answers[0](json({ available: true, devices: [] }));
      for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    });
    expect(latest.devices.map((device) => device.serial)).toEqual(["p1"]);
  });

  it("forgets the server's phones and stops asking when the feature goes off on a page without the desktop app", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fetch = server(async () => json({ available: true, devices: [PHONE] }));
    vi.stubGlobal("ogb", undefined);
    await draw(createElement(Probe));
    expect(latest.devices).toEqual([PHONE]);

    await act(async () => {
      root!.render(createElement(Probe, { serverPhones: false }));
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(latest).toEqual({ available: false, devices: [], scanned: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("AndroidDevicePanel with the server's phones", () => {
  const panel = (status: AndroidDeviceStatus, serverPhones: boolean) => {
    vi.stubGlobal("ogb", { androidDevice: bridge });
    return draw(createElement(AndroidDevicePanel, { status, serverPhones }));
  };

  it("shows a ready phone's live screen from the server, not the desktop app's screenshots", async () => {
    await panel({ available: true, devices: [PHONE] }, true);
    expect(FakePhoneSocket.all.map((socket) => new URL(socket.url, "http://omb.test").pathname)).toEqual(["/api/usb-phones/p1/stream"]);
    expect(bridge.frame).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Watching · the bots keep working");
    expect(document.body.textContent).toContain("First-time USB setup");
    expect(document.body.textContent).toContain(`Connected over USB to the computer that runs ${productName()}.`);
    expect(document.body.textContent).not.toContain("stay on this computer");
  });

  it("keeps the unauthorized notice and opens no stream for a phone that is not ready", async () => {
    await panel({ available: true, devices: [{ ...PHONE, state: "unauthorized" }] }, true);
    expect(FakePhoneSocket.all).toHaveLength(0);
    expect(document.body.textContent).toContain("Allow USB debugging");
    expect(document.body.textContent).toContain("First-time USB setup");
  });

  it("stays the desktop app's panel without the server's phones", async () => {
    await panel({ available: true, devices: [PHONE] }, false);
    expect(FakePhoneSocket.all).toHaveLength(0);
    expect(bridge.frame).toHaveBeenCalledWith("p1");
    expect(document.body.textContent).not.toContain("Watching · the bots keep working");
    expect(document.body.textContent).toContain("Connected directly over USB. The screen and controls stay on this computer.");
  });
});
