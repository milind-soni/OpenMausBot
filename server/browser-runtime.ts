import { killCliTree, spawnCli } from "./procs.ts";
import { DEFAULT_BROWSER_RESULT_BUDGET, shapeBrowserToolResult, slimBrowserToolList, stripHarnessOwnedArguments } from "./browser-tool-shape.ts";

export interface BrowserSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

export const BROWSER_CONTROL_REFUSAL = "Browser tools are paused while a person controls this browser. Wait for them to hand control back; do not try another browser or execution tool.";
/** Harness-owned recovery tool, advertised beside the engine's own tools. A
 * phone or chat-only user has no Browser panel Restart button; without this
 * an interrupted action refuses the bot's browser until the app restarts. */
export const BROWSER_RESTART_TOOL = "restart_browser";
const BROWSER_RESTART_TOOL_SPEC = {
  name: BROWSER_RESTART_TOOL,
  description: "Close and restart your browser. Use this only when a browser tool says a browser action was interrupted and the browser must be restarted. Open pages are closed; afterwards open the page you need again and check whether the interrupted action already happened before repeating it.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const BROWSER_INTERRUPTED = `The browser engine is stuck. Press Restart in the Browser panel, or call ${BROWSER_RESTART_TOOL}, before using browser tools again.`;
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 16_777_216;
/** Startup, not per-request work: a cold engine spawn can exceed a tight
 * per-request budget before anything has been accepted to guard. */
const HANDSHAKE_TIMEOUT_MS = 1_000;
const HOST_ENV = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATH", "Path", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"];

/** MCP, viewer commands, and cleanup must resolve the same HOME/socket paths.
 * Inherit OS plumbing, never the harness's model-provider credentials. */
export function browserRuntimeEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(HOST_ENV.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  return { ...env, ...overrides };
}

/** The page size of a headless browser OMB launches, in CSS pixels.
 *
 * agent-browser sizes the Chrome *window* (`--window-size=1280,720`). Full
 * Chrome in headless mode (Chrome for Testing, as the Docker image installs)
 * takes its emulated browser UI out of that window, so the page itself comes
 * out 1280×577 while the screencast metadata still reports 1280×720, and the
 * live view aimed clicks at the wrong place. chrome-headless-shell has no such
 * UI, so there this changes nothing. agent-browser has no launch option for
 * the page size; `set viewport` sets it and resizes the window's content area,
 * which the browser's later tabs inherit. */
export const BROWSER_VIEWPORT = { width: 1280, height: 720 } as const;
export const BROWSER_VIEWPORT_ARGS = ["set", "viewport", String(BROWSER_VIEWPORT.width), String(BROWSER_VIEWPORT.height)] as const;

/** Only a headless browser this server launches is OMB's to size. A browser
 * attached over CDP is someone's own Chrome, and a headed window is the
 * user's to size. */
export function ownsBrowserViewport(env: NodeJS.ProcessEnv): boolean {
  return env.AGENT_BROWSER_HEADLESS === "1" && !env.AGENT_BROWSER_CDP;
}

export class TransportError extends Error {}

/** One timed browser action, logged with OMB_BROWSER_TIMING=1. Times are in
 * milliseconds. `inFlight` counts this session's browser work already running
 * when the action started: the engine runs one command per session, so the
 * action waited behind it. */
export interface BrowserTiming {
  session: string;
  tool: string;
  outcome: "ok" | "error";
  totalMs: number;
  /** Transport handshake and page sizing; the first call launches the browser here. */
  launchMs?: number;
  engineMs?: number;
  /** The snapshot taken after agent_browser_open. */
  observeMs?: number;
  /** Text the model receives, after shaping; the frame's base64 for a preview frame. */
  chars?: number;
  inFlight: number;
}

export function formatBrowserTiming(timing: BrowserTiming): string {
  const parts = [`browser timing: ${timing.tool} ${timing.outcome}`];
  const phases: Array<[string, number | undefined]> = [
    ["total", timing.totalMs], ["launch", timing.launchMs], ["engine", timing.engineMs], ["observe", timing.observeMs],
  ];
  for (const [label, value] of phases) {
    if (value !== undefined) parts.push(`${label}=${Math.round(value)}ms`);
  }
  if (timing.chars !== undefined) parts.push(`chars=${timing.chars}`);
  parts.push(`inflight=${timing.inFlight}`, `session=${timing.session}`);
  return parts.join(" ");
}

