// Persistent read-only `codex app-server` JSON-RPC 2.0 transport for external approval review.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

export interface AppServerStartThreadOptions {
  model: string;
  instructions: string;
  useBaseInstructions?: boolean;
  cwd?: string;
}

export interface AppServerTurnUsage {
  inputTokens?: number;
  input_tokens?: number;
  cachedInputTokens?: number;
  cached_input_tokens?: number;
  outputTokens?: number;
  output_tokens?: number;
}

export interface AppServerTurnResult {
  text: string;
  usage: AppServerTurnUsage | null;
}

export interface AppServerRunTurnOptions {
  effort?: string;
  outputSchema?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal | null;
}

export interface ExternalAppServerTransport {
  isAlive(): boolean;
  ensureReady(): Promise<unknown>;
  startThread(opts: AppServerStartThreadOptions): Promise<string>;
  runTurn(threadId: string, promptText: string, opts?: AppServerRunTurnOptions): Promise<AppServerTurnResult>;
  unsubscribe(threadId: string): Promise<void>;
  close(): void;
}

const RPC_TIMEOUT_MS = 15_000;
const DEFAULT_TURN_TIMEOUT_MS = 45_000;
const APP_SERVER_DISABLE_FEATURES = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "view_image",
  "image_generation",
  "apps",
  "plugins",
  "remote_plugin",
  "hooks",
  "memories",
  "goals",
  "sleep_tool",
  "daemon_auto_start",
];

