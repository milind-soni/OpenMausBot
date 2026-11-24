// One Google sign-in at a time for an instance run by the native Antigravity CLI's `acp --login`.
//
// With piped output the CLI prints Google's authorization link, then reads one line from stdin: the authorization
// code, or the full address of the page Google ends on (https://antigravity.google/oauth-callback). It opens no
// browser and needs no listener on this machine, so a boxed runtime, a remote server and a desktop all sign in the
// same way. Nothing the CLI prints after the link reaches the person: it can carry the code.
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { killCliTree, spawnCli } from "../procs.ts";
import type { ProviderAuthenticationStart, ProviderAuthenticationStatus } from "../contracts.ts";
import { STARTUP_TIMEOUT_MS, type AntigravityProfile } from "./antigravity-acp.ts";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";

export const ANTIGRAVITY_LOGIN_REDIRECT = "https://antigravity.google/oauth-callback";

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const SUBMIT_TIMEOUT_MS = 60_000;
const EXIT_CONFIRM_MS = 10_000;
const MAX_LINK_CHARS = 16_384;
const MAX_OUTPUT_BEFORE_LINK = 64 * 1024;
const MAX_CODE_CHARS = 2_048;
const MAX_PASTED_ADDRESS_CHARS = 16_384;

const EXPIRED = "Google sign-in expired. Start sign-in again.";
const CANCELLED = "Google sign-in was cancelled.";
const FAILED = "Google sign-in failed. Start sign-in again.";
const NOT_APPROVED = "Google sign-in was not approved. Start sign-in again.";
const NO_LINK = "Google sign-in did not return a link. Start sign-in again.";
const BAD_LINK = "Antigravity returned an invalid Google sign-in link.";
const ALREADY_SENT = "The sign-in code was already sent. Wait for Google to finish.";
const INACTIVE = "This Google sign-in is no longer active. Start again.";
const STILL_RUNNING = "The Antigravity sign-in in progress could not be stopped. Try again.";

export function antigravityLoginArgs(profileDirectory: string): string[] {
  return ["acp", "--login", "--gemini-dir", profileDirectory, "--app-data-dir", "antigravity-acp"];
}

/** The authorization link in what the CLI printed, found by its shape and not its wording: the first address in full,
 * which must be Google's own host with the callback page as the redirect and a code response. Null while none has been
 * printed in full; throws when the first is not the sign-in's. */
export function antigravityLoginLink(output: string): { authorizationUrl: string; state: string | null } | null {
  const token = /https?:\/\/\S+(?=\s)/u.exec(output)?.[0];
  if (token === undefined) return null;
  if (token.length > MAX_LINK_CHARS) throw new Error(BAD_LINK);
  let url: URL;
  try { url = new URL(token); } catch { throw new Error(BAD_LINK); }
  const state = url.searchParams.get("state");
  if (
    url.origin !== "https://accounts.google.com" || !url.pathname.startsWith("/o/oauth2/")
    || url.username || url.password || url.hash
    || url.searchParams.getAll("redirect_uri").length !== 1 || url.searchParams.get("redirect_uri") !== ANTIGRAVITY_LOGIN_REDIRECT
    || url.searchParams.getAll("response_type").length !== 1 || url.searchParams.get("response_type") !== "code"
    || (state !== null && (state.length > 512 || /\s/u.test(state)))
  ) throw new Error(BAD_LINK);
  return { authorizationUrl: token, state };
}

/** The one line to hand the CLI for what the person pasted: an authorization code, or the callback page's address with a
 * code in it (and this sign-in's `state`, when both name one). Throws the line to show when it is neither. */
export function antigravityLoginInput(pending: { state: string | null }, pasted: string): string {
  const text = pasted.trim();
  if (!text) throw new Error("Paste the authorization code, or the full address of the page Google ended on.");
  if (/[\r\n\0]/u.test(text)) throw new Error("Paste only the authorization code, or the full address of the page Google ended on.");
  if (!/^https?:\/\//iu.test(text)) {
    if (text.length > MAX_CODE_CHARS || !/^[\w./~+=%-]+$/u.test(text)) throw new Error("That does not look like an authorization code. Paste the code Google shows, or the page's full address.");
    return text;
  }
  if (text.length > MAX_PASTED_ADDRESS_CHARS) throw new Error("The pasted address is too long.");
  let url: URL;
  try { url = new URL(text); } catch { throw new Error("Paste the full address of the page Google ended on."); }
  if (url.origin !== new URL(ANTIGRAVITY_LOGIN_REDIRECT).origin || url.pathname !== new URL(ANTIGRAVITY_LOGIN_REDIRECT).pathname || url.username || url.password) {
    throw new Error("That address is not the page Google ends on after sign-in. Paste the code Google shows, or that page's full address.");
  }
  const codes = url.searchParams.getAll("code");
  if (url.searchParams.has("error")) throw new Error(NOT_APPROVED);
  if (codes.length !== 1 || !codes[0]) throw new Error("That address has no sign-in code. Paste the page's full address after Google finishes.");
  const states = url.searchParams.getAll("state");
  if (states.length > 1 || (states.length === 1 && pending.state !== null && states[0] !== pending.state)) {
    throw new Error("That address belongs to another sign-in. Start again from the link above.");
  }
  return text;
}