/** The text a tool result hands the model, in characters. */
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

/** An error the engine answered: the action ran and failed (a page that
 * would not load). Nothing is left running in the browser, so unlike a
 * timeout or a lost connection it does not need a restart. Errors mark
 * themselves with `settled: true`. */
export function isSettledBrowserFailure(error: unknown): boolean {
  return (error as { settled?: unknown } | null)?.settled === true;
}
type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** A server-owned JSONL client. Neither child stderr nor its environment is
 * returned to the agent. Reuse the existing cross-platform spawn/kill rules. */
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
  private onRequestTimeout: () => void;

  constructor(
    spec: BrowserSpawnSpec,
    requestTimeoutMs: number,
    idleMs: number,
    maxPending: number,
    onClose: () => void,
    onRequestTimeout: () => void,
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
      if (!pending) continue; // MCP notifications do not contain tool results.
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
        // Seal the gate synchronously with the timer, before stop() teardown:
        // the rejection can surface through the ready handshake, which sits
        // outside agentRpc's uncertainty classifier.
        this.onRequestTimeout();
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
      // Only the stateless MCP transport expires; saved browser state and the
      // browser daemon itself belong to the profile, not this client.
      this.idleTimer = setTimeout(() => { void this.stop(undefined, "transport"); }, this.idleMs);
      this.idleTimer.unref();
    }
  }

  /** Upstream's MCP loop exits on stdin EOF without closing the daemon.
   * In particular, Windows taskkill /T would also kill that profile's Chrome,
   * even when the daemon created a new process group. Idle is not shutdown. */
  private retireTransport(): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.child.off("exit", finish);
        resolve();
      };
      const timer = setTimeout(() => {
        try { this.child.kill("SIGKILL"); } catch { /* transport already exited */ }
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
      } catch { /* owned process already exited */ }
    });
    return this.stoppedPromise;
  }
}

/** Sets the page size of a session's browser, launching it if needed. */
export type ApplyViewport = (spec: BrowserSpawnSpec) => Promise<unknown>;

interface Gate {
  owner: string | null;
  ready: boolean;
  releasing: boolean;
  agents: number;
  humans: number;
  uncertain: boolean;
  closing: boolean;
  changed: Set<() => void>;
}

/** Closes one session's native browser daemon; true only when it is gone. */
export type CloseBrowser = (session: string, spec: BrowserSpawnSpec) => Promise<boolean>;

export class BrowserRuntime {
  private gates = new Map<string, Gate>();
  private clients = new Map<string, { key: string; client: BrowserClient; viewport?: Promise<unknown> }>();
  /** Last advertised tools per session, so a turn that starts while the
   * browser is uncertain still sees the tools it can use after recovering. */
  private toolLists = new Map<string, unknown>();
  private options: { requestTimeoutMs: number; takeoverTimeoutMs: number; idleMs: number; maxPending: number; resultBudget: number };
  private closeBrowser: CloseBrowser;
  private applyViewport?: ApplyViewport;
  private onTiming?: (timing: BrowserTiming) => void;

