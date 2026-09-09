// Sign the server's Claude Code CLI in from Settings, with the user's own
// Claude subscription, without a terminal on the server.
//
// The unmodified `claude auth login` is spawned with pipes. It prints the
// sign-in link (Anthropic's own page, with this login's one-time PKCE
// challenge in the query) and then waits on stdin for the code that page
// shows once the user has signed in. We surface only that link, accept the
// pasted code once, write it to the CLI's stdin, and confirm the result with
// `claude auth status --json`. Nothing about the sign-in is stored here: the
// credential lands where Claude Code keeps it for the account that will run
// the bots. Anthropic permits exactly this — an end user signing in to the
// unmodified binary with their own subscription, including where a platform
// hosts it — and forbids any flow that intermediates claude.ai credentials
// itself, which is why there is no OAuth client code in this repository.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ProviderAuthenticationStart, ProviderAuthenticationStatus } from "../contracts.ts";
import { killCliTree, spawnCli } from "../procs.ts";

const MAX_OUTPUT = 32_768;
/** Where Anthropic's sign-in lives. Anything else in the CLI's output is not a link we show. */
const SIGN_IN_HOSTS = ["claude.com", "claude.ai", "console.anthropic.com", "platform.claude.com"];
// One login per credential home at a time; turns are never blocked by this.
const authenticatingHomes = new Set<string>();

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonicalPath(parent), basename(path));
  }
}

/** The sign-in link, or null for anything that is not Anthropic's own page over https. */
export function claudeSignInLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const trusted = SIGN_IN_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    return url.protocol === "https:" && trusted && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** The link from the CLI's output, once its line is complete. */
export function claudeLoginPrompt(output: string): { authorizationUrl: string } | null {
  const lines = stripVTControlCharacters(output).split(/\r?\n/).slice(0, -1);
  for (const line of lines) {
    const match = /(https:\/\/\S+)/.exec(line.trim());
    const link = match ? claudeSignInLink(match[1].replace(/[),.;]+$/, "")) : null;
    if (link) return { authorizationUrl: link };
  }
  return null;
}