interface LoginFlow {
  id: string;
  child: ReturnType<typeof spawnCli>;
  state: string | null;
  expiresAt: number;
  submitted: boolean;
  exited: Promise<number | null>;
  /** Resolves when the sign-in succeeded; rejects with one of the fixed lines. */
  settled: Promise<void>;
  settle: { resolve(): void; reject(error: Error): void };
  timer: ReturnType<typeof setTimeout>;
}

export interface NativeLoginHooks {
  signedIn(): void;
  /** Whether the CLI accepts a session after it gave no exit in time. */
  confirm?(): Promise<boolean>;
}

/** Every `--login` process started that has not exited yet, ended flows included: one that outlived its kill can still
 * write the sign-in it was given. */
export type LoginProcesses = Map<ReturnType<typeof spawnCli>, Promise<number | null>>;

export class AntigravityCliLogin {
  #flow: LoginFlow | null = null;
  readonly #alive: LoginProcesses;
  #ended: ProviderAuthenticationStatus | null = null;
  #cancels = 0;
  readonly #hooks: NativeLoginHooks;
  readonly #timing: { startupMs: number; submitMs: number; lifetimeMs: number; exitConfirmMs: number };

  /** `alive`: the instance's `--login` processes, shared with a controller the instance is rebuilt with. */
  constructor(
    hooks: NativeLoginHooks,
    timing: Partial<{ startupMs: number; submitMs: number; lifetimeMs: number; exitConfirmMs: number }> = {},
    alive: LoginProcesses = new Map(),
  ) {
    this.#hooks = hooks;
    this.#alive = alive;
    this.#timing = { startupMs: STARTUP_TIMEOUT_MS, submitMs: SUBMIT_TIMEOUT_MS, lifetimeMs: LOGIN_TIMEOUT_MS, exitConfirmMs: EXIT_CONFIRM_MS, ...timing };
  }

  get active(): boolean {
    return this.#flow !== null;
  }

