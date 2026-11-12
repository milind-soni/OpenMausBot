// First-party Android phone MCP server: physical USB devices only (no emulators, wireless or network ADB).
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

import { PHONE_STEP_TOOLS, type PhoneStepTool } from "../../shared/phone-steps.ts";

type Json = Record<string, unknown>;
type Device = { serial: string; state: string; model: string; connection: "usb" | "network" | "emulator" };
type UiNode = { text: string; description: string; id: string; className: string; bounds: [number, number, number, number] };
type ClaimOutcome = { ok: true } | { ok: false; message: string };

const MAX_ADB_OUTPUT = 16 * 1024 * 1024;
const PHONE_BUSY_TEXT = "Another thread is using the phone. This call was not performed. Pause phone work until that thread finishes, then read the screen again before acting.";
const PACKAGE = /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/;
const COMPONENT = /^([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\/\S+$/;
const SAFE_TEXT = /^[A-Za-z0-9 _.,@-]+$/;
const ADB_KEYBOARD = "com.android.adbkeyboard/.AdbIME";
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
  sleep: "KEYCODE_SLEEP",
  space: "KEYCODE_SPACE",
  tab: "KEYCODE_TAB",
  up: "KEYCODE_DPAD_UP",
  wakeup: "KEYCODE_WAKEUP",
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

type Shell = (...command: string[]) => Promise<string>;
const deviceShell = (serial: string): Shell => async (...command) => (await onDevice(serial, ["shell", ...command])).toString("utf8");

export async function typePhoneText(shell: Shell, text: string): Promise<string> {
  if (!text || [...text].length > 256) throw new Error("Android text must be 1 to 256 characters");
  if (SAFE_TEXT.test(text)) {
    await shell("input", "text", text.replaceAll(" ", "%s"));
    return "Typed text into the focused Android field";
  }
  if ((await shell("settings", "get", "secure", "default_input_method")).trim() !== ADB_KEYBOARD) {
    throw new Error("Only letters, digits, spaces and _.,@- can be typed until ADBKeyBoard (https://github.com/senzhk/ADBKeyBoard) is installed and chosen as the phone's keyboard. Ask the person to set it up, or type only those characters.");
  }
  // ADBKeyBoard reads msg as Base64 UTF-8; Base64 also keeps the text out of the device shell's syntax.
  // -p delivers it to ADBKeyBoard alone, not to any other app listening for the action.
  await shell("am", "broadcast", "-a", "ADB_INPUT_B64", "-p", "com.android.adbkeyboard", "--es", "msg", Buffer.from(text, "utf8").toString("base64"));
  // ADBKeyBoard drops the text when no field has focus, and the broadcast reports success either way.
  return "Sent the text to ADBKeyBoard. Use read_screen to check that it reached the field.";
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

export function launchTarget(name: string, packages: string[]) {
  const matches = findPackages(name, packages);
  if (matches.length === 1) return matches[0];
  throw new Error(matches.length
    ? `App name is ambiguous: ${matches.join(", ")}`
    : `No installed launchable app matches ${JSON.stringify(name)}. open_app knows English names and package names; call list_apps without a query and pass the package name.`);
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

const SINGLE_TOOLS = [
  { name: "status", description: "Check physical USB Android devices and USB-debugging authorization before any Android phone task.", inputSchema: { type: "object", properties: {} } },
  { name: "read_screen", description: "Read visible text, accessibility labels, resource ids, and pixel bounds from the connected Android screen. Use it before choosing what to act on. To act and see the result in one call, put the action and read_screen in one batch.", inputSchema: { type: "object", properties: { serial: { type: "string" } } } },
  { name: "screenshot", description: "Capture the connected Android screen when accessibility text is insufficient. Returns a PNG image.", inputSchema: { type: "object", properties: { serial: { type: "string" } } } },
  { name: "list_apps", description: "List installed launchable Android package names, optionally filtered by a human app name. Prefer open_app first.", inputSchema: { type: "object", properties: { query: { type: "string" }, serial: { type: "string" } } } },
  { name: "open_app", description: "Open an installed Android app directly by its English name, such as Uber or Skyscanner, or by its package name. Do not scan the app drawer first.", inputSchema: { type: "object", properties: { name: { type: "string" }, serial: { type: "string" } }, required: ["name"] } },
  { name: "tap_text", description: "Tap visible Android text or an accessibility label.", inputSchema: { type: "object", properties: { text: { type: "string" }, exact: { type: "boolean" }, index: { type: "integer", minimum: 0 }, serial: { type: "string" } }, required: ["text"] } },
  { name: "tap", description: "Tap Android screen pixel coordinates obtained from read_screen or screenshot.", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, serial: { type: "string" } }, required: ["x", "y"] } },
  { name: "swipe", description: "Swipe the Android screen in a direction.", inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] }, serial: { type: "string" } }, required: ["direction"] } },
  { name: "type_text", description: "Type text into the focused Android field. Letters, digits, spaces and _.,@- always work; other text, such as Chinese, emoji or +, needs the ADBKeyBoard keyboard selected on the phone. Never enter passwords or payment details. A one-time code only for a sign-in the person asked for, into the app it was sent for.", inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 256 }, serial: { type: "string" } }, required: ["text"] } },
  { name: "press", description: "Press an Android navigation or keyboard key. wakeup turns the screen on and sleep turns it off.", inputSchema: { type: "object", properties: { key: { type: "string", enum: Object.keys(KEYCODES) }, serial: { type: "string" } }, required: ["key"] } },
] as const;

