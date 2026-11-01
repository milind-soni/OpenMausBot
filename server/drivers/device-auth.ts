// Device-code CLI sign-in from the app (`codex login --device-auth`, `grok login --device-auth`),
// confirmed the way turns will see it; a DeviceSignIn holds the per-CLI parts.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { deviceSignInPrompt, type DeviceSignInProvider } from "../../shared/device-sign-in.ts";
import type { ProviderAuthenticationStart, ProviderAuthenticationStatus } from "../contracts.ts";
import { killCliTree, spawnCli } from "../procs.ts";

const MAX_OUTPUT = 16_384;
// Only the auth operation on a shared credential home is exclusive, never normal turns.
const authenticatingHomes = new Set<string>();

export function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonicalPath(parent), basename(path));
  }
}

type Env = Record<string, string | undefined>;

/** `other` is a sign-in by another method, never replaced from here. */
export type DeviceSignInState = "signed-in" | "signed-out" | "other" | "unknown";

export interface DeviceSignIn {
  provider: DeviceSignInProvider;
  product: string;
  account: string;
  /** Where the CLI keeps its sign-in: `$homeEnv`, else `~/homeDir`; one sign-in per home at a time. */
  homeEnv: string;
  homeDir: string;
  loginArgs: readonly string[];
  install: string;
  /** One safe sentence for a failed login command; never the CLI's own words, which may carry tokens. */
  failure(output: string): string;
  /** Checked before a sign-in, so a working one is never replaced, and after it to confirm. */
  status?: { args: readonly string[]; read(code: number | null, output: string): DeviceSignInState };
  /** Without a status command: whether the sign-in a turn uses is now there. */
  signedIn?(env: Env): boolean;
  logoutArgs?: readonly string[];
}

type Flow = {
  status: ProviderAuthenticationStatus;
  child: ChildProcess | null;
  ready: boolean;
  resolve: (value: ProviderAuthenticationStart) => void;
  reject: (error: Error) => void;
  startupTimer: NodeJS.Timeout;
  expiryTimer: NodeJS.Timeout;
  homeKey: string;
  stopping?: Promise<void>;
  terminationFailed?: boolean;
};

export interface DeviceAuthOptions {
  cli: string;
  environment: () => Env;
  onAuthenticated?: () => Promise<void>;
  /** The provider refused the stored sign-in though the CLI still reports it. */
  signInRejected?: () => boolean;
  startupTimeoutMs?: number;
  lifetimeMs?: number;
  terminateTimeoutMs?: number;
}

/** A fixed login command, not a terminal: CLI output stays in bounded private memory; only the page and code leave. */
export class DeviceAuthController {
  private flow: Flow | null = null;
  private command: ChildProcess | null = null;
  private signingOut: Promise<void> | null = null;
  private disposed = false;
  private readonly spec: DeviceSignIn;
  private readonly options: DeviceAuthOptions;

  constructor(spec: DeviceSignIn, options: DeviceAuthOptions) {
    this.spec = spec;
    this.options = options;
  }

  private home(env: Env, action: "signing in" | "signing out"): { home: string; homeKey: string } {
    const { homeEnv, homeDir, product } = this.spec;
    const home = env.HOME || env.USERPROFILE || homedir();
    const named = env[homeEnv];
    if (!isAbsolute(home) || (named && !isAbsolute(named))) {
      throw new Error(`Use an absolute HOME and ${homeEnv} path for this server's ${product} provider before ${action}.`);
    }
    return { home, homeKey: canonicalPath(resolve(named || join(home, homeDir))) };
  }

  async start(): Promise<ProviderAuthenticationStart> {
    const { product, account, status } = this.spec;
    if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing in.");
    if (this.flow?.status.phase === "waiting") {
      if (this.flow.ready) return { ...this.flow.status, phase: "waiting" };
      throw new Error(`A ${account} sign-in is already starting. Please wait for the code.`);
    }
    await this.flow?.stopping;
    if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing in.");
    const env = this.options.environment();
    const { home, homeKey } = this.home(env, "signing in");
    if (authenticatingHomes.has(homeKey)) {
      throw new Error(`A ${account} sign-in is already running for this server account. Finish or cancel it before starting another.`);
    }
    authenticatingHomes.add(homeKey);
    return new Promise<ProviderAuthenticationStart>((resolveStart, reject) => {
      const flow: Flow = {
        status: {
          phase: "waiting", flowId: randomUUID(), authorizationUrl: null,
          expiresAt: new Date(Date.now() + (this.options.lifetimeMs ?? 15 * 60_000)).toISOString(),
        },
        child: null, ready: false, resolve: resolveStart, reject, homeKey,
        startupTimer: setTimeout(() => this.finish(flow, "failed", `${product} did not provide a sign-in code in time. Check the server connection and update ${product}, then try again.`), this.options.startupTimeoutMs ?? 30_000),
        expiryTimer: setTimeout(() => this.finish(flow, "expired", `The ${account} sign-in code expired. Start sign-in again.`), this.options.lifetimeMs ?? 15 * 60_000),
      };
      flow.startupTimer.unref();
      flow.expiryTimer.unref();
      this.flow = flow;
      const login = () => this.run(flow, [...this.spec.loginArgs], env, home, (loginCode, loginOutput) => {
        if (loginCode !== 0 || !flow.ready) {
          this.finish(flow, "failed", this.spec.failure(loginOutput));
          return;
        }
        flow.startupTimer = setTimeout(() => this.finish(flow, "failed", `${product} finished sign-in but could not confirm the account. Refresh Settings and try again.`), this.options.startupTimeoutMs ?? 30_000);
        flow.startupTimer.unref();
        this.confirm(flow, env, home, (signedIn) => this.finish(flow, signedIn ? "succeeded" : "failed",
          `${product} finished sign-in but did not confirm a ${account} account. Refresh Settings and try again.`));
      }, true);
      // Never overwrite a working login; one the provider refused is not working, whatever status says.
      if (!status) { login(); return; }
      this.run(flow, [...status.args], env, home, (code, output) => {
        const state = status.read(code, output);
        if (state === "signed-in" && !this.options.signInRejected?.()) this.finish(flow, "succeeded");
        else if (state === "signed-in" || state === "signed-out") login();
        else if (state === "other") this.finish(flow, "failed", `${product} already has a different sign-in method on this server. Ask the server administrator to review it before changing accounts.`);
        else this.finish(flow, "failed", `${product} could not confirm the existing sign-in on this server. Update ${product} and check its login status before trying again.`);
      });
    });
  }

