// Served at POST /api/internal/computer/mcp behind a turn-scoped capability, so the Boat credential never leaves this server.
import type { ValidateFunction } from "ajv";
import { isolatedRemoteCommand, screenshotBoat } from "./boat.ts";
import { isRedditAddress, REDDIT_REFUSAL } from "./browser/egress/reddit.ts";
import {
  backgroundStatus, commandLateText, EXEC_LATE, PROCESS_ID_PATTERN, processIdOn, startInBackground, STATUS_WAIT_MAX_SECONDS, STDERR_TAIL_CHARS, STDOUT_TAIL_CHARS,
} from "./cloud-computer-background.ts";
import { COMMAND_WALL, commandsLeftRunning, noteLeftRunning, untrackProcess } from "./boat-command.ts";
import { copyFromComputer, copyToComputer } from "./cloud-computer-files.ts";
import { retryRead, runOnce } from "./cloud-computer-once.ts";
import type { AppConfig } from "./config.ts";
import { controlRefusal, type ControlState } from "./control-client.ts";
import { COMPUTER_COPY_BUDGET_MS, HARNESS_CALL_BUDGET_MS } from "./harness-budget.ts";
import { compileToolSchema } from "./mcp-schema-validator.ts";
import {
  CLOUD_COMPUTER_ANSWER_LOST, CLOUD_COMPUTER_EXEC_ANSWER_LOST, CLOUD_COMPUTER_NO_ANSWER, CLOUD_COMPUTER_STILL_RESTORING, CLOUD_COMPUTER_STILL_WAKING,
  CLOUD_COMPUTER_UNREACHABLE,
} from "../shared/cloud-computer-recovery.ts";

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
  tool("exec", "Run a shell command on the assigned cloud computer and wait for its result. For a command that may run long (downloads, installs, builds, data jobs), set background: true: it starts the command and answers at once with a process_id to follow with exec_status, and the computer stays on for it for up to two hours. Completion does not automatically resume this turn or notify a delegator. If the result is needed for this task, use exec_status with wait_seconds in this turn until it finishes, then check its exit code and output. If you cannot finish checking in this turn, report the work as unfinished with the process_id; do not claim completion or start another copy blindly.", {
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
/** A command that outlasted its call: it is left running, since stopping a build half-way is worse, and handed back to follow. */
export const EXEC_STILL_RUNNING = "The command is still running on the cloud computer; it was not stopped and was not started twice. Follow it with exec_status and this "
  + "processId (wait_seconds up to 60) until it finishes, then check its exit code and output. Do not run it again. Start a command that may run long with background: true.";
export const TOO_MANY_LEFT_RUNNING = `This command ran past this call's time limit, and this cloud computer already has ${COMMAND_WALL.leftRunningMax} commands left running from earlier exec calls, `
  + "so this one was stopped. Start a command that keeps running (a server, a watcher, a long build) with background: true. To see what is running, exec "
  + "`ps -eo pid,etime,args --sort=start_time | tail -n 30`; to stop one, exec `kill <pid>`. Short commands like these always run.";
/** Only reached through a relay that does not start commands in the background: the provider itself ended the command. */
export const EXEC_STOPPED_AT_LIMIT = "The cloud computer's provider stopped this command after 30 seconds, its limit for a command run this way. The command did not fail by itself and is "
  + "no longer running; what it had done up to then stays. Start it again with background: true, then follow it with exec_status.";
/** Pointer moves, clicks, keys and the like take well under a second; this ends five seconds before the provider would stop a direct command at 30 s. */
const QUICK_CALL_MS = 25_000;
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

/** What a call that was sent again until its time ran out tells the bot; each is also how such a call is recognised. */
const UNANSWERED_TEXT = { waking: CLOUD_COMPUTER_STILL_WAKING, restoring: CLOUD_COMPUTER_STILL_RESTORING, unreachable: CLOUD_COMPUTER_UNREACHABLE } as const;
const UNANSWERED_TEXTS = new Set<string>([CLOUD_COMPUTER_NO_ANSWER, ...Object.values(UNANSWERED_TEXT)]);
const unansweredResult = (phase: keyof typeof UNANSWERED_TEXT): CloudComputerResult => ({ isError: true, content: [{ type: "text", text: UNANSWERED_TEXT[phase] }] });
/** The call got no answer from the computer, as opposed to an answer that reports a failure. */
export const cloudComputerUnanswered = (result: CloudComputerResult): boolean =>
  result.isError === true && result.content.some((part) => part.type === "text" && UNANSWERED_TEXTS.has(part.text));

/** The caller has already checked the arguments and the person's control. `folder` is the bot's working folder for this
 * turn. `deadline`: when the whole call must have answered; a call the computer did not answer is sent again inside it.
 * `stopped`: aborts when the person stops the turn, which also stops a command this call is still following. */
export async function runCloudComputerTool(
  cfg: AppConfig,
  boxId: string,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
  folder?: string | null,
  deadline = Date.now() + HARNESS_CALL_BUDGET_MS,
  stopped?: AbortSignal,
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
    const shot = await retryRead(cfg, boxId, () => screenshotBoat(cfg, "", boxId, { signal, nativeSize: true }),
      (error) => error instanceof Error && error.message === CLOUD_COMPUTER_NO_ANSWER, { signal, deadline });
    signal.throwIfAborted();
    if ("phase" in shot) return unansweredResult(shot.phase);
    return { content: [{ type: "image", mimeType: "image/jpeg", data: shot.value.png }] };
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
    case "exec": if (a.background === true) return startInBackground(cfg, boxId, String(a.command), signal); command = String(a.command); break;
    case "exec_status": return backgroundStatus(cfg, boxId, a as { process_id: string; wait_seconds?: number }, signal);
    default: return { isError: true, content: [{ type: "text", text: "Unknown cloud computer tool." }] };
  }
  // Only exec may run long. Every other call is a quick one, sent the direct way so it answers in one round trip.
  const sent = await runOnce(cfg, boxId, isolatedRemoteCommand(command), { signal, deadline, ...(stopped ? { stopped } : {}), ...(name === "exec" ? {} : { timeoutMs: QUICK_CALL_MS }) });
  signal.throwIfAborted();
  if (sent.kind === "unanswered") return unansweredResult(sent.phase);
  if (sent.kind === "late") return { isError: true, content: [{ type: "text", text: commandLateText(name, a) ?? CLOUD_COMPUTER_LATE }] };
  if (sent.kind === "lost") return { isError: true, content: [{ type: "text", text: name === "exec" ? CLOUD_COMPUTER_EXEC_ANSWER_LOST : CLOUD_COMPUTER_ANSWER_LOST }] };
  const result = sent.result;
  if (name === "open_url" && result.ok) return { content: [{ type: "text", text: "Browser launch requested. Page loading is not confirmed; inspect the screen before continuing." }] };
  if (name === "exec" && result.timedOut && result.processId !== undefined) {
    // The limit applies here, to the command that would be one too many, and never to a command before it is sent: a
    // short command, such as the one that stops the others, always goes through.
    if (await commandsLeftRunning(cfg, boxId) >= COMMAND_WALL.leftRunningMax) {
      await sent.stop();
      untrackProcess(boxId, result.processId);
      return { isError: true, content: [{ type: "text", text: TOO_MANY_LEFT_RUNNING }] };
    }
    noteLeftRunning(boxId, result.processId);
    return { content: [{ type: "text", text: JSON.stringify({
      status: "running", processId: processIdOn(boxId, result.processId), stdout: result.stdout.slice(-STDOUT_TAIL_CHARS), stderr: result.stderr.slice(-STDERR_TAIL_CHARS), next: EXEC_STILL_RUNNING,
    }) }] };
  }
  if (name === "exec" && result.providerLimit) return { isError: true, content: [{ type: "text", text: EXEC_STOPPED_AT_LIMIT }] };
  if (name === "exec" && result.timedOut) return { isError: true, content: [{ type: "text", text: EXEC_LATE }] };
  return { isError: !result.ok, content: [{ type: "text", text: JSON.stringify(result) }] };
}

/** The order is the safety argument: arguments, then the control gate (which may create or wake the Boat), then the Boat
 * read; the turn's capability must be live before and after the Boat acts. Listing touches no Boat. */
export async function cloudComputerRpc(
  request: { method?: unknown; params?: unknown } | null | undefined,
  deps: {
    cfg: AppConfig;
    /** The Boat this call acts on, read after the gate. */
    boxId(): string | null | undefined;
    /** The bot's working folder, which the copy tools read from and write into. */
    folder?(): string | null | undefined;
    gate(): Promise<Pick<ControlState, "held" | "reason" | "blockedReason">>;
    assertActive(): void;
    signal: AbortSignal;
    /** The whole call, the gate's wait included, answers within this. */
    budgetMs?: number;
    /** A computer that stopped answering (server/boat-recovery.ts): what the bot is told instead, and once after it was replaced. */
    recovery?: { refusal(boxId: string, phase: "before" | "after"): string | null; notice(boxId: string): string | null };
    /** Whether the computer answered this call: a call refused before it was sent, or one that got no answer, did not. */
    settled?(answered: boolean): void;
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
  const refused = (phase: "before" | "after"): CloudComputerResult | null => {
    const text = deps.recovery?.refusal(boxId, phase);
    return text ? { isError: true, content: [{ type: "text", text }] } : null;
  };
  const before = refused("before");
  if (before) { deps.settled?.(false); return before; }
  const late = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  let result: CloudComputerResult;
  try {
    result = await runCloudComputerTool(deps.cfg, boxId, params.name as string, args as Record<string, unknown>, AbortSignal.any([deps.signal, late]), deps.folder?.(), deadline, deps.signal);
  } catch (error) {
    if (deps.signal.aborted) throw error;
    const after = refused("after");
    if (after) { deps.settled?.(false); return after; }
    if (!late.aborted) throw error;
    return { isError: true, content: [{ type: "text", text: commandLateText(params.name, args) ?? (copy ? CLOUD_COMPUTER_COPY_LATE : CLOUD_COMPUTER_LATE) }] };
  }
  deps.assertActive();
  const unanswered = cloudComputerUnanswered(result);
  if (unanswered) result = refused("after") ?? result;
  deps.settled?.(!unanswered);
  const notice = deps.recovery?.notice(boxId);
  return notice ? { ...result, content: [{ type: "text", text: notice }, ...result.content] } : result;
}