type StepAction = PhoneStepTool | "wait";
export type PhoneStep = Json & { action: StepAction };
type StepRule = { ok: (step: Json) => boolean; needs: string; example?: Json };
type FieldSchema = { type?: string; enum?: readonly string[]; [keyword: string]: unknown };

const STEP_ACTIONS: readonly StepAction[] = [...PHONE_STEP_TOOLS, "wait"];
const MAX_STEPS = 10;
const DEFAULT_WAIT_SECONDS = 2;
const MAX_WAIT_SECONDS = 60;
const STEP_FIELD_NOTES: Record<string, string> = {
  name: "the app's English name or package name",
  text: "the visible text to tap, or the text to type",
  exact: "true to match the whole text, not part of it",
  index: "which match of the text, from 0",
  x: "pixel x from read_screen or screenshot",
  y: "pixel y from read_screen or screenshot",
  direction: "which way to swipe",
  key: "the key to press",
  seconds: `how long to wait, 0 to ${MAX_WAIT_SECONDS}, default ${DEFAULT_WAIT_SECONDS}`,
};
const STEP_EXAMPLES: Record<StepAction, Json> = {
  open_app: { action: "open_app", name: "Settings" },
  tap_text: { action: "tap_text", text: "Search" },
  tap: { action: "tap", x: 540, y: 1200 },
  swipe: { action: "swipe", direction: "up" },
  type_text: { action: "type_text", text: "iPad mini" },
  press: { action: "press", key: "enter" },
  read_screen: { action: "read_screen" },
  wait: { action: "wait", seconds: 3 },
};
const inPixels = (value: unknown) => Number.isFinite(value) && Number(value) >= 0 && Number(value) <= 10_000;
const STEP_RULES: Partial<Record<StepAction, StepRule[]>> = {
  open_app: [{ ok: (step) => String(step.name).trim() !== "", needs: "name, an app's English name or package name" }],
  tap_text: [
    { ok: (step) => String(step.text).trim() !== "", needs: "text that is not blank" },
    { ok: (step) => step.index === undefined || (Number.isInteger(step.index) && Number(step.index) >= 0), needs: "index as a whole number from 0", example: { action: "tap_text", text: "Search", index: 1 } },
  ],
  tap: [{ ok: (step) => inPixels(step.x) && inPixels(step.y), needs: "x and y from 0 to 10000" }],
  type_text: [{ ok: (step) => [...String(step.text)].length <= 256, needs: "text of at most 256 characters" }],
  wait: [{ ok: (step) => step.seconds === undefined || Number(step.seconds) >= 0, needs: `seconds as a number from 0 to ${MAX_WAIT_SECONDS}` }],
};