  async get(flowId: string): Promise<ProviderAuthenticationStatus> {
    if (!flowId || this.flow?.status.flowId !== flowId) throw new Error("This sign-in is no longer available. Start sign-in again.");
    return { ...this.flow.status };
  }

  async cancel(): Promise<void> {
    if (this.flow?.status.phase === "waiting") this.finish(this.flow, "cancelled", `${this.spec.account} sign-in cancelled.`);
    await this.flow?.stopping;
    if (this.flow?.terminationFailed) throw new Error(this.flow.status.message);
    if (this.command && !await this.stopChild(this.command)) {
      throw new Error(`${this.spec.product} could not be stopped on this server. Ask the server administrator to stop the account command before trying again.`);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel();
    // A stopped sign-out frees the account's lock once its pipes close, which can come after the exit cancel() waits for.
    const signingOut = this.signingOut;
    if (signingOut) await Promise.race([signingOut.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 1_500).unref())]);
    this.flow = null;
  }

  /** A sign-in in progress is never pulled away underneath the browser completing it. */
  async signOut(): Promise<void> {
    const run = this.signOutNow();
    this.signingOut = run;
    try {
      await run;
    } finally {
      if (this.signingOut === run) this.signingOut = null;
    }
  }

  private async signOutNow(): Promise<void> {
    const { product, account, status, logoutArgs } = this.spec;
    if (!status || !logoutArgs) throw new Error(`Signing out of ${account} is not available from here.`);
    if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing out.");
    if (this.flow?.status.phase === "waiting") throw new Error(`Finish or cancel the ${account} sign-in in progress before signing out.`);
    await this.flow?.stopping;
    if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing out.");
    const env = this.options.environment();
    const { home, homeKey } = this.home(env, "signing out");
    if (authenticatingHomes.has(homeKey)) {
      throw new Error(`A ${account} sign-in is running for this server account. Finish or cancel it before signing out.`);
    }
    authenticatingHomes.add(homeKey);
    try {
      const before = await this.exec([...status.args], env, home);
      const state = status.read(before.code, before.output);
      if (state === "signed-out") return;
      if (state !== "signed-in") {
        throw new Error(`${product} did not confirm a ${account} sign-in. Other authentication methods will not be removed; ask the server administrator to check the account.`);
      }
      const logout = await this.exec([...logoutArgs], env, home);
      if (logout.code !== 0) throw new Error(`${product} could not remove the sign-in on this server. Check the server's ${product} installation and try again.`);
      const after = await this.exec([...status.args], env, home);
      if (status.read(after.code, after.output) !== "signed-out") {
        throw new Error(`${product} still reports a sign-in on this server. Update ${product} and check its login status before trying again.`);
      }
    } finally {
      // A command the OS could not stop may still change credentials: keep the home reserved until it exits.
      const child = this.command;
      if (child && child.exitCode === null && child.signalCode === null) {
        child.once("close", () => authenticatingHomes.delete(homeKey));
      } else authenticatingHomes.delete(homeKey);
    }
  }

  private confirm(flow: Flow, env: Env, home: string, done: (signedIn: boolean) => void): void {
    const status = this.spec.status;
    if (status) {
      this.run(flow, [...status.args], env, home, (code, output) => done(status.read(code, output) === "signed-in"));
      return;
    }
    let signedIn = false;
    try { signedIn = this.spec.signedIn?.(env) === true; } catch {}
    done(signedIn);
  }

  private startFailure(error: NodeJS.ErrnoException): string {
    const { product, install } = this.spec;
    return error.code === "ENOENT"
      ? `${product} is not installed on this server. ${install}`
      : `${product} could not start on this server. Check the configured CLI path and its executable permissions.`;
  }

  /** Callers see an exit code and a status-line match, never the output. */
  private exec(args: string[], env: Env, cwd: string): Promise<{ code: number | null; output: string }> {
    const { product } = this.spec;
    return new Promise((resolveExec, rejectExec) => {
      if (this.disposed) {
        rejectExec(new Error("This provider was removed. Refresh Settings before signing out."));
        return;
      }
      let child: ReturnType<typeof spawnCli>;
      try {
        child = spawnCli(this.options.cli, args, { env: { ...env, NO_COLOR: "1" }, cwd, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        rejectExec(new Error(`${product} could not start on this server. Install or update the configured ${product} CLI, then try again.`));
        return;
      }
      this.command = child;
      child.stdin.end();
      let output = "";
      const receive = (chunk: Buffer) => {
        if (output.length < MAX_OUTPUT) output += chunk.toString("utf8").slice(0, MAX_OUTPUT - output.length);
      };
      child.stdout.on("data", receive);
      child.stderr.on("data", receive);
      // A hung CLI must not hold the credential-home lock forever.
      const timer = setTimeout(() => {
        void this.stopChild(child).catch(() => false).then((stopped) => {
          if (!stopped) rejectExec(new Error(`${product} could not be stopped on this server. Ask the server administrator to stop the account command before trying again.`));
        });
      }, this.options.startupTimeoutMs ?? 30_000);
      timer.unref();
      child.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        rejectExec(new Error(this.startFailure(error)));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (this.command === child) this.command = null;
        resolveExec({ code, output: stripVTControlCharacters(output) });
      });
    });
  }

  private run(flow: Flow, args: string[], env: Env, cwd: string,
    done: (code: number | null, output: string) => void, parsePrompt = false): void {
    const { product, provider } = this.spec;
    if (flow.status.phase !== "waiting") return;
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(this.options.cli, args, { env: { ...env, NO_COLOR: "1" }, cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      this.finish(flow, "failed", `${product} could not start on this server. Install or update the configured ${product} CLI, then try again.`);
      return;
    }
    flow.child = child;
    child.stdin.end();
    let output = "";
    const receive = (chunk: Buffer) => {
      if (flow.status.phase !== "waiting") return;
      if (output.length + chunk.length > MAX_OUTPUT) {
        this.finish(flow, "failed", `${product} returned an unexpected sign-in response. Update the server's ${product} CLI and try again.`);
        return;
      }
      output += chunk.toString("utf8");
      const prompt = parsePrompt ? deviceSignInPrompt(provider, stripVTControlCharacters(output)) : null;
      if (!prompt || (prompt.userCode === flow.status.userCode && prompt.authorizationUrl === flow.status.authorizationUrl)) return;
      flow.status = { ...flow.status, ...prompt };
      if (!flow.ready) {
        flow.ready = true;
        clearTimeout(flow.startupTimer);
        flow.resolve({ ...flow.status, phase: "waiting" });
      }
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("error", (error: NodeJS.ErrnoException) => this.finish(flow, "failed", this.startFailure(error)));
    child.once("close", (code) => {
      if (flow.child === child) flow.child = null;
      if (flow.status.phase === "waiting") done(code, stripVTControlCharacters(output));
      output = "";
    });
  }

  private finish(flow: Flow, phase: Exclude<ProviderAuthenticationStatus["phase"], "waiting">, message?: string): void {
    const { product, account } = this.spec;
    if (flow.status.phase !== "waiting") return;
    clearTimeout(flow.startupTimer);
    clearTimeout(flow.expiryTimer);
    flow.status = {
      phase, flowId: flow.status.flowId, authorizationUrl: null, expiresAt: null,
      ...(phase !== "succeeded" && message ? { message } : {}),
    };
    if (!flow.ready) {
      if (phase === "succeeded") flow.resolve({ ...flow.status, phase });
      else flow.reject(new Error(message ?? `${account} sign-in did not finish.`));
    }
    flow.stopping = this.stopChild(flow.child).catch(() => false).then((stopped) => {
      const release = () => authenticatingHomes.delete(flow.homeKey);
      if (stopped) { release(); return; }
      flow.terminationFailed = true;
      flow.status = { ...flow.status, phase: "failed", message: `${product} could not be stopped on this server. Ask the server administrator to stop the login process before trying again.` };
      // Retain the credential-home lock until the OS actually reports exit.
      const child = flow.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) release();
      else child.once("close", release);
    });
    if (phase === "succeeded") void this.options.onAuthenticated?.().catch(() => {});
  }

  private async stopChild(child: ChildProcess | null): Promise<boolean> {
    if (!child || await killCliTree(child, this.options.terminateTimeoutMs ?? 1500)) return true;
    // A broken CLI may ignore SIGTERM; a cancelled device flow must not go on to write credentials.
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    } else child.kill("SIGKILL");
    await new Promise<void>((resolveStop) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolveStop();
      const timer = setTimeout(resolveStop, 1500);
      timer.unref();
      child.once("close", () => { clearTimeout(timer); resolveStop(); });
    });
    return child.exitCode !== null || child.signalCode !== null;
  }
}
