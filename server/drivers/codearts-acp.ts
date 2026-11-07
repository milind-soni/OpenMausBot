#!/usr/bin/env node
// ACP bridge for Huawei CodeArts Agent, which speaks no ACP of its own.
//
// OpenMausBot's shared ACP driver owns the client side; this process is the ACP *agent* it
// spawns. Each `session/prompt` runs one headless CodeArts task through the official adapter
// (`codearts_cli.py`), converts the adapter's single result envelope into `session/update`
// chunks, and answers `end_turn`. CodeArts credentials never leave CodeArts' own store and the
// adapter's raw stdout/stderr are never forwarded.
//
// The adapter has no token streaming and a task can legitimately take 5-10 minutes, so the
// bridge keeps the ACP session alive with a periodic heartbeat and allows 900 s per task.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_SEC = 900;
const HEARTBEAT_MS = 20_000;
const REPLY_CHUNK = 4_000;

const LOGIN_NOTE =
  "CodeArts is not signed in — open a terminal, run the CodeArts CLI once and finish its sign-in, then try again.";

interface Session {
  id: string;
  cwd: string;
  model?: string;
}

interface RunningTask {
  child: ChildProcess;
  cancelled: boolean;
  settle: (message: RunResult) => void;
}

type RunResult =
  | { kind: "text"; text: string }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

function argFlag(name: string): boolean {
  return process.argv.includes(name);
}

function scriptPath(): string {
  const candidates = [
    argValue("--script") ?? process.env.OMB_CODEARTS_CLI_SCRIPT,
    join(homedir(), ".local/share/AgentHub-CodeArts/server/drivers/codearts_cli.py"),
    join(homedir(), "multi-agent-hub/drivers/codearts_cli.py"),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error("CodeArts bridge: codearts_cli.py was not found; set OMB_CODEARTS_CLI_SCRIPT to its path.");
  }
  return found;
}

function pythonPath(): string {
  return argValue("--python") ?? process.env.OMB_CODEARTS_PYTHON ?? "/usr/bin/python3";
}

/**
 * The store the official CLI is signed in to. `HOME` here is often the harness's own home while the
 * CodeArts login lives in the account's real home, so both are checked, never the token itself.
 */
function signedInHome(): string | undefined {
  const candidates: string[] = [];
  if (process.env.OMB_CODEARTS_HOME) candidates.push(process.env.OMB_CODEARTS_HOME);
  if (process.env.HOME) candidates.push(process.env.HOME);
  try {
    candidates.push(userInfo().homedir);
  } catch {
    // No passwd entry: process.env.HOME is all there is.
  }
  candidates.push(homedir());
  return candidates.find((home) => home && existsSync(join(home, ".codeartsdoer", "cli-data", "auth.json")));
}

function errorText(code: string | undefined): string {
  switch (code) {
    case "CODEARTS_TIMEOUT":
      return `CodeArts ran past its ${DEFAULT_TIMEOUT_SEC}-second limit before finishing, so the task was stopped. Send a smaller task, or send it again.`;
    case "CODEARTS_AUTH_REQUIRED":
    case "CODEARTS_PROVIDER_UNAVAILABLE":
      return LOGIN_NOTE;
    case "CODEARTS_MODEL_UNAVAILABLE":
      return "CodeArts does not offer that model to this account. Pick another model in the bot's engine settings and try again.";
    case "CODEARTS_PERMISSION_REQUIRED":
      return "CodeArts stopped because the tools this task needed were not approved. Enable tool use in CodeArts' own settings, or send a task that needs no tools.";
    case "CODEARTS_EMPTY_RESPONSE":
      return "CodeArts finished without any reply text.";
    case "CODEARTS_CLI_NOT_FOUND":
    case "CODEARTS_UNSUPPORTED_SHELL_LAUNCHER":
      return "The CodeArts CLI isn't installed, or isn't on this app's PATH. Install CodeArts or use Set CLI, then try again.";
    case "CODEARTS_COMPLETION_NOT_CONFIRMED":
      return "CodeArts stopped before it confirmed the task had finished. Send the message again to retry.";
    case "CODEARTS_INVALID_WORKDIR":
      return "CodeArts could not use this bot's workspace folder. Check that the folder exists and is available.";
    case undefined:
    case "CODEARTS_PROVIDER_ERROR":
    case "CODEARTS_PROCESS_FAILED":
      return "CodeArts failed to answer this turn. Send the message again to retry.";
    default:
      return `CodeArts failed this turn (${code}). Send the message again to retry.`;
  }
}

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .flatMap((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : []))
    .join("\n");
}

