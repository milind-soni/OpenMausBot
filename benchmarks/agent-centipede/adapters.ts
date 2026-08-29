import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type {
  ActionKind,
  BenchmarkAdapter,
  EvidenceEvent,
  BenchmarkSandbox,
  SandboxProfile,
  ScenarioAction,
  ScenarioId,
} from "./types.ts";
import { assertSandboxIsolated } from "./sandbox.ts";

type Primitive = string | number | boolean | null;
type PrimitiveRecord = Record<string, Primitive>;

export type ProcessSandboxAdapterOptions = SandboxProfile & {
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
  /** Keep this false unless the action has been explicitly approved. */
  allowSideEffects?: boolean;
  approvedActionIds?: readonly string[];
  env?: Readonly<Record<string, string>>;
};

export type HttpSandboxAdapterOptions = SandboxProfile & {
  endpoint: string;
  timeoutMs?: number;
  allowSideEffects?: boolean;
  approvedActionIds?: readonly string[];
  headers?: Readonly<Record<string, string>>;
};

type AgentReply = {
  status?: EvidenceEvent["status"];
  latencyMs?: number;
  costUsd?: number;
  tokens?: number;
  data?: PrimitiveRecord;
};

const statuses: readonly string[] = ["ok", "failed", "blocked", "needs-auth", "dry-run"];
const sideEffectKinds = new Set<ActionKind>(["execute", "windows"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is Primitive {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isEventStatus(value: unknown): value is EvidenceEvent["status"] {
  return typeof value === "string" && statuses.includes(value);
}

function toPrimitiveRecord(value: unknown): PrimitiveRecord | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  const result: PrimitiveRecord = {};
  for (const [key, item] of entries) {
    if (!isPrimitive(item)) return undefined;
    result[key] = item;
  }
  return result;
}

function parseReply(text: string): AgentReply {
  const trimmed = text.trim();
  if (!trimmed) return {};
  let value: unknown;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    value = parsed;
  } catch {
    return {};
  }
  if (!isRecord(value)) return {};
  const reply: AgentReply = {};
  const status = value.status;
  if (isEventStatus(status)) reply.status = status;
  if (typeof value.latencyMs === "number" && Number.isFinite(value.latencyMs) && value.latencyMs >= 0) reply.latencyMs = value.latencyMs;
  if (typeof value.costUsd === "number" && Number.isFinite(value.costUsd) && value.costUsd >= 0) reply.costUsd = value.costUsd;
  if (typeof value.tokens === "number" && Number.isFinite(value.tokens) && value.tokens >= 0) reply.tokens = value.tokens;
  reply.data = toPrimitiveRecord(value.data);
  return reply;
}

function assertSandboxProfile(profile: SandboxProfile): void {
  for (const [name, path] of Object.entries({ profileDir: profile.profileDir, dataRoot: profile.dataRoot, traceDir: profile.traceDir })) {
    if (!isAbsolute(path)) throw new Error(`live benchmark ${name} must be an absolute path`);
    if (path.includes("\0")) throw new Error(`live benchmark ${name} contains a NUL byte`);
  }
  if (!profile.dryRun && profile.allowNetwork === undefined) {
    throw new Error("live benchmark requires an explicit allowNetwork value");
  }
}

function assertInside(root: string, candidate: string): void {
  const rel = relative(normalize(resolve(root)), normalize(resolve(candidate)));
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`live benchmark path escaped dataRoot: ${candidate}`);
}

function assertSafeProfilePath(profile: SandboxProfile, containmentRoot = profile.dataRoot): void {
  assertInside(containmentRoot, profile.profileDir);
  assertInside(containmentRoot, profile.dataRoot);
  assertInside(containmentRoot, profile.traceDir);
  if (resolve(profile.dataRoot) === resolve(profile.profileDir)) throw new Error("profileDir must be distinct from dataRoot");
}

function profileFromSandbox(sandbox: BenchmarkSandbox, options: Pick<SandboxProfile, "dryRun" | "allowNetwork">): SandboxProfile {
  assertSandboxIsolated(sandbox.paths);
  const profile: SandboxProfile = {
    profileDir: sandbox.paths.profile,
    dataRoot: sandbox.paths.storage,
    traceDir: sandbox.paths.traces,
    dryRun: options.dryRun,
    ...(options.allowNetwork !== undefined ? { allowNetwork: options.allowNetwork } : {}),
  };
  // assertSandboxIsolated has already resolved every path and rejected links;
  // this second check documents the profile relationship at the adapter seam.
  assertSafeProfilePath(profile, sandbox.paths.root);
  return profile;
}

