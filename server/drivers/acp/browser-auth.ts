//Browser sign-in through the engine's own ACP `authenticate`: the app starts a one-shot session much like a turn's
// spawn, initializes it, and sends `authenticate`; the engine then opens the person's browser itself and holds that
// request until the person finishes there. `start` resolves as soon as the engine holds the sign-in open (the
// browser pops behind it); `get` reports the flow until the authenticate response, a readiness probe, expiry or a
// cancel decides it; nothing leaves a session running on a failure path. This mirrors DeviceAuthController
// (see device-auth.ts); the wire follows what a discovery session speaks (see custom-model-catalog.ts).
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ProviderAuthenticationStart, ProviderAuthenticationStatus } from "../../contracts.ts";
import { killCliTree, spawnCli } from "../../procs.ts";

type Env = Record<string, string | undefined>;

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** initialize is the only quick request; the long one is `authenticate`, under the flow's own expiry. */
const INIT_TIMEOUT_MS = 30_000;

/** Where a failure came from, seen by the app; the message is decided by stage, never by the CLI's own words. */
export type AcpBrowserAuthStage = "start" | "initialize" | "authenticate" | "processEnded" | "expired";

export interface AcpBrowserSignInSpec {
  product: string;
  /** Extra spawn arguments for the sign-in session, ahead of the engine's own session args. */
  args?: readonly (string | ((env: Env) => string | undefined))[];
  /** initialize's authMethods → the methodId the authenticate carries; null means no sign-in is offered. */
  methodId(authMethods: Array<{ id?: string }>, env: Env): string | null;
  /** Checked while the engine still holds `authenticate`: once the sign-in is there where a turn reads it, the flow
   * ends well even if the engine never answers. */
  signedIn?(env: Env): boolean;
  /** On a server the engine's browser cannot reach the person's screen: one sentence of guidance. */
  serverHint?: string;
  /** One safe sentence for a failed sign-in, per stage; `detail` is the app's own observation. */
  failure(stage: AcpBrowserAuthStage, detail?: string): string;
  /** Remove the engine's own stored sign-in (its cache files, its keychain entry); the person's pasted
   * provider key in Connections is not this engine's to remove. */
  removeCredentials?(env: Env): void | Promise<void>;
}

export interface AcpBrowserAuthOptions {
  cli: string;
  /** The engine's own session spawn args, so the sign-in runs with a turn's environment. */
  sessionArgs?: (env: Env) => readonly string[];
  cwd?: string;
  environment: () => Env;
  onAuthenticated?: () => Promise<void>;
  startupTimeoutMs?: number;
  lifetimeMs?: number;
  terminateTimeoutMs?: number;
}

type Flow = {
  id: string;
  status: ProviderAuthenticationStatus;
  child: ChildProcess | null;
  ready: boolean;
  resolve: ((value: ProviderAuthenticationStart) => void) | null;
  startupTimer: NodeJS.Timeout;
  expiryTimer: NodeJS.Timeout;
  stopping?: Promise<boolean>;
};

/** The instance surface an ACP driver exposes for its browser sign-in: start/get/cancel, plus `signOut` when the spec
 * can remove the stored sign-in. Marked `browser` so the registry separates it from a device-code flow. Lives beside
 * the controller so the instance wiring stays one line in each driver, like deviceAuthInstanceSurface (see
 * device-auth.ts). */
export function acpBrowserAuthInstanceSurface(auth: AcpBrowserAuth, spec: AcpBrowserSignInSpec) {
  return {
    authenticationMethod: "browser" as const,
    startAuthentication: () => auth.start(),
    getAuthentication: (flowId: string) => auth.get(flowId),
    cancelAuthentication: () => auth.cancel(),
    ...(spec.removeCredentials ? { signOut: () => auth.signOut() } : {}),
  };
}

export class AcpBrowserAuth {
  private flow: Flow | null = null;
  /** A finished flow's status stays findable by its flowId until the next start replaces it, so a status poll never
   * races a finishing sign-in. */
  private finished: { flowId: string; status: ProviderAuthenticationStatus } | null = null;
  private disposed = false;
  private readonly spec: AcpBrowserSignInSpec;
  private readonly options: AcpBrowserAuthOptions;

