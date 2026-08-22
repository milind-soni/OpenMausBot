import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, win32 as winPath } from "node:path";

import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type { RuntimeEvent } from "./contracts.ts";
import { augmentedPath } from "./env-path.ts";
import { killCliTree, spawnCli } from "./procs.ts";
import { redactProtectedEnvironmentValues, redactSecrets } from "./redact.ts";
import type { TelemetryEnvelope, TelemetryErrorEnvelope, TelemetryToolSpan, TelemetryTraceEnvelope } from "./telemetry-protocol.ts";
import { windowsCmdCommand } from "./windows-cmd.ts";

const SUMMARY_CHARS = 4_000;
export const TELEMETRY_JOURNAL_ROLL_BYTES = 8 * 1024 * 1024;
export const TELEMETRY_JOURNAL_RETAIN_BYTES = 4 * 1024 * 1024;

type SinkKind = "sentry" | "langfuse";
type SinkChild = ChildProcessByStdio<Writable, Readable, Readable>;

export interface TelemetryHealth {
  configured: boolean;
  running: boolean;
  degraded: boolean;
  lastError?: string;
  lastSuccess?: string;
}

export interface RegisterTurnInput {
  botId: string;
  botName: string;
  threadId: string;
  engine: string;
  model: string;
  prompt: string;
}

interface TurnState extends RegisterTurnInput {
  correlationId: string;
  traceId: string;
  turnId: string;
  startedAt: string;
  promptSummary: string;
  responseSummary: string;
  tools: Map<string, Omit<TelemetryToolSpan, "endedAt" | "ok">>;
  completedTools: TelemetryToolSpan[];
  usage?: { input: number; output: number };
  errorSummary?: string;
}

export interface TelemetryOptions {
  dataDir: string;
  sinkPath: string;
  sourceSha: string;
  release: string;
  now?: () => Date;
  spawnSink?: (kind: SinkKind) => SinkChild | null;
}

function summary(value: string, max = SUMMARY_CHARS): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function sinkAliases(kind: SinkKind, env: NodeJS.ProcessEnv): Array<{ alias: string; env: string }> {
  if (kind === "sentry") {
    return [{ alias: env.OMB_SENTRY_DSN_ALIAS ?? "sentry_dsn_gusdigital_ios", env: "SENTRY_DSN" }];
  }
  return [
    { alias: env.OMB_LANGFUSE_PUBLIC_KEY_ALIAS ?? "langfuse_local_init_project_public_key", env: "LANGFUSE_PUBLIC_KEY" },
    { alias: env.OMB_LANGFUSE_SECRET_KEY_ALIAS ?? "langfuse_local_init_project_secret_key", env: "LANGFUSE_SECRET_KEY" },
  ];
}

function cleanEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = ["HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SHELL"] as const;
  const env: NodeJS.ProcessEnv = {
    PATH: augmentedPath(),
  };
  for (const name of keep) if (source[name]) env[name] = source[name];
  return env;
}

function boundedRuntimeValue(value: string | undefined, fallback: string, max: number): string {
  const candidate = value?.trim() ?? "";
  return candidate && candidate.length <= max && /^[A-Za-z0-9._+-]+$/.test(candidate)
    ? candidate
    : fallback;
}

function langfuseBaseUrl(value: string | undefined): string {
  try {
    const parsed = new URL(value?.trim() || "http://127.0.0.1:3030");
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return "http://127.0.0.1:3030";
    }
    return parsed.href.replace(/\/$/, "");
  } catch {
    return "http://127.0.0.1:3030";
  }
}

