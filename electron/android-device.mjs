import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import localOriginModule from "./local-origin.cjs";

const execFileAsync = promisify(execFile);
const STATUS_TTL_MS = 750;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const KEYCODES = new Map([
  ["back", "KEYCODE_BACK"],
  ["delete", "KEYCODE_DEL"],
  ["down", "KEYCODE_DPAD_DOWN"],
  ["end", "KEYCODE_MOVE_END"],
  ["enter", "KEYCODE_ENTER"],
  ["escape", "KEYCODE_BACK"],
  ["home", "KEYCODE_HOME"],
  ["left", "KEYCODE_DPAD_LEFT"],
  ["recent", "KEYCODE_APP_SWITCH"],
  ["return", "KEYCODE_ENTER"],
  ["right", "KEYCODE_DPAD_RIGHT"],
  ["space", "KEYCODE_SPACE"],
  ["tab", "KEYCODE_TAB"],
  ["up", "KEYCODE_DPAD_UP"],
]);

function executableName(platform) {
  return platform === "win32" ? "adb.exe" : "adb";
}

export function resolveAdbBinary({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  resourcesPath = process.resourcesPath,
  exists = fs.existsSync,
} = {}) {
  const executable = executableName(platform);
  const candidates = [
    env.OMB_ADB_PATH,
    resourcesPath && path.join(resourcesPath, "android-platform-tools", platform, executable),
    ...String(env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, executable)),
    platform === "darwin" && path.join(homeDir, "Library/Android/sdk/platform-tools/adb"),
    platform === "darwin" && "/opt/homebrew/bin/adb",
    platform === "darwin" && "/usr/local/bin/adb",
    platform === "linux" && path.join(homeDir, "Android/Sdk/platform-tools/adb"),
  ].filter(Boolean);
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

function connectionKind(serial, fields) {
  if (serial.startsWith("emulator-")) return "emulator";
  if (fields.some((field) => field.startsWith("usb:"))) return "usb";
  if (serial.includes(":") || serial.startsWith("adb-")) return "network";
  return "usb";
}

export function parseAdbDevices(output) {
  const lines = String(output).split(/\r?\n/);
  const devices = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("List of devices attached") || trimmed.startsWith("* daemon")) {
      continue;
    }
    const [serial, state, ...fields] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    const properties = Object.fromEntries(
      fields
        .map((field) => field.split(/:(.*)/s))
        .filter(([key, value]) => Boolean(key && value)),
    );
    devices.push({
      serial,
      state,
      connection: connectionKind(serial, fields),
      model: String(properties.model ?? properties.product ?? "Android device").replaceAll("_", " "),
      product: properties.product,
      transportId: properties.transport_id,
    });
  }
  return devices;
}

function trustedMainFrame(event) {
  const sender = event?.sender;
  const frame = event?.senderFrame;
  const mainFrame = sender?.mainFrame;
  return Boolean(
    sender &&
      frame &&
      mainFrame &&
      frame.processId === mainFrame.processId &&
      frame.routingId === mainFrame.routingId,
  );
}

function safeDimension(value) {
  return Number.isFinite(value) && value >= 100 && value <= 10_000 ? value : null;
}

