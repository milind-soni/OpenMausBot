import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ProviderAuthenticationStart, ProviderAuthenticationStatus } from "../contracts.ts";
import { killCliTree, spawnCli } from "../procs.ts";

const DEVICE_URL = "https://auth.openai.com/codex/device";
const MAX_OUTPUT = 16_384;
// Two configured instances can use the same on-disk login. Only the auth
// operation is exclusive: normal turns are not blocked by this lock.
const authenticatingHomes = new Set<string>();

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonicalPath(parent), basename(path));
  }
}

export function codexDevicePrompt(output: string): { authorizationUrl: string; userCode: string } | null {
  const clean = stripVTControlCharacters(output);
  // Chunks may stop halfway through a code. Never publish the incomplete
  // final line before its newline arrives.
  const lines = clean.split(/\r?\n/).slice(0, -1).map((line) => line.trim());
  // Do not turn arbitrary output into a link, or pass through query tokens.
  if (!lines.some((line) => /^https:\/\/auth\.openai\.com\/codex\/device\/?$/.test(line))) return null;
  const userCode = lines.find((line) => /^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/.test(line));
  return userCode ? { authorizationUrl: DEVICE_URL, userCode } : null;
}

function loginFailure(output: string): string {
  if (/(unexpected argument|unrecognized (argument|option)|unknown option).*device-auth/i.test(output)) {
    return "This server's Codex CLI needs updating for browser sign-in. Run npm install -g @openai/codex@latest on the server, then try again.";
  }
  if (/device.{0,40}(disabled|not enabled|not allowed)|enable.{0,40}device/i.test(output)) {
    return "Enable device-code login in your ChatGPT security settings or ask your workspace admin to allow it, then try again.";
  }
  if (/expired|expiration|timed out/i.test(output)) {
    return "The ChatGPT sign-in code expired. Start sign-in again for a new code.";
  }
  return "ChatGPT sign-in did not finish. Check the server's connection and that device-code login is enabled in ChatGPT, then try again.";
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

interface CodexDeviceAuthOptions {
  cli: string;
  environment: () => Record<string, string | undefined>;
  onAuthenticated?: () => Promise<void>;
  startupTimeoutMs?: number;
  lifetimeMs?: number;
  terminateTimeoutMs?: number;
}

/** A fixed Codex login command, not a remotely accessible terminal. CLI
 * output stays in bounded private memory; only a device URL/code is exposed. */
export class CodexDeviceAuthController {
  private flow: Flow | null = null;
  private command: ChildProcess | null = null;
  private disposed = false;
  private readonly options: CodexDeviceAuthOptions;

  constructor(options: CodexDeviceAuthOptions) { this.options = options; }

  async start(): Promise<ProviderAuthenticationStart> {
    if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing in.");
    if (this.flow?.status.phase === "waiting") {
      if (this.flow.ready) return { ...this.flow.status, phase: "waiting" };
      throw new Error("A ChatGPT sign-in is already starting. Please wait for the code.");
    }
    await this.flow?.stopping;
    if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing in.");
    const env = this.options.environment();
    const home = env.HOME || env.USERPROFILE || homedir();
    if (!isAbsolute(home) || (env.CODEX_HOME && !isAbsolute(env.CODEX_HOME))) {
      throw new Error("Use an absolute HOME and CODEX_HOME path for this server's Codex provider before signing in.");
    }
    const homeKey = canonicalPath(resolve(env.CODEX_HOME || join(home, ".codex")));
    if (authenticatingHomes.has(homeKey)) {
      throw new Error("A ChatGPT sign-in is already running for this server account. Finish or cancel it before starting another.");
    }
    authenticatingHomes.add(homeKey);
    return new Promise<ProviderAuthenticationStart>((resolveStart, reject) => {
      const flow: Flow = {
        status: {
          phase: "waiting", flowId: randomUUID(), authorizationUrl: null,
          expiresAt: new Date(Date.now() + (this.options.lifetimeMs ?? 15 * 60_000)).toISOString(),
        },
        child: null, ready: false, resolve: resolveStart, reject, homeKey,
        startupTimer: setTimeout(() => this.finish(flow, "failed", "Codex did not provide a sign-in code in time. Check the server connection and update Codex, then try again."), this.options.startupTimeoutMs ?? 30_000),
        expiryTimer: setTimeout(() => this.finish(flow, "expired", "The ChatGPT sign-in code expired. Start sign-in again."), this.options.lifetimeMs ?? 15 * 60_000),
      };
      flow.startupTimer.unref();
      flow.expiryTimer.unref();
      this.flow = flow;
      // Never overwrite a working login just because Connect was clicked twice.
      this.run(flow, ["login", "status"], env, home, (code, output) => {
        if (code === 0 && /^logged in.*chatgpt\b/im.test(output)) {
          this.finish(flow, "succeeded");
        } else if (code === 0 && /^logged in\b/im.test(output)) {
          this.finish(flow, "failed", "Codex already has a different sign-in method on this server. Ask the server administrator to review it before changing accounts.");
        } else if (code !== 0 && /^not logged in\b/im.test(output)) {
          this.run(flow, ["login", "--device-auth"], env, home, (loginCode, loginOutput) => {
            if (loginCode !== 0 || !flow.ready) {
              this.finish(flow, "failed", loginFailure(loginOutput));
              return;
            }
            // A successful command is not enough: verify credentials using the
            // same executable and environment that will run this client's bots.
            flow.startupTimer = setTimeout(() => this.finish(flow, "failed", "Codex finished sign-in but could not confirm the account. Refresh Settings and try again."), this.options.startupTimeoutMs ?? 30_000);
            flow.startupTimer.unref();
            this.run(flow, ["login", "status"], env, home, (statusCode, statusOutput) => {
              this.finish(flow, statusCode === 0 && /^logged in.*chatgpt\b/im.test(statusOutput) ? "succeeded" : "failed",
                "Codex finished sign-in but did not confirm a ChatGPT account. Refresh Settings and try again.");
            });
          }, true);
        } else this.finish(flow, "failed", "Codex could not confirm the existing sign-in on this server. Update Codex and check its login status before trying again.");
      });
    });
  }

  async get(flowId: string): Promise<ProviderAuthenticationStatus> {
    if (!flowId || this.flow?.status.flowId !== flowId) throw new Error("This sign-in is no longer available. Start sign-in again.");
    return { ...this.flow.status };
  }

  async cancel(): Promise<void> {
    if (this.flow?.status.phase === "waiting") this.finish(this.flow, "cancelled", "ChatGPT sign-in cancelled.");
    await this.flow?.stopping;
    if (this.flow?.terminationFailed) throw new Error(this.flow.status.message);
    if (this.command && !await this.stopChild(this.command)) {
      throw new Error("Codex could not be stopped on this server. Ask the server administrator to stop the account command before trying again.");
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel();
    this.flow = null;
  }

  /** Remove the ChatGPT sign-in Codex stores for this server account so a
   * different account can connect. A sign-in in progress is never pulled
   * away underneath the browser completing it. */
  async signOut(): Promise<void> {
    if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing out.");
    if (this.flow?.status.phase === "waiting") throw new Error("Finish or cancel the ChatGPT sign-in in progress before signing out.");
    await this.flow?.stopping;
    if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing out.");
    const env = this.options.environment();
    const home = env.HOME || env.USERPROFILE || homedir();
    if (!isAbsolute(home) || (env.CODEX_HOME && !isAbsolute(env.CODEX_HOME))) {
      throw new Error("Use an absolute HOME and CODEX_HOME path for this server's Codex provider before signing out.");
    }
    const homeKey = canonicalPath(resolve(env.CODEX_HOME || join(home, ".codex")));
    if (authenticatingHomes.has(homeKey)) {
      throw new Error("A ChatGPT sign-in is running for this server account. Finish or cancel it before signing out.");
    }
    authenticatingHomes.add(homeKey);
    try {
      const before = await this.exec(["login", "status"], env, home);
      if (before.code === 1 && /^not logged in\b/im.test(before.output)) return;
      if (before.code !== 0 || !/^logged in.*chatgpt\b/im.test(before.output)) {
        throw new Error("Codex did not confirm a ChatGPT sign-in. Other authentication methods will not be removed; ask the server administrator to check the account.");
      }
      const logout = await this.exec(["logout"], env, home);
      if (logout.code !== 0) throw new Error("Codex could not remove the sign-in on this server. Check the server's Codex installation and try again.");
      // The command's own report is not enough: confirm with the same status
      // check that decides whether bots may run on this account.
      const status = await this.exec(["login", "status"], env, home);
      if (status.code !== 1 || !/^not logged in\b/im.test(status.output)) {
        throw new Error("Codex still reports a sign-in on this server. Update Codex and check its login status before trying again.");
      }
    } finally {
      // If the OS cannot stop a command, it may still change credentials.
      // Keep the home reserved until that exact child actually exits.
      const child = this.command;
      if (child && child.exitCode === null && child.signalCode === null) {
        child.once("close", () => authenticatingHomes.delete(homeKey));
      } else authenticatingHomes.delete(homeKey);
    }
  }

  /** One bounded, non-interactive Codex command. Its output stays here;
   * callers see an exit code and a status-line match, never the text. */
  private exec(args: string[], env: Record<string, string | undefined>, cwd: string): Promise<{ code: number | null; output: string }> {
    return new Promise((resolveExec, rejectExec) => {
      if (this.disposed) {
        rejectExec(new Error("This provider was removed. Refresh Settings before signing out."));
        return;
      }
      let child: ReturnType<typeof spawnCli>;
      try {
        child = spawnCli(this.options.cli, args, { env: { ...env, NO_COLOR: "1" }, cwd, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        rejectExec(new Error("Codex could not start on this server. Install or update the configured Codex CLI, then try again."));
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
          if (!stopped) rejectExec(new Error("Codex could not be stopped on this server. Ask the server administrator to stop the account command before trying again."));
        });
      }, this.options.startupTimeoutMs ?? 30_000);
      timer.unref();
      child.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        rejectExec(new Error(error.code === "ENOENT"
          ? "Codex is not installed on this server. Run npm install -g @openai/codex@latest on the server, then try again."
          : "Codex could not start on this server. Check the configured CLI path and its executable permissions."));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (this.command === child) this.command = null;
        resolveExec({ code, output: stripVTControlCharacters(output) });
      });
    });
  }

  private run(flow: Flow, args: string[], env: Record<string, string | undefined>, cwd: string,
    done: (code: number | null, output: string) => void, parsePrompt = false): void {
    if (flow.status.phase !== "waiting") return;
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(this.options.cli, args, { env: { ...env, NO_COLOR: "1" }, cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      this.finish(flow, "failed", "Codex could not start on this server. Install or update the configured Codex CLI, then try again.");
      return;
    }
    flow.child = child;
    child.stdin.end();
    let output = "";
    const receive = (chunk: Buffer) => {
      if (flow.status.phase !== "waiting") return;
      if (output.length + chunk.length > MAX_OUTPUT) {
        this.finish(flow, "failed", "Codex returned an unexpected sign-in response. Update the server's Codex CLI and try again.");
        return;
      }
      output += chunk.toString("utf8");
      const prompt = parsePrompt && !flow.ready ? codexDevicePrompt(output) : null;
      if (prompt) {
        flow.status = { ...flow.status, ...prompt };
        flow.ready = true;
        clearTimeout(flow.startupTimer);
        flow.resolve({ ...flow.status, phase: "waiting" });
      }
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("error", (error: NodeJS.ErrnoException) => {
      const message = error.code === "ENOENT"
        ? "Codex is not installed on this server. Run npm install -g @openai/codex@latest on the server, then try again."
        : "Codex could not start on this server. Check the configured CLI path and its executable permissions.";
      this.finish(flow, "failed", message);
    });
    child.once("close", (code) => {
      if (flow.child === child) flow.child = null;
      if (flow.status.phase === "waiting") done(code, stripVTControlCharacters(output));
      output = "";
    });
  }

  private finish(flow: Flow, phase: Exclude<ProviderAuthenticationStatus["phase"], "waiting">, message?: string): void {
    if (flow.status.phase !== "waiting") return;
    clearTimeout(flow.startupTimer);
    clearTimeout(flow.expiryTimer);
    flow.status = {
      phase, flowId: flow.status.flowId, authorizationUrl: null, expiresAt: null,
      ...(phase !== "succeeded" && message ? { message } : {}),
    };
    if (!flow.ready) {
      if (phase === "succeeded") flow.resolve({ ...flow.status, phase });
      else flow.reject(new Error(message ?? "ChatGPT sign-in did not finish."));
    }
    flow.stopping = this.stopChild(flow.child).catch(() => false).then((stopped) => {
      const release = () => authenticatingHomes.delete(flow.homeKey);
      if (stopped) { release(); return; }
      flow.terminationFailed = true;
      flow.status = { ...flow.status, phase: "failed", message: "Codex could not be stopped on this server. Ask the server administrator to stop the login process before trying again." };
      // Retain the credential-home lock until the OS actually reports exit.
      const child = flow.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) release();
      else child.once("close", release);
    });
    if (phase === "succeeded") void this.options.onAuthenticated?.().catch(() => {});
  }

  private async stopChild(child: ChildProcess | null): Promise<boolean> {
    if (!child || await killCliTree(child, this.options.terminateTimeoutMs ?? 1500)) return true;
    // A broken CLI may ignore SIGTERM. Do not leave a stale device flow able
    // to write credentials after the user cancelled it.
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