function stepSchema(action: StepAction): { properties: Record<string, FieldSchema>; required?: readonly string[] } {
  if (action === "wait") return { properties: { seconds: { type: "number", minimum: 0 } } };
  return SINGLE_TOOLS.find((tool) => tool.name === action)!.inputSchema;
}

const stepFields = (action: StepAction) => Object.keys(stepSchema(action).properties).filter((field) => field !== "serial");
const fieldOwners = (field: string) => STEP_ACTIONS.filter((action) => stepFields(action).includes(field));

function stepProperties() {
  const properties: Record<string, FieldSchema> = {
    action: { type: "string", enum: STEP_ACTIONS, description: "What the step does: a phone tool's name, or wait." },
  };
  for (const action of STEP_ACTIONS) {
    for (const field of stepFields(action)) {
      const owners = fieldOwners(field).join(" and ");
      const note = STEP_FIELD_NOTES[field];
      properties[field] ??= { ...stepSchema(action).properties[field], description: note ? `${owners}: ${note}.` : owners };
    }
  }
  return properties;
}

const STEP_PROPERTIES = stepProperties();

const lower = (value: unknown) => String(value).toLowerCase();
const toNumber = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN);

function coerce(field: string, value: unknown): unknown {
  const { type, enum: choices } = STEP_PROPERTIES[field];
  if (type === "number" || type === "integer") return toNumber(value);
  if (type === "boolean") return value === "true" || value === "false" ? value === "true" : value;
  if (type === "string") return choices ? lower(value) : String(value);
  return value;
}

function typeRules(action: StepAction): StepRule[] {
  return stepFields(action).flatMap((field): StepRule[] => {
    const { type, enum: choices } = stepSchema(action).properties[field];
    if (type === "boolean") {
      return [{ ok: (step) => step[field] === undefined || typeof step[field] === "boolean", needs: `${field} as true or false`, example: { ...STEP_EXAMPLES[action], [field]: true } }];
    }
    if (choices) return [{ ok: (step) => step[field] === undefined || choices.includes(String(step[field])), needs: `${field} as one of ${choices.join(", ")}` }];
    return [];
  });
}

const BATCH_HINT = "To do several steps, or to act and then read the screen, in one call, use batch.";
const takesBatchHint = (name: string) => name !== "read_screen" && (PHONE_STEP_TOOLS as readonly string[]).includes(name);

export const TOOLS = [
  ...SINGLE_TOOLS.map((tool) => (takesBatchHint(tool.name) ? { ...tool, description: `${tool.description} ${BATCH_HINT}` } : tool)),
  {
    name: "batch",
    description: `Run up to ${MAX_STEPS} phone steps in order in one call. A step is one of open_app, tap_text, tap, swipe, type_text, press, read_screen or wait, with that tool's fields: {action, ...fields}. Add read_screen as the last step to see the result; the batch returns the screen only at a read_screen step. A wait step (0 to ${MAX_WAIT_SECONDS} s) gives content time to load. It stops at the first failing step. End a batch where the next screen is uncertain, such as after a step that may open a dialog, and read it before acting further. Example: {"steps":[{"action":"tap_text","text":"Search"},{"action":"type_text","text":"iPad mini"},{"action":"press","key":"enter"},{"action":"wait","seconds":3},{"action":"read_screen"}]}`,
    inputSchema: {
      type: "object",
      properties: {
        steps: { type: "array", maxItems: MAX_STEPS, items: { type: "object", properties: STEP_PROPERTIES, required: ["action"] } },
        serial: { type: "string" },
      },
      required: ["steps"],
    },
  },
] as const;

type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean };
const textResult = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

const isStepAction = (value: unknown): value is StepAction => STEP_ACTIONS.includes(value as StepAction);
const refusal = (problem: string) => new Error(`${problem}. No step was performed.`);

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function parseSteps(raw: unknown): PhoneStep[] {
  const steps = parseJson(raw);
  if (!Array.isArray(steps) || !steps.length) {
    throw refusal(`steps needs a list of 1 to ${MAX_STEPS} steps, e.g. {"steps":[{"action":"tap_text","text":"Search"},{"action":"read_screen"}]}`);
  }
  if (steps.length > MAX_STEPS) throw refusal(`A batch runs at most ${MAX_STEPS} steps, not ${steps.length}; split them into several batches`);
  return steps.map((step, index) => parseStep(parseJson(step), index + 1));
}