function actionIsSideEffect(action: ScenarioAction): boolean {
  return action.sideEffect === true || sideEffectKinds.has(action.kind);
}

function blockedEvent(scenarioId: ScenarioId, action: ScenarioAction, attempt: number, profile: SandboxProfile, reason: string): EvidenceEvent {
  const event: EvidenceEvent = {
    id: `${scenarioId}:${action.id}:${attempt}`,
    scenarioId,
    actionId: action.id,
    kind: action.kind,
    status: "blocked",
    attempt,
    timestampMs: Date.now(),
    latencyMs: 0,
    costUsd: 0,
    tokens: 0,
    data: { target: action.target, blockedReason: reason, dryRun: profile.dryRun },
  };
  if (action.agentId) event.agentId = action.agentId;
  return event;
}

function makeEvent(scenarioId: ScenarioId, action: ScenarioAction, attempt: number, reply: AgentReply, elapsedMs: number, tracePath: string): EvidenceEvent {
  const event: EvidenceEvent = {
    id: `${scenarioId}:${action.id}:${attempt}`,
    scenarioId,
    actionId: action.id,
    kind: action.kind,
    status: reply.status ?? "ok",
    attempt,
    timestampMs: Date.now(),
    latencyMs: reply.latencyMs ?? elapsedMs,
    costUsd: reply.costUsd ?? action.costUsd,
    tokens: reply.tokens ?? (typeof action.data?.tokens === "number" ? action.data.tokens : 0),
    data: { target: action.target, tracePath, ...action.data, ...reply.data },
  };
  if (action.agentId) event.agentId = action.agentId;
  return event;
}

async function saveTrace(tracePath: string, value: unknown): Promise<void> {
  await appendFile(tracePath, `${JSON.stringify(value)}\n`, "utf8");
}

function adapterBase(name: string, profile: SandboxProfile): { name: string; events: EvidenceEvent[] } {
  assertSandboxProfile(profile);
  assertSafeProfilePath(profile);
  return { name, events: [] };
}

/** Run a real agent process with benchmark-owned profile/data directories.
 * The process receives the action as OMB_BENCHMARK_ACTION and must return a
 * JSON object on stdout. shell=false prevents command-string injection. */
export function createProcessSandboxAdapter(options: ProcessSandboxAdapterOptions): BenchmarkAdapter {
  const base = adapterBase(`process:${basename(options.command)}`, options);
  let runtimeProfile: SandboxProfile = options;
  const approved = new Set(options.approvedActionIds ?? []);
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (timeoutMs <= 0) throw new Error("process benchmark timeout must be positive");
  return {
    name: base.name,
    evidenceMode: "adapter-reported",
    requiresSandboxBinding: true,
    bindSandbox: (sandbox) => { runtimeProfile = profileFromSandbox(sandbox, options); },
    get events() { return base.events; },
    async perform(scenarioId, action, attempt) {
      if (runtimeProfile.dryRun && actionIsSideEffect(action)) {
        const event: EvidenceEvent = blockedEvent(scenarioId, action, attempt, runtimeProfile, "dry-run-side-effect");
        event.status = "dry-run";
        base.events.push(event);
        return event;
      }
      if (actionIsSideEffect(action) && (!options.allowSideEffects || !approved.has(action.id))) {
        const event = blockedEvent(scenarioId, action, attempt, runtimeProfile, "approval-required");
        base.events.push(event);
        return event;
      }
      await mkdir(runtimeProfile.profileDir, { recursive: true });
      await mkdir(runtimeProfile.dataRoot, { recursive: true });
      await mkdir(runtimeProfile.traceDir, { recursive: true });
      const started = Date.now();
      const tracePath = join(runtimeProfile.traceDir, `${scenarioId}-${action.id}-${attempt}.ndjson`);
      const actionJson = JSON.stringify({ scenarioId, action, attempt });
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TMP", "TEMP"] as const) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      Object.assign(env, {
        ...options.env,
        OMB_BENCHMARK: "1",
        OMB_DRY_RUN: String(runtimeProfile.dryRun ?? false),
        OMB_PROFILE_DIR: runtimeProfile.profileDir,
        OMB_DATA_DIR: runtimeProfile.dataRoot,
        OMB_BENCHMARK_ACTION: actionJson,
      });
      const child = spawn(options.command, [...(options.args ?? [])], { cwd: runtimeProfile.dataRoot, env, shell: false, windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      const result = await new Promise<{ code: number | null; error?: string }>((resolvePromise) => {
        let settled = false;
        const finish = (value: { code: number | null; error?: string }): void => { if (!settled) { settled = true; resolvePromise(value); } };
        const timer = setTimeout(() => { child.kill(); finish({ code: null, error: "timeout" }); }, timeoutMs);
        child.once("error", (error: Error) => { clearTimeout(timer); finish({ code: null, error: error.message }); });
        child.once("close", (code: number | null) => { clearTimeout(timer); finish({ code }); });
      });
      const elapsedMs = Date.now() - started;
      const reply = parseReply(stdout);
      const event = makeEvent(scenarioId, action, attempt, result.error || result.code !== 0 ? { ...reply, status: "failed" } : reply, elapsedMs, tracePath);
      await writeFile(tracePath, "", "utf8");
      await saveTrace(tracePath, { version: 1, adapter: base.name, scenarioId, action, attempt, command: options.command, args: options.args ?? [], stdout, stderr, result, event });
      base.events.push(event);
      return event;
    },
  };
}

