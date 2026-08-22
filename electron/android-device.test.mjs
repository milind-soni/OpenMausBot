import { describe, expect, it } from "vitest";

import {
  createAndroidDeviceController,
  parseAdbDevices,
  resolveAdbBinary,
} from "./android-device.mjs";

const devicesOutput = `List of devices attached
USB123\tdevice product:husky model:Pixel_8_Pro usb:1-2 transport_id:4
USB456\tunauthorized usb:1-3 transport_id:5
emulator-5554\tdevice product:sdk_gphone model:Android_SDK transport_id:6
192.0.2.4:5555\tdevice product:remote model:Remote_Phone transport_id:7
`;

describe("Android USB device bridge", () => {
  it("parses physical USB devices separately from emulators and network devices", () => {
    expect(parseAdbDevices(devicesOutput)).toEqual([
      expect.objectContaining({ serial: "USB123", state: "device", connection: "usb", model: "Pixel 8 Pro" }),
      expect.objectContaining({ serial: "USB456", state: "unauthorized", connection: "usb" }),
      expect.objectContaining({ serial: "emulator-5554", connection: "emulator" }),
      expect.objectContaining({ serial: "192.0.2.4:5555", connection: "network" }),
    ]);
  });

  it("resolves an explicit ADB path before PATH and SDK fallbacks", () => {
    const checked = [];
    const result = resolveAdbBinary({
      platform: "darwin",
      env: { OMB_ADB_PATH: "/trusted/adb", PATH: "/other/bin" },
      homeDir: "/Users/test",
      resourcesPath: "/Resources",
      exists(candidate) {
        checked.push(candidate);
        return candidate === "/trusted/adb";
      },
    });
    expect(result).toBe("/trusted/adb");
    expect(checked).toEqual(["/trusted/adb"]);
  });

  it("captures a validated USB device and maps normalized swipes to ADB pixels", async () => {
    const calls = [];
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(2_000),
    ]);
    const run = async (_binary, args, options) => {
      calls.push({ args, options });
      if (args[0] === "devices") return { stdout: devicesOutput, stderr: "" };
      if (args.includes("screencap")) return { stdout: png, stderr: Buffer.alloc(0) };
      return { stdout: "", stderr: "" };
    };
    const controller = createAndroidDeviceController({ run, resolveBinary: () => "/trusted/adb" });

    await expect(controller.frame("USB123")).resolves.toMatchObject({
      serial: "USB123",
      dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
    });
    await controller.input("USB123", {
      type: "swipe",
      fromX: 0.5,
      fromY: 0.8,
      toX: 0.5,
      toY: 0.2,
      durationMs: 240,
      width: 1080,
      height: 2400,
    });

    expect(calls.at(-1)?.args).toEqual([
      "-s", "USB123", "shell", "input", "swipe", "540", "1920", "540", "480", "240",
    ]);
  });

  it("rejects network devices and shell metacharacters", async () => {
    const run = async () => ({ stdout: devicesOutput, stderr: "" });
    const controller = createAndroidDeviceController({ run, resolveBinary: () => "/trusted/adb" });

    await expect(controller.frame("192.0.2.4:5555")).rejects.toThrow("no longer connected");
    await expect(
      controller.input("USB123", {
        type: "text",
        text: "hello; reboot",
      }),
    ).rejects.toThrow("basic punctuation");
  });
});
