#!/usr/bin/env node
// ACP bridge for MiniMax Code (`mcode`), which speaks no ACP of its own (`mcode --acp` exits 0).
//
// OpenMausBot's shared ACP driver owns the client side; this process is the ACP *agent* it spawns.
// Each `session/prompt` runs one headless `mcode exec` turn with `--output-format stream-json`,
// relays the line-delimited `agent_message` deltas as `session/update` chunks, and answers with
// the turn's stop reason and token usage. The MiniMax login lives in the account's own
// `~/.minimax/auth` store; the raw stderr, which can carry vendor diagnostics, is never forwarded.
//
// One turn can legitimately take minutes, so the bridge keeps the ACP session alive with a
// periodic heartbeat and stops the child at the same deadline it gives `mcode`.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_SEC = 900;
const HEARTBEAT_MS = 20_000;

const LOGIN_NOTE =
  "MiniMax Code is not signed in — open a terminal, run `mcode login` and finish its sign-in, then try again.";

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  totalTokens?: number;
}

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
  | { kind: "text"; text: string; streamed: boolean; usage?: Usage }
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

/**
 * The account home holding the MiniMax login. `HOME` is often the harness's own home while `mcode`
 * keeps its sign-in in the account's real home, so every plausible one is checked, never the token itself.
 */
function accountHomes(): string[] {
  const candidates: string[] = [];
  if (process.env.OMB_MCODE_HOME) candidates.push(process.env.OMB_MCODE_HOME);
  if (process.env.HOME) candidates.push(process.env.HOME);
  try {
    candidates.push(userInfo().homedir);
  } catch {
    // No passwd entry: process.env.HOME is all there is.
  }
  candidates.push(homedir());
  return [...new Set(candidates.filter((home) => home.length > 0))];
}

function signedInHome(): string | undefined {
  return accountHomes().find((home) => {
    for (const region of ["cn", "global"]) {
      const path = join(home, ".minimax", "auth", "prod", region, "mcode-public", "auth.json");
      try {
        if (existsSync(path)) return true;
      } catch {
        // An unreadable store is not a login this bridge can use.
      }
    }
    return false;
  });
}

/** `mcode` installs itself outside the app's PATH (`~/.minimax-code/bin/mcode`), so look there too. */
function cliPath(): string {
  const explicit = argValue("--cli") ?? process.env.OMB_MCODE_CLI;
  if (explicit && (explicit.includes("/") || explicit.includes("\\") || existsSync(explicit))) return explicit;
  for (const home of accountHomes()) {
    const path = join(home, ".minimax-code", "bin", "mcode");
    if (existsSync(path)) return path;
  }
  return explicit ?? "mcode";
}

function errorText(reason: string): string {
  switch (reason) {
    case "timeout":
      return `MiniMax Code ran past its ${DEFAULT_TIMEOUT_SEC}-second limit before finishing, so the task was stopped. Send a smaller task, or send it again.`;
    case "auth":
      return LOGIN_NOTE;
    case "empty":
      return "MiniMax Code finished without any reply text.";
    case "not-found":
      return "The MiniMax Code CLI isn't installed, or isn't on this app's PATH. Install MiniMax Code or use Set CLI, then try again.";
    default:
      return "MiniMax Code failed to answer this turn. Send the message again to retry.";
  }
}

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .flatMap((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : []))
    .join("\n");
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `mcode` reports `cacheReadTokens`; ACP's result field for the same figure is `cachedReadTokens`. */
function usageFrom(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const usage: Usage = {
    inputTokens: numberField(record, "inputTokens"),
    outputTokens: numberField(record, "outputTokens"),
    cachedReadTokens: numberField(record, "cacheReadTokens"),
    totalTokens: numberField(record, "totalTokens"),
  };
  return Object.values(usage).some((entry) => entry !== undefined) ? usage : undefined;
}

function definedUsage(usage: Usage): Record<string, number> {
  const out: Record<string, number> = {};
  if (usage.inputTokens !== undefined) out.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) out.outputTokens = usage.outputTokens;
  if (usage.cachedReadTokens !== undefined) out.cachedReadTokens = usage.cachedReadTokens;
  if (usage.totalTokens !== undefined) out.totalTokens = usage.totalTokens;
  return out;
}

