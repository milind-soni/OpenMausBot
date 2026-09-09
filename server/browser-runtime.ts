import { killCliTree, spawnCli } from "./procs.ts";

export interface BrowserSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

export const BROWSER_CONTROL_REFUSAL = "Browser tools are paused while a person controls this browser. Wait for them to hand control back; do not try another browser or execution tool.";
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 16_777_216;
const HOST_ENV = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATH", "Path", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"];

/** MCP, viewer commands, and cleanup must resolve the same HOME/socket paths.
 * Inherit OS plumbing, never the harness's model-provider credentials. */
export function browserRuntimeEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(HOST_ENV.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  return { ...env, ...overrides };
}

class TransportError extends Error {}
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

  constructor(
    spec: BrowserSpawnSpec,
    requestTimeoutMs: number,
    idleMs: number,
    maxPending: number,
    onClose: () => void,
  ) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.idleMs = idleMs;
    this.maxPending = maxPending;
    this.onClose = onClose;
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
    }).then((result) => {
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

  rpc(method: string, params: unknown): Promise<unknown> {
    if (this.stopped) return Promise.reject(new TransportError("Browser connection closed."));
    if (this.pending.size >= this.maxPending) return Promise.reject(new Error("Too many pending browser requests. Try again when the current action finishes."));
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_REQUEST_BYTES) return Promise.reject(new Error("Browser request exceeded the size limit."));
    if (this.idleTimer) clearTimeout(this.idleTimer);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.stop(new TransportError("Browser request timed out; restart the browser before taking control.")); }, this.requestTimeoutMs);
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
      this.idleTimer = setTimeout(() => { void this.stop(); }, this.idleMs);
      this.idleTimer.unref();
    }
  }

  stop(error = new TransportError("Browser connection closed.")): Promise<void> {
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
    this.stoppedPromise = killCliTree(this.child, 1_000).then((stopped) => {
      if (stopped) return;
      try {
        if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, "SIGKILL");
        else this.child.kill("SIGKILL");
      } catch { /* owned process already exited */ }
    });
    return this.stoppedPromise;
  }
}

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

export class BrowserRuntime {
  private gates = new Map<string, Gate>();
  private clients = new Map<string, { key: string; client: BrowserClient }>();
  private options: { requestTimeoutMs: number; takeoverTimeoutMs: number; idleMs: number; maxPending: number };

  constructor(options: Partial<BrowserRuntime["options"]> = {}) {
    this.options = { requestTimeoutMs: 120_000, takeoverTimeoutMs: 15_000, idleMs: 60_000, maxPending: 16, ...options };
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
    if (gate.uncertain) throw new Error("A browser action was interrupted. Restart this browser before continuing.");
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
    const invoke = async () => {
      const key = JSON.stringify([spec.command, spec.args, Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b))]);
      let entry = this.clients.get(session);
      if (entry && entry.key !== key) throw new Error("Browser launch settings changed. Close the browser before reconnecting.");
      if (!entry) {
        const client = new BrowserClient(spec, this.options.requestTimeoutMs, this.options.idleMs, this.options.maxPending, () => {
          if (this.clients.get(session)?.client === client) this.clients.delete(session);
        });
        entry = { key, client };
        this.clients.set(session, entry);
      }
      await entry.client.ready;
      beforeDispatch?.();
      if (method === "tools/call" && this.gate(session).owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
      try {
        const result = await entry.client.rpc(method, params);
        beforeDispatch?.(); // A turn revoked while the tool ran receives no result.
        return result;
      }
      catch (error) {
        // An MCP timeout cannot prove the independent daemon stopped an
        // accepted action. Recovery must close the browser, not just its pipe.
        if (method === "tools/call" && error instanceof TransportError) this.gate(session).uncertain = true;
        throw error;
      }
    };
    return method === "tools/call" ? this.withAgentAction(session, invoke) : invoke();
  }

  async take(session: string, owner: string): Promise<void> {
    if (!owner) throw new Error("Browser control requires an owner.");
    const gate = this.gate(session);
    if (gate.closing || gate.releasing) throw new Error("Browser control is changing. Try again shortly.");
    if (gate.owner !== null && gate.owner !== owner) throw new Error("Another person controls this browser.");
    gate.owner = owner; // synchronous: no new agent work slips in while draining.
    gate.ready = false;
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
  }

  canControl(session: string, owner: string): boolean {
    const gate = this.gates.get(session);
    return Boolean(owner && gate?.owner === owner && gate.ready && !gate.releasing && !gate.closing && !gate.uncertain && gate.agents === 0);
  }

  heldBy(session: string): string | null { return this.gates.get(session)?.owner ?? null; }

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
      gate.uncertain = true;
      gate.ready = false;
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

  /** Call after the underlying browser is closed when recovering an uncertain
   * action. This closes the MCP transport, not saved logins or profile files. */
  async close(session: string): Promise<void> {
    const gate = this.gate(session);
    gate.closing = true;
    gate.ready = false;
    this.changed(gate);
    await this.clients.get(session)?.client.stop();
    gate.closing = false;
    gate.uncertain = false;
    this.changed(gate);
    if (!gate.owner && !gate.agents && !gate.humans) this.gates.delete(session);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...new Set([...this.clients.keys(), ...this.gates.keys()])].map((session) => this.close(session)));
  }
}
