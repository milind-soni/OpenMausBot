// Served at POST /api/internal/computer/mcp behind a turn-scoped capability, so the Boat credential never leaves this server.
import type { ValidateFunction } from "ajv";
import { isolatedRemoteCommand, runCommand, screenshotBoat } from "./boat.ts";
import { isRedditAddress, REDDIT_REFUSAL } from "./browser/egress/reddit.ts";
import {
  BACKGROUND_KEEPS_AWAKE_MS, backgroundStatus, commandCompletion, commandLateText, EXEC_LATE, PROCESS_ID_PATTERN, restoreBackgroundCommand, startInBackground, STATUS_WAIT_MAX_SECONDS, STDERR_TAIL_CHARS, STDOUT_TAIL_CHARS, type BackgroundCommandHooks,
} from "./cloud-computer-background.ts";
import { copyFromComputer, copyToComputer } from "./cloud-computer-files.ts";
import type { AppConfig } from "./config.ts";
import type { Coordinator, RoomAddress } from "./coordinator.ts";
import type { BackgroundCommand } from "./runtime/types.ts";
import { controlRefusal, type ControlState } from "./control-client.ts";
import { COMPUTER_COPY_BUDGET_MS, HARNESS_CALL_BUDGET_MS } from "./harness-budget.ts";
import { compileToolSchema } from "./mcp-schema-validator.ts";

export function commandHandoff(coordinator: Coordinator, source: RoomAddress & Pick<BackgroundCommand, "teamComputerId">, id: string, assertActive: () => void): BackgroundCommandHooks {
  const address = { ...source, groupId: source.groupId ?? coordinator.node(id)?.groupId };
  return {
    started: (boxId, processId) => {
      assertActive();
      return coordinator.trackBackground(address, id, { boxId, processId, expiresAt: Date.now() + BACKGROUND_KEEPS_AWAKE_MS,
        ...(source.teamComputerId ? { teamComputerId: source.teamComputerId } : {}) });
    },
    observed: (boxId, processId, result) => {
      assertActive();
      coordinator.observeBackground(address, id, boxId, processId, result);
    },
  };
}

export async function commandResult(cfg: AppConfig, command: BackgroundCommand, signal: AbortSignal): Promise<string | undefined> {
  restoreBackgroundCommand(command.boxId, command.processId, command.expiresAt);
  return commandCompletion(await backgroundStatus(cfg, command.boxId, { process_id: command.processId }, AbortSignal.any([signal, AbortSignal.timeout(20_000)])));
}

const coordinate = { type: "integer", minimum: 0, maximum: 32767 };
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) =>
  ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });
