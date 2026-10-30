import { killCliTree, spawnCli } from "./procs.ts";
import { scrubHeldSecrets } from "../shared/redact.ts";
import { DEFAULT_BROWSER_RESULT_BUDGET, describePageChange, OBSERVE_PAGE_SCRIPT, parsePageState, READ_OPEN_PAGE_ONLY, readsAroundBrowser, scrubBrowserResult, shapeBrowserToolResult, slimBrowserToolList, stripHarnessOwnedArguments, type PageState } from "./browser-tool-shape.ts";
import { BrowserLanes } from "./browser-lane.ts";
import { PageSizes, type PageSize } from "./browser-page-size.ts";
import { SECRET_ON_PAGE, SecretHolds, type SecretHold } from "./browser-secret-hold.ts";
import type { BrowserSteps, StepCall, StepContext } from "./browser-steps.ts";
import { HARNESS_CALL_BUDGET_MS } from "./harness-budget.ts";

export interface BrowserSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

export const BROWSER_CONTROL_REFUSAL = "Browser tools are paused while a person controls this browser. Wait for them to hand control back; do not try another browser or execution tool.";
export const BROWSER_RESTART_TOOL = "restart_browser";
const BROWSER_RESTART_TOOL_SPEC = {
  name: BROWSER_RESTART_TOOL,
  description: "Close and restart your browser. Use this only when a browser tool says the browser must be restarted, or it stays busy after a call that did not answer. Every open tab is closed and unsaved page state such as form input is lost; sign-ins stay unless it is a temporary browser. Afterwards open the page you need again and check whether the interrupted action already happened before repeating it.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
export const BROWSER_UPLOAD_TOOL = "agent_browser_upload";
export const BROWSER_HOVER_TOOL = "agent_browser_hover";
/** agent-browser 0.37.0 offers upload and hover only in its 156-tool "all" profile, so OMB runs these two through the daemon's relay. */
const RELAYED_TOOL_SPECS = [
  {
    name: BROWSER_UPLOAD_TOOL,
    description: "Put files into a file input (<input type=\"file\">), then submit its form as usual. files are absolute paths of files the person attached to this conversation or files in your own working folder; any other path is refused.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["selector", "files"],
      properties: {
        selector: { type: "string", minLength: 1, description: "The file input: an @eN ref from a snapshot, or a CSS selector." },
        files: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1 }, description: "Absolute paths of the files to put in the input." },
      },
    },
  },
  {
    name: BROWSER_HOVER_TOOL,
    description: "Move the mouse over an element, for menus and tooltips that open on hover.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["selector"],
      properties: { selector: { type: "string", minLength: 1, description: "An @eN ref from a snapshot, or a CSS selector." } },
    },
  },
];
type RelayedToolSpec = (typeof RELAYED_TOOL_SPECS)[number];
const RELAYED_TOOLS: ReadonlyMap<string, RelayedToolSpec> = new Map(RELAYED_TOOL_SPECS.map((spec) => [spec.name, spec]));
const BROWSER_INTERRUPTED = `The browser engine is stuck. Press Restart in the Browser panel, or call ${BROWSER_RESTART_TOOL}, before using browser tools again.`;
const idleClosedNote = (saves: boolean) => `Your browser sat unused and was closed to free memory; this call opened it again. Pages you had open are gone (${saves ? "saved sign-ins are kept" : "it is a temporary browser, so its sign-ins are gone too"}), so open the page you need again before using earlier @eN refs.`;
const PERSON_RESTARTED = "The person restarted your browser from the Browser panel; this call ran in the fresh browser. Pages you had open are gone, so open the page you need again before using earlier @eN refs, and check whether an interrupted action already happened before repeating it.";
const LANE_BUSY = "Your previous browser call is still running; wait for it to finish, then call again.";
/** One bot call, lane wait included, answers within `callBudgetMs`; the engine's action keeps `followUpReserveMs` of it for the reads after. */
export const BROWSER_CALL_DEFAULTS = { requestTimeoutMs: 120_000, laneWaitMs: 30_000, callBudgetMs: HARNESS_CALL_BUDGET_MS, followUpReserveMs: 15_000 } as const;
const RESTART_COST = "a restart closes every tab and loses page state such as form input";
const LATE = Symbol("late");
const PAGE_ACTIONS: ReadonlySet<string> = new Set([
  "agent_browser_click", "agent_browser_fill", "agent_browser_type", "agent_browser_press",
  "agent_browser_check", "agent_browser_uncheck", "agent_browser_select", BROWSER_UPLOAD_TOOL, BROWSER_HOVER_TOOL,
]);
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 16_777_216;
const HANDSHAKE_TIMEOUT_MS = 1_000;
const HOST_ENV = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATH", "Path", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"];

/** One env for MCP, viewer and cleanup so they share HOME/socket paths: OS plumbing, never provider credentials. */
export function browserRuntimeEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(HOST_ENV.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  return { ...env, ...overrides };
}

export function attachesToChrome(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.AGENT_BROWSER_CDP || env.AGENT_BROWSER_AUTO_CONNECT);
}

export function ownsBrowserViewport(env: NodeJS.ProcessEnv): boolean {
  return env.AGENT_BROWSER_HEADLESS === "1" && !attachesToChrome(env);
}

export class TransportError extends Error {}

/** One timed browser action (ms), logged with OMB_BROWSER_TIMING=1; `inFlight` is this session's work already running. */
export interface BrowserTiming {
  session: string;
  tool: string;
  outcome: "ok" | "error";
  totalMs: number;
  launchMs?: number;
  engineMs?: number;
  observeMs?: number;
  stepsMs?: number;
  chars?: number;
  inFlight: number;
}