  constructor({ closeBrowser, applyViewport, onTiming, ...options }: Partial<BrowserRuntime["options"]> & { closeBrowser?: CloseBrowser; applyViewport?: ApplyViewport; onTiming?: (timing: BrowserTiming) => void } = {}) {
    this.options = { requestTimeoutMs: 120_000, takeoverTimeoutMs: 15_000, idleMs: 60_000, maxPending: 16, resultBudget: DEFAULT_BROWSER_RESULT_BUDGET, ...options };
    this.closeBrowser = closeBrowser ?? (async () => false);
    this.applyViewport = applyViewport;
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

  /** A preview frame of the bot's browser. It runs as agent work so a person
   * taking control waits for it, and it shares the engine with the bot's tools. */
  agentFrame<T extends { png: string }>(session: string, capture: () => Promise<T>): Promise<T> {
    const phases: Partial<BrowserTiming> = {};
    return this.timed(session, "preview_frame", phases, () => this.withAgentAction(session, async () => {
      const frame = await capture();
      phases.chars = frame.png.length;
      return frame;
    }));
  }

  private gate(session: string): Gate {
    let gate = this.gates.get(session);
    if (!gate) {
      gate = { owner: null, ready: false, releasing: false, agents: 0, humans: 0, uncertain: false, closing: false, changed: new Set() };
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
    const gate = this.gate(session);
    if (gate.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
    if (gate.uncertain) throw new Error(BROWSER_INTERRUPTED);
    if (gate.closing) throw new Error("The browser is closing. Try again shortly.");
    gate.agents++;
    try {
      const result = await fn();
      // Discard observations completed after takeover was requested.
      if (gate.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
      return result;
    } finally {
      gate.agents--;
      this.changed(gate);
    }
  }

  async agentRpc(session: string, spec: BrowserSpawnSpec, method: "tools/list" | "tools/call", params: unknown, beforeDispatch?: () => void): Promise<unknown> {
    if (method !== "tools/list" && method !== "tools/call") throw new Error("Unsupported browser method.");
    // tools/list bypasses withAgentAction (a human may hold control), so it
    // must refuse the closing window itself or its client outlives restart().
    if (method !== "tools/call" && this.gate(session).closing) throw new Error("The browser is closing. Try again shortly.");
    if (method === "tools/call" && params && typeof params === "object" && (params as { name?: unknown }).name === BROWSER_RESTART_TOOL) {
      beforeDispatch?.();
      await this.agentRestart(session, () => this.closeBrowser(session, spec));
      beforeDispatch?.(); // A turn revoked while the browser closed receives no result.
      return { content: [{ type: "text", text: "Browser restarted. Open pages were closed; open the page you need again and check whether the interrupted action already happened before repeating it." }] };
    }
    // Uncertainty survives client replacement and never self-resolves: refuse
    // every new browser request until an explicit restart clears it. Listing
    // never reaches the engine; it answers from the last list so the restart
    // tool is reachable and the engine's tools are there once it succeeds.
    if (this.gate(session).uncertain) {
      if (method === "tools/list") return withRestartTool(this.toolLists.get(session) ?? { tools: [] });
      // A person still holding the browser hears the pause, not the stuck
      // engine. Once they hand it back, the call is a tool result — not a
      // dead MCP server — so this thread can Restart and continue.
      if (this.gate(session).owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
      return stuckBrowserToolError();
    }
    const toolName = typeof (params as { name?: unknown } | null)?.name === "string" ? (params as { name: string }).name : undefined;
    const phases: Partial<BrowserTiming> = {};
    const invoke = async () => {
      const launchStarted = performance.now();
      const key = JSON.stringify([spec.command, spec.args, Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b))]);
      let entry = this.clients.get(session);
      if (entry && entry.key !== key) throw new Error("Browser launch settings changed. Close the browser before reconnecting.");
      if (!entry) {
        const client = new BrowserClient(spec, this.options.requestTimeoutMs, this.options.idleMs, this.options.maxPending, () => {
          if (this.clients.get(session)?.client === client) this.clients.delete(session);
        }, () => {
          const gate = this.gate(session);
          if (!gate.closing) gate.uncertain = true;
        });
        entry = { key, client };
        this.clients.set(session, entry);
      }
      await entry.client.ready;
      beforeDispatch?.();
      if (method === "tools/call" && this.gate(session).owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
      if (method === "tools/call" && this.applyViewport) {
        // The bot's first call on a transport may launch the browser. Size its
        // page first, once per transport, so the page, the bot's screenshots
        // and the live view agree. Failure only leaves the engine's default.
        entry.viewport ??= this.applyViewport(spec).catch(() => undefined);
        await entry.viewport;
        beforeDispatch?.();
        if (this.gate(session).owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
      }
      phases.launchMs = performance.now() - launchStarted;
      try {
        // The model sees slimmed schemas and text-only, bounded results; the
        // launch/session parameters OMB owns never reach the engine from a call.
        const request = method === "tools/call" ? stripHarnessOwnedArguments(params) : params;
        const engineStarted = performance.now();
        let result = await entry.client.rpc(method, request);
        phases.engineMs = performance.now() - engineStarted;
        beforeDispatch?.(); // A turn revoked while the tool ran receives no result.
        if (method === "tools/list") {
          const tools = withRestartTool(slimBrowserToolList(result));
          this.toolLists.set(session, tools);
          return tools;
        }
        if (toolName === "agent_browser_open" && result && typeof result === "object" &&
            (result as { isError?: boolean }).isError !== true) {
          // Navigation alone does not prove that the requested page loaded.
          // Observe in the same scoped session, without replaying the action.
          beforeDispatch?.();
          if (this.gate(session).owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
          let observation: unknown;
          const observeStarted = performance.now();
          try {
            observation = await entry.client.rpc("tools/call", {
              name: "agent_browser_snapshot", arguments: { compact: true },
            });
          } catch (error) {
            // A tool-level refusal does not undo the completed navigation.
            // Transport failures still engage the uncertainty/recovery gate.
            if (error instanceof TransportError) throw error;
            observation = { isError: true, content: [] };
          } finally {
            phases.observeMs = performance.now() - observeStarted;
          }
          beforeDispatch?.();
          const navigation = result as { content?: unknown[] };
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
            ...(!observed ? { isError: true } : {}),
          };
        }
        const shaped = shapeBrowserToolResult(result, { toolName, budget: this.options.resultBudget });
        phases.chars = resultChars(shaped);
        return shaped;
      }
      catch (error) {
        // An MCP timeout cannot prove the independent daemon stopped an
        // accepted action. Recovery must close the browser, not just its pipe.
        // A stop from close()/restart() is intentional, not uncertainty.
        if (method === "tools/call" && error instanceof TransportError && !this.gate(session).closing) {
          const gate = this.gate(session);
          gate.uncertain = true;
        }
        throw error;
      }
    };
    if (method !== "tools/call") return invoke();
    try {
      return await this.timed(session, toolName ?? "unknown", phases, () => this.withAgentAction(session, invoke));
    } catch (error) {
      if (error instanceof Error && error.message === BROWSER_INTERRUPTED) return stuckBrowserToolError();
      throw error;
    }
  }

  /** Resolves true when the grant had to wait for the bot's own browser
   * action to finish: the page may have changed since the person aimed. */
  async take(session: string, owner: string): Promise<boolean> {
    if (!owner) throw new Error("Browser control requires an owner.");
    const gate = this.gate(session);
    if (gate.closing || gate.releasing) throw new Error("Browser control is changing. Try again shortly.");
    if (gate.owner !== null && gate.owner !== owner) throw new Error("Another person controls this browser.");
    gate.owner = owner; // synchronous: no new agent work slips in while draining.
    gate.ready = false;
    const waited = gate.agents > 0;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        gate.changed.delete(check);
        if (error) reject(error);
        else { gate.ready = true; resolve(); }
      };
      const check = () => {
        if (gate.owner !== owner || gate.releasing || gate.closing) finish(new Error("Browser control request was cancelled."));
        else if (gate.uncertain) finish(new Error("A browser action may still be running. Restart this browser before taking control."));
        else if (gate.agents === 0) finish();
      };
      const timer = setTimeout(() => finish(new Error("Browser action is still finishing. Control remains paused; retry taking control or hand it back.")), this.options.takeoverTimeoutMs);
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

  /** An interrupted action left the browser's state unknown; only a restart clears it. */
  interrupted(session: string): boolean { return this.gates.get(session)?.uncertain === true; }

  /** A disconnected viewer may leave a physical key/button pressed. Never
   * let an agent inherit that input state; explicit restart clears it. */
  abandonHumanInput(session: string, owner: string): void {
    const gate = this.gates.get(session);
    if (!owner || !gate || gate.owner !== owner) return;
    gate.uncertain = true;
    gate.ready = false;
    this.changed(gate);
  }

  release(session: string, owner: string): void {
    const gate = this.gates.get(session);
    if (!owner || !gate || gate.owner !== owner) return;
    gate.ready = false;
    gate.releasing = true;
    this.changed(gate); // don't admit agents until pending human input drains.
  }

  async withHumanAction<T>(session: string, owner: string, fn: () => Promise<T>): Promise<T> {
    if (!this.canControl(session, owner)) throw new Error("Take control of this browser before interacting.");
    const gate = this.gate(session);
    gate.humans++;
    try { return await fn(); }
    catch (error) {
      // Validation happens before entry. A failed accepted command might still
      // be executing in the daemon; hand-back must not race its completion.
      // One the engine answered as failed is over, and the browser stays usable.
      if (!isSettledBrowserFailure(error)) {
        gate.uncertain = true;
        gate.ready = false;
      }
      throw error;
    }
    finally { gate.humans--; this.changed(gate); }
  }

  /** Exclusive recovery. Unlike take(), this never waits through active work
   * or admits human input; a successful native close is its safety barrier. */
  async restart(session: string, owner: string, closeBrowser: () => Promise<void>): Promise<void> {
    if (!owner) throw new Error("Browser recovery requires an owner.");
    const gate = this.gate(session);
    if (gate.closing || gate.releasing || gate.agents || gate.humans) throw new Error("The browser is busy. Wait for current work to finish before restarting.");
    if (gate.owner !== null && gate.owner !== owner) throw new Error("Another person controls this browser.");
    gate.owner = owner;
    gate.ready = false;
    gate.closing = true;
    this.changed(gate);
    try {
      await closeBrowser();
      await this.clients.get(session)?.client.stop();
      // A tools/list admitted before closing set in can register a client
      // while that stop awaits; registration is synchronous, so one re-check
      // is deterministic and no stray transport survives to idle expiry.
      await this.clients.get(session)?.client.stop();
      gate.uncertain = false;
      gate.owner = null;
      gate.releasing = false;
    } catch (error) {
      gate.owner = owner;
      gate.uncertain = true;
      throw error;
    } finally {
      gate.closing = false;
      this.changed(gate);
    }
  }

  /** The agent's own recovery, for a turn with no Browser panel to press
   * Restart in. The same barrier as restart() — the native browser must
   * close — but it never takes a person's hold, and a failed close leaves no
   * owner behind that would lock a person out of the panel. */
  async agentRestart(session: string, closeBrowser: () => Promise<boolean>): Promise<void> {
    const gate = this.gate(session);
    if (gate.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
    if (gate.closing || gate.releasing || gate.agents || gate.humans) throw new Error("The browser is busy. Wait for current work to finish before restarting.");
    gate.ready = false;
    gate.closing = true;
    this.changed(gate);
    try {
      if (!await closeBrowser()) throw new Error("The browser could not be closed. Ask the person to press Restart in the Browser panel of OpenMausBot on their computer, or to restart OpenMausBot.");
      await this.clients.get(session)?.client.stop();
      await this.clients.get(session)?.client.stop(); // see restart()
      gate.uncertain = false;
    } catch (error) {
      gate.uncertain = true;
      throw error;
    } finally {
      gate.closing = false;
      this.changed(gate);
    }
  }

  /** Call after the underlying browser is closed when recovering an uncertain
   * action. This closes the MCP transport, not saved logins or profile files. */
  async close(session: string): Promise<void> {
    const gate = this.gate(session);
    gate.closing = true;
    gate.ready = false;
    // Clear before the awaited stop: any uncertain latch after this point must win.
    gate.uncertain = false;
    this.changed(gate);
    await this.clients.get(session)?.client.stop();
    gate.closing = false;
    this.changed(gate);
    if (!gate.owner && !gate.agents && !gate.humans) { this.gates.delete(session); this.toolLists.delete(session); }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...new Set([...this.clients.keys(), ...this.gates.keys()])].map((session) => this.close(session)));
  }
}

function stuckBrowserToolError(): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text: BROWSER_INTERRUPTED }] };
}

function withRestartTool(result: unknown): unknown {
  if (!result || typeof result !== "object" || !Array.isArray((result as { tools?: unknown }).tools)) return result;
  const tools = ((result as { tools: unknown[] }).tools).filter((tool) => (tool as { name?: unknown } | null)?.name !== BROWSER_RESTART_TOOL);
  return { ...result, tools: [...tools, BROWSER_RESTART_TOOL_SPEC] };
}