function safeUnit(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

export function createAndroidDeviceController(options = {}) {
  const run = options.run ?? execFileAsync;
  const resolveBinary = options.resolveBinary ?? (() => resolveAdbBinary(options));
  let cachedStatus = null;

  const invoke = async (binary, args, extra = {}) => {
    const result = await run(binary, args, {
      timeout: extra.timeout ?? 6_000,
      maxBuffer: extra.maxBuffer ?? 32 * 1024 * 1024,
      encoding: extra.encoding ?? "utf8",
      env: { ...process.env, ADB_TRACE: "" },
    });
    return result;
  };

  const status = async ({ fresh = false } = {}) => {
    if (!fresh && cachedStatus && Date.now() - cachedStatus.at < STATUS_TTL_MS) {
      return cachedStatus.value;
    }
    const binary = resolveBinary();
    if (!binary) {
      const value = { available: false, reasonCode: "adb-unavailable", devices: [] };
      cachedStatus = { at: Date.now(), value };
      return value;
    }
    try {
      const { stdout } = await invoke(binary, ["devices", "-l"]);
      const devices = parseAdbDevices(stdout).filter((device) => device.connection === "usb");
      const value = { available: true, adbPath: binary, devices };
      cachedStatus = { at: Date.now(), value };
      return value;
    } catch (error) {
      const value = {
        available: false,
        reasonCode: "adb-failed",
        message: error instanceof Error ? error.message : String(error),
        devices: [],
      };
      cachedStatus = { at: Date.now(), value };
      return value;
    }
  };

  const readyDevice = async (serial) => {
    if (typeof serial !== "string" || !serial) throw new Error("An Android device is required");
    const current = await status({ fresh: true });
    const device = current.devices.find((candidate) => candidate.serial === serial);
    if (!device) throw new Error("That USB Android device is no longer connected");
    if (device.state !== "device") {
      throw new Error(
        device.state === "unauthorized"
          ? "Unlock the Android phone and allow USB debugging"
          : `The Android device is ${device.state}`,
      );
    }
    const binary = resolveBinary();
    if (!binary) throw new Error("Android platform tools are unavailable");
    return { binary, device };
  };

  const frame = async (serial) => {
    const { binary } = await readyDevice(serial);
    const { stdout } = await invoke(binary, ["-s", serial, "exec-out", "screencap", "-p"], {
      timeout: 8_000,
      encoding: "buffer",
    });
    const png = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    if (png.length < 1_024 || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error("The Android device returned an invalid screen capture");
    }
    return { serial, dataUrl: `data:image/png;base64,${png.toString("base64")}` };
  };

  const input = async (serial, payload) => {
    const { binary } = await readyDevice(serial);
    if (!payload || typeof payload !== "object") throw new Error("Invalid Android input");
    const width = safeDimension(payload.width);
    const height = safeDimension(payload.height);
    const point = (x, y) => {
      const unitX = safeUnit(x);
      const unitY = safeUnit(y);
      if (unitX === null || unitY === null || width === null || height === null) {
        throw new Error("Invalid Android coordinates");
      }
      return [Math.round(unitX * width), Math.round(unitY * height)];
    };

    let command;
    if (payload.type === "tap") {
      const [x, y] = point(payload.x, payload.y);
      command = ["input", "tap", String(x), String(y)];
    } else if (payload.type === "swipe") {
      const [fromX, fromY] = point(payload.fromX, payload.fromY);
      const [toX, toY] = point(payload.toX, payload.toY);
      const duration = Number.isFinite(payload.durationMs)
        ? Math.max(80, Math.min(1_500, Math.round(payload.durationMs)))
        : 260;
      command = [
        "input",
        "swipe",
        String(fromX),
        String(fromY),
        String(toX),
        String(toY),
        String(duration),
      ];
    } else if (payload.type === "key") {
      const keycode = KEYCODES.get(String(payload.key ?? "").toLowerCase());
      if (!keycode) throw new Error("Unsupported Android key");
      command = ["input", "keyevent", keycode];
    } else if (payload.type === "text") {
      if (
        typeof payload.text !== "string" ||
        payload.text.length < 1 ||
        payload.text.length > 64 ||
        !/^[A-Za-z0-9 _.,@-]+$/.test(payload.text)
      ) {
        throw new Error("Android text currently supports letters, numbers, spaces, and basic punctuation");
      }
      command = ["input", "text", payload.text.replaceAll(" ", "%s")];
    } else {
      throw new Error("Unsupported Android input");
    }
    await invoke(binary, ["-s", serial, "shell", ...command]);
  };

  const registerIpc = (ipcMain) => {
    const protect = (handler) => async (event, ...args) => {
      if (!trustedMainFrame(event) || !localOriginModule.isLocalSender(event)) {
        throw new Error("Android device access is limited to the local app");
      }
      return handler(...args);
    };
    ipcMain.handle("android-device:status", protect(() => status({ fresh: true })));
    ipcMain.handle("android-device:frame", protect(frame));
    ipcMain.handle("android-device:input", protect(input));
  };

  return { frame, input, registerIpc, status };
}