function parseStep(raw: unknown, n: number): PhoneStep {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw refusal(`Step ${n} needs to be an object such as ${JSON.stringify(STEP_EXAMPLES.tap_text)}`);
  const { serial } = raw as Json;
  if (serial !== undefined && serial !== null && serial !== "") {
    const named = typeof serial === "string" || typeof serial === "number" ? String(serial) : "<serial>";
    throw refusal(`Step ${n} names a serial, but a batch runs on one phone; set serial once beside steps, e.g. ${JSON.stringify({ serial: named, steps: [STEP_EXAMPLES.read_screen] })}`);
  }
  const step: Json = {};
  for (const [field, value] of Object.entries(raw)) {
    if (!Object.hasOwn(STEP_PROPERTIES, field) || value === null || value === "") continue;
    step[field] = typeof value === "object" ? value : coerce(field, value);
  }
  const { action } = step;
  if (action === "screenshot") throw refusal(`Step ${n}: screenshot returns an image and cannot be a batch step; use read_screen, or call screenshot after the batch`);
  if (action === "batch") throw refusal(`Step ${n}: a batch cannot be a batch step; put its steps in this list`);
  if (!isStepAction(action)) throw refusal(`Step ${n} needs an action from ${STEP_ACTIONS.join(", ")}, e.g. ${JSON.stringify(STEP_EXAMPLES.tap_text)}`);
  const example = JSON.stringify(STEP_EXAMPLES[action]);
  const foreign = Object.keys(step).find((field) => field !== "action" && !stepFields(action).includes(field));
  if (foreign === "seconds") {
    const seconds = Number.isFinite(step.seconds) && Number(step.seconds) >= 0 ? step.seconds : STEP_EXAMPLES.wait.seconds;
    throw refusal(`Step ${n} (${action}) does not take seconds; put a separate ${JSON.stringify({ action: "wait", seconds })} step after it`);
  }
  if (foreign) throw refusal(`Step ${n} (${action}) does not take ${foreign}, which belongs to ${fieldOwners(foreign).join(" or ")}; write it like ${example}`);
  const missing = (stepSchema(action).required ?? []).filter((field) => step[field] === undefined);
  if (missing.length) throw refusal(`Step ${n} (${action}) needs ${missing.join(" and ")}, e.g. ${example}`);
  const nested = Object.keys(step).find((field) => typeof step[field] === "object");
  if (nested) throw refusal(`Step ${n} (${action}) needs ${nested} as a single value, not a list or an object, e.g. ${example}`);
  const broken = [...(STEP_RULES[action] ?? []), ...typeRules(action)].find((rule) => !rule.ok(step));
  if (broken) throw refusal(`Step ${n} (${action}) needs ${broken.needs}, e.g. ${JSON.stringify(broken.example ?? STEP_EXAMPLES[action])}`);
  return { ...step, action };
}

// The harness reserves the phone per turn from the first real tool call. Retained MCP processes can
// outlive their turn, so every call revalidates the claim.
export function createPhoneClaim(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): () => Promise<ClaimOutcome> {
  const url = env.OMB_HARNESS_URL?.trim();
  const token = env.OMB_PHONE_TOKEN?.trim();
  if (!url || !token) {
    return async () => ({ ok: true });
  }
  return async () => {
    try {
      const response = await fetchImpl(new URL("/api/internal/phone/claim", url), {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { ok: true };
      if (response.status === 409) return { ok: false, message: PHONE_BUSY_TEXT };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: "This turn no longer has phone access. Start a new turn to use the phone." };
      }
      return { ok: false, message: "OpenMausBot could not reserve the phone for this call. This call was not performed; try again, or start a new turn if it keeps failing." };
    } catch {
      return { ok: false, message: "OpenMausBot could not be reached to reserve the phone. This call was not performed; try again." };
    }
  };
}