/** What Anthropic's page shows after sign-in: a code, sometimes with `#state`. */
export function claudeLoginCode(value: string): string | null {
  const code = value.trim();
  return /^[A-Za-z0-9_\-#.:]{8,1024}$/.test(code) ? code : null;
}

type Flow = {
  status: ProviderAuthenticationStatus;
  child: ChildProcess | null;
  ready: boolean;
  codeSent: boolean;
  output: string;
  resolve: (value: ProviderAuthenticationStart) => void;
  reject: (error: Error) => void;
  startupTimer: NodeJS.Timeout;
  expiryTimer: NodeJS.Timeout;
  homeKey: string;
  env: NodeJS.ProcessEnv;
  completion?: { resolve: () => void; reject: (error: Error) => void };
  stopping?: Promise<void>;
  terminationFailed?: boolean;
};

interface ClaudeLoginOptions {
  cli: string;
  environment: () => NodeJS.ProcessEnv;
  onAuthenticated?: () => Promise<void>;
  startupTimeoutMs?: number;
  lifetimeMs?: number;
  completeTimeoutMs?: number;
  terminateTimeoutMs?: number;
}

const NOT_AVAILABLE = "This sign-in is no longer available. Start sign-in again.";

export class ClaudeLoginController {
  private flow: Flow | null = null;
  private logoutChild: ChildProcess | null = null;
  private disposed = false;
  private readonly options: ClaudeLoginOptions;

  constructor(options: ClaudeLoginOptions) {
    this.options = options;
  }

  async start(): Promise<ProviderAuthenticationStart> {
    if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing in.");
    if (this.flow?.status.phase === "waiting") {
      if (this.flow.ready) return { ...this.flow.status, phase: "waiting" };
      throw new Error("A Claude sign-in is already starting. Please wait for the link.");
    }
    await this.flow?.stopping;
    if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing in.");
    const env = this.options.environment();
    const home = env.HOME || env.USERPROFILE || homedir();
    if (!isAbsolute(home) || (env.CLAUDE_CONFIG_DIR && !isAbsolute(env.CLAUDE_CONFIG_DIR))) {
      throw new Error("Use an absolute HOME and CLAUDE_CONFIG_DIR path for this server's Claude provider before signing in.");
    }
    const homeKey = canonicalPath(resolve(env.CLAUDE_CONFIG_DIR || join(home, ".claude")));
    if (authenticatingHomes.has(homeKey)) {
      throw new Error("A Claude sign-in is already running for this server account. Finish or cancel it before starting another.");
    }
    authenticatingHomes.add(homeKey);
    return new Promise<ProviderAuthenticationStart>((resolveStart, reject) => {
      const flow: Flow = {
        status: {
          phase: "waiting",
          flowId: randomUUID(),
          authorizationUrl: null,
          expiresAt: new Date(Date.now() + (this.options.lifetimeMs ?? 15 * 60_000)).toISOString(),
        },
        child: null,
        ready: false,
        codeSent: false,
        output: "",
        resolve: resolveStart,
        reject,
        homeKey,
        env,
        startupTimer: setTimeout(
          () => this.finish(flow, "failed", "Claude Code did not show a sign-in link in time. Check that it is installed and up to date on the server, then try again."),
          this.options.startupTimeoutMs ?? 30_000,
        ),
        expiryTimer: setTimeout(() => this.finish(flow, "expired", "The Claude sign-in link expired. Start sign-in again."), this.options.lifetimeMs ?? 15 * 60_000),
      };
      flow.startupTimer.unref();
      flow.expiryTimer.unref();
      this.flow = flow;
      // Never replace a working login because the button was clicked twice.
      void this.signedIn(env).then((already) => {
        if (flow.status.phase !== "waiting") return;
        if (already) {
          this.finish(flow, "succeeded");
          return;
        }
        this.login(flow);
      });
    });
  }

  /** The pasted code goes to the CLI once; the CLI's exit decides the outcome. */
  async complete(flowId: string, pasted: string): Promise<void> {
    const flow = this.flow;
    if (!flowId || flow?.status.flowId !== flowId) throw new Error(NOT_AVAILABLE);
    if (flow.status.phase !== "waiting" || !flow.ready) throw new Error(NOT_AVAILABLE);
    if (flow.codeSent) throw new Error("A code was already sent for this sign-in. Wait for the result, or cancel and start again.");
    const code = claudeLoginCode(pasted);
    if (!code) throw new Error("Paste the whole code shown on Anthropic's page after signing in.");
    const child = flow.child;
    const stdin = child?.stdin;
    if (!child || !stdin || child.exitCode !== null || child.signalCode !== null) throw new Error(NOT_AVAILABLE);
    flow.codeSent = true;
    await new Promise<void>((resolveDone, rejectDone) => {
      flow.completion = { resolve: resolveDone, reject: rejectDone };
      const timer = setTimeout(
        () => this.finish(flow, "failed", "Claude Code did not finish the sign-in after the code was entered. Start sign-in again."),
        this.options.completeTimeoutMs ?? 60_000,
      );
      timer.unref();
      stdin.write(`${code}\n`, (error) => {
        if (error) this.finish(flow, "failed", "The code could not be handed to Claude Code on the server. Start sign-in again.");
      });
    });
  }

  async get(flowId: string): Promise<ProviderAuthenticationStatus> {
    if (!flowId || this.flow?.status.flowId !== flowId) throw new Error(NOT_AVAILABLE);
    return { ...this.flow.status };
  }

  async cancel(): Promise<void> {
    if (this.flow?.status.phase === "waiting") this.finish(this.flow, "cancelled", "Claude sign-in cancelled.");
    await this.flow?.stopping;
    if (this.flow?.terminationFailed) throw new Error(this.flow.status.message);
    if (this.logoutChild && !await this.stopChild(this.logoutChild)) {
      throw new Error("Claude Code could not be stopped on this server. Ask the server administrator to stop the account command before trying again.");
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel();
    this.flow = null;
  }

  /** Remove the sign-in Claude Code stores for this server account (its
   * configuration directory) so a different subscription can sign in. A
   * sign-in in progress is never pulled away underneath the browser
   * completing it, and the CLI's own status is the verdict, as for sign-in. */
  async signOut(): Promise<void> {
    if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing out.");
    if (this.flow?.status.phase === "waiting") throw new Error("Finish or cancel the Claude sign-in in progress before signing out.");
    await this.flow?.stopping;
    if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing out.");
    const env = this.options.environment();
    const home = env.HOME || env.USERPROFILE || homedir();
    if (!isAbsolute(home) || (env.CLAUDE_CONFIG_DIR && !isAbsolute(env.CLAUDE_CONFIG_DIR))) {
      throw new Error("Use an absolute HOME and CLAUDE_CONFIG_DIR path for this server's Claude provider before signing out.");
    }
    const homeKey = canonicalPath(resolve(env.CLAUDE_CONFIG_DIR || join(home, ".claude")));
    if (authenticatingHomes.has(homeKey)) {
      throw new Error("A Claude sign-in is running for this server account. Finish or cancel it before signing out.");
    }
    authenticatingHomes.add(homeKey);
    try {
      await this.logout(env);
      if (this.disposed) throw new Error("This provider was removed. Refresh Settings before signing out.");
      const status = await this.authStatus(env);
      if (status === "in") throw new Error("Claude Code still reports a sign-in on this server. Update Claude Code and check its auth status before trying again.");
      if (status === "unknown") throw new Error("Claude Code could not confirm the sign-out on this server. Update Claude Code and check its auth status before trying again.");
    } finally {
      // A command the OS could not stop may still change credentials. Keep
      // this home reserved until that exact child actually exits.
      const child = this.logoutChild;
      if (child && child.exitCode === null && child.signalCode === null) {
        child.once("close", () => authenticatingHomes.delete(homeKey));
      } else authenticatingHomes.delete(homeKey);
    }
  }

  /** `claude auth logout`, bounded and non-interactive. Its output stays
   * here; the status command afterwards decides whether it worked. */
  private logout(env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolveDone, rejectDone) => {
      if (this.disposed) {
        rejectDone(new Error("This provider was removed. Refresh Settings before signing out."));
        return;
      }
      let child: ReturnType<typeof spawnCli>;
      try {
        child = spawnCli(this.options.cli, ["auth", "logout"], { env: { ...env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        rejectDone(new Error("Claude Code could not start on this server. Install or update the configured Claude CLI, then try again."));
        return;
      }
      this.logoutChild = child;
      child.stdin.end();
      child.stdout.on("data", () => {});
      child.stderr.on("data", () => {});
      // A hung CLI must not hold the credential-home lock forever.
      const timer = setTimeout(() => {
        void this.stopChild(child).catch(() => false).then((stopped) => {
          if (!stopped) rejectDone(new Error("Claude Code could not be stopped on this server. Ask the server administrator to stop the account command before trying again."));
        });
      }, this.options.startupTimeoutMs ?? 30_000);
      timer.unref();
      child.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        rejectDone(new Error(error.code === "ENOENT"
          ? "Claude Code is not installed on this server. Install it on the server, then try again."
          : "Claude Code could not start on this server. Check the configured CLI path and its executable permissions."));
      });
      child.once("close", () => {
        clearTimeout(timer);
        if (this.logoutChild === child) this.logoutChild = null;
        resolveDone();
      });
    });
  }

  private signedIn(env: NodeJS.ProcessEnv): Promise<boolean> {
    return this.authStatus(env).then((status) => status === "in");
  }

  /** `claude auth status --json`: signed in, signed out, or not answered. */
  private authStatus(env: NodeJS.ProcessEnv): Promise<"in" | "out" | "unknown"> {
    return new Promise((resolveStatus) => {
      let child: ReturnType<typeof spawnCli>;
      try {
        child = spawnCli(this.options.cli, ["auth", "status", "--json"], { env: { ...env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        resolveStatus("unknown");
        return;
      }
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", () => {});
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveStatus("unknown");
      }, 8_000);
      timer.unref();
      child.once("error", () => {
        clearTimeout(timer);
        resolveStatus("unknown");
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        try {
          const status: unknown = JSON.parse(stdout);
          const loggedIn = typeof status === "object" && status !== null ? Reflect.get(status, "loggedIn") : undefined;
          resolveStatus(code === 0 && loggedIn === true ? "in" : code === 1 && loggedIn === false ? "out" : "unknown");
        } catch {
          resolveStatus("unknown");
        }
      });
    });
  }

  private login(flow: Flow): void {
    if (flow.status.phase !== "waiting") return;
    let child: ReturnType<typeof spawnCli>;
    try {
      // No browser on a server: the CLI then prints the link instead of opening it.
      const browserless = process.platform === "win32" ? {} : { BROWSER: "true" };
      child = spawnCli(this.options.cli, ["auth", "login"], {
        env: { ...flow.env, ...browserless, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      this.finish(flow, "failed", "Claude Code could not start on this server. Install or update the configured Claude CLI, then try again.");
      return;
    }
    flow.child = child;
    const receive = (chunk: Buffer) => {
      if (flow.status.phase !== "waiting") return;
      if (flow.output.length + chunk.length > MAX_OUTPUT) {
        this.finish(flow, "failed", "Claude Code returned an unexpected sign-in response. Update the server's Claude CLI and try again.");
        return;
      }
      flow.output += chunk.toString("utf8");
      if (flow.ready) return;
      const prompt = claudeLoginPrompt(flow.output);
      if (!prompt) return;
      flow.status = { ...flow.status, authorizationUrl: prompt.authorizationUrl };
      flow.ready = true;
      clearTimeout(flow.startupTimer);
      flow.resolve({ ...flow.status, phase: "waiting" });
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.once("error", (error: NodeJS.ErrnoException) => {
      const message = error.code === "ENOENT"
        ? "Claude Code is not installed on this server. Install it on the server, then try again."
        : "Claude Code could not start on this server. Check the configured CLI path and its executable permissions.";
      this.finish(flow, "failed", message);
    });
    child.once("close", (code) => {
      if (flow.child === child) flow.child = null;
      if (flow.status.phase !== "waiting") return;
      const output = stripVTControlCharacters(flow.output);
      flow.output = "";
      // The CLI's exit is the verdict; the login status command is the proof.
      void this.signedIn(flow.env).then((signedIn) => {
        if (flow.status.phase !== "waiting") return;
        if (signedIn) {
          this.finish(flow, "succeeded");
          return;
        }
        this.finish(flow, "failed", flow.codeSent
          ? /invalid|expired|denied|rejected/i.test(output)
            ? "Anthropic did not accept that code. Start sign-in again and paste the whole code it shows."
            : "Claude Code finished but is not signed in. Start sign-in again."
          : code === 0
            ? "Claude Code finished but is not signed in. Start sign-in again."
            : "Claude Code stopped before the sign-in finished. Check the server's connection and try again.");
      });
    });
  }

  private finish(flow: Flow, phase: Exclude<ProviderAuthenticationStatus["phase"], "waiting">, message?: string): void {
    if (flow.status.phase !== "waiting") return;
    clearTimeout(flow.startupTimer);
    clearTimeout(flow.expiryTimer);
    flow.status = {
      phase,
      flowId: flow.status.flowId,
      authorizationUrl: null,
      expiresAt: null,
      ...(phase !== "succeeded" && message ? { message } : {}),
    };
    flow.output = "";
    if (!flow.ready) {
      if (phase === "succeeded") flow.resolve({ ...flow.status, phase });
      else flow.reject(new Error(message ?? "Claude sign-in did not finish."));
    }
    if (flow.completion) {
      if (phase === "succeeded") flow.completion.resolve();
      else flow.completion.reject(new Error(message ?? "Claude sign-in did not finish."));
      flow.completion = undefined;
    }
    flow.stopping = this.stopChild(flow.child)
      .catch(() => false)
      .then((stopped) => {
        const release = () => authenticatingHomes.delete(flow.homeKey);
        if (stopped) {
          release();
          return;
        }
        flow.terminationFailed = true;
        flow.status = { ...flow.status, phase: "failed", message: "Claude Code could not be stopped on this server. Ask the server administrator to stop the login process before trying again." };
        const child = flow.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) release();
        else child.once("close", release);
      });
    if (phase === "succeeded") void this.options.onAuthenticated?.().catch(() => {});
  }

  private async stopChild(child: ChildProcess | null): Promise<boolean> {
    if (!child || (await killCliTree(child, this.options.terminateTimeoutMs ?? 1500))) return true;
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    } else child.kill("SIGKILL");
    await new Promise<void>((resolveStop) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolveStop();
      const timer = setTimeout(resolveStop, 1500);
      timer.unref();
      child.once("close", () => {
        clearTimeout(timer);
        resolveStop();
      });
    });
    return child.exitCode !== null || child.signalCode !== null;
  }
}
