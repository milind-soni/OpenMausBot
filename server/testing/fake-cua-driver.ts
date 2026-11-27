#!/usr/bin/env node
// Fake of `cua-driver mcp` for the saved-steps fixture: TextEdit's one window, answered in cua-driver 0.28.2's shapes
// (a whole tree says elements_complete with matching counts and echoes the pid and window_id asked for; every app and
// window carries its pid; a text element's `value` is what it holds), with element tokens that go stale at the next
// get_window_state, as the real driver's do.
// Env knobs:
//   FAKE_CUA_STATE  JSON file holding the snapshot count and the document's text, so the fixture's many driver processes agree on them
//   FAKE_CUA_LOG    JSON-lines file each tools/call is appended to as {name, arguments} when it arrives
//   FAKE_CUA_FAIL   path: the next set_value on a live element while it exists removes it and answers isError "Fixture failure."
//   FAKE_CUA_HOLD   path: click and set_value wait while it exists before answering
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv[2] !== "mcp") {
  process.stderr.write("usage: fake-cua-driver.ts mcp\n");
  process.exit(2);
}

const { FAKE_CUA_STATE: stateFile, FAKE_CUA_LOG: logFile, FAKE_CUA_FAIL: failFile, FAKE_CUA_HOLD: holdFile } = process.env;

const TEXTEDIT = { pid: 4242, name: "TextEdit", bundle_id: "com.apple.TextEdit" };
const APPS = [
  { ...TEXTEDIT, running: true, active: true },
  { pid: 401, name: "Finder", bundle_id: "com.apple.finder", running: true, active: false },
];
const WINDOWS = [
  { window_id: 7, pid: TEXTEDIT.pid, app_name: TEXTEDIT.name, title: "Untitled", is_on_screen: true, bounds: { x: 120, y: 80, width: 800, height: 600 } },
  { window_id: 12, pid: 401, app_name: "Finder", title: "Desktop", is_on_screen: true, bounds: { x: 0, y: 0, width: 1440, height: 900 } },
];
const DOCUMENT_WINDOW = WINDOWS[0]!;
const ELEMENTS = [
  { element_index: 0, role: "AXWindow", label: "Untitled", depth: 0 },
  { element_index: 1, role: "AXScrollArea", parent_index: 0, depth: 1 },
  { element_index: 2, role: "AXTextArea", label: "Document", parent_index: 1, depth: 2 },
  { element_index: 3, role: "AXButton", label: "Save", parent_index: 0, depth: 1 },
];

const TOOLS = [
  { name: "list_apps", description: "List running apps.", inputSchema: { type: "object", properties: {} } },
  {
    name: "list_windows",
    description: "List windows, optionally for one pid.",
    inputSchema: { type: "object", properties: { pid: { type: "integer" }, on_screen_only: { type: "boolean" } } },
  },
  {
    name: "get_window_state",
    description: "Read a window's accessibility tree; its element tokens replace every earlier snapshot's.",
    inputSchema: {
      type: "object",
      properties: { pid: { type: "integer" }, window_id: { type: "integer" }, include_screenshot: { type: "boolean" } },
      required: ["pid", "window_id"],
    },
  },
  {
    name: "click",
    description: "Click an element by its token.",
    inputSchema: { type: "object", properties: { element_token: { type: "string" }, pid: { type: "integer" }, window_id: { type: "integer" } } },
  },
  {
    name: "set_value",
    description: "Replace an element's value by its token.",
    inputSchema: {
      type: "object",
      properties: { element_token: { type: "string" }, pid: { type: "integer" }, window_id: { type: "integer" }, value: { type: "string" } },
      required: ["value"],
    },
  },
];

type Args = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: true };

const text = (message: string, structuredContent?: Record<string, unknown>): ToolResult =>
  ({ content: [{ type: "text", text: message }], ...(structuredContent ? { structuredContent } : {}) });
const refused = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

type FakeState = { snapshot: number; document: string };
let stateInMemory: FakeState = { snapshot: 0, document: "" };
function readState(): FakeState {
  if (!stateFile) return stateInMemory;
  try {
    const { snapshot, document } = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    return {
      snapshot: typeof snapshot === "number" && Number.isInteger(snapshot) && snapshot >= 0 ? snapshot : 0,
      document: typeof document === "string" ? document : "",
    };
  } catch {
    return { snapshot: 0, document: "" };
  }
}
function writeState(state: FakeState): void {
  if (!stateFile) {
    stateInMemory = state;
    return;
  }
  const partial = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(partial, JSON.stringify(state));
  renameSync(partial, stateFile);
}
const currentSnapshot = () => readState().snapshot;
function nextSnapshot(): number {
  const state = readState();
  writeState({ ...state, snapshot: state.snapshot + 1 });
  return state.snapshot + 1;
}