async function wait(requested: unknown): Promise<string> {
  const seconds = Math.min(requested === undefined ? DEFAULT_WAIT_SECONDS : Number(requested), MAX_WAIT_SECONDS);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  return seconds < Number(requested) ? `Waited ${seconds} s (a wait is at most ${MAX_WAIT_SECONDS} s)` : `Waited ${seconds} s`;
}

async function act(serial: string, { action, ...fields }: PhoneStep): Promise<string> {
  if (action === "wait") return wait(fields.seconds);
  const [first] = (await callToolOn(serial, action, fields)).content;
  return first.type === "text" ? first.text : "";
}

const reason = (problem: unknown) => (problem instanceof Error ? problem.message : String(problem)).replace(/\.$/, "");
// Mid-batch, earlier steps did run, so a claim text's "This call was not performed" sentence would be false.
const midBatchClaimReason = (message: string) => reason(message.replace(/ This call was not performed[^.]*\./, ""));
const EARLIER_AND_LATER_STEPS = "Steps before it were done; do not repeat them. Later steps were not performed.";

export async function runSteps(
  serial: string,
  steps: PhoneStep[],
  ensureClaim: () => Promise<ClaimOutcome>,
  perform: (serial: string, step: PhoneStep) => Promise<string> = act,
): Promise<ToolResult> {
  const lines: string[] = [];
  for (const [index, step] of steps.entries()) {
    const n = index + 1;
    // Stopping the turn revokes its phone claim while this process lives on, so each later step rechecks it.
    if (n > 1) {
      const claim = await ensureClaim();
      if (!claim.ok) return textResult([...lines, `Stopped before step ${n}: ${midBatchClaimReason(claim.message)}. ${EARLIER_AND_LATER_STEPS}`].join("\n"));
    }
    let output: string;
    try {
      output = await perform(serial, step);
    } catch (error) {
      // An error flag leads models to redo the whole call, so it marks only a first-step failure, where no finished step is redone.
      return textResult([...lines, `Step ${n} failed: ${reason(error)}. Its effect is unknown; call read_screen or screenshot before trying it again. ${EARLIER_AND_LATER_STEPS}`].join("\n"), n === 1);
    }
    lines.push(step.action === "read_screen" ? `${n}. read_screen:\n${output}` : `${n}. ${step.action}: ${output}`);
  }
  return textResult(lines.join("\n"));
}

async function callTool(name: string, args: Json, ensureClaim: () => Promise<ClaimOutcome>): Promise<ToolResult> {
  if (name === "status") {
    const adb = resolveAdbPath();
    const devices = adb ? await usbDevices() : [];
    return textResult(JSON.stringify({ available: Boolean(adb), devices }, null, 2));
  }
  if (name === "batch") {
    const steps = parseSteps(args.steps);
    return runSteps(await readySerial(args.serial), steps, ensureClaim);
  }
  const serial = await readySerial(args.serial);
  return callToolOn(serial, name, args);
}

async function callToolOn(serial: string, name: string, args: Json): Promise<ToolResult> {
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
    const target = launchTarget(appName, await launchablePackages(serial));
    await onDevice(serial, ["shell", "monkey", "-p", target, "-c", "android.intent.category.LAUNCHER", "1"]);
    return textResult(`Opened ${appName} (${target})`);
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
  if (name === "type_text") return textResult(await typePhoneText(deviceShell(serial), String(args.text ?? "")));
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

async function handle(message: Json, ensureClaim: () => Promise<ClaimOutcome>) {
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
    const claim = await ensureClaim();
    if (!claim.ok) return ok(id, textResult(claim.message, true));
    try {
      return ok(id, await callTool(name, (params.arguments ?? {}) as Json, ensureClaim));
    } catch (error) {
      return ok(id, textResult(error instanceof Error ? error.message : String(error), true));
    }
  }
  if (id !== undefined) rpcError(id, -32601, `Method not found: ${String(method)}`);
}

if (process.argv[1] && existsSync(process.argv[1]) && /phone-proxy\.(?:ts|js)$/.test(process.argv[1])) {
  const ensureClaim = createPhoneClaim();
  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line) as Json;
      void handle(message, ensureClaim).catch((error) => rpcError(message.id, -32603, error instanceof Error ? error.message : String(error)));
    } catch {}
  });
}