export const CLOUD_COMPUTER_TOOLS = [
  tool("screenshot", "See the assigned cloud desktop at native pixel resolution."),
  tool("get_screen_size", "Get the cloud desktop width and height."),
  tool("click", "Click a point on the cloud desktop.", { x: coordinate, y: coordinate, button: { type: "string", enum: ["left", "middle", "right"] }, count: { type: "integer", minimum: 1, maximum: 3 } }, ["x", "y"]),
  tool("move", "Move the cloud mouse pointer.", { x: coordinate, y: coordinate }, ["x", "y"]),
  tool("drag", "Drag on the cloud desktop.", { x: coordinate, y: coordinate, to_x: coordinate, to_y: coordinate }, ["x", "y", "to_x", "to_y"]),
  tool("type_text", "Type Unicode text into the focused cloud application.", { text: { type: "string", maxLength: 4000 } }, ["text"]),
  tool("key_press", "Press an X11 key or shortcut.", { key: { type: "string", pattern: "^[A-Za-z0-9_+]+$", minLength: 1, maxLength: 100 } }, ["key"]),
  tool("scroll", "Scroll at a point on the cloud desktop.", { x: coordinate, y: coordinate, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "integer", minimum: 1, maximum: 30 } }, ["x", "y", "direction"]),
  tool("open_url", "Request opening an HTTP or HTTPS URL in the cloud desktop browser; inspect the screen to confirm it loaded.", { url: { type: "string", pattern: "^https?://", maxLength: 2000 } }, ["url"]),
  tool("exec", "Run a shell command on the assigned cloud computer and wait for its result. For a command that may run long (downloads, installs, builds, data jobs), set background: true: it starts the command and answers at once with a process_id to follow with exec_status, and the computer stays on for it for up to two hours. The result says whether completion is tracked for this task: when tracked, a terminal result resumes this assignment if the turn ends first. Otherwise use exec_status with wait_seconds in this turn until it finishes. Check the exit code and artifacts; do not claim completion or start another copy blindly.", {
    command: { type: "string", minLength: 1, maxLength: 4000 },
    background: { type: "boolean", description: "Start the command and answer at once with a process_id, instead of waiting for it to finish." },
  }, ["command"]),
  tool("exec_status", `Check a command started with exec and background: true: running or finished, its exit code, and the end of its stdout and stderr (the last ${STDOUT_TAIL_CHARS.toLocaleString("en-US")} and ${STDERR_TAIL_CHARS.toLocaleString("en-US")} characters).`, {
    process_id: { type: "string", pattern: PROCESS_ID_PATTERN },
    wait_seconds: { type: "integer", minimum: 0, maximum: STATUS_WAIT_MAX_SECONDS, description: "Wait up to this many seconds for the command to finish before answering. A running result can arrive before the full interval because the last status read needs time to respond." },
  }, ["process_id"]),
  tool("copy_from_computer", "Copy one file of up to 2 GiB from the cloud computer into your working folder, for example to load it with data_load or use it in a page. A file already there is replaced.", {
    path: { type: "string", minLength: 1, maxLength: 4096, description: "The file on the cloud computer, under /home/user or /tmp." },
    to: { type: "string", minLength: 1, maxLength: 1000, description: "Where it goes, relative to your working folder. Default: the file's own name." },
  }, ["path"]),
  tool("copy_to_computer", "Copy one file of up to 2 GiB from your working folder to the cloud computer. A file already there is replaced.", {
    from: { type: "string", minLength: 1, maxLength: 1000, description: "The file, relative to your working folder." },
    path: { type: "string", minLength: 1, maxLength: 4096, description: "Where it goes on the cloud computer, under /home/user or /tmp." },
  }, ["from", "path"]),
];
/** A call the gate let through while no Boat had landed for the turn. */
export const CLOUD_COMPUTER_NOT_READY = "The cloud computer is not ready. This call was not performed. Take a fresh screenshot in a moment.";
export const CLOUD_COMPUTER_LATE = "The cloud computer did not answer in time. This call may still have run; take a fresh screenshot before repeating it.";
export const CLOUD_COMPUTER_COPY_LATE = "The copy did not finish within 9 minutes and was stopped; nothing was changed. Make the file smaller on the cloud computer first (filter, compress or split it), then copy the parts.";
const COPY_TOOLS = new Set(["copy_from_computer", "copy_to_computer"]);
export const cloudComputerCallBudgetMs = (name: unknown): number =>
  typeof name === "string" && COPY_TOOLS.has(name) ? COMPUTER_COPY_BUDGET_MS : HARNESS_CALL_BUDGET_MS;
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const buttons: Record<string, number> = { left: 1, middle: 2, right: 3 };
const scrollButtons: Record<string, number> = { up: 4, down: 5, left: 6, right: 7 };

let validators: Map<string, ValidateFunction> | undefined;

/** x and y reach the remote shell unquoted, so only the advertised integer schema stands between a model's arguments and a command line.
 * A cloud computer browses from a data centre, so it never opens Reddit. */
export function cloudComputerCallProblem(name: unknown, args: unknown): string | null {
  validators ??= new Map(CLOUD_COMPUTER_TOOLS.map(entry => [entry.name, compileToolSchema(entry.inputSchema)]));
  const validate = typeof name === "string" ? validators.get(name) : undefined;
  if (!validate) return "Unknown cloud computer tool. Use one of the advertised computer tools.";
  if (!args || typeof args !== "object" || Array.isArray(args) || !validate(args)) {
    return "Tool arguments do not match the advertised input schema; use its required fields and types.";
  }
  if (name === "open_url" && isRedditAddress(String((args as { url: unknown }).url))) return REDDIT_REFUSAL;
  return null;
}

export type CloudComputerResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>;
  isError?: boolean;
};

