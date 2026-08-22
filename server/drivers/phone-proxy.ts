// First-party Android phone MCP server. It deliberately accepts physical USB
// devices only: no emulators, wireless debugging, network ADB, or Tailscale.
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

type Json = Record<string, unknown>;
type Device = { serial: string; state: string; model: string; connection: "usb" | "network" | "emulator" };
type UiNode = { text: string; description: string; id: string; className: string; bounds: [number, number, number, number] };

const MAX_ADB_OUTPUT = 16 * 1024 * 1024;
const PACKAGE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/;
const COMPONENT = /^([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\/\S+$/;
const SAFE_TEXT = /^[A-Za-z0-9 _.,@-]+$/;
const KEYCODES: Record<string, string> = {
  back: "KEYCODE_BACK",
  delete: "KEYCODE_DEL",
  down: "KEYCODE_DPAD_DOWN",
  enter: "KEYCODE_ENTER",
  escape: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  left: "KEYCODE_DPAD_LEFT",
  recent: "KEYCODE_APP_SWITCH",
  return: "KEYCODE_ENTER",
  right: "KEYCODE_DPAD_RIGHT",
  space: "KEYCODE_SPACE",
  tab: "KEYCODE_TAB",
  up: "KEYCODE_DPAD_UP",
};
const KNOWN_PACKAGES: Record<string, string> = {
  skyscanner: "net.skyscanner.android.main",
  uber: "com.ubercab",
};

function executableName(platform = process.platform) {
  return platform === "win32" ? "adb.exe" : "adb";
}

export function resolveAdbPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const executable = executableName(platform);
  const home = homedir();
  const candidates = [
    env.OMB_ADB_PATH,
    env.OMB_RESOURCES_PATH && join(env.OMB_RESOURCES_PATH, "android-platform-tools", platform, executable),
    ...(env.PATH ?? "").split(delimiter).map((entry) => entry && join(entry, executable)),
    platform === "darwin" && join(home, "Library/Android/sdk/platform-tools/adb"),
    platform === "darwin" && "/opt/homebrew/bin/adb",
    platform === "darwin" && "/usr/local/bin/adb",
    platform === "linux" && join(home, "Android/Sdk/platform-tools/adb"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function runAdb(args: string[], options: { binary?: boolean; timeoutMs?: number } = {}): Promise<Buffer> {
  const adb = resolveAdbPath();
  if (!adb) throw new Error("Android platform tools are unavailable. Reopen OpenMausBot or install adb.");
  return new Promise((resolve, reject) => {
    const child = spawn(adb, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("The Android device command timed out"));
    }, options.timeoutMs ?? 12_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ADB_OUTPUT) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (size > MAX_ADB_OUTPUT) return reject(new Error("The Android device returned too much data"));
      if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `adb exited ${code}`));
      resolve(Buffer.concat(stdout));
    });
  });
}

export function parseDevices(output: string): Device[] {
  const devices: Device[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices attached") || line.startsWith("* daemon")) continue;
    const [serial, state, ...fields] = line.split(/\s+/);
    if (!serial || !state) continue;
    const connection = serial.startsWith("emulator-")
      ? "emulator"
      : serial.includes(":") || serial.startsWith("adb-")
        ? "network"
        : "usb";
    const properties = Object.fromEntries(fields.flatMap((field) => {
      const split = field.indexOf(":");
      return split > 0 ? [[field.slice(0, split), field.slice(split + 1)]] : [];
    }));
    devices.push({
      serial,
      state,
      connection,
      model: String(properties.model ?? properties.product ?? "Android device").replaceAll("_", " "),
    });
  }
  return devices;
}

async function usbDevices() {
  if (!resolveAdbPath()) return [];
  return parseDevices((await runAdb(["devices", "-l"])).toString("utf8")).filter((device) => device.connection === "usb");
}

async function readySerial(requested?: unknown): Promise<string> {
  const devices = await usbDevices();
  const serial = typeof requested === "string" && requested ? requested : process.env.PH_ANDROID_SERIAL;
  const candidates = serial ? devices.filter((device) => device.serial === serial) : devices;
  if (!candidates.length) throw new Error("No physical USB Android device is connected");
  if (candidates.length > 1 && !serial) throw new Error("Multiple USB Android devices are connected; pass serial");
  const device = candidates[0];
  if (device.state === "unauthorized") throw new Error("Unlock the phone and accept Allow USB debugging");
  if (device.state !== "device") throw new Error(`The Android device is ${device.state}`);
  return device.serial;
}

async function onDevice(serial: string, args: string[], binary = false) {
  return runAdb(["-s", serial, ...args], { binary });
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseLaunchablePackages(output: string): string[] {
  const packages: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const match = COMPONENT.exec(raw.trim());
    if (match && !packages.includes(match[1])) packages.push(match[1]);
  }
  return packages;
}