function appServerArgs(): string[] {
  const args = [
    "app-server",
    "-c", "check_for_update_on_startup=false",
    "-c", "agents.enabled=false",
  ];
  for (const feature of APP_SERVER_DISABLE_FEATURES) {
    args.push("--disable", feature);
  }
  return args;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveTurn {
  resolve: (result: AppServerTurnResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanupAbort: () => void;
  lastText: string;
  deltaText: string;
  usage: AppServerTurnUsage | null;
}

export class CodexExternalAppServerClient implements ExternalAppServerTransport {
  private readonly command: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private workDir: string | null = null;
  private nextId = 1;
  private pendingRpc = new Map<number, PendingRpc>();
  private activeTurns = new Map<string, ActiveTurn>();
  readyPromise: Promise<ChildProcessWithoutNullStreams> | null = null;
  closed = false;
  private baseInstructionsUnsupportedModels = new Set<string>();

  constructor(command = "codex") {
    this.command = command;
  }

  isAlive(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed && !this.closed);
  }

  async ensureReady(): Promise<ChildProcessWithoutNullStreams> {
    if (this.closed) throw new Error("external app-server client closed");
    if (this.readyPromise && this.isAlive()) return this.readyPromise;
    this.readyPromise = this.startProcess();
    try {
      return await this.readyPromise;
    } catch (err) {
      this.readyPromise = null;
      throw err;
    }
  }

  private async startProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (!this.workDir) {
      this.workDir = mkdtempSync(join(tmpdir(), "omb-ext-app-"));
    }
    const child = spawn(this.command, appServerArgs(), {
      cwd: this.workDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdin.on("error", () => {});

    const failAll = (reason: string) => {
      for (const p of this.pendingRpc.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
      }
      this.pendingRpc.clear();
      for (const t of this.activeTurns.values()) {
        clearTimeout(t.timer);
        t.cleanupAbort();
        t.reject(new Error(reason));
      }
      this.activeTurns.clear();
      this.readyPromise = null;
      if (this.child === child) this.child = null;
    };

    child.on("error", (err) => failAll(`external app-server spawn error: ${err.message}`));
    child.on("close", (code, sig) => failAll(`external app-server exited (${code ?? sig ?? "unknown"})`));

    const rl = readline.createInterface({ input: child.stdout });
    this.rl = rl;
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg.id !== undefined && msg.method !== undefined) {
        try {
          child.stdin.write(`${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "External reviewer accepts no client RPC calls" },
          })}\n`);
        } catch {}
        return;
      }

      if (typeof msg.id === "number" && this.pendingRpc.has(msg.id)) {
        const entry = this.pendingRpc.get(msg.id)!;
        this.pendingRpc.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          const errObj = msg.error as { message?: unknown };
          entry.reject(new Error(typeof errObj.message === "string" ? errObj.message : JSON.stringify(msg.error)));
        } else {
          entry.resolve(msg.result);
        }
        return;
      }

      const params = (msg.params ?? {}) as Record<string, unknown>;
      const threadObj = (params.thread ?? {}) as Record<string, unknown>;
      const tid = typeof params.threadId === "string"
        ? params.threadId
        : (typeof threadObj.id === "string" ? threadObj.id : "");
      if (!tid) return;
      const turn = this.activeTurns.get(tid);
      if (!turn) return;

      if (msg.method === "item/agentMessage/delta" && typeof params.delta === "string") {
        turn.deltaText += params.delta;
      } else if (msg.method === "item/completed") {
        const item = (params.item ?? {}) as { type?: unknown; text?: unknown; content?: Array<{ text?: unknown }> };
        if (item.type === "agentMessage" || item.type === "agent_message") {
          const txt = typeof item.text === "string" ? item.text : (typeof item.content?.[0]?.text === "string" ? item.content[0].text : "");
          if (txt.trim()) turn.lastText = txt;
        }
      } else if (msg.method === "thread/tokenUsage/updated") {
        const tokenUsage = (params.tokenUsage ?? {}) as { last?: AppServerTurnUsage };
        const last = tokenUsage.last ?? (params.tokenUsage as AppServerTurnUsage | undefined);
        if (last && typeof last === "object") turn.usage = last;
      } else if (msg.method === "turn/completed") {
        this.activeTurns.delete(tid);
        clearTimeout(turn.timer);
        turn.cleanupAbort();
        const turnInfo = (params.turn ?? {}) as { status?: unknown; error?: { message?: unknown } };
        if (turnInfo.status === "completed") {
          turn.resolve({ text: turn.lastText || turn.deltaText, usage: turn.usage });
        } else {
          const errMsg = typeof turnInfo.error?.message === "string"
            ? turnInfo.error.message
            : `external reviewer turn ended with status ${String(turnInfo.status ?? "unknown")}`;
          turn.reject(new Error(errMsg));
        }
      }
    });

    await this.request("initialize", {
      clientInfo: { name: "openmausbot-external-reviewer", version: "2" },
      capabilities: { experimentalApi: true },
    }, RPC_TIMEOUT_MS, child);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    return child;
  }

  request(method: string, params: unknown, timeoutMs = RPC_TIMEOUT_MS, explicitChild: ChildProcessWithoutNullStreams | null = null): Promise<unknown> {
    const child = explicitChild || this.child;
    if (!child || child.exitCode !== null || child.killed) {
      return Promise.reject(new Error("external app-server process not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRpc.delete(id)) reject(new Error(`app-server RPC timeout: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRpc.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRpc.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async startThread(opts: AppServerStartThreadOptions): Promise<string> {
    await this.ensureReady();
    const preferBase = opts.useBaseInstructions !== false && !this.baseInstructionsUnsupportedModels.has(opts.model);
    const buildParams = (useBase: boolean) => ({
      model: opts.model,
      cwd: opts.cwd || this.workDir || tmpdir(),
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      ephemeral: true,
      environments: [],
      ...(opts.instructions ? (useBase ? { baseInstructions: opts.instructions } : { developerInstructions: opts.instructions }) : {}),
    });

    let res: unknown;
    try {
      res = await this.request("thread/start", buildParams(preferBase));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (preferBase && opts.instructions && /base.?instructions|unsupported|invalid.*instruction/i.test(msg)) {
        this.baseInstructionsUnsupportedModels.add(opts.model);
        res = await this.request("thread/start", buildParams(false));
      } else {
        throw err;
      }
    }
    const tid = (res as { thread?: { id?: unknown } })?.thread?.id;
    if (typeof tid !== "string" || !tid) throw new Error("app-server thread/start returned no thread id");
    return tid;
  }

  async runTurn(threadId: string, promptText: string, opts: AppServerRunTurnOptions = {}): Promise<AppServerTurnResult> {
    const signal = opts.signal ?? null;
    if (signal?.aborted) throw new Error("external review aborted");
    await this.ensureReady();
    if (this.activeTurns.has(threadId)) throw new Error(`concurrent turn on same thread ${threadId}`);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

    const turnPromise = new Promise<AppServerTurnResult>((resolve, reject) => {
      let onAbort: (() => void) | null = null;
      const cleanupAbort = () => {
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
          onAbort = null;
        }
      };
      const timer = setTimeout(() => {
        if (this.activeTurns.delete(threadId)) {
          cleanupAbort();
          void this.request("turn/interrupt", { threadId }).catch(() => {});
          reject(new Error("external reviewer timed out"));
        }
      }, timeoutMs);
      timer.unref?.();
      onAbort = () => {
        if (this.activeTurns.delete(threadId)) {
          clearTimeout(timer);
          cleanupAbort();
          void this.request("turn/interrupt", { threadId }).catch(() => {});
          reject(new Error("external review aborted"));
        }
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.activeTurns.set(threadId, { resolve, reject, timer, cleanupAbort, lastText: "", deltaText: "", usage: null });
    });

    try {
      await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: promptText }],
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
      });
    } catch (err) {
      const t = this.activeTurns.get(threadId);
      if (t) {
        clearTimeout(t.timer);
        t.cleanupAbort();
        this.activeTurns.delete(threadId);
      }
      throw err;
    }
    return turnPromise;
  }

  async unsubscribe(threadId: string): Promise<void> {
    if (!threadId || !this.isAlive()) return;
    try {
      await this.request("thread/unsubscribe", { threadId }, 3_000);
    } catch {}
  }

  close(): void {
    this.closed = true;
    try { this.rl?.close(); } catch {}
    this.rl = null;
    const c = this.child;
    this.child = null;
    this.readyPromise = null;
    if (c && c.exitCode === null && !c.killed) {
      try { c.kill("SIGTERM"); } catch {}
      const kt = setTimeout(() => {
        try { if (c.exitCode === null) c.kill("SIGKILL"); } catch {}
      }, 800);
      kt.unref?.();
    }
    if (this.workDir) {
      const dir = this.workDir;
      this.workDir = null;
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }
}