function lastEnvelope(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]!) as unknown;
      if (parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "result") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // The adapter only ever prints its envelope; any other line is ignored.
    }
  }
  return null;
}

export function startBridge(): void {
  const script = scriptPath();
  const python = pythonPath();
  const launchModel = argValue("--model");
  const cli = argValue("--cli");
  const autoPermission = argFlag("--auto");
  const timeoutSec = Math.max(1, Number(argValue("--timeout") ?? DEFAULT_TIMEOUT_SEC) || DEFAULT_TIMEOUT_SEC);
  const home = signedInHome();

  const sessions = new Map<string, Session>();
  const running = new Map<string, RunningTask>();
  const children = new Set<ChildProcess>();

  const send = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id: unknown, result: unknown): void => {
    send({ jsonrpc: "2.0", id, result });
  };
  const fail = (id: unknown, code: number, message: string): void => {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  };
  const update = (sessionId: string, value: Record<string, unknown>): void => {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
  };

  const killTree = (child: ChildProcess): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== "win32" && typeof child.pid === "number") {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone, or never became its own group leader.
      }
      const force = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // Already gone.
        }
      }, 3_000);
      force.unref?.();
      return;
    }
    child.kill();
  };

  const runTask = (session: Session, text: string): Promise<RunResult> => new Promise((resolveRun) => {
    const args = [script, "--task", text, "--cwd", session.cwd, "--timeout", String(timeoutSec)];
    const model = session.model ?? launchModel;
    if (model) args.push("--model", model);
    if (cli && isAbsolute(cli)) args.push("--cli", cli);

    const env: Record<string, string | undefined> = { ...process.env };
    if (home) env.HOME = home;
    if (autoPermission) env.AGENTHUB_CODEARTS_AUTO = "1";

    let stdout = "";
    let settled = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let hardStop: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      if (hardStop) clearTimeout(hardStop);
      if (running.get(session.id)?.child === child) running.delete(session.id);
      resolveRun(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(python, args, {
        cwd: existsSync(session.cwd) ? session.cwd : process.cwd(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group so a cancel reclaims the CLI and every helper it started.
        detached: process.platform !== "win32",
      });
    } catch {
      resolveRun({ kind: "error", message: errorText("CODEARTS_CLI_NOT_FOUND") });
      return;
    }
    children.add(child);
    running.set(session.id, { child, cancelled: false, settle: finish });
    heartbeat = setInterval(() => update(session.id, { sessionUpdate: "codearts_bridge_heartbeat" }), HEARTBEAT_MS);
    heartbeat.unref?.();
    // The adapter enforces its own deadline; this is the backstop if it cannot.
    hardStop = setTimeout(() => {
      killTree(child);
      finish({ kind: "error", message: errorText("CODEARTS_TIMEOUT") });
    }, (timeoutSec + 60) * 1_000);
    hardStop.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 32 * 1024 * 1024) stdout = stdout.slice(-8 * 1024 * 1024);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", () => {
      // The adapter's diagnostics can carry vendor log text; never forward them.
    });
    child.once("error", () => {
      children.delete(child);
      finish({ kind: "error", message: errorText("CODEARTS_CLI_NOT_FOUND") });
    });
    child.once("close", () => {
      children.delete(child);
      const task = running.get(session.id);
      if (task?.cancelled) return finish({ kind: "cancelled" });
      const envelope = lastEnvelope(stdout);
      const status = typeof envelope?.status === "string" ? envelope.status : undefined;
      const text = typeof envelope?.result === "string" ? envelope.result : "";
      if (envelope && status === "completed" && text.trim()) return finish({ kind: "text", text });
      if (envelope && status === "completed") return finish({ kind: "error", message: errorText("CODEARTS_EMPTY_RESPONSE") });
      const code = (envelope?.error as { code?: unknown } | undefined)?.code;
      finish({ kind: "error", message: errorText(typeof code === "string" ? code : undefined) });
    });
  });

  const handlePrompt = async (id: unknown, params: Record<string, unknown>): Promise<void> => {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const session = sessions.get(sessionId);
    if (!session) return fail(id, -32602, "CodeArts bridge: unknown session.");
    if (running.has(sessionId)) return fail(id, -32000, "CodeArts is still running this session's previous task.");
    const text = promptText(params.prompt);
    if (!text.trim()) return fail(id, -32602, "CodeArts bridge: the prompt carried no text.");

    const result = await runTask(session, text);
    if (result.kind === "cancelled") return reply(id, { stopReason: "cancelled" });
    if (result.kind === "error") return fail(id, -32000, result.message);
    for (let offset = 0; offset < result.text.length; offset += REPLY_CHUNK) {
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: result.text.slice(offset, offset + REPLY_CHUNK) },
      });
    }
    reply(id, { stopReason: "end_turn" });
  };

  const cancel = (sessionId: string): void => {
    const task = running.get(sessionId);
    if (!task) return;
    task.cancelled = true;
    killTree(task.child);
    // Answer at once; the process group is being reclaimed in the background.
    task.settle({ kind: "cancelled" });
  };

  const handle = (message: Record<string, unknown>): void => {
    const method = typeof message.method === "string" ? message.method : "";
    const id = message.id;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const isRequest = id !== undefined && id !== null;
    switch (method) {
      case "initialize":
        return reply(id, {
          protocolVersion: 1,
          agentCapabilities: { promptCapabilities: { image: false } },
          authMethods: [],
        });
      case "session/new": {
        const sessionId = `codearts-${randomUUID()}`;
        const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : process.cwd();
        sessions.set(sessionId, { id: sessionId, cwd });
        return reply(id, { sessionId });
      }
      case "session/prompt":
        void handlePrompt(id, params);
        return;
      case "session/cancel":
        if (typeof params.sessionId === "string") cancel(params.sessionId);
        return;
      case "session/close": {
        if (typeof params.sessionId === "string") {
          cancel(params.sessionId);
          sessions.delete(params.sessionId);
        }
        return reply(id, {});
      }
      case "session/set_model": {
        const session = typeof params.sessionId === "string" ? sessions.get(params.sessionId) : undefined;
        if (session && typeof params.modelId === "string" && params.modelId) session.model = params.modelId;
        return reply(id, {});
      }
      case "authenticate":
        return reply(id, {});
      default:
        // session/load is unsupported: the driver falls back to session/new, which is the only
        // way this one-shot transport can start a task.
        if (isRequest) fail(id, -32601, `CodeArts bridge: ${method || "unknown method"} is not supported.`);
    }
  };

  const shutdown = (): void => {
    for (const task of running.values()) {
      task.cancelled = true;
      killTree(task.child);
    }
    for (const child of children) killTree(child);
  };
  process.once("SIGTERM", () => { shutdown(); process.exit(0); });
  process.once("SIGINT", () => { shutdown(); process.exit(0); });
  process.once("exit", shutdown);
  process.stdin.once("end", () => { shutdown(); process.exit(0); });

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (message && typeof message === "object" && !Array.isArray(message)) handle(message as Record<string, unknown>);
  });
}

const entry = process.argv[1];
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) startBridge();
