// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AndroidUsbDevice } from "@/types/ogb";
import { useAndroidUsbDevices, type AndroidUsbDevicesStatus } from "./AndroidDevicePanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => true }));

const PHONE: AndroidUsbDevice = { serial: "p1", state: "device", connection: "usb", model: "Pixel" };

let root: Root | null = null;
let latest: AndroidUsbDevicesStatus;

function Probe() {
  latest = useAndroidUsbDevices();
  return null;
}

/** Mounts the hook and flushes its initial async refresh. */
async function draw() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Probe));
    await Promise.resolve();
    await Promise.resolve();
  });
}

function bridge(status: () => Promise<unknown>) {
  vi.stubGlobal("ogb", {
    androidDevice: {
      status,
      frame: async () => ({ serial: "", dataUrl: "" }),
      input: async () => {},
    },
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useAndroidUsbDevices", () => {
  it("leaves the first check unscanned until it resolves", async () => {
    bridge(() => new Promise(() => {}));
    await draw();
    expect(latest).toMatchObject({ scanned: false, devices: [] });
    expect(latest.reasonCode).toBeUndefined();
  });

  it("treats a missing bridge as a final, empty answer", async () => {
    vi.stubGlobal("ogb", undefined);
    await draw();
    expect(latest).toMatchObject({ scanned: true, devices: [] });
    expect(latest.reasonCode).toBeUndefined();
  });

  it("marks a failed check scanned but keeps the failure reason", async () => {
    bridge(async () => {
      throw new Error("adb exited 1");
    });
    await draw();
    expect(latest).toMatchObject({ scanned: true, devices: [], reasonCode: "adb-failed" });
  });

  it("passes a native adb-unavailable result through with its reason", async () => {
    bridge(async () => ({ available: false, reasonCode: "adb-unavailable", devices: [] }));
    await draw();
    expect(latest).toMatchObject({ scanned: true, devices: [], reasonCode: "adb-unavailable" });
  });

  it("confirms a successful check, devices or none", async () => {
    bridge(async () => ({ available: true, devices: [{ serial: "p1", state: "device", connection: "usb", model: "Pixel" }] }));
    await draw();
    expect(latest.scanned).toBe(true);
    expect(latest.reasonCode).toBeUndefined();
    expect(latest.devices.map((device) => device.serial)).toEqual(["p1"]);
  });

  it("keeps the newest answer when an older check answers late", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const answers: Array<(status: unknown) => void> = [];
    bridge(() => new Promise((resolve) => answers.push(resolve)));
    await draw();
    expect(answers).toHaveLength(1);

    // The next poll starts while the first check is still unanswered.
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(answers).toHaveLength(2);

    // The newer check lands first and finds the phone.
    await act(async () => {
      answers[1]({ available: true, devices: [PHONE] });
      await Promise.resolve();
    });
    expect(latest.devices.map((device) => device.serial)).toEqual(["p1"]);

    // The older, superseded answer must not erase it.
    await act(async () => {
      answers[0]({ available: true, devices: [] });
      await Promise.resolve();
    });
    expect(latest.devices.map((device) => device.serial)).toEqual(["p1"]);
  });
});