const clientsByCommand = new Map<string, CodexExternalAppServerClient>();
let hooksRegistered = false;

export function shutdownExternalAppServerClients(): void {
  for (const client of clientsByCommand.values()) client.close();
  clientsByCommand.clear();
}

export function getExternalAppServerClient(command = "codex"): CodexExternalAppServerClient {
  if (!hooksRegistered) {
    hooksRegistered = true;
    const cleanup = () => shutdownExternalAppServerClients();
    process.once("exit", cleanup);
    process.once("SIGTERM", cleanup);
    process.once("SIGINT", cleanup);
  }
  const existing = clientsByCommand.get(command);
  if (existing && !existing.closed) return existing;
  const created = new CodexExternalAppServerClient(command);
  clientsByCommand.set(command, created);
  return created;
}

export function prewarmExternalAppServer(command = "codex"): void {
  try {
    const client = getExternalAppServerClient(command);
    if (client.isAlive() || client.readyPromise) return;
    void client.ensureReady().catch(() => {});
  } catch {}
}

export const MAX_CONSECUTIVE_DENIALS_PER_TURN = 3;
export const MAX_RECENT_DENIALS_PER_TURN = 10;
export const AUTO_REVIEW_DENIAL_WINDOW_SIZE = 50;

export const GUARDIAN_FOLLOWUP_REVIEW_REMINDER =
  "Use prior reviews as context, not binding precedent. " +
  "Follow the Security Policy. " +
  'If the user explicitly approves a previously rejected action after being informed of the concrete risks, set outcome to "allow" and user_authorization to "high" unless the policy explicitly disallows user overrides in such cases.';

export const GUARDIAN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    risk_level: { type: "string", enum: ["low", "medium", "high", "critical"] },
    user_authorization: { type: "string", enum: ["unknown", "low", "medium", "high"] },
    outcome: { type: "string", enum: ["allow", "deny"] },
    rationale: { type: "string" },
  },
  required: ["risk_level", "user_authorization", "outcome", "rationale"],
} as const;

