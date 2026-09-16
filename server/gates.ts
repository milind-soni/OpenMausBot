// Phase 3 part 1 — gates and scoped claims.
//
// A project's own checks (typecheck, lint, test, build), discovered from the
// folder or declared in .openmausbot/gates.json, run by the harness as code
// when unattended work finishes, and folded into one line that says what
// ran and what did not. The verifier (part 3) judges against this; the
// graph runner (part 4) runs it as the `check` node. Pure discovery, child
// processes for runs; nothing here knows about bots or the board.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GateSpec {
  name: string;
  /** A shell command line, run in the folder. */
  command: string;
}

export type GateStatus = "pass" | "fail" | "timeout";

export interface GateResult {
  name: string;
  status: GateStatus;
  /** Wall time, whole seconds. */
  seconds: number;
  /** The last lines of combined output, for the comment and the verifier. */
  tail: string;
}

export const GATES_FILE = join(".openmausbot", "gates.json");
/** The package.json scripts that count as gates, in the order they run. */
export const SCRIPT_GATES: readonly string[] = ["typecheck", "lint", "test", "build"];
export const DEFAULT_GATE_TIMEOUT_MS = 600_000;
const TAIL_LINES = 40;
const TAIL_CHARS = 4_000;
const NAME_MAX = 40;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function packageManager(cwd: string): "pnpm" | "yarn" | "npm" {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

/** The declared sequence if the folder has one, else the package.json
 * scripts that count, else nothing. Never throws: a folder that cannot be
 * read simply has no gates. */
export function discoverGates(cwd: string | undefined): GateSpec[] {
  if (!cwd || !existsSync(cwd)) return [];
  const declared = readJson(join(cwd, GATES_FILE));
  if (Array.isArray(declared)) {
    const gates: GateSpec[] = [];
    for (const entry of declared) {
      if (!entry || typeof entry !== "object") continue;
      const { name, run } = entry as { name?: unknown; run?: unknown };
      if (typeof name !== "string" || !name.trim() || typeof run !== "string" || !run.trim()) continue;
      gates.push({ name: name.trim().slice(0, NAME_MAX), command: run.trim() });
    }
    if (gates.length) return gates;
  }
  const pkg = readJson(join(cwd, "package.json")) as { scripts?: Record<string, unknown> } | undefined;
  const scripts = pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const manager = packageManager(cwd);
  return SCRIPT_GATES.filter((name) => typeof scripts[name] === "string" && String(scripts[name]).trim())
    .map((name) => ({ name, command: `${manager} run ${name}` }));
}

function tailOf(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.slice(-TAIL_LINES).join("\n").slice(-TAIL_CHARS);
}

function runOne(cwd: string, gate: GateSpec, timeoutMs: number): Promise<GateResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let settled = false;
    const finish = (status: GateStatus, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ name: gate.name, status, seconds: Math.round((Date.now() - started) / 1000), tail: tailOf(output + (extra ? `\n${extra}` : "")) });
    };
    let child: ReturnType<typeof spawn>;
    try {
      // A gate is a shell line by design (declared files carry "pnpm run
      // test", "make check"); the folder is the project's own, so this runs
      // with the same trust as the bot's turn did there.
      child = spawn(gate.command, { cwd, shell: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish("fail", error instanceof Error ? error.message : String(error));
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish("timeout", `(killed after ${Math.round(timeoutMs / 1000)} s)`);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { output = (output + String(chunk)).slice(-TAIL_CHARS * 4); });
    child.stderr?.on("data", (chunk) => { output = (output + String(chunk)).slice(-TAIL_CHARS * 4); });
    child.on("error", (error) => finish("fail", error.message));
    child.on("close", (code, signal) => finish(code === 0 ? "pass" : "fail", code === 0 ? "" : `(exit ${code ?? signal ?? "?"})`));
  });
}

/** Run every gate in order. One failing does not skip the rest: the claim
 * needs the whole picture, and the verifier reads each tail. */
export async function runGates(cwd: string, gates: readonly GateSpec[], opts: { timeoutMs?: number } = {}): Promise<GateResult[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const results: GateResult[] = [];
  for (const gate of gates) results.push(await runOne(cwd, gate, timeoutMs));
  return results;
}

/** The one line a completion claim carries: what ran, how it went, and
 * which declared gates did not run. */
export function scopeLine(results: readonly GateResult[], declared: readonly string[]): string {
  if (!declared.length && !results.length) return "Gates: none declared for this folder; nothing was run.";
  const ran = results.map((r) => `${r.name} ${r.status === "timeout" ? "timed out" : r.status} (${r.seconds} s)`);
  const done = new Set(results.map((r) => r.name));
  const skipped = declared.filter((name) => !done.has(name));
  const head = ran.length ? `Gates: ${ran.join(", ")}` : "Gates: nothing ran";
  return skipped.length ? `${head}; ${skipped.join(", ")} not run.` : `${head}.`;
}