  async start(runtime: AntigravityRuntime, profile: AntigravityProfile): Promise<ProviderAuthenticationStart & { kind: "pasted-code" }> {
    const cancels = this.#cancels + 1;
    if (!(await this.cancel())) throw new Error(STILL_RUNNING);
    if (this.#cancels !== cancels) throw new Error(CANCELLED);
    // Without a display it can only print the link, as it does with piped output: no browser opens on this machine.
    const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, ...env } = profile.environment;
    const child = spawnCli(
      runtime.executablePath,
      antigravityLoginArgs(profile.directory),
      { cwd: profile.directory, env, stdio: ["pipe", "pipe", "pipe"], box: { ro: [join(profile.directory, "omb-skills")] } },
      "bot",
    );
    child.stdin.on("error", () => {});
    child.stderr.resume();
    const exited = new Promise<number | null>((resolveExit) => {
      child.once("close", (code) => resolveExit(code));
      child.once("error", () => { if (child.pid === undefined) resolveExit(null); });
    });
    this.#alive.set(child, exited);
    void exited.then(() => this.#alive.delete(child));
    let output = "";
    let found: ReturnType<typeof antigravityLoginLink> = null;
    let onLink!: (link: NonNullable<ReturnType<typeof antigravityLoginLink>>) => void;
    let onBad!: (error: Error) => void;
    const linked = new Promise<NonNullable<ReturnType<typeof antigravityLoginLink>>>((resolveLink, rejectLink) => { onLink = resolveLink; onBad = rejectLink; });
    linked.catch(() => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (found) return;
      output += chunk;
      try {
        found = antigravityLoginLink(output);
      } catch (error) {
        output = "";
        found = null;
        return onBad(error as Error);
      }
      if (found) { output = ""; onLink(found); }
      else if (output.length > MAX_OUTPUT_BEFORE_LINK) { output = ""; onBad(new Error(NO_LINK)); }
    });
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const link = await Promise.race([
        linked,
        exited.then(() => { throw new Error(NO_LINK); }),
        new Promise<never>((_resolve, reject) => {
          startupTimer = setTimeout(() => reject(new Error(NO_LINK)), this.#timing.startupMs);
          startupTimer.unref?.();
        }),
      ]);
      if (startupTimer) clearTimeout(startupTimer);
      if (this.#cancels !== cancels) throw new Error(CANCELLED);
      const flow = this.#open(child, exited, link.state);
      return { phase: "waiting", flowId: flow.id, authorizationUrl: link.authorizationUrl, expiresAt: new Date(flow.expiresAt).toISOString(), kind: "pasted-code" };
    } catch (error) {
      if (startupTimer) clearTimeout(startupTimer);
      await killCliTree(child).catch(() => false);
      throw this.#cancels !== cancels ? new Error(CANCELLED) : error;
    }
  }

  #open(child: LoginFlow["child"], exited: Promise<number | null>, state: string | null): LoginFlow {
    let settle!: LoginFlow["settle"];
    const settled = new Promise<void>((resolveDone, rejectDone) => { settle = { resolve: resolveDone, reject: rejectDone }; });
    settled.catch(() => {});
    const flow: LoginFlow = {
      id: randomUUID(), child, state, expiresAt: Date.now() + this.#timing.lifetimeMs, submitted: false, exited, settled, settle,
      timer: setTimeout(() => {
        if (flow.submitted || !this.#end(flow, "expired", EXPIRED)) return;
        flow.settle.reject(new Error(EXPIRED));
        void killCliTree(child).catch(() => false);
      }, this.#timing.lifetimeMs),
    };
    flow.timer.unref?.();
    this.#flow = flow;
    void exited.then((code) => {
      clearTimeout(flow.timer);
      if (this.#flow !== flow) return;
      if (flow.submitted && code === 0) {
        this.#end(flow, "succeeded");
        this.#hooks.signedIn();
        flow.settle.resolve();
      } else {
        this.#end(flow, "failed", FAILED);
        flow.settle.reject(new Error(FAILED));
      }
    });
    return flow;
  }

  #end(flow: LoginFlow, phase: Exclude<ProviderAuthenticationStatus["phase"], "waiting" | "verifying">, message?: string): boolean {
    if (this.#flow !== flow) return false;
    this.#flow = null;
    this.#ended = { phase, flowId: flow.id, authorizationUrl: null, expiresAt: null, ...(message ? { message } : {}) };
    return true;
  }

  async get(flowId: string): Promise<ProviderAuthenticationStatus> {
    const flow = this.#flow;
    if (flow && flow.id === flowId) {
      return { phase: flow.submitted ? "verifying" : "waiting", flowId, authorizationUrl: null, expiresAt: new Date(flow.expiresAt).toISOString() };
    }
    if (this.#ended?.flowId === flowId) return { ...this.#ended };
    return { phase: "expired", flowId, authorizationUrl: null, expiresAt: null, message: EXPIRED };
  }

  /** Gives the CLI what the person pasted and waits for it to finish: exit 0 is signed in. */
  async complete(flowId: string, pasted: string): Promise<void> {
    const flow = this.#flow;
    if (!flow || flow.id !== flowId || Date.now() >= flow.expiresAt) throw new Error(INACTIVE);
    if (flow.submitted) throw new Error(ALREADY_SENT);
    const line = antigravityLoginInput(flow, pasted);
    flow.submitted = true;
    try {
      await new Promise<void>((resolveWrite, rejectWrite) => flow.child.stdin.write(`${line}\n`, (error) => error ? rejectWrite(error) : resolveWrite()));
    } catch {
      if (this.#end(flow, "failed", FAILED)) flow.settle.reject(new Error(FAILED));
      await killCliTree(flow.child).catch(() => false);
      throw new Error(FAILED);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolveLate) => {
      timer = setTimeout(() => resolveLate("late"), this.#timing.submitMs);
      timer.unref?.();
    });
    try {
      if ((await Promise.race([flow.settled.then(() => "done" as const), late])) === "done") return;
    } finally {
      if (timer) clearTimeout(timer);
    }
    // No exit in time: a CLI that signed in and stayed up is told apart from one that is stuck.
    const accepted = await this.#hooks.confirm?.().catch(() => false);
    if (this.#flow === flow) {
      if (accepted) {
        this.#end(flow, "succeeded");
        this.#hooks.signedIn();
        flow.settle.resolve();
      } else {
        this.#end(flow, "failed", FAILED);
        flow.settle.reject(new Error(FAILED));
      }
      await killCliTree(flow.child).catch(() => false);
    }
    await flow.settled;
  }

  /** Ends the sign-in in progress and resolves true once every `--login` process started here is gone. */
  async cancel(): Promise<boolean> {
    this.#cancels += 1;
    const flow = this.#flow;
    if (flow) {
      this.#end(flow, "cancelled", CANCELLED);
      clearTimeout(flow.timer);
      flow.settle.reject(new Error(CANCELLED));
      try { flow.child.stdin.end(); } catch {}
    }
    await Promise.all([...this.#alive].map(async ([child, exited]) => {
      await killCliTree(child).catch(() => false);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exited, new Promise((resolveWait) => { timer = setTimeout(resolveWait, this.#timing.exitConfirmMs); timer.unref?.(); })]);
      if (timer) clearTimeout(timer);
    }));
    return this.#alive.size === 0;
  }
}