export interface TelemetrySinkSpawnSpec {
  cli: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface TelemetrySinkRuntimeConfig {
  schema: "openmaus.telemetry-sink-runtime.v1";
  kind: SinkKind;
  release: string;
  environment: string;
  langfuseBaseUrl: string;
}

export function telemetrySinkRuntimeConfig(
  kind: SinkKind,
  release: string,
  env: NodeJS.ProcessEnv = process.env,
): TelemetrySinkRuntimeConfig {
  return {
    schema: "openmaus.telemetry-sink-runtime.v1",
    kind,
    release: boundedRuntimeValue(release, "unknown", 128),
    environment: boundedRuntimeValue(env.OMB_TELEMETRY_ENVIRONMENT, "production", 64),
    langfuseBaseUrl: langfuseBaseUrl(env.OMB_LANGFUSE_BASE_URL),
  };
}

/** Build one CredVault stdio broker invocation for all credentials a sink
 * needs. CredVault deliberately strips the parent environment, so the final
 * executable boundary restores only Electron's Node-mode flag. Bounded
 * non-secret metadata travels in a private file; raw values remain inside
 * CredVault and the sink. */
export function telemetrySinkSpawnSpec(
  kind: SinkKind,
  sinkPath: string,
  runtimeConfigPath: string,
  options: {
    platform?: NodeJS.Platform;
    executable?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): TelemetrySinkSpawnSpec {
  const platform = options.platform ?? process.platform;
  const executable = options.executable ?? process.execPath;
  const source = options.env ?? process.env;
  const bindings = sinkAliases(kind, source).flatMap(({ alias, env }) => ["--env", `${env}=${alias}`]);
  let command: string;
  let commandArgs: string[];
  if (platform === "win32") {
    command = source.ComSpec || source.COMSPEC || "cmd.exe";
    commandArgs = [
      "/d",
      "/v:off",
      "/s",
      "/c",
      windowsCmdCommand([
        winPath.join(winPath.dirname(sinkPath), "telemetry-node-launcher.cmd"),
        executable,
        sinkPath,
        runtimeConfigPath,
      ]),
    ];
  } else {
    command = "/usr/bin/env";
    commandArgs = [
      "ELECTRON_RUN_AS_NODE=1",
      executable,
      sinkPath,
      runtimeConfigPath,
    ];
  }
  return {
    cli: "cv",
    args: ["--source", "main", "stdio-exec", ...bindings, "--", command, ...commandArgs],
    env: cleanEnvironment(source),
  };
}

/** Sanitized, non-blocking telemetry fan-out. Credentials are injected into
 * dedicated sink children by CredVault and never enter this process, agent
 * environments, argv, journals, or tool results. */
export class TelemetryManager {
  private readonly options: TelemetryOptions;
  /** Correlation IDs are unique even when multiple authenticated external
   * turns intentionally share a conversation thread. */
  private readonly turns = new Map<string, TurnState>();
  private readonly turnByIdentity = new Map<string, string>();
  private readonly turnsByThread = new Map<string, string[]>();
  private readonly sinks = new Map<SinkKind, SinkChild>();
  private readonly healthState: Record<SinkKind, TelemetryHealth> = {
    sentry: { configured: true, running: false, degraded: false },
    langfuse: { configured: true, running: false, degraded: false },
  };
  private readonly now: () => Date;
  private readonly journalPath: string;

  constructor(options: TelemetryOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    const directory = join(options.dataDir, "telemetry");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.journalPath = join(directory, "turns.ndjson");
    for (const kind of ["sentry", "langfuse"] as const) this.startSink(kind);
  }

  private spawnDefault(kind: SinkKind): SinkChild {
    const configPath = join(this.options.dataDir, "telemetry", `sink-${kind}.json`);
    const temporary = `${configPath}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify(telemetrySinkRuntimeConfig(kind, this.options.release))}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, configPath);
    const spec = telemetrySinkSpawnSpec(kind, this.options.sinkPath, configPath);
    return spawnCli(spec.cli, spec.args, {
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  private startSink(kind: SinkKind): void {
    try {
      const child = this.options.spawnSink ? this.options.spawnSink(kind) : this.spawnDefault(kind);
      if (!child) {
        this.healthState[kind] = { configured: false, running: false, degraded: true, lastError: "telemetry sink is disabled" };
        return;
      }
      this.sinks.set(kind, child);
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += String(chunk);
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const frame = JSON.parse(line) as { kind?: string; message?: string };
            if (frame.kind === "ready") this.healthState[kind] = { ...this.healthState[kind], running: true, degraded: false, lastError: undefined };
            if (frame.kind === "sent") this.healthState[kind].lastSuccess = this.now().toISOString();
            if (frame.kind === "error") this.degrade(kind, frame.message ?? "telemetry export failed");
          } catch {
            // CredVault wrappers may emit benign status lines. Never retain them.
          }
        }
      });
      child.stderr.resume();
      child.on("error", () => this.degrade(kind, "telemetry sink could not start"));
      child.on("close", () => {
        this.sinks.delete(kind);
        this.degrade(kind, "telemetry sink stopped");
      });
    } catch {
      this.degrade(kind, "telemetry sink could not start");
    }
  }

  private degrade(kind: SinkKind, message: string): void {
    this.healthState[kind] = {
      ...this.healthState[kind],
      running: false,
      degraded: true,
      lastError: summary(String(this.sanitize(message)), 300),
    };
  }

  private sanitize<T>(input: T): T {
    return redactProtectedEnvironmentValues(redactSecrets(input)) as T;
  }

  health(): Record<SinkKind, TelemetryHealth> {
    return structuredClone(this.healthState);
  }

  private identityKey(threadId: string, turnId: string): string {
    return JSON.stringify([threadId, turnId]);
  }

  private stateForThread(threadId: string): { correlationId: string; state: TurnState } | undefined {
    const correlations = this.turnsByThread.get(threadId) ?? [];
    // Preserve the legacy single-thread behavior for providers that do not
    // report turn IDs: the most recently registered active turn owns events.
    for (let index = correlations.length - 1; index >= 0; index -= 1) {
      const correlationId = correlations[index]!;
      const state = this.turns.get(correlationId);
      if (state) return { correlationId, state };
    }
    return undefined;
  }

  private stateForEvent(event: RuntimeEvent): { correlationId: string; state: TurnState } | undefined {
    if (!event.turnId) return this.stateForThread(event.threadId);
    const identity = this.identityKey(event.threadId, event.turnId);
    const exactCorrelation = this.turnByIdentity.get(identity);
    if (exactCorrelation) {
      const exact = this.turns.get(exactCorrelation);
      if (exact) return { correlationId: exactCorrelation, state: exact };
      this.turnByIdentity.delete(identity);
    }

    // Existing callers register before a provider reports its native turn ID.
    // Bind the oldest unbound state once, then route every subsequent event by
    // exact identity. External callers may also provide the ID up front via
    // the backwards-compatible overload below.
    for (const correlationId of this.turnsByThread.get(event.threadId) ?? []) {
      const state = this.turns.get(correlationId);
      if (!state || state.turnId !== "pending") continue;
      state.turnId = event.turnId;
      this.turnByIdentity.set(identity, correlationId);
      return { correlationId, state };
    }
    return undefined;
  }

  registerTurn(input: RegisterTurnInput): string;
  registerTurn(input: RegisterTurnInput, turnId: string): string;
  registerTurn(input: RegisterTurnInput, turnId?: string): string {
    if (turnId) {
      const existing = this.turnByIdentity.get(this.identityKey(input.threadId, turnId));
      if (existing && this.turns.has(existing)) return existing;
    }
    const correlationId = randomUUID();
    const state: TurnState = {
      ...input,
      correlationId,
      traceId: randomUUID(),
      turnId: turnId || "pending",
      startedAt: this.now().toISOString(),
      promptSummary: summary(String(this.sanitize(input.prompt))),
      responseSummary: "",
      tools: new Map(),
      completedTools: [],
    };
    this.turns.set(correlationId, state);
    this.turnsByThread.set(input.threadId, [...(this.turnsByThread.get(input.threadId) ?? []), correlationId]);
    if (turnId) this.turnByIdentity.set(this.identityKey(input.threadId, turnId), correlationId);
    return correlationId;
  }

  handleRuntimeEvent(event: RuntimeEvent): void {
    const active = this.stateForEvent(event);
    const state = active?.state;
    if (event.type === "runtime.error") {
      if (state) state.errorSummary = summary(String(this.sanitize(event.message)), 1_000);
      this.captureError(event.message, {
        component: "driver",
        state,
        threadId: event.threadId,
        turnId: event.turnId,
      });
    }
    if (!state) return;
    const at = event.createdAt || this.now().toISOString();
    if (event.type === "item.started" && event.itemType === "tool") {
      const id = event.itemId ?? randomUUID();
      state.tools.set(id, { id, name: summary(event.title ?? "tool", 256), startedAt: at });
    } else if (event.type === "item.completed" && event.itemType === "tool") {
      const id = event.itemId ?? "unknown";
      const open = state.tools.get(id) ?? { id, name: "tool", startedAt: at };
      state.tools.delete(id);
      state.completedTools.push({ ...open, endedAt: at, ok: event.ok });
    } else if (event.type === "item.completed" && event.itemType === "assistant_text") {
      state.responseSummary = summary(`${state.responseSummary} ${String(this.sanitize(event.text))}`);
    } else if (event.type === "thread.token-usage.updated") {
      state.usage = { input: event.input, output: event.output };
    } else if (event.type === "turn.completed") {
      if (event.usage) state.usage = event.usage;
      const cancelled = /cancel|interrupt|abort/i.test(event.stopReason ?? "");
      this.finishTurn(
        active.correlationId,
        event.ok ? "completed" : cancelled ? "cancelled" : "failed",
        event.stopReason ?? undefined,
      );
    }
  }

  failTurn(threadId: string, error: unknown): void;
  failTurn(threadId: string, turnId: string, error: unknown): void;
  failTurn(threadId: string, turnIdOrError: string | unknown, explicitError?: unknown): void {
    const hasTurnId = arguments.length >= 3;
    const turnId = hasTurnId ? String(turnIdOrError) : undefined;
    const error = hasTurnId ? explicitError : turnIdOrError;
    const correlationId = turnId
      ? this.turnByIdentity.get(this.identityKey(threadId, turnId))
      : this.stateForThread(threadId)?.correlationId;
    const state = correlationId ? this.turns.get(correlationId) : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (state) state.errorSummary = summary(String(this.sanitize(message)), 1_000);
    this.captureError(error, { component: "driver", state, threadId, turnId });
    if (correlationId) this.finishTurn(correlationId, "failed", message);
  }

  private finishTurn(correlationId: string, outcome: TelemetryTraceEnvelope["outcome"], error?: string): void {
    const state = this.turns.get(correlationId);
    if (!state) return;
    this.turns.delete(correlationId);
    if (state.turnId !== "pending") {
      this.turnByIdentity.delete(this.identityKey(state.threadId, state.turnId));
    }
    const remaining = (this.turnsByThread.get(state.threadId) ?? []).filter((id) => id !== correlationId);
    if (remaining.length) this.turnsByThread.set(state.threadId, remaining);
    else this.turnsByThread.delete(state.threadId);
    const endedAt = this.now().toISOString();
    for (const open of state.tools.values()) {
      state.completedTools.push({ ...open, endedAt, ok: false });
    }
    const envelope: TelemetryTraceEnvelope = this.sanitize({
      kind: "trace",
      application: "openmausbot",
      correlationId: state.correlationId,
      traceId: state.traceId,
      botId: state.botId,
      botName: state.botName,
      threadId: state.threadId,
      turnId: state.turnId,
      engine: state.engine,
      model: state.model,
      release: this.options.release,
      sourceSha: this.options.sourceSha,
      startedAt: state.startedAt,
      endedAt,
      promptSummary: state.promptSummary,
      responseSummary: state.responseSummary,
      tools: state.completedTools.slice(0, 200),
      usage: state.usage,
      outcome,
      errorSummary: error ? summary(error, 1_000) : state.errorSummary,
    });
    this.writeJournal(envelope);
    this.send("langfuse", envelope);
  }

  captureError(
    error: unknown,
    context: {
      component: TelemetryErrorEnvelope["component"];
      state?: TurnState;
      turnId?: string;
      botId?: string;
      botName?: string;
      threadId?: string;
      engine?: string;
      model?: string;
      correlationId?: string;
      diagnostics?: Record<string, unknown>;
    },
  ): void {
    const original = error instanceof Error ? error : new Error(String(error));
    const state = context.state;
    const envelope: TelemetryErrorEnvelope = this.sanitize({
      kind: "error",
      application: "openmausbot",
      correlationId: context.correlationId ?? state?.correlationId ?? randomUUID(),
      traceId: state?.traceId,
      botId: context.botId ?? state?.botId,
      botName: context.botName ?? state?.botName,
      threadId: context.threadId ?? state?.threadId,
      turnId: context.turnId ?? state?.turnId,
      engine: context.engine ?? state?.engine,
      model: context.model ?? state?.model,
      release: this.options.release,
      sourceSha: this.options.sourceSha,
      component: context.component,
      name: original.name,
      message: summary(original.message, 1_000),
      stack: original.stack ? summary(original.stack, 4_000) : undefined,
      diagnostics: this.sanitizeDiagnostics(context.diagnostics),
      at: this.now().toISOString(),
    });
    this.send("sentry", envelope);
  }

  private sanitizeDiagnostics(input: Record<string, unknown> | undefined): Record<string, string | number | boolean> | undefined {
    if (!input) return undefined;
    const diagnostics: Record<string, string | number | boolean> = {};
    for (const [rawKey, rawValue] of Object.entries(input).slice(0, 16)) {
      const key = summary(rawKey, 80).replace(/[^A-Za-z0-9_.-]/g, "_");
      if (!key) continue;
      if (typeof rawValue === "string") diagnostics[key] = summary(rawValue, 1_000);
      else if (typeof rawValue === "number" && Number.isFinite(rawValue)) diagnostics[key] = rawValue;
      else if (typeof rawValue === "boolean") diagnostics[key] = rawValue;
    }
    return Object.keys(diagnostics).length ? diagnostics : undefined;
  }

  private writeJournal(envelope: TelemetryTraceEnvelope): void {
    try {
      const line = `${JSON.stringify(envelope)}\n`;
      let currentBytes = 0;
      try {
        currentBytes = statSync(this.journalPath).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (currentBytes + Buffer.byteLength(line) > TELEMETRY_JOURNAL_ROLL_BYTES) {
        const retainBytes = Math.min(currentBytes, TELEMETRY_JOURNAL_RETAIN_BYTES);
        const buffer = Buffer.alloc(retainBytes);
        const fd = openSync(this.journalPath, "r");
        try {
          readSync(fd, buffer, 0, retainBytes, currentBytes - retainBytes);
        } finally {
          closeSync(fd);
        }
        const retained = buffer.toString("utf8");
        const firstNewline = retained.indexOf("\n");
        const completeRows = currentBytes > retainBytes
          ? firstNewline >= 0 ? retained.slice(firstNewline + 1) : ""
          : retained;
        writeFileSync(this.journalPath, completeRows, { mode: 0o600 });
      }
      appendFileSync(this.journalPath, line, { mode: 0o600 });
    } catch {
      this.degrade("langfuse", "sanitized telemetry journal could not be written");
    }
  }

  private send(kind: SinkKind, envelope: TelemetryEnvelope): void {
    const child = this.sinks.get(kind);
    if (!child || child.stdin.destroyed) {
      this.degrade(kind, "telemetry sink is unavailable");
      return;
    }
    try {
      child.stdin.write(`${JSON.stringify(envelope)}\n`);
    } catch {
      this.degrade(kind, "telemetry sink write failed");
    }
  }

  shutdown(): void {
    for (const correlationId of [...this.turns.keys()]) this.finishTurn(correlationId, "cancelled", "application shutdown");
    for (const child of this.sinks.values()) {
      try { child.stdin.end(); } catch {}
      killCliTree(child);
    }
    this.sinks.clear();
  }
}
