#!/usr/bin/env node
// ACP bridge for Meoo (秒悟), which speaks no ACP of its own: the `meoo` command line is a project /
// cloud-service tool, and the AI itself is the platform's Agent Run HTTP API.
//
// OpenMausBot's shared ACP driver owns the client side; this process is the ACP *agent* it spawns.
// Each `session/prompt` becomes one Agent Run (`POST /projects/<id>/agent/runs`), whose SSE stream is
// read to the end and then replayed as `session/update` chunks. Text is deliberately not streamed
// live: the upstream sends `message.snapshot` as the *whole* reply so far, and a chunk already printed
// cannot be taken back (that is the "66" duplicate the hub's own runner warns about). A long run is
// kept alive with the same heartbeat CodeArts uses.
//
// Credentials: the agent key is read from `MEOO_AK` or `~/.config/agenthub-meoo/meoo-auth.env`, the
// project id from `--project`, `MEOO_PROJECT_URL_ID` or `~/.config/agenthub-meoo/project.env`. No key
// is ever logged or forwarded. A run may take minutes and is stopped by aborting the HTTP stream.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_SEC = 900;
const HEARTBEAT_MS = 20_000;
const REPLY_CHUNK = 4_000;
const BASE_URL = process.env.MEOO_BASE_URL || "https://meoo.com/open/v1";

const LOGIN_NOTE =
  "Meoo is not signed in — put MEOO_AK in ~/.config/agenthub-meoo/meoo-auth.env (or run the Meoo CLI once), then try again.";
const PROJECT_NOTE =
  "Meoo has no project to run in — set MEOO_PROJECT_URL_ID in ~/.config/agenthub-meoo/project.env, or create one with `meoo projects create`, then try again.";

interface Session {
  id: string;
  cwd: string;
  model?: string;
}

interface RunningTask {
  cancelled: boolean;
  abort: () => void;
}

type RunResult =
  | { kind: "text"; text: string; note?: string }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value !== undefined && !value.startsWith("--") ? value : undefined;
}

/**
 * Every home the login could live in. `HOME` is often the harness's own home while the Meoo files sit
 * in the account's real home, so each candidate is checked and the key itself is never read here.
 */
function accountHomes(): string[] {
  const candidates: string[] = [];
  if (process.env.OMB_MEOO_HOME) candidates.push(process.env.OMB_MEOO_HOME);
  if (process.env.HOME) candidates.push(process.env.HOME);
  try {
    candidates.push(userInfo().homedir);
  } catch {
    // No passwd entry: process.env.HOME is all there is.
  }
  candidates.push(homedir());
  return [...new Set(candidates.filter((home) => home.length > 0))];
}