export function formatBrowserTiming(timing: BrowserTiming): string {
  const parts = [`browser timing: ${timing.tool} ${timing.outcome}`];
  const phases: Array<[string, number | undefined]> = [
    ["total", timing.totalMs], ["launch", timing.launchMs], ["engine", timing.engineMs], ["observe", timing.observeMs], ["steps", timing.stepsMs],
  ];
  for (const [label, value] of phases) {
    if (value !== undefined) parts.push(`${label}=${Math.round(value)}ms`);
  }
  if (timing.chars !== undefined) parts.push(`chars=${timing.chars}`);
  parts.push(`inflight=${timing.inFlight}`, `session=${timing.session}`);
  return parts.join(" ");
}

function resultChars(result: unknown): number {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const item of content) {
    const text = (item as { text?: unknown } | null)?.text;
    if (typeof text === "string") chars += text.length;
  }
  return chars;
}

/** The engine answered with a failure (marked `settled: true`): nothing is left running, so no restart is needed. */
export function isSettledBrowserFailure(error: unknown): boolean {
  return (error as { settled?: unknown } | null)?.settled === true;
}
type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** Neither the child's stderr nor its environment is ever returned to the agent. */
class BrowserClient {
  readonly child: ReturnType<typeof spawnCli>;
  readonly ready: Promise<void>;
  private pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private stopped = false;
  private idleTimer?: NodeJS.Timeout;
  private stoppedPromise?: Promise<void>;
  private requestTimeoutMs: number;
  private idleMs: number;
  private maxPending: number;
  private onClose: () => void;
  private onRequestTimeout: (params: unknown) => void;

  constructor(
    spec: BrowserSpawnSpec,
    requestTimeoutMs: number,
    idleMs: number,
    maxPending: number,
    onClose: () => void,
    onRequestTimeout: (params: unknown) => void,
  ) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.idleMs = idleMs;
    this.maxPending = maxPending;
    this.onClose = onClose;
    this.onRequestTimeout = onRequestTimeout;
    this.child = spawnCli(spec.command, spec.args, {
      env: browserRuntimeEnv(spec.env), stdio: ["pipe", "pipe", "pipe"], shell: false,
    });
    this.child.stderr.resume();
    this.child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    this.child.stdin.on("error", () => { void this.stop(new TransportError("Browser connection closed.")); });
    this.child.on("error", () => { void this.stop(new TransportError("Could not start the browser engine.")); });
    this.child.on("close", () => { void this.stop(new TransportError("Browser connection closed.")); });
    this.ready = this.rpc("initialize", {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "openmausbot-browser", version: "1" },
    }, Math.max(this.requestTimeoutMs, HANDSHAKE_TIMEOUT_MS)).then((result) => {
      if (!result || typeof result !== "object" || !("protocolVersion" in result)) {
        throw new TransportError("Browser engine returned an invalid handshake.");
      }
      this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    }).catch((error: unknown) => {
      void this.stop(error instanceof Error ? error : new TransportError("Browser handshake failed."));
      throw error;
    });
  }

  private read(chunk: Buffer): void {
    if (this.stopped) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) !== -1) {
      if (newline > MAX_RESPONSE_BYTES) {
        void this.stop(new TransportError("Browser response exceeded the size limit."));
        return;
      }
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.trim()) continue;
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
      } catch {
        void this.stop(new TransportError("Browser engine returned invalid JSON."));
        return;
      }
      const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!pending) continue;
      this.pending.delete(message.id!);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "Browser request failed."));
      else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
      else pending.reject(new TransportError("Browser response has no result."));
      this.armIdle();
    }
    if (this.buffer.length > MAX_RESPONSE_BYTES) {
      void this.stop(new TransportError("Browser response exceeded the size limit."));
    }
  }

  private write(message: unknown): void {
    if (this.stopped) throw new TransportError("Browser connection closed.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) void this.stop(new TransportError("Browser connection closed."));
    });
  }

  rpc(method: string, params: unknown, timeoutMs: number = this.requestTimeoutMs): Promise<unknown> {
    if (this.stopped) return Promise.reject(new TransportError("Browser connection closed."));
    if (this.pending.size >= this.maxPending) return Promise.reject(new Error("Too many pending browser requests. Try again when the current action finishes."));
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_REQUEST_BYTES) return Promise.reject(new Error("Browser request exceeded the size limit."));
    if (this.idleTimer) clearTimeout(this.idleTimer);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Seal the gate synchronously, before stop(): the rejection can surface through the ready handshake, outside agentRpc's classifier.
        this.onRequestTimeout(params);
        void this.stop(new TransportError("Browser request timed out; restart the browser before taking control."));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write(message); }
      catch { void this.stop(new TransportError("Browser connection closed.")); }
    });
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.stopped && this.pending.size === 0) {
      this.idleTimer = setTimeout(() => { void this.stop(undefined, "transport"); }, this.idleMs);
      this.idleTimer.unref();
    }
  }

  /** agent-browser's MCP loop exits on stdin EOF and leaves the daemon; Windows taskkill /T would kill that profile's Chrome too. */
  private retireTransport(): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.child.off("exit", finish);
        resolve();
      };
      const timer = setTimeout(() => {
        try { this.child.kill("SIGKILL"); } catch {}
        finish();
      }, 1_000);
      this.child.once("exit", finish);
      if (this.child.exitCode !== null || this.child.signalCode !== null) finish();
      else this.child.stdin.end();
    });
  }

  stop(error = new TransportError("Browser connection closed."), scope: "transport" | "tree" = "tree"): Promise<void> {
    if (this.stoppedPromise) return this.stoppedPromise;
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onClose();
    this.stoppedPromise = scope === "transport" ? this.retireTransport() : killCliTree(this.child, 1_000).then((stopped) => {
      if (stopped) return;
      try {
        if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, "SIGKILL");
        else this.child.kill("SIGKILL");
      } catch {}
    });
    return this.stoppedPromise;
  }
}