/** Call a benchmark-aware HTTP agent endpoint. Network use is opt-in and
 * side effects remain dry-run/approval gated exactly like process runs. */
export function createHttpSandboxAdapter(options: HttpSandboxAdapterOptions): BenchmarkAdapter {
  const base = adapterBase(`http:${options.endpoint}`, options);
  let runtimeProfile: SandboxProfile = options;
  const approved = new Set(options.approvedActionIds ?? []);
  const endpoint = new URL(options.endpoint).toString();
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (options.allowNetwork !== true) throw new Error("HTTP benchmark adapter requires allowNetwork: true");
  return {
    name: base.name,
    evidenceMode: "adapter-reported",
    requiresSandboxBinding: true,
    bindSandbox: (sandbox) => { runtimeProfile = profileFromSandbox(sandbox, options); },
    get events() { return base.events; },
    async perform(scenarioId, action, attempt) {
      if (runtimeProfile.dryRun && actionIsSideEffect(action)) {
        const event: EvidenceEvent = blockedEvent(scenarioId, action, attempt, runtimeProfile, "dry-run-side-effect");
        event.status = "dry-run";
        base.events.push(event);
        return event;
      }
      if (actionIsSideEffect(action) && (!options.allowSideEffects || !approved.has(action.id))) {
        const event = blockedEvent(scenarioId, action, attempt, runtimeProfile, "approval-required");
        base.events.push(event);
        return event;
      }
      await mkdir(runtimeProfile.traceDir, { recursive: true });
      const started = Date.now();
      const tracePath = join(runtimeProfile.traceDir, `${scenarioId}-${action.id}-${attempt}.ndjson`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response | undefined;
      let body = "";
      let error = "";
      try {
        response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", ...options.headers }, body: JSON.stringify({ scenarioId, action, attempt, dryRun: runtimeProfile.dryRun, profileDir: runtimeProfile.profileDir, dataRoot: runtimeProfile.dataRoot }), signal: controller.signal });
        body = await response.text();
      } catch (caught: unknown) {
        error = caught instanceof Error ? caught.message : "HTTP benchmark request failed";
      } finally {
        clearTimeout(timer);
      }
      const reply = parseReply(body);
      const event = makeEvent(scenarioId, action, attempt, error || !response?.ok ? { ...reply, status: "failed" } : reply, Date.now() - started, tracePath);
      await writeFile(tracePath, `${JSON.stringify({ version: 1, adapter: base.name, scenarioId, action, attempt, status: response?.status ?? 0, body, error, event })}\n`, "utf8");
      base.events.push(event);
      return event;
    },
  };
}
