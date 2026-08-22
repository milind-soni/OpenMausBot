import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { augmentedPath } from "./env-path.ts";

const DEFAULT_GOAL_CONTROL = join(homedir(), ".local", "lib", "aos", "fleet-memory", "aos_goal_control.py");
const MAX_OUTPUT_BYTES = 256 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;

type ParsedGoalCommand =
  | { action: "show" }
  | { action: "set"; objective: string; replace: boolean }
  | { action: "pause" | "resume" | "clear" }
  | { action: "complete"; proof: string }
  | { action: "block"; reason: string; proof: string };

export interface GoalCommandContext {
  botId: string;
  threadId: string;
  model: string;
  cwd: string;
}

export interface GoalCommandOutcome {
  handled: true;
  ok: boolean;
  status: number;
  response: string;
  record?: Record<string, unknown>;
}

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type Runner = (args: string[], options: { cwd: string; input?: string }) => Promise<ProcessResult>;

function words(value: string): string[] {
  const tokens: string[] = [];
  const expression = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(value)) !== null) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["\\])/g, "$1"));
  }
  return tokens;
}

function proofArgument(tokens: string[]): { proof: string; remaining: string[] } {
  const remaining: string[] = [];
  let proof = "";
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--proof") {
      proof = tokens[index + 1] ?? "";
      index += 1;
    } else if (token.startsWith("--proof=")) {
      proof = token.slice("--proof=".length);
    } else {
      remaining.push(token);
    }
  }
  return { proof, remaining };
}

export function parseGoalCommand(text: string): ParsedGoalCommand | null {
  const match = text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const tail = (match[1] ?? "").trim();
  if (!tail || /^(?:status|show)$/i.test(tail)) return { action: "show" };
  const tokens = words(tail);
  const first = tokens.shift() ?? "";
  const verb = first.toLowerCase();
  if (verb === "pause" || verb === "resume" || verb === "clear") return { action: verb };
  if (verb === "done" || verb === "complete") {
    const { proof, remaining } = proofArgument(tokens);
    if (!proof || remaining.length) throw new Error("/goal done requires exactly --proof /absolute/path");
    return { action: "complete", proof };
  }
  if (verb === "block") {
    const { proof, remaining } = proofArgument(tokens);
    const reason = remaining.join(" ").trim();
    if (!proof || !reason) throw new Error("/goal block requires a reason and --proof /absolute/path");
    return { action: "block", reason, proof };
  }
  if (verb === "replace" || verb === "start") {
    const objective = tokens.join(" ").trim();
    if (!objective) throw new Error(`/goal ${verb} requires an objective`);
    return { action: "set", objective, replace: verb === "replace" };
  }
  return { action: "set", objective: [first, ...tokens].join(" ").trim(), replace: false };
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: augmentedPath() };
  for (const name of ["HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"] as const) {
    if (typeof process.env[name] === "string") env[name] = process.env[name];
  }
  return env;
}

function defaultRunner(scriptPath: string): Runner {
  return (args, options) => new Promise((resolveResult) => {
    let settled = false;
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    const python = process.env.OMB_GOAL_PYTHON_PATH?.trim() || (process.platform === "win32" ? "python.exe" : "python3");
    const child = execFile(
      python,
      [scriptPath, ...args],
      {
        cwd: options.cwd,
        env: minimalEnvironment(),
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        finish({
          exitCode: typeof (error as { code?: unknown } | null)?.code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
    child.stdin?.on("error", () => finish({
      exitCode: 1,
      stdout: "",
      stderr: "goal control input failed",
    }));
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

function parsePayload(result: ProcessResult): Record<string, unknown> | null {
  for (const candidate of [result.stdout, result.stderr]) {
    try {
      const value = JSON.parse(candidate.trim()) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {}
  }
  return null;
}

function display(record: Record<string, unknown> | null): string {
  if (!record || Object.keys(record).length === 0) return "No shared goal is active.";
  if (record.status === "blocked" && typeof record.error === "string") {
    const known = record.error.replace(/[^A-Za-z0-9._:/-]+/g, " ").trim().slice(0, 240);
    return `Shared goal command was blocked: ${known || "goal authority rejected the request"}.`;
  }
  const status = typeof record.status === "string" ? record.status : "UNKNOWN";
  const id = typeof record.goal_id === "string" ? record.goal_id : "goal";
  const objective = typeof record.objective === "string" ? record.objective.slice(0, 1_200) : "";
  return objective ? `Shared goal ${id} is ${status}.\n\n${objective}` : `Shared goal ${id} is ${status}.`;
}

async function verifiedProof(raw: string): Promise<string> {
  if (!raw || !isAbsolute(raw)) throw new Error("goal proof must be an absolute file path");
  const path = resolve(raw);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error("goal proof file does not exist");
  return path;
}

export class GoalCommandAdapter {
  private readonly run: Runner;

  constructor(options: { scriptPath?: string; run?: Runner } = {}) {
    const scriptPath = options.scriptPath ?? process.env.OMB_GOAL_CONTROL_PATH ?? process.env.AOS_GOAL_CONTROL_PATH ?? DEFAULT_GOAL_CONTROL;
    this.run = options.run ?? defaultRunner(scriptPath);
  }

  async execute(text: string, context: GoalCommandContext): Promise<GoalCommandOutcome | null> {
    let command: ParsedGoalCommand | null;
    try {
      command = parseGoalCommand(text);
    } catch (error) {
      return { handled: true, ok: false, status: 400, response: error instanceof Error ? error.message : "Invalid /goal command." };
    }
    if (!command) return null;
    const cwd = isAbsolute(context.cwd) ? resolve(context.cwd) : homedir();
    try {
      if (command.action !== "show") await this.run(["show"], { cwd });
      let args: string[];
      let input: string | undefined;
      switch (command.action) {
        case "show":
          args = ["show"];
          break;
        case "set":
          args = [
            "set",
            // The shared goal contract currently models engine families, not
            // wrapper applications. OpenMaus owns the lane/session identity
            // while using the Codex-family adapter for compatibility.
            "--surface", "codex",
            "--lane", `openmaus-${context.botId}`,
            "--session", context.threadId,
            "--model", context.model || "unknown",
            "--objective-stdin",
            ...(command.replace ? ["--replace"] : []),
          ];
          input = command.objective;
          break;
        case "pause":
        case "resume":
        case "clear":
          args = [command.action];
          break;
        case "complete":
          args = ["complete", "--proof", await verifiedProof(command.proof)];
          break;
        case "block":
          args = ["block", "--reason", command.reason, "--proof", await verifiedProof(command.proof)];
          break;
      }
      const result = await this.run(args, { cwd, input });
      const record = parsePayload(result);
      const ok = result.exitCode === 0 && record?.status !== "blocked";
      return {
        handled: true,
        ok,
        status: ok ? 200 : 409,
        response: display(record),
        ...(record ? { record } : {}),
      };
    } catch (error) {
      return {
        handled: true,
        ok: false,
        status: 409,
        response: error instanceof Error ? error.message : "Shared goal command failed.",
      };
    }
  }
}