export type ApplyViewport = (spec: BrowserSpawnSpec, size: PageSize) => Promise<unknown>;

type LaunchSpec = { command: string; env?: Record<string, string | undefined> };
/** The browser the engine starts, prepared by OMB. */
export interface BrowserLaunch {
  /** Before the engine may start the browser; rejects with a message for the bot while it cannot start yet. */
  ready(spec: LaunchSpec): Promise<void>;
  /** Once the engine runs the browser, again after every start. */
  started(session: string, spec: LaunchSpec): Promise<void>;
  stopped(session: string): void;
}

interface Gate {
  owner: string | null;
  ready: boolean;
  releasing: boolean;
  agents: number;
  /** Of `agents`, reads that only check whether a lost call ended. */
  probes: number;
  dispatched: number;
  humans: number;
  uncertain: boolean;
  /** Null when a person left the uncertainty behind: only a restart clears that. */
  lostCall: string | null;
  closing: boolean;
  changed: Set<() => void>;
  watchers: number;
  calls: number;
  lastUsed: number;
  spec?: BrowserSpawnSpec;
  /** An idle close in progress: agent calls and new views wait for it. */
  idleClose?: Promise<void>;
  /** Closed since the bot's last call: its next answer says why its pages are gone. */
  reopened: "idle" | "restart" | null;
}

type ClientEntry = { key: string; client: BrowserClient };

/** Closes one session's native browser daemon; true only when it is gone. */
export type CloseBrowser = (session: string, spec: BrowserSpawnSpec) => Promise<boolean>;
/** Sends one command to the session's running agent-browser daemon. Throws TransportError when it does not answer in time. */
export type RelayCommand = (spec: BrowserSpawnSpec, session: string, command: Record<string, unknown>, timeoutMs: number) =>
  Promise<{ success: boolean; data: Record<string, unknown> | null; error?: string }>;

export class BrowserRuntime {
  private gates = new Map<string, Gate>();
  private clients = new Map<string, ClientEntry>();
  private recoveries = new Map<string, Promise<string | null>>();
  private toolLists = new Map<string, unknown>();
  private idleCloseListeners = new Set<(session: string) => void>();
  private options: { requestTimeoutMs: number; takeoverTimeoutMs: number; idleMs: number; maxPending: number; resultBudget: number; recoveryCheckMs: number; laneWaitMs: number; callBudgetMs: number; followUpReserveMs: number };
  private closeBrowser: CloseBrowser;
  private applyViewport?: ApplyViewport;
  private launch?: BrowserLaunch;
  private relayCommand?: RelayCommand;
  private steps?: Pick<BrowserSteps, "before" | "after" | "signIn" | "note" | "forget" | "recentFrame" | "personTook">;
  private lanes = new BrowserLanes();
  /** The page size people's views want; the agent-browser live view sets it, and every bot call applies it first. */
  readonly pageSizes = new PageSizes({
    apply: (session, size) => { const spec = this.gates.get(session)?.spec; return spec && this.applyViewport ? this.applyViewport(spec, size) : Promise.resolve(); },
    lane: (session, work) => this.lanes.run(session, work, this.options.laneWaitMs),
    watched: (session) => { const gate = this.gates.get(session); return Boolean(gate && gate.watchers > 0 && !gate.closing); },
  });
  private holds = new SecretHolds((session, clear) => this.lanes.run(session, () => this.agentAction(session, clear, false), this.options.laneWaitMs).then((ran) => ran !== null));
  /** Strips held secrets (a filled password, a one-time code) from every tool result before the bot reads it. */
  private scrub: (text: string) => string;
  private onTiming?: (timing: BrowserTiming) => void;

  constructor({ closeBrowser, applyViewport, launch, relayCommand, steps, scrub, onTiming, ...options }: Partial<BrowserRuntime["options"]> & { closeBrowser?: CloseBrowser; applyViewport?: ApplyViewport; launch?: BrowserLaunch; relayCommand?: RelayCommand; steps?: BrowserRuntime["steps"]; scrub?: (text: string) => string; onTiming?: (timing: BrowserTiming) => void } = {}) {
    this.options = { ...BROWSER_CALL_DEFAULTS, takeoverTimeoutMs: 15_000, idleMs: 60_000, maxPending: 16, resultBudget: DEFAULT_BROWSER_RESULT_BUDGET, recoveryCheckMs: 30_000, ...options };
    this.closeBrowser = closeBrowser ?? (async () => false);
    this.applyViewport = applyViewport;
    this.launch = launch;
    this.relayCommand = relayCommand;
    this.steps = steps;
    this.scrub = scrub ?? scrubHeldSecrets;
    this.onTiming = onTiming;
  }

  private timed<T>(session: string, tool: string, phases: Partial<BrowserTiming>, fn: () => Promise<T>): Promise<T> {
    if (!this.onTiming) return fn();
    const onTiming = this.onTiming;
    const started = performance.now();
    const inFlight = this.gate(session).agents;
    const report = (outcome: BrowserTiming["outcome"]) => onTiming({ session, tool, outcome, totalMs: performance.now() - started, ...phases, inFlight });
    return fn().then((result) => {
      report((result as { isError?: unknown } | null)?.isError === true ? "error" : "ok");
      return result;
    }, (error: unknown) => {
      report("error");
      throw error;
    });
  }

  private gate(session: string): Gate {
    let gate = this.gates.get(session);
    if (!gate) {
      gate = { owner: null, ready: false, releasing: false, agents: 0, probes: 0, dispatched: 0, humans: 0, uncertain: false, lostCall: null, closing: false, changed: new Set(), watchers: 0, calls: 0, lastUsed: Date.now(), reopened: null };
      this.gates.set(session, gate);
    }
    return gate;
  }