export function startBridge(): void {
  const cli = cliPath();
  const launchModel = argValue("--model");
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
    const model = session.model ?? launchModel;
    const args = [
      "exec",
      "--prompt-mode", "work",
      "--permission", autoPermission ? "full" : "smart",
      "--output-format", "stream-json",
      "--timeout", `${timeoutSec}s`,
      ...(model ? ["--model", model] : []),
      text,
    ];

    const env: Record<string, string | undefined> = { ...process.env };
    if (home) env.HOME = home;

    let textOut = "";
    let usage: Usage | undefined;
    let execStatus: string | undefined;
    let authFailed = false;
    let settled = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let hardStop: ReturnType<typeof setTimeout> | null = null;
    // An item's deltas already carried its text; its completed form must not be appended again.
    const streamedItems = new Set<string>();

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      if (hardStop) clearTimeout(hardStop);
      if (running.get(session.id)?.child === child) running.delete(session.id);
      resolveRun(result);
    };

    const emitText = (chunk: string): void => {
      if (!chunk) return;
      textOut += chunk;
      update(session.id, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk },
      });
    };

    const handleEvent = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!event || typeof event !== "object") return;
      const record = event as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "";
      const item = record.item as Record<string, unknown> | undefined;

      if ((type === "item.started" || type === "item.updated") && item && item.type === "agent_message") {
        const delta = typeof item.contentDelta === "string" ? item.contentDelta : "";
        if (delta) {
          if (typeof item.id === "string") streamedItems.add(item.id);
          emitText(delta);
        }
        return;
      }
      if (type === "item.completed" && item && item.type === "agent_message") {
        const id = typeof item.id === "string" ? item.id : "";
        const content = typeof item.content === "string" ? item.content : "";
        if (content && !(id && streamedItems.has(id))) emitText(content);
        return;
      }
      if (type === "turn.completed") {
        usage = usageFrom(record.usage) ?? usage;
        return;
      }
      if (type === "exec.completed") {
        const result = record.result as Record<string, unknown> | undefined;
        if (result) {
          if (typeof result.status === "string") execStatus = result.status;
          usage = usageFrom(result.usage) ?? usage;
          const output = typeof result.output === "string" ? result.output : "";
          // A turn that produced no deltas still has its reply here; never duplicate one already streamed.
          if (!textOut && output) emitText(output);
          if (result.status !== "succeeded") {
            const failure = result.error as Record<string, unknown> | string | undefined;
            const message = typeof failure === "string" ? failure
              : failure && typeof failure === "object" && typeof failure.message === "string" ? failure.message : "";
            if (/sign in|login|unauthori[sz]ed/i.test(message)) authFailed = true;
          }
        }
        return;
      }
      if (type === "exec.failed" || type === "turn.failed") {
        if (typeof record.message === "string" && /sign in|login|unauthor/i.test(record.message)) authFailed = true;
      }
    };

    let pending = "";
    const feed = (chunk: string): void => {
      pending += chunk;
      // Line buffering: a chunk may end mid-JSON, so only whole lines are parsed.
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        handleEvent(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length > 4 * 1024 * 1024) pending = pending.slice(-1024 * 1024);
    };

    let child: ChildProcess;
    try {
      child = spawn(cli, args, {
        cwd: existsSync(session.cwd) ? session.cwd : process.cwd(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group so a cancel reclaims `mcode` and every helper it started.
        detached: process.platform !== "win32",
      });
    } catch {
      resolveRun({ kind: "error", message: errorText("not-found") });
      return;
    }
    children.add(child);
    running.set(session.id, { child, cancelled: false, settle: finish });
    heartbeat = setInterval(() => update(session.id, { sessionUpdate: "mcode_bridge_heartbeat" }), HEARTBEAT_MS);
    heartbeat.unref?.();
    // `mcode` enforces its own deadline; this is the backstop if it cannot.
    hardStop = setTimeout(() => {
      killTree(child);
      finish({ kind: "error", message: errorText("timeout") });
    }, (timeoutSec + 60) * 1_000);
    hardStop.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => feed(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // Never forward vendor diagnostics verbatim; only the login hint is recognised.
      if (/sign in to minimax|run `?mcode login`?/i.test(chunk)) authFailed = true;
    });
    child.once("error", () => {
      children.delete(child);
      finish({ kind: "error", message: errorText("not-found") });
    });
    child.once("close", (code) => {
      children.delete(child);
      if (pending.trim()) handleEvent(pending);
      pending = "";
      const task = running.get(session.id);
      if (task?.cancelled) return finish({ kind: "cancelled" });
      if (execStatus === "succeeded" || (execStatus === undefined && code === 0)) {
        if (!textOut.trim()) return finish({ kind: "error", message: errorText("empty") });
        return finish({ kind: "text", text: textOut, streamed: true, ...(usage ? { usage } : {}) });
      }
      if (authFailed) return finish({ kind: "error", message: errorText("auth") });
      finish({ kind: "error", message: errorText("failed") });
    });
  });

  const handlePrompt = async (id: unknown, params: Record<string, unknown>): Promise<void> => {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const session = sessions.get(sessionId);
    if (!session) return fail(id, -32602, "MiniMax Code bridge: unknown session.");
    if (running.has(sessionId)) return fail(id, -32000, "MiniMax Code is still running this session's previous task.");
    const text = promptText(params.prompt);
    if (!text.trim()) return fail(id, -32602, "MiniMax Code bridge: the prompt carried no text.");

    const result = await runTask(session, text);
    if (result.kind === "cancelled") return reply(id, { stopReason: "cancelled" });
    if (result.kind === "error") return fail(id, -32000, result.message);
    // The deltas were already streamed as they arrived; only a run that produced none is sent here.
    if (!result.streamed) {
      for (let offset = 0; offset < result.text.length; offset += 4_000) {
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result.text.slice(offset, offset + 4_000) },
        });
      }
    }
    reply(id, { stopReason: "end_turn", ...(result.usage ? { usage: definedUsage(result.usage) } : {}) });
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
        const sessionId = `mcode-${randomUUID()}`;
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
        if (isRequest) fail(id, -32601, `MiniMax Code bridge: ${method || "unknown method"} is not supported.`);
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