export class GuardianRejectionCircuitBreaker {
  readonly turns = new Map<string, { consecutiveDenials: number; recentDenials: boolean[]; interruptTriggered: boolean }>();

  clearTurn(turnKey: string): void {
    this.turns.delete(turnKey);
  }

  private entry(turnKey: string) {
    let st = this.turns.get(turnKey);
    if (!st) {
      st = { consecutiveDenials: 0, recentDenials: [], interruptTriggered: false };
      this.turns.set(turnKey, st);
    }
    return st;
  }

  recordDenial(turnKey: string): { tripped: boolean; consecutiveDenials: number; recentDenials: number } {
    const st = this.entry(turnKey);
    st.consecutiveDenials += 1;
    st.recentDenials.push(true);
    if (st.recentDenials.length > AUTO_REVIEW_DENIAL_WINDOW_SIZE) st.recentDenials.shift();
    const recentDenials = st.recentDenials.filter(Boolean).length;
    if (!st.interruptTriggered && (st.consecutiveDenials >= MAX_CONSECUTIVE_DENIALS_PER_TURN || recentDenials >= MAX_RECENT_DENIALS_PER_TURN)) {
      st.interruptTriggered = true;
      return { tripped: true, consecutiveDenials: st.consecutiveDenials, recentDenials };
    }
    return { tripped: false, consecutiveDenials: st.consecutiveDenials, recentDenials };
  }

  recordNonDenial(turnKey: string): void {
    const st = this.entry(turnKey);
    st.consecutiveDenials = 0;
    st.recentDenials.push(false);
    if (st.recentDenials.length > AUTO_REVIEW_DENIAL_WINDOW_SIZE) st.recentDenials.shift();
  }
}

export function parseGuardianAssessment(rawText: string):
  | { ok: true; outcome: "allow" | "deny"; decision: "approve" | "ask" | "deny"; riskLevel: "low" | "medium" | "high" | "critical"; userAuthorization: "unknown" | "low" | "medium" | "high"; rationale: string }
  | { ok: false; reason: string } {
  const text = String(rawText ?? "").trim();
  if (!text) return { ok: false, reason: "empty reviewer output" };
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { obj = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>; } catch {}
    }
  }
  if (!obj || typeof obj !== "object") return { ok: false, reason: "invalid JSON from reviewer" };

  const rawDecision = typeof obj.decision === "string" ? obj.decision.trim().toLowerCase() : "";
  const rawOutcome = typeof obj.outcome === "string" ? obj.outcome.trim().toLowerCase() : rawDecision;
  let outcome: "allow" | "deny";
  let decision: "approve" | "ask" | "deny";
  if (rawOutcome === "allow" || rawOutcome === "approve") {
    outcome = "allow";
    decision = "approve";
  } else if (rawOutcome === "deny" || rawOutcome === "ask" || rawOutcome === "reject") {
    outcome = "deny";
    decision = rawOutcome === "ask" ? "ask" : "deny";
  } else {
    return { ok: false, reason: "invalid outcome/decision field" };
  }

  const rawRisk = typeof obj.risk_level === "string"
    ? obj.risk_level.trim().toLowerCase()
    : (typeof obj.risk === "string" ? obj.risk.trim().toLowerCase() : "");
  if (!["low", "medium", "high", "critical"].includes(rawRisk)) {
    return { ok: false, reason: "invalid risk_level/risk field" };
  }
  const riskLevel = rawRisk as "low" | "medium" | "high" | "critical";

  const rawAuth = typeof obj.user_authorization === "string" ? obj.user_authorization.trim().toLowerCase() : "";
  const userAuthorization = (["unknown", "low", "medium", "high"].includes(rawAuth) ? rawAuth : "unknown") as "unknown" | "low" | "medium" | "high";
  const rawReason = typeof obj.rationale === "string"
    ? obj.rationale
    : (typeof obj.reason === "string" ? obj.reason : "");
  const rationale = rawReason.trim().slice(0, 120) || (outcome === "allow" ? "Auto-review allowed the action." : "Auto-review denied the action.");
  return { ok: true, outcome, decision, riskLevel, userAuthorization, rationale };
}