  private changed(gate: Gate): void {
    if (gate.releasing && gate.humans === 0) {
      gate.owner = null;
      gate.releasing = false;
      gate.ready = false;
    }
    for (const notify of gate.changed) notify();
  }

  async withAgentAction<T>(session: string, fn: () => Promise<T>): Promise<T> {
    return this.agentAction(session, fn, true);
  }

  /** `use`: a bot's own action restarts idle time; a preview frame holds off an idle close but never keeps the browser open. */
  private async agentAction<T>(session: string, fn: () => Promise<T>, use: boolean): Promise<T> {
    const gate = this.gate(session);
    if (gate.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
    if (gate.uncertain) throw new Error(BROWSER_INTERRUPTED);
    if (gate.closing) throw new Error("The browser is closing. Try again shortly.");
    gate.agents++;
    try {
      const result = await fn();
      if (gate.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
      return result;
    } finally {
      gate.agents--;
      if (use) gate.lastUsed = Date.now();
      this.changed(gate);
    }
  }

  /** Runs in the browser's lane, so no capture or read happens while a secret is typed. */
  async withSecretInput<T extends { ok: boolean; text: string; host?: string; filled?: string[]; held?: SecretHold }>(session: string, spec: Pick<BrowserSpawnSpec, "command" | "env">, fn: () => Promise<T>, ctx?: StepContext): Promise<T> {
    const outcome = await this.lanes.run(session, async () => {
      const value = await this.withAgentAction(session, async () => {
        const filled = await fn();
        if (filled.held) this.holds.hold(session, filled.held);
        return filled;
      });
      const step = await this.steps?.signIn({ session, spec, ctx }, value).catch(() => null);
      return step ? { ...value, text: `${value.text} Recorded as step ${step}.` } : value;
    }, this.options.laneWaitMs);
    if (outcome === null) throw new Error(LANE_BUSY);
    return outcome;
  }

  /** agent-browser runs one command at a time, and a frame behind a stuck action stays queued past its own timeout (0.37.0:
   * 27 frames during a 120 s stuck click kept it busy two more minutes), so frames are skipped while an action runs. */
  async previewFrame<T>(session: string, capture: () => Promise<T>): Promise<T> {
    if (this.gate(session).agents > 0 || this.lanes.held(session)) throw new Error("The browser is busy with an agent action.");
    const phases: Partial<BrowserTiming> = {};
    return this.timed(session, "preview_frame", phases, () => this.agentAction(session, async () => {
      const frame = (this.steps?.recentFrame(session) as T | null | undefined) ?? await capture();
      const png = (frame as { png?: unknown } | null)?.png;
      if (typeof png === "string") phases.chars = png.length;
      return frame;
    }, false));
  }

  /** Every tool result, recovery notes included, is scrubbed of held secrets. */
  async agentRpc(session: string, spec: BrowserSpawnSpec, method: "tools/list" | "tools/call", params: unknown, beforeDispatch?: () => void, ctx?: StepContext): Promise<unknown> {
    if (method === "tools/call" && readsAroundBrowser(params)) return { isError: true, content: [{ type: "text", text: READ_OPEN_PAGE_ONLY }] };
    // Counted in the same event-loop turn, so no idle close can start under a call.
    for (let closing = this.gates.get(session)?.idleClose; closing; closing = this.gates.get(session)?.idleClose) await closing;
    const gate = this.gate(session);
    gate.spec = spec;
    gate.calls++;
    const deadline = Date.now() + this.options.callBudgetMs;
    let result: unknown;
    try {
      const request = () => this.agentRequest(session, spec, method, params, deadline, beforeDispatch, ctx);
      const work = method !== "tools/call" || toolNameOf(params) === BROWSER_RESTART_TOOL || gate.uncertain ? request() : this.lanes.run(session, request, this.options.laneWaitMs);
      result = await this.withinBudget(session, method, toolNameOf(params) ?? "browser", work, deadline);
    } finally { gate.calls--; gate.lastUsed = Date.now(); }
    if (method !== "tools/call") return result;
    if (result === null || result === undefined) return scrubBrowserResult({ isError: true, content: [{ type: "text", text: LANE_BUSY }] }, this.scrub);
    if (!gate.reopened) return scrubBrowserResult(result, this.scrub);
    const note = gate.reopened === "restart" ? PERSON_RESTARTED : idleClosedNote(spec.env.AGENT_BROWSER_RESTORE_SAVE !== "never");
    gate.reopened = null;
    const content = (result as { content?: unknown } | null)?.content;
    return scrubBrowserResult({ ...result as object, content: [{ type: "text", text: note }, ...Array.isArray(content) ? content : []] }, this.scrub);
  }

  /** Work that outlasts the budget goes on, so its outcome is unknown: the call counts as lost until the engine answers again. */
  private async withinBudget(session: string, method: "tools/list" | "tools/call", call: string, work: Promise<unknown>, deadline: number): Promise<unknown> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<typeof LATE>((resolve) => { timer = setTimeout(() => resolve(LATE), Math.max(0, deadline - Date.now())); timer.unref(); });
    let outcome: unknown;
    try { outcome = await Promise.race([work, late]); } finally { clearTimeout(timer); }
    if (outcome !== LATE) return outcome;
    if (method !== "tools/call") throw new TransportError("The browser did not answer in time.");
    this.latchLostCall(session, call);
    return this.gate(session).lostCall === null ? stuckBrowserToolError() : lostCallToolError(call);
  }

  private async agentRequest(session: string, spec: BrowserSpawnSpec, method: "tools/list" | "tools/call", params: unknown, deadline: number, beforeDispatch?: () => void, ctx?: StepContext): Promise<unknown> {
    if (method !== "tools/list" && method !== "tools/call") throw new Error("Unsupported browser method.");
    // tools/list skips withAgentAction, so it must refuse the closing window itself or its client outlives restart().
    if (method !== "tools/call" && this.gate(session).closing) throw new Error("The browser is closing. Try again shortly.");
    if (method === "tools/call" && params && typeof params === "object" && (params as { name?: unknown }).name === BROWSER_RESTART_TOOL) {
      beforeDispatch?.();
      await this.agentRestart(session, () => this.closeBrowser(session, spec));
      await this.steps?.note(ctx, { tool: BROWSER_RESTART_TOOL, ok: true });
      beforeDispatch?.();
      return { content: [{ type: "text", text: "Browser restarted. Open pages were closed; open the page you need again and check whether the interrupted action already happened before repeating it." }] };
    }
    // Uncertainty survives client replacement: nothing new reaches the engine until it is resolved.
    const toolName = toolNameOf(params);
    const gate = this.gate(session);
    if (gate.uncertain) {
      if (method === "tools/list") return withOmbTools(this.toolLists.get(session) ?? { tools: [] });
      if (gate.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
      const lostCall = gate.lostCall;
      if (lostCall === null) return stuckBrowserToolError();
      beforeDispatch?.();
      const url = await this.recoverAfterLoss(session, spec);
      beforeDispatch?.();
      if (gate.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
      return url === null ? stillBusyToolError(lostCall) : recoveredResult(lostCall, url);
    }
    const followUpMs = () => Math.min(this.options.requestTimeoutMs, deadline - Date.now());
    const phases: Partial<BrowserTiming> = {};
    const invoke = async () => {
      const launchStarted = performance.now();
      let dispatched = false;
      if (method === "tools/call") await this.launchReady(spec);
      const entry = this.connect(session, spec);
      await entry.client.ready;
      beforeDispatch?.();
      if (method === "tools/call" && this.gate(session).owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
      if (method === "tools/call" && await this.pageSizes.beforeCall(session)) {
        beforeDispatch?.();
        if (this.gate(session).owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
      }
      if (method === "tools/call" && this.launch && toolName !== "agent_browser_close") {
        await this.launched(session, spec);
        beforeDispatch?.();
        if (this.gate(session).owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
      }
      phases.launchMs = performance.now() - launchStarted;
      try {
        const pageUrl = () => entry.client.rpc("tools/call", { name: "agent_browser_get_url", arguments: {} }, Math.max(1, Math.min(followUpMs(), 5_000)))
          .then((result) => firstText(result).trim(), (error: unknown) => { if (error instanceof TransportError) throw error; return ""; });
        if (toolName === "agent_browser_eval" && await this.holds.refuses(session, pageUrl)) return { isError: true, content: [{ type: "text", text: SECRET_ON_PAGE }] };
        // Launch and session parameters OMB owns never reach the engine from a call.
        const request = method === "tools/call" ? this.pageSizes.callArguments(session, stripHarnessOwnedArguments(params)) : params;
        const args = (request as { arguments?: unknown } | null)?.arguments;
        const call: StepCall | null = this.steps && method === "tools/call" && toolName !== undefined ? {
          session, spec, tool: toolName, args: args && typeof args === "object" ? args as Record<string, unknown> : {}, ctx,
          stopped: () => gate.owner !== null || gate.uncertain || gate.closing,
          alive: () => { try { beforeDispatch?.(); return true; } catch { return false; } },
          resize: () => this.pageSizes.again(session),
        } : null;
        const stepsStarted = performance.now();
        const stepState = call ? await this.steps!.before(call) : null;
        phases.stepsMs = performance.now() - stepsStarted;
        // Read with eval, not a snapshot: agent-browser's snapshot renumbers every @eN ref the model holds.
        const observePage = async (): Promise<PageState | null> => {
          if (followUpMs() <= 0) return null;
          const observeStarted = performance.now();
          try {
            return parsePageState(await entry.client.rpc("tools/call", {
              name: "agent_browser_eval", arguments: { script: OBSERVE_PAGE_SCRIPT, timeoutMs: 5_000 },
            }, followUpMs()));
          } catch (error) {
            if (error instanceof TransportError) throw error;
            return null;
          } finally {
            phases.observeMs = (phases.observeMs ?? 0) + performance.now() - observeStarted;
          }
        };
        let before: PageState | null = null;
        if (method === "tools/call" && toolName !== undefined && PAGE_ACTIONS.has(toolName)) {
          before = await observePage();
          beforeDispatch?.();
          if (this.gate(session).owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
        }
        const engineStarted = performance.now();
        if (method === "tools/call") { dispatched = true; gate.dispatched++; }
        const engineTimeoutMs = Math.max(1, Math.min(this.options.requestTimeoutMs, deadline - Date.now() - this.options.followUpReserveMs));
        const relayed = method === "tools/call" && toolName !== undefined ? RELAYED_TOOLS.get(toolName) : undefined;
        let result = relayed
          ? await this.relayTool(session, spec, relayed, args, engineTimeoutMs)
          : await entry.client.rpc(method, request, engineTimeoutMs);
        phases.engineMs = performance.now() - engineStarted;
        beforeDispatch?.();
        if (method === "tools/list") {
          const tools = withOmbTools(slimBrowserToolList(result));
          this.toolLists.set(session, tools);
          return tools;
        }
        if (before && result && typeof result === "object" && (result as { isError?: boolean }).isError !== true &&
            this.gate(session).owner === null) {
          const after = await observePage();
          beforeDispatch?.();
          if (after) {
            const action = result as { content?: unknown[] };
            const change = { type: "text", text: describePageChange(before, after) };
            result = { ...action, content: [...(Array.isArray(action.content) ? action.content : []), change] };
          }
        }
        if (toolName === "agent_browser_open" && result && typeof result === "object" &&
            (result as { isError?: boolean }).isError !== true) {
          beforeDispatch?.();
          if (this.gate(session).owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
          let observation: unknown;
          const observeStarted = performance.now();
          try {
            observation = followUpMs() <= 0 ? { isError: true, content: [] } : await entry.client.rpc("tools/call", {
              name: "agent_browser_snapshot", arguments: { compact: true },
            }, followUpMs());
          } catch (error) {
            if (error instanceof TransportError) throw error;
            observation = { isError: true, content: [] };
          } finally {
            phases.observeMs = (phases.observeMs ?? 0) + performance.now() - observeStarted;
          }
          beforeDispatch?.();
          const navigation = result as { content?: unknown[]; structuredContent?: unknown };
          const page = observation as { content?: unknown[]; isError?: boolean } | null;
          const observed = page?.isError !== true && Array.isArray(page?.content) && page.content.some((item) =>
            item && typeof item === "object" && (item as { type?: unknown }).type === "text" &&
            typeof (item as { text?: unknown }).text === "string" && (item as { text: string }).text.trim().length > 0);
          result = {
            content: [
              ...(Array.isArray(navigation.content) ? navigation.content : []),
              { type: "text", text: !observed
                ? "Navigation returned, but page verification failed. Do not claim the requested page loaded and do not blindly repeat navigation."
                : "Page observed after navigation. Its refs are current, so act on them without another snapshot. Check this result for redirects, sign-in requirements or page errors before reporting task success:" },
              ...(Array.isArray(page?.content) ? page.content : []),
            ],
            ...(navigation.structuredContent !== undefined ? { structuredContent: navigation.structuredContent } : {}),
            ...(!observed ? { isError: true } : {}),
          };
        }
        const afterStarted = performance.now();
        const extra = call && stepState ? await this.steps!.after(call, result, stepState, phases.engineMs) : null;
        phases.stepsMs = (phases.stepsMs ?? 0) + performance.now() - afterStarted;
        beforeDispatch?.();
        const shaped = shapeBrowserToolResult(result, { toolName, budget: this.options.resultBudget }) as { content?: unknown[] };
        const final = extra?.parts.length && Array.isArray(shaped?.content) ? { ...shaped, content: [...shaped.content, ...extra.parts] } : shaped;
        phases.chars = resultChars(final);
        return final;
      }
      catch (error) {
        // An MCP timeout cannot prove the daemon stopped an accepted action, so nothing reaches the engine until it answers or a restart.
        if (method === "tools/call" && error instanceof TransportError) {
          this.latchLostCall(session, toolName ?? method);
          if (gate.lostCall !== null && toolName) gate.lostCall = toolName;
        }
        throw error;
      }
      finally { if (dispatched) gate.dispatched--; }
    };
    if (method !== "tools/call") return invoke();
    try {
      return await this.timed(session, toolName ?? "unknown", phases, () => this.withAgentAction(session, invoke));
    } catch (error) {
      if (error instanceof Error && error.message === BROWSER_INTERRUPTED) return stuckBrowserToolError();
      if (error instanceof TransportError && gate.uncertain && gate.lostCall !== null) return lostCallToolError(toolName ?? gate.lostCall);
      throw error;
    }
  }

  private async relayTool(session: string, spec: BrowserSpawnSpec, tool: RelayedToolSpec, args: unknown, timeoutMs: number): Promise<unknown> {
    const action = tool.name.replace("agent_browser_", "");
    const given = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const fields = Object.keys(tool.inputSchema.properties).filter((field) => field in given);
    const command = Object.fromEntries([["action", action], ...fields.map((field) => [field, given[field]])]);
    try {
      if (!this.relayCommand) throw new Error(`This browser cannot ${action} here.`);
      const answer = await this.relayCommand(spec, session, command, timeoutMs);
      if (!answer.success) return { isError: true, content: [{ type: "text", text: answer.error ?? `The browser could not ${action} that element.` }] };
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data: answer.data }) }] };
    } catch (error) {
      if (error instanceof TransportError) throw error;
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  }

  private connect(session: string, spec: BrowserSpawnSpec): ClientEntry {
    const key = JSON.stringify([spec.command, spec.args, Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b))]);
    const existing = this.clients.get(session);
    if (existing && existing.key !== key) throw new Error("Browser launch settings changed. Close the browser before reconnecting.");
    if (existing) return existing;
    const client = new BrowserClient(spec, this.options.requestTimeoutMs, this.options.idleMs, this.options.maxPending, () => {
      if (this.clients.get(session)?.client === client) this.clients.delete(session);
    }, (params) => this.latchLostCall(session, toolNameOf(params) ?? "browser"));
    const entry: ClientEntry = { key, client };
    this.clients.set(session, entry);
    this.pageSizes.forget(session);
    return entry;
  }

  private latchLostCall(session: string, call: string): void {
    const gate = this.gate(session);
    if (gate.closing || gate.uncertain) return;
    gate.uncertain = true;
    gate.lostCall = call;
  }

  /** agent-browser runs one command per session even across connections (0.37.0), so a read that answers proves the lost call
   * ended; it is never replayed. Resolves to the page URL, or null while the engine still does not answer. */
  private recoverAfterLoss(session: string, spec: BrowserSpawnSpec): Promise<string | null> {
    let check = this.recoveries.get(session);
    if (!check) {
      check = this.checkEngine(session, spec).finally(() => this.recoveries.delete(session));
      this.recoveries.set(session, check);
    }
    return check;
  }

  private async checkEngine(session: string, spec: BrowserSpawnSpec): Promise<string | null> {
    const gate = this.gate(session);
    gate.agents++;
    gate.probes++;
    try {
      const { client } = this.connect(session, spec);
      await client.ready;
      const result = await client.rpc("tools/call", { name: "agent_browser_get_url", arguments: {} }, this.options.recoveryCheckMs);
      if (gate.closing || !gate.uncertain || gate.lostCall === null) return null;
      gate.uncertain = false;
      gate.lostCall = null;
      return firstText(result).trim().slice(0, 500);
    } catch {
      return null;
    } finally {
      gate.agents--;
      gate.probes--;
      this.changed(gate);
    }
  }

  /** True when the grant waited for a bot command the engine received: the page may have changed since the person aimed. A bot
   * call that never answered is checked once with the engine: if it answers, that call has ended and the person may take over. */
  async take(session: string, owner: string): Promise<boolean> {
    if (!owner) throw new Error("Browser control requires an owner.");
    const gate = this.gate(session);
    if (gate.closing || gate.releasing) throw new Error("Browser control is changing. Try again shortly.");
    if (gate.owner !== null && gate.owner !== owner) throw new Error("Another person controls this browser.");
    gate.owner = owner; // synchronous: no agent work slips in while draining
    gate.ready = false;
    this.steps?.personTook(session);
    const waited = gate.dispatched > 0;
    const stillRunning = "A browser action may still be running. Restart this browser before taking control.";
    await new Promise<void>((resolve, reject) => {
      let probe: "none" | "running" | "done" = "none";
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        gate.changed.delete(check);
        if (error) reject(error);
        else { gate.ready = true; resolve(); }
      };
      const check = () => {
        if (gate.owner !== owner || gate.releasing || gate.closing) finish(new Error("Browser control request was cancelled."));
        else if (gate.uncertain && probe === "none" && gate.lostCall !== null && gate.spec) {
          probe = "running";
          void this.recoverAfterLoss(session, gate.spec).finally(() => { probe = "done"; check(); });
        } else if (gate.uncertain) { if (probe !== "running") finish(new Error(stillRunning)); }
        else if (gate.agents === 0) finish();
      };
      const timer = setTimeout(() => finish(new Error(gate.uncertain ? stillRunning : "Browser action is still finishing. Control remains paused; retry taking control or hand it back.")), this.options.takeoverTimeoutMs);
      timer.unref();
      gate.changed.add(check);
      check();
    });
    return waited;
  }

  canControl(session: string, owner: string): boolean {
    const gate = this.gates.get(session);
    return Boolean(owner && gate?.owner === owner && gate.ready && !gate.releasing && !gate.closing && !gate.uncertain && gate.agents === 0);
  }

  heldBy(session: string): string | null { return this.gates.get(session)?.owner ?? null; }

  /** An interrupted action left the browser's state unknown until the engine answers again or the browser restarts. */
  interrupted(session: string): boolean { return this.gates.get(session)?.uncertain === true; }

  interruptedCount(): number { return [...this.gates.values()].filter((gate) => gate.uncertain).length; }

  /** A disconnected viewer may leave a key or button pressed; an agent must never inherit that input state. */
  abandonHumanInput(session: string, owner: string): void {
    const gate = this.gates.get(session);
    if (!owner || !gate || gate.owner !== owner) return;
    gate.uncertain = true;
    gate.lostCall = null;
    gate.ready = false;
    this.changed(gate);
  }

  release(session: string, owner: string): void {
    const gate = this.gates.get(session);
    if (!owner || !gate || gate.owner !== owner) return;
    gate.ready = false;
    gate.releasing = true;
    gate.lastUsed = Date.now();
    this.changed(gate); // don't admit agents until pending human input drains.
  }

  async withHumanAction<T>(session: string, owner: string, fn: () => Promise<T>): Promise<T> {
    if (!this.canControl(session, owner)) throw new Error("Take control of this browser before interacting.");
    const gate = this.gate(session);
    gate.humans++;
    try { return await fn(); }
    catch (error) {
      // A failed accepted command may still be running in the daemon; hand-back must not race its completion.
      if (!isSettledBrowserFailure(error)) {
        gate.uncertain = true;
        gate.lostCall = null;
        gate.ready = false;
      }
      throw error;
    }
    finally { gate.humans--; gate.lastUsed = Date.now(); this.changed(gate); }
  }

  /** A person opened a view, which counts as use; call the returned function when it closes. */
  watch(session: string, spec: { command: string; args?: readonly string[]; env?: Record<string, string | undefined> }): () => void {
    const gate = this.gate(session);
    gate.watchers++;
    gate.lastUsed = Date.now();
    gate.spec = { command: spec.command, args: [...spec.args ?? []], env: { ...spec.env } };
    let watching = true;
    return () => {
      if (!watching) return;
      watching = false;
      gate.watchers--;
    };
  }

  async settled(session: string): Promise<void> { await this.gates.get(session)?.idleClose; }

  /** A bot call, a person's action or hold, or a close is under way in this session's browser. */
  working(session: string): boolean {
    const gate = this.gates.get(session);
    return Boolean(gate && (gate.calls || gate.agents || gate.humans || gate.owner !== null || gate.closing || gate.releasing || this.lanes.held(session)));
  }

  /** Told just before an idle close stops a session's browser. */
  onIdleClose(listener: (session: string) => void): void { this.idleCloseListeners.add(listener); }

  launchReady(spec: LaunchSpec): Promise<void> { return this.launch?.ready(spec) ?? Promise.resolve(); }

  /** A browser without its identity still browses, so a failure here never fails the call. */
  launched(session: string, spec: LaunchSpec): Promise<void> { return this.launch?.started(session, spec).catch(() => undefined) ?? Promise.resolve(); }

  /** The same barrier as a restart. Saved sign-ins stay, and a browser attached to the person's own Chrome is never closed. */
  async closeIfIdle(session: string, idleMs: number, spec?: { command: string; args?: readonly string[]; env: Record<string, string | undefined> }): Promise<boolean> {
    const gate = spec ? this.gate(session) : this.gates.get(session);
    if (gate && !gate.spec && spec) gate.spec = { command: spec.command, args: [...spec.args ?? []], env: { ...spec.env } };
    const launch = gate?.spec;
    if (!gate || !launch || attachesToChrome(launch.env) || !(idleMs > 0) || Date.now() - gate.lastUsed < idleMs) return false;
    if (this.working(session)) return false;
    gate.closing = true;
    gate.ready = false;
    let finished!: () => void;
    gate.idleClose = new Promise((resolve) => { finished = resolve; });
    this.changed(gate);
    try {
      for (const listener of this.idleCloseListeners) listener(session);
      if (!await this.closeBrowser(session, launch)) return false;
      this.steps?.forget(session);
      this.launch?.stopped(session);
      await this.clients.get(session)?.client.stop();
      await this.clients.get(session)?.client.stop();
      gate.uncertain = false;
      gate.lostCall = null;
      gate.reopened = "idle";
      return true;
    } catch {
      return false;
    } finally {
      gate.closing = false;
      gate.idleClose = undefined;
      finished();
      this.changed(gate);
    }
  }

  /** Never waits through active work or admits human input; a successful native close is its safety barrier. A read that only
   * checks whether a lost call ended is not such work. */
  async restart(session: string, owner: string, closeBrowser: () => Promise<void>): Promise<void> {
    if (!owner) throw new Error("Browser recovery requires an owner.");
    const gate = this.gate(session);
    if (gate.closing || gate.releasing || gate.agents > gate.probes || gate.humans) throw new Error("The browser is busy. Wait for current work to finish before restarting.");
    if (gate.owner !== null && gate.owner !== owner) throw new Error("Another person controls this browser.");
    gate.owner = owner;
    gate.ready = false;
    gate.closing = true;
    this.changed(gate);
    try {
      await closeBrowser();
      this.steps?.forget(session);
      this.launch?.stopped(session);
      await this.clients.get(session)?.client.stop();
      // A tools/list admitted before closing can register a client during this stop; registration is synchronous, so one re-check suffices.
      await this.clients.get(session)?.client.stop();
      gate.uncertain = false;
      gate.lostCall = null;
      gate.owner = null;
      gate.releasing = false;
      gate.reopened = "restart";
    } catch (error) {
      gate.owner = owner;
      gate.uncertain = true;
      gate.lostCall = null;
      throw error;
    } finally {
      gate.closing = false;
      this.changed(gate);
    }
  }

  /** Never takes a person's hold, and a failed close leaves no owner behind to lock a person out. */
  async agentRestart(session: string, closeBrowser: () => Promise<boolean>): Promise<void> {
    const gate = this.gate(session);
    if (gate.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
    if (gate.closing || gate.releasing || gate.agents || gate.humans) throw new Error("The browser is busy. Wait for current work to finish before restarting.");
    gate.ready = false;
    gate.closing = true;
    this.changed(gate);
    try {
      if (!await closeBrowser()) throw new Error("The browser could not be closed. Ask the person to press Restart in the Browser panel of OpenMausBot on their computer, or to restart OpenMausBot.");
      this.steps?.forget(session);
      this.launch?.stopped(session);
      await this.clients.get(session)?.client.stop();
      await this.clients.get(session)?.client.stop();
      gate.uncertain = false;
      gate.lostCall = null;
    } catch (error) {
      gate.uncertain = true;
      gate.lostCall = null;
      throw error;
    } finally {
      gate.closing = false;
      this.changed(gate);
    }
  }

  /** Call after the browser is closed; closes the MCP transport, not saved logins or profile files. */
  async close(session: string): Promise<void> {
    this.holds.drop(session);
    const gate = this.gate(session);
    gate.closing = true;
    gate.ready = false;
    this.steps?.forget(session);
    this.launch?.stopped(session);
    // Clear before the awaited stop: any uncertain latch after this point must win.
    gate.uncertain = false;
    gate.lostCall = null;
    this.changed(gate);
    await this.clients.get(session)?.client.stop();
    gate.closing = false;
    this.changed(gate);
    if (!gate.owner && !gate.agents && !gate.humans && !gate.watchers && !gate.calls) { this.gates.delete(session); this.toolLists.delete(session); }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...new Set([...this.clients.keys(), ...this.gates.keys(), ...this.holds.sessions()])].map((session) => this.close(session)));
  }
}