export function findPackages(name: string, packages: string[]) {
  if (PACKAGE.test(name) && packages.includes(name)) return [name];
  const needle = normalize(name);
  const known = KNOWN_PACKAGES[needle];
  if (known && packages.includes(known)) return [known];
  if (needle.length < 4) return [];
  const ranked = [
    (token: string) => token === needle,
    (token: string) => token.startsWith(needle),
    (token: string) => token.includes(needle),
  ];
  for (const matches of ranked) {
    const found = packages.filter((pkg) => pkg.split(".").some((token) => matches(normalize(token))));
    if (found.length) return found;
  }
  return [];
}

async function launchablePackages(serial: string) {
  const output = await onDevice(serial, [
    "shell", "cmd", "package", "query-activities", "--brief",
    "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER",
  ]);
  return parseLaunchablePackages(output.toString("utf8"));
}

function decodeXml(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function parseUiNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  for (const match of xml.matchAll(/<node\s+([^>]+?)\/?\s*>/g)) {
    const attributes: Record<string, string> = {};
    for (const attribute of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attributes[attribute[1]] = decodeXml(attribute[2]);
    }
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attributes.bounds ?? "");
    if (!bounds) continue;
    const text = attributes.text ?? "";
    const description = attributes["content-desc"] ?? "";
    if (!text && !description && !attributes["resource-id"]) continue;
    nodes.push({
      text,
      description,
      id: attributes["resource-id"] ?? "",
      className: attributes.class ?? "",
      bounds: [Number(bounds[1]), Number(bounds[2]), Number(bounds[3]), Number(bounds[4])],
    });
  }
  return nodes;
}

async function readNodes(serial: string) {
  const streamed = (await onDevice(serial, ["shell", "uiautomator", "dump", "/dev/tty"])).toString("utf8");
  const streamedStart = streamed.indexOf("<?xml");
  if (streamedStart >= 0) return parseUiNodes(streamed.slice(streamedStart));

  const remotePath = "/data/local/tmp/openmaus-window.xml";
  await onDevice(serial, ["shell", "uiautomator", "dump", remotePath]);
  const saved = (await onDevice(serial, ["shell", "cat", remotePath])).toString("utf8");
  void onDevice(serial, ["shell", "rm", "-f", remotePath]).catch(() => undefined);
  const savedStart = saved.indexOf("<?xml");
  return parseUiNodes(savedStart >= 0 ? saved.slice(savedStart) : saved);
}

function nodeLines(nodes: UiNode[]) {
  return nodes.slice(0, 250).map((node, index) => {
    const label = [node.text, node.description].filter(Boolean).join(" · ");
    return `${index}: ${JSON.stringify(label || node.id)} bounds=${node.bounds.join(",")} class=${node.className}`;
  }).join("\n") || "No accessible Android UI text is visible.";
}

const TOOLS = [
  { name: "status", description: "Check physical USB Android devices and USB-debugging authorization before any Android phone task.", inputSchema: { type: "object", properties: {} } },
  { name: "read_screen", description: "Read visible text, accessibility labels, resource ids, and pixel bounds from the connected Android screen. Use after every action to verify the result.", inputSchema: { type: "object", properties: { serial: { type: "string" } } } },
  { name: "screenshot", description: "Capture the connected Android screen when accessibility text is insufficient. Returns a PNG image.", inputSchema: { type: "object", properties: { serial: { type: "string" } } } },
  { name: "list_apps", description: "List installed launchable Android package names, optionally filtered by a human app name. Prefer open_app first.", inputSchema: { type: "object", properties: { query: { type: "string" }, serial: { type: "string" } } } },
  { name: "open_app", description: "Open an installed Android app directly by its human name, such as Uber or Skyscanner. Do not scan the app drawer first.", inputSchema: { type: "object", properties: { name: { type: "string" }, serial: { type: "string" } }, required: ["name"] } },
  { name: "tap_text", description: "Tap visible Android text or an accessibility label, then use read_screen to verify.", inputSchema: { type: "object", properties: { text: { type: "string" }, exact: { type: "boolean" }, index: { type: "integer", minimum: 0 }, serial: { type: "string" } }, required: ["text"] } },
  { name: "tap", description: "Tap Android screen pixel coordinates obtained from read_screen or screenshot.", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, serial: { type: "string" } }, required: ["x", "y"] } },
  { name: "swipe", description: "Swipe the Android screen in a direction, then use read_screen to verify.", inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] }, serial: { type: "string" } }, required: ["direction"] } },
  { name: "type_text", description: "Type basic ASCII text into the focused Android field. Never enter passwords, payment details, or one-time codes.", inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 256 }, serial: { type: "string" } }, required: ["text"] } },
  { name: "press", description: "Press an Android navigation or keyboard key.", inputSchema: { type: "object", properties: { key: { type: "string", enum: Object.keys(KEYCODES) }, serial: { type: "string" } }, required: ["key"] } },
] as const;

type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };
const textResult = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