  constructor(spec: AcpBrowserSignInSpec, options: AcpBrowserAuthOptions) {
    this.spec = spec;
    this.options = options;
  }

  async start(): Promise<ProviderAuthenticationStart> {
    if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing in.");
    if (this.flow) await this.flow.stopping;
    if (this.flow) throw new Error(`A ${this.spec.product} sign-in is already in progress. Finish or cancel it first.`);
    if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing in.");
    return new Promise<ProviderAuthenticationStart>((resolveStart, rejectStart) => {
      const env = this.options.environment();
      const lifetimeMs = this.options.lifetimeMs ?? 15 * 60_000;
      const flow: Flow = {
        id: randomUUID(),
        status: {
          phase: "waiting", flowId: null, authorizationUrl: null,
          expiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
        },
        child: null, ready: false, resolve: null,
        startupTimer: setTimeout(() => this.finish(flow, "failed", this.spec.failure("start")), this.options.startupTimeoutMs ?? 30_000),
        expiryTimer: setTimeout(() => this.finish(flow, "expired", this.spec.failure("expired")), lifetimeMs),
      };
      flow.startupTimer.unref();
      flow.expiryTimer.unref();
      this.flow = flow;
      this.finished = null;

      const failFlow = (stage: AcpBrowserAuthStage, detail?: string) =>
        this.finish(flow, "failed", this.spec.failure(stage, detail));
      const spawnFail = (detail?: string) => {
        const message = this.spec.failure("start", detail);
        const reported = detail === "ENOENT" && this.spec.serverHint ? `${message} ${this.spec.serverHint}` : message;
        this.finish(flow, "failed", reported);
        rejectStart(new Error(message));
      };

      let child: ReturnType<typeof spawnCli>;
      try {
        const extra = (this.spec.args ?? []).map((arg) => typeof arg === "function" ? arg(env) : arg).filter((arg): arg is string => arg !== undefined);
        const sessionArgs = this.options.sessionArgs ? this.options.sessionArgs(env) : [];
        const argv = [this.options.cli, ...extra, ...sessionArgs];
        child = spawnCli(argv[0], argv.slice(1), { cwd: this.options.cwd, env, stdio: ["pipe", "pipe", "pipe"] }, "bot");
      } catch (error) {
        spawnFail(error instanceof Error && typeof (error as { code?: unknown }).code === "string"
          ? String((error as { code?: unknown }).code) : undefined);
        return;
      }
      flow.child = child;
      child.once("error", (error) => {
        if (flow.ready || this.flow !== flow) return;
        const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
        if (code === "ENOENT") spawnFail("ENOENT");
        else failFlow("processEnded", typeof code === "string" ? code : undefined);
      });
      child.once("close", (code) => {
        if (flow.ready || this.flow !== flow) return;
        failFlow("processEnded", code !== null ? `exit ${code}` : undefined);
      });

      const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
      let requestSeq = 1;
      let buffer = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > MAX_OUTPUT_BYTES) { failFlow("processEnded", "overflow"); return; }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.length > MAX_LINE_BYTES) { failFlow("processEnded", "overflow"); return; }
          this.receive(flow, pending, line);
        }
      });
      child.stderr!.on("data", () => {});

      const request = (method: string, params: unknown, timeoutMs: number) => new Promise<unknown>((resolve, rejectRequest) => {        const id = requestSeq++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectRequest(new Error(`${method} was not answered in time`));
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); rejectRequest(error); },
        });
        if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        else rejectRequest(new Error("the sign-in process ended early"));
      });

      // The engine holds `authenticate` open until the browser step ends, and its answer IS that step's end; every
      // request the engine itself raises is refused: this session grants nothing and decides nothing.
      request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "openmausbot", version: "0.0.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, INIT_TIMEOUT_MS).then((raw) => {
        if (this.flow !== flow) return;
        const methods = Array.isArray((raw as { authMethods?: unknown })?.authMethods)
          ? (raw as { authMethods: Array<{ id?: string }> }).authMethods : [];
        const methodId = this.spec.methodId(methods, env);
        if (!methodId) { failFlow("start"); return; }
        request("authenticate", { methodId }, lifetimeMs).then(
          () => this.finish(flow, "succeeded"),
          () => failFlow("authenticate"),
        );
      }, () => failFlow("initialize"));

      // The browser opens behind this; the person's progress shows up on the status endpoint.
      resolveStart({ phase: "waiting", flowId: flow.id, authorizationUrl: null, expiresAt: flow.status.expiresAt });
    });
  }

  async get(flowId: string): Promise<ProviderAuthenticationStatus> {
    if (this.finished?.flowId === flowId) return { ...this.finished.status };
    if (!flowId || this.flow?.id !== flowId) throw new Error("This sign-in is no longer available. Start sign-in again.");
    const flow = this.flow;
    if (!flow.ready && this.spec.signedIn && this.spec.signedIn(this.options.environment())) this.finish(flow, "succeeded");
    return { ...(this.flow === flow ? flow.status : this.finished?.status ?? flow.status) };
  }

  async cancel(): Promise<void> {
    const flow = this.flow;
    if (flow) this.finish(flow, "cancelled", `${this.spec.product} sign-in was cancelled.`);
    await flow?.stopping;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel();
    this.flow = null;
  }

  /** Removes the engine's own stored sign-in; refuses while a sign-in is in progress. */
  async signOut(): Promise<void> {
    if (!this.spec.removeCredentials) throw new Error(`Signing out of ${this.spec.product} is not available from here.`);
    if (this.flow) throw new Error(`Finish or cancel the ${this.spec.product} sign-in in progress before signing out.`);
    await this.spec.removeCredentials(this.options.environment());
  }

  /** Every request the engine raises is refused; a reply to this app's requests resolves or rejects its pending. */
  private receive(flow: Flow, pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void }>, line: string) {
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; } catch { return; }
    const message = (parsed ?? {}) as { id?: unknown; method?: unknown; error?: unknown; result?: unknown };
    if (typeof message.method === "string" && message.id !== undefined && typeof message.id === "number") {
      const stdin = flow.child?.stdin;
      if (stdin?.writable) {
        stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not available during sign-in." } })}\n`);
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error !== undefined && message.error !== null && typeof message.error === "object"
      && typeof (message.error as { message?: unknown }).message === "string") {
      // The CLI's own words never travel — the stage decides the message the person reads.
      entry.reject(new Error("a sign-in request was refused"));
    } else entry.resolve(message.result);
  }

  private finish(flow: Flow, phase: "failed" | "succeeded" | "expired" | "cancelled", message?: string): void {
    if (this.flow !== flow) return;
    this.flow = null;
    clearTimeout(flow.startupTimer);
    clearTimeout(flow.expiryTimer);
    flow.ready = true;
    const status: ProviderAuthenticationStatus = {
      ...flow.status, phase,
      authorizationUrl: null, expiresAt: null,
      ...(message ? { message } : {}),
    };
    this.finished = { flowId: flow.id, status };
    if (phase === "succeeded") void this.options.onAuthenticated?.().catch(() => {});
    // A start promise still open (a spawn failure before the early resolve) only ever rejects; finish's resolve was
    // consumed by start() right after the spawn, so this is for that window alone.
    flow.resolve?.({ phase: phase === "succeeded" ? "succeeded" : "waiting", flowId: flow.id, authorizationUrl: null, expiresAt: null });
    flow.resolve = null;
    const child = flow.child;
    flow.child = null;
    if (child) flow.stopping = this.stopChild(child);
  }

  private async stopChild(child: ChildProcess): Promise<boolean> {
    const stopped = await killCliTree(child, this.options.terminateTimeoutMs ?? 2_000).catch(() => false);
    if (stopped || child.exitCode !== null || child.signalCode !== null) return true;
    child.kill("SIGKILL");
    return false;
  }
}