/** `KEY=value` from an env-style file, without exporting anything. */
function readEnvFile(path: string, key: string): string {
  try {
    const found = new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`, "m").exec(readFileSync(path, "utf-8"));
    return found?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function readAgentKey(): string {
  if (process.env.MEOO_AK) return process.env.MEOO_AK.trim();
  for (const home of accountHomes()) {
    const key = readEnvFile(join(home, ".config", "agenthub-meoo", "meoo-auth.env"), "MEOO_AK");
    if (key) return key;
  }
  return "";
}

function readProjectId(): string {
  const explicit = argValue("--project") ?? process.env.MEOO_PROJECT_URL_ID;
  if (explicit) return explicit.trim();
  for (const home of accountHomes()) {
    const id = readEnvFile(join(home, ".config", "agenthub-meoo", "project.env"), "MEOO_PROJECT_URL_ID");
    if (id) return id;
  }
  return "";
}

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .flatMap((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : []))
    .join("\n");
}

/** The project's real model list, used only to pick the default the project itself names. */
async function defaultModel(key: string, project: string, signal: AbortSignal): Promise<string> {
  try {
    const answer = await fetch(`${BASE_URL}/projects/${project}/agent/capabilities`, {
      headers: { Authorization: `Bearer ${key}`, accept: "application/json" },
      signal,
    });
    if (!answer.ok) return "auto";
    const body = await answer.json() as { defaults?: { model?: unknown }; models?: Array<{ id?: unknown }> };
    if (typeof body.defaults?.model === "string" && body.defaults.model) return body.defaults.model;
    const first = body.models?.find((entry) => typeof entry?.id === "string")?.id;
    return typeof first === "string" && first ? first : "auto";
  } catch {
    return "auto";
  }
}

/** `message.delta` appends, `message.snapshot` replaces the whole reply so far. */
function reduceText(text: string, type: string, payload: Record<string, unknown> | null): string {
  if (type === "message.delta" && typeof payload?.delta === "string") return text + payload.delta;
  if (type === "message.snapshot" && typeof payload?.content === "string") return payload.content;
  return text;
}

const TERMINAL: Record<string, "completed" | "failed" | "cancelled"> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.canceled": "cancelled",
  "run.interrupted": "cancelled",
  "run.superseded": "cancelled",
};

/** One Agent Run: start it, read its event stream to the end, return the reply text. */
async function runAgent(
  session: Session,
  text: string,
  launchModel: string | undefined,
  timeoutSec: number,
  task: RunningTask,
): Promise<RunResult> {
  const key = readAgentKey();
  if (!key) return { kind: "error", message: LOGIN_NOTE };
  const project = readProjectId();
  if (!project) return { kind: "error", message: PROJECT_NOTE };

  const controller = new AbortController();
  task.abort = () => controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutSec * 1_000);
  timer.unref?.();

  try {
    const wanted = session.model ?? launchModel ?? "";
    const model = wanted || await defaultModel(key, project, controller.signal);

    const started = await fetch(`${BASE_URL}/projects/${project}/agent/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
        "Idempotency-Key": `omb_${randomUUID()}`,
      },
      body: JSON.stringify({ message: text, model }),
      signal: controller.signal,
    });
    const created = await started.json().catch(() => ({})) as { run_id?: unknown; error?: unknown };
    if (!started.ok) {
      if (started.status === 401 || started.status === 403) return { kind: "error", message: LOGIN_NOTE };
      if (started.status === 404) return { kind: "error", message: PROJECT_NOTE };
      const raw = created.error;
      const detail = typeof raw === "string" ? raw
        : raw && typeof raw === "object" && typeof (raw as { message?: unknown }).message === "string"
          ? (raw as { message: string }).message : "";
      return {
        kind: "error",
        message: `Meoo could not start this run (${started.status}${detail ? `: ${detail}` : ""}). Send the message again to retry.`,
      };
    }
    const runId = typeof created.run_id === "string" ? created.run_id : "";
    if (!runId) return { kind: "error", message: "Meoo started a run but returned no run id. Send the message again to retry." };

    const events = await fetch(`${BASE_URL}/projects/${project}/agent/runs/${runId}/events`, {
      headers: { Authorization: `Bearer ${key}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!events.ok) {
      if (events.status === 401 || events.status === 403) return { kind: "error", message: LOGIN_NOTE };
      return { kind: "error", message: `Meoo stopped sending this run (${events.status}). Send the message again to retry.` };
    }

    let replyText = "";
    let status = "running";
    let note = "";
    let buffer = "";
    const body = events.body as unknown as AsyncIterable<Uint8Array> | null;
    if (!body) return { kind: "error", message: "Meoo returned an empty event stream. Send the message again to retry." };

    for await (const chunk of body) {
      buffer += Buffer.from(chunk).toString("utf-8");
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
        const lines = raw.split("\n");
        const name = (lines.find((line) => line.startsWith("event:")) ?? "").slice(6).trim();
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
        if (!data) continue;
        let payload: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(data) as unknown;
          payload = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
        } catch {
          continue;
        }
        const type = name || (typeof payload?.type === "string" ? payload.type : "");
        if (type === "message.delta" || type === "message.snapshot") {
          replyText = reduceText(replyText, type, payload);
        } else if (type === "run.input_required") {
          const action = payload?.action as { prompt?: unknown } | undefined;
          const asked = typeof action?.prompt === "string" ? action.prompt : typeof payload?.detail === "string" ? payload.detail : "";
          note = asked.slice(0, 300);
          status = "input_required";
          break;
        }
        const terminal = TERMINAL[type];
        if (terminal) {
          status = terminal;
          break;
        }
      }
      if (status !== "running") break;
    }

    if (task.cancelled) return { kind: "cancelled" };
    if (timedOut) {
      return {
        kind: "error",
        message: `Meoo ran past its ${timeoutSec}-second limit before finishing, so the run was stopped. Send a smaller task, or send it again.`,
      };
    }
    if (status === "failed") {
      return { kind: "error", message: "Meoo failed this run. Send the message again to retry." };
    }
    if (status === "cancelled") return { kind: "cancelled" };
    if (status === "running") {
      // The stream ended without a terminal event: partial text is still the only answer we have.
      if (!replyText.trim()) return { kind: "error", message: "Meoo closed this run before it finished. Send the message again to retry." };
    } else if (!replyText.trim()) {
      return { kind: "error", message: "Meoo finished without any reply text." };
    }
    return { kind: "text", text: replyText, ...(note ? { note } : {}) };
  } catch (error) {
    if (task.cancelled) return { kind: "cancelled" };
    if (timedOut) {
      return {
        kind: "error",
        message: `Meoo ran past its ${timeoutSec}-second limit before finishing, so the run was stopped. Send a smaller task, or send it again.`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(message)) {
      return { kind: "error", message: "Meoo could not be reached from this machine. Check the connection, then send the message again." };
    }
    return { kind: "error", message: "Meoo failed to answer this turn. Send the message again to retry." };
  } finally {
    clearTimeout(timer);
  }
}

export function startBridge(): void {
  const launchModel = argValue("--model");
  const timeoutSec = Math.max(1, Number(argValue("--timeout") ?? DEFAULT_TIMEOUT_SEC) || DEFAULT_TIMEOUT_SEC);

  const sessions = new Map<string, Session>();
  const running = new Map<string, RunningTask>();

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

  const handlePrompt = async (id: unknown, params: Record<string, unknown>): Promise<void> => {
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const session = sessions.get(sessionId);
    if (!session) return fail(id, -32602, "Meoo bridge: unknown session.");
    if (running.has(sessionId)) return fail(id, -32000, "Meoo is still running this session's previous task.");
    const text = promptText(params.prompt);
    if (!text.trim()) return fail(id, -32602, "Meoo bridge: the prompt carried no text.");

    const task: RunningTask = { cancelled: false, abort: () => {} };
    running.set(sessionId, task);
    // A run can take minutes with no tokens to show; this proves the ACP session is alive meanwhile.
    const heartbeat = setInterval(() => update(sessionId, { sessionUpdate: "meoo_bridge_heartbeat" }), HEARTBEAT_MS);
    heartbeat.unref?.();

    let result: RunResult;
    try {
      result = await runAgent(session, text, launchModel, timeoutSec, task);
    } catch {
      // runAgent handles its own failures; this only keeps a surprise from leaving the prompt unanswered.
      result = { kind: "error", message: "Meoo failed to answer this turn. Send the message again to retry." };
    } finally {
      clearInterval(heartbeat);
      running.delete(sessionId);
    }

    if (result.kind === "cancelled") return reply(id, { stopReason: "cancelled" });
    if (result.kind === "error") return fail(id, -32000, result.message);
    const body = result.note ? `${result.text}\n\n(Meoo asked for more input, which this connection cannot send: ${result.note})` : result.text;
    for (let offset = 0; offset < body.length; offset += REPLY_CHUNK) {
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: body.slice(offset, offset + REPLY_CHUNK) },
      });
    }
    reply(id, { stopReason: "end_turn" });
  };

  const cancel = (sessionId: string): void => {
    const task = running.get(sessionId);
    if (!task) return;
    task.cancelled = true;
    task.abort();
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
        const sessionId = `meoo-${randomUUID()}`;
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
        // session/load is unsupported: each Agent Run is independent, so session/new is the only entry point.
        if (isRequest) fail(id, -32601, `Meoo bridge: ${method || "unknown method"} is not supported.`);
    }
  };

  const shutdown = (): void => {
    for (const task of running.values()) {
      task.cancelled = true;
      task.abort();
    }
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