async function callTool(name: string, args: Json): Promise<ToolResult> {
  if (name === "status") {
    const adb = resolveAdbPath();
    const devices = adb ? await usbDevices() : [];
    return textResult(JSON.stringify({ available: Boolean(adb), devices }, null, 2));
  }
  const serial = await readySerial(args.serial);
  if (name === "read_screen") return textResult(nodeLines(await readNodes(serial)));
  if (name === "screenshot") {
    const png = await onDevice(serial, ["exec-out", "screencap", "-p"], true);
    if (!png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("Android returned an invalid screenshot");
    return { content: [{ type: "text", text: `Android screenshot from ${serial}` }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
  }
  if (name === "list_apps") {
    const packages = await launchablePackages(serial);
    const query = typeof args.query === "string" ? args.query : "";
    return textResult((query ? findPackages(query, packages) : packages).join("\n") || "No matching launchable app found");
  }
  if (name === "open_app") {
    const appName = String(args.name ?? "").trim();
    if (!appName) throw new Error("name is required");
    const matches = findPackages(appName, await launchablePackages(serial));
    if (matches.length !== 1) throw new Error(matches.length ? `App name is ambiguous: ${matches.join(", ")}` : `No installed launchable app matches ${JSON.stringify(appName)}`);
    await onDevice(serial, ["shell", "monkey", "-p", matches[0], "-c", "android.intent.category.LAUNCHER", "1"]);
    return textResult(`Opened ${appName} (${matches[0]})`);
  }
  if (name === "tap_text") {
    const query = String(args.text ?? "").trim().toLowerCase();
    if (!query) throw new Error("text is required");
    const exact = args.exact === true;
    const hits = (await readNodes(serial)).filter((node) => {
      const labels = [node.text, node.description].filter(Boolean).map((value) => value.toLowerCase());
      return labels.some((label) => exact ? label === query : label.includes(query));
    });
    const index = Number.isInteger(args.index) ? Number(args.index) : 0;
    const hit = hits[index];
    if (!hit) throw new Error(`No visible Android text matches ${JSON.stringify(args.text)}`);
    const [x1, y1, x2, y2] = hit.bounds;
    await onDevice(serial, ["shell", "input", "tap", String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2))]);
    return textResult(`Tapped ${JSON.stringify(hit.text || hit.description)}`);
  }
  if (name === "tap") {
    const x = Number(args.x); const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 10000 || y > 10000) throw new Error("Invalid Android coordinates");
    await onDevice(serial, ["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))]);
    return textResult(`Tapped ${Math.round(x)},${Math.round(y)}`);
  }
  if (name === "swipe") {
    const direction = String(args.direction ?? "");
    const size = (await onDevice(serial, ["shell", "wm", "size"])).toString("utf8");
    const match = /(\d+)x(\d+)/.exec(size);
    if (!match) throw new Error("Could not read Android screen size");
    const width = Number(match[1]); const height = Number(match[2]);
    const points: Record<string, [number, number, number, number]> = {
      up: [width / 2, height * 0.75, width / 2, height * 0.25],
      down: [width / 2, height * 0.25, width / 2, height * 0.75],
      left: [width * 0.75, height / 2, width * 0.25, height / 2],
      right: [width * 0.25, height / 2, width * 0.75, height / 2],
    };
    const point = points[direction];
    if (!point) throw new Error("Invalid swipe direction");
    await onDevice(serial, ["shell", "input", "swipe", ...point.map((value) => String(Math.round(value))), "260"]);
    return textResult(`Swiped ${direction}`);
  }
  if (name === "type_text") {
    const value = String(args.text ?? "");
    if (!value || value.length > 256 || !SAFE_TEXT.test(value)) throw new Error("Android text supports only basic ASCII text up to 256 characters");
    await onDevice(serial, ["shell", "input", "text", value.replaceAll(" ", "%s")]);
    return textResult("Typed text into the focused Android field");
  }
  if (name === "press") {
    const key = String(args.key ?? "").toLowerCase();
    if (!KEYCODES[key]) throw new Error("Unsupported Android key");
    await onDevice(serial, ["shell", "input", "keyevent", KEYCODES[key]]);
    return textResult(`Pressed ${key}`);
  }
  throw new Error(`Unknown phone tool: ${name}`);
}

const send = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(message: Json) {
  const id = message.id;
  const method = message.method;
  const params = (message.params ?? {}) as Json;
  if (method === "initialize") return ok(id, { protocolVersion: String(params.protocolVersion ?? "2024-11-05"), capabilities: { tools: {} }, serverInfo: { name: "openmausbot-phone", version: "1" } });
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") return ok(id, {});
  if (method === "tools/list") return ok(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = String(params.name ?? "");
    if (!TOOLS.some((tool) => tool.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
    try {
      return ok(id, await callTool(name, (params.arguments ?? {}) as Json));
    } catch (error) {
      return ok(id, textResult(error instanceof Error ? error.message : String(error), true));
    }
  }
  if (id !== undefined) rpcError(id, -32601, `Method not found: ${String(method)}`);
}

if (process.argv[1] && existsSync(process.argv[1]) && /phone-proxy\.(?:ts|js)$/.test(process.argv[1])) {
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line) as Json;
      void handle(message).catch((error) => rpcError(message.id, -32603, error instanceof Error ? error.message : String(error)));
    } catch {}
  });
}