function stuckBrowserToolError(): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text: BROWSER_INTERRUPTED }] };
}

function lostCallToolError(call: string): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text: `The browser did not answer this ${call} call. It may still be running, or it may already have taken effect. Do not repeat it yet: your next browser call first waits for the browser, then tells you where the page is. Call ${BROWSER_RESTART_TOOL} only if the browser stays busy, because ${RESTART_COST}.` }] };
}

function stillBusyToolError(call: string): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text: `The browser is still busy with an earlier ${call} call that did not answer. This call did not run. Try again in a moment. If the browser stays busy, call ${BROWSER_RESTART_TOOL}; ${RESTART_COST}.` }] };
}

function recoveredResult(call: string, url: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: `The browser answers again: the earlier ${call} call that did not answer has ended, and it may have taken effect. This call did not run. The current page is ${url || "unknown"}. Check the page before you repeat the earlier action, then call again what you need.` }] };
}

function toolNameOf(params: unknown): string | undefined {
  const name = (params as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : undefined;
}

function firstText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  const part = Array.isArray(content) ? content.find((item) => typeof (item as { text?: unknown } | null)?.text === "string") : undefined;
  return part ? (part as { text: string }).text : "";
}

function withOmbTools(result: unknown): unknown {
  if (!result || typeof result !== "object" || !Array.isArray((result as { tools?: unknown }).tools)) return result;
  const own = [...RELAYED_TOOL_SPECS, BROWSER_RESTART_TOOL_SPEC];
  const tools = ((result as { tools: unknown[] }).tools).filter((tool) => !own.some((spec) => spec.name === (tool as { name?: unknown } | null)?.name));
  return { ...result, tools: [...tools, ...own] };
}