/** The caller has already checked the arguments and the person's control. `folder` is the bot's working folder for this turn. */
export async function runCloudComputerTool(
  cfg: AppConfig,
  boxId: string,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  folder?: string | null,
  background?: BackgroundCommandHooks,
): Promise<CloudComputerResult> {
  const problem = cloudComputerCallProblem(name, args);
  if (problem) return { isError: true, content: [{ type: "text", text: problem }] };
  signal.throwIfAborted();
  if (COPY_TOOLS.has(name)) {
    if (!folder) return { isError: true, content: [{ type: "text", text: "This turn has no working folder to copy into or out of." }] };
    const copied = name === "copy_from_computer"
      ? await copyFromComputer(cfg, boxId, folder, args as { path: string; to?: string }, signal)
      : await copyToComputer(cfg, boxId, folder, args as { from: string; path: string }, signal);
    return "error" in copied ? { isError: true, content: [{ type: "text", text: copied.error }] } : { content: [{ type: "text", text: JSON.stringify(copied) }] };
  }
  if (name === "screenshot") {
    const shot = await screenshotBoat(cfg, "", boxId, { signal, nativeSize: true });
    signal.throwIfAborted();
    return { content: [{ type: "image", mimeType: "image/jpeg", data: shot.png }] };
  }
  const a = args;
  const mouse = `xdotool mousemove --sync ${a.x} ${a.y}`;
  let command: string;
  switch (name) {
    case "get_screen_size": command = "xdotool getdisplaygeometry"; break;
    case "click": command = `${mouse} click --repeat ${a.count ?? 1} --delay 100 ${buttons[String(a.button ?? "left")]}`; break;
    case "move": command = mouse; break;
    case "drag": command = `${mouse} mousedown 1 mousemove --sync ${a.to_x} ${a.to_y} mouseup 1`; break;
    case "type_text": command = `printf %s ${quote(Buffer.from(String(a.text)).toString("base64"))} | base64 -d | xclip -selection clipboard && xdotool key --clearmodifiers ctrl+v`; break;
    case "key_press": command = `xdotool key --clearmodifiers ${quote(String(a.key))}`; break;
    case "scroll": command = `${mouse} click --repeat ${a.amount ?? 3} --delay 80 ${scrollButtons[String(a.direction)]}`; break;
    case "open_url": command = `nohup xdg-open ${quote(String(a.url))} >/dev/null 2>&1 </dev/null &`; break;
    case "exec": if (a.background === true) return startInBackground(cfg, boxId, String(a.command), signal, background); command = String(a.command); break;
    case "exec_status": {
      const result = await backgroundStatus(cfg, boxId, a as { process_id: string; wait_seconds?: number }, signal);
      const completed = commandCompletion(result);
      if (completed !== undefined) background?.observed(boxId, String(a.process_id), completed);
      return result;
    }
    default: return { isError: true, content: [{ type: "text", text: "Unknown cloud computer tool." }] };
  }
  const result = await runCommand(cfg, boxId, isolatedRemoteCommand(command), { signal });
  signal.throwIfAborted();
  if (name === "open_url" && result.ok) return { content: [{ type: "text", text: "Browser launch requested. Page loading is not confirmed; inspect the screen before continuing." }] };
  if (name === "exec" && result.timedOut) return { isError: true, content: [{ type: "text", text: EXEC_LATE }] };
  return { isError: !result.ok, content: [{ type: "text", text: JSON.stringify(result) }] };
}

/** The order is the safety argument: arguments, then the control gate (which may create or wake the Boat), then the Boat
 * read; the turn's capability must be live before and after the Boat acts. Listing touches no Boat. */
export async function cloudComputerRpc(
  request: { method?: unknown; params?: unknown } | null | undefined,
  deps: {
    cfg: AppConfig;
    background?: BackgroundCommandHooks;
    /** The Boat this call acts on, read after the gate. */
    boxId(): string | null | undefined;
    /** The bot's working folder, which the copy tools read from and write into. */
    folder?(): string | null | undefined;
    gate(): Promise<Pick<ControlState, "held" | "reason" | "blockedReason">>;
    assertActive(): void;
    signal: AbortSignal;
    /** The whole call, the gate's wait included, answers within this. */
    budgetMs?: number;
  },
): Promise<{ tools: typeof CLOUD_COMPUTER_TOOLS } | CloudComputerResult> {
  const started = Date.now();
  if (request?.method === "tools/list") {
    deps.assertActive();
    return { tools: CLOUD_COMPUTER_TOOLS };
  }
  if (request?.method !== "tools/call") throw Object.assign(new Error("unsupported computer method"), { status: 400 });
  const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown };
  const args = params.arguments ?? {};
  const copy = typeof params.name === "string" && COPY_TOOLS.has(params.name);
  const deadline = started + (deps.budgetMs ?? cloudComputerCallBudgetMs(params.name));
  const problem = cloudComputerCallProblem(params.name, args);
  if (problem) return { isError: true, content: [{ type: "text", text: problem }] };
  const control = await deps.gate();
  // A refusal acts on no Boat, so it answers even when the turn has ended meanwhile.
  if (control.held) return { isError: true, content: [{ type: "text", text: controlRefusal(control) }] };
  deps.assertActive();
  const boxId = deps.boxId();
  if (!boxId) return { isError: true, content: [{ type: "text", text: CLOUD_COMPUTER_NOT_READY }] };
  const late = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  let result: CloudComputerResult;
  try {
    result = await runCloudComputerTool(deps.cfg, boxId, params.name as string, args as Record<string, unknown>, AbortSignal.any([deps.signal, late]), deps.folder?.(), deps.background);
  } catch (error) {
    if (!late.aborted || deps.signal.aborted) throw error;
    return { isError: true, content: [{ type: "text", text: commandLateText(params.name, args) ?? (copy ? CLOUD_COMPUTER_COPY_LATE : CLOUD_COMPUTER_LATE) }] };
  }
  deps.assertActive();
  return result;
}