function windowState(args: Args): ToolResult {
  const { pid, window_id: windowId } = args;
  if (pid !== DOCUMENT_WINDOW.pid || windowId !== DOCUMENT_WINDOW.window_id) return refused(`no window ${String(windowId)} for pid ${String(pid)}`);
  const snapshot = nextSnapshot();
  const { document } = readState();
  const elements = ELEMENTS.map((element) => ({
    ...element, element_token: `s${snapshot}-e${element.element_index}`, ...(element.role === "AXTextArea" ? { value: document } : {}),
  }));
  const tree = elements.map((element) => `${"  ".repeat(element.depth)}- [${element.element_index}] ${element.role}${"label" in element ? ` "${element.label}"` : ""}`).join("\n");
  return text(tree, {
    pid, window_id: windowId, snapshot_id: `s${snapshot}`, app_name: TEXTEDIT.name, window_title: DOCUMENT_WINDOW.title, elements,
    element_count: elements.length, returned_element_count: elements.length, total_element_count: elements.length, elements_complete: true,
  });
}

function target(args: Args): ToolResult | (typeof ELEMENTS)[number] {
  const token = args.element_token;
  if (typeof token !== "string") return refused("this driver addresses elements by element_token");
  const match = /^s(\d+)-e(\d+)$/.exec(token);
  const snapshot = Number(match?.[1]);
  const element = ELEMENTS[Number(match?.[2])];
  const latest = currentSnapshot();
  if (!match || !element || snapshot < 1 || snapshot > latest) return refused(`unknown element token ${token}`);
  if (snapshot < latest) return refused(`stale element token ${token}: call get_window_state again`);
  if ((args.pid !== undefined && args.pid !== DOCUMENT_WINDOW.pid) || (args.window_id !== undefined && args.window_id !== DOCUMENT_WINDOW.window_id)) {
    return refused(`element token ${token} belongs to another window`);
  }
  return element;
}

let inputClosed = false;
async function held(): Promise<void> {
  while (holdFile && existsSync(holdFile) && !inputClosed) await new Promise((resolve) => setTimeout(resolve, 25));
}

async function act(name: "click" | "set_value", args: Args): Promise<ToolResult> {
  await held();
  const element = target(args);
  if ("content" in element) return element;
  const described = `${element.role} "${"label" in element ? element.label : ""}"`;
  if (name === "click") return text(`Clicked ${described}.`);
  if (typeof args.value !== "string") return refused("set_value needs a value");
  if (failFile && existsSync(failFile)) {
    rmSync(failFile, { force: true });
    return refused("Fixture failure.");
  }
  if (element.role === "AXTextArea") writeState({ ...readState(), document: args.value });
  return text(`Set ${described} to ${args.value.length} characters.`);
}

async function callTool(name: unknown, args: Args): Promise<ToolResult> {
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ name, arguments: args })}\n`);
  if (name === "list_apps") return text(APPS.map((app) => `${app.name} (${app.pid})`).join("\n"), { apps: APPS });
  if (name === "list_windows") {
    const windows = typeof args.pid === "number" ? WINDOWS.filter((window) => window.pid === args.pid) : WINDOWS;
    return text(windows.map((window) => `${window.window_id} ${window.title}`).join("\n"), { windows });
  }
  if (name === "get_window_state") return windowState(args);
  if (name === "click" || name === "set_value") return act(name, args);
  return refused(`unknown tool ${String(name)}`);
}

const send = (frame: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
};

async function answer(line: string): Promise<void> {
  let frame: { id?: number | string; method?: string; params?: { protocolVersion?: string; name?: unknown; arguments?: unknown } };
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = frame;
  if (id === undefined) return;
  if (method === "initialize") {
    return send({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cua-driver", version: "0.28.2" } } });
  }
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list") return send({ id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    const args = params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as Args : {};
    return send({ id, result: await callTool(params?.name, args) });
  }
  send({ id, error: { code: -32601, message: `method not found: ${String(method)}` } });
}

process.stdout.on("error", () => {});
let queue = Promise.resolve();
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  queue = queue.then(() => answer(line));
});
lines.on("close", () => {
  inputClosed = true;
});
