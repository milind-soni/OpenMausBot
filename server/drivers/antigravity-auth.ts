// One Google sign-in at a time for an Antigravity account: the pinned runtime's own `authenticate`, or the native
// CLI's `--login`.
//
// Adapted from pingdotgg/t3code@b9bc03869e, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified:
//   - apps/server/src/provider/AntigravityAuth.ts:33-47, 117-141, 231-250,
//     321-333, 434-480 (the sign-in's phases, its fixed failure lines, expiry,
//     and one accepted redirect per sign-in), on promises instead of fibers;
//     the link is returned by `start` and the redirect can go through a
//     relay into a boxed runtime;
//   - apps/server/src/provider/Drivers/AntigravityDriver.ts:422-494 and
//     apps/server/src/provider/AntigravityAuth.ts:330-345, 540-568 at
//     38067630229 (the native CLI's `--login`: a separate process that prints
//     Google's link and reads the code the Antigravity page shows on stdin,
//     with no display so it opens no browser here).
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { botBox } from "../bot-box/box.ts";
import type { ProviderAuthenticationStart, ProviderAuthenticationStatus } from "../contracts.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import {
  AntigravityAcpClient,
  STARTUP_TIMEOUT_MS,
  antigravityLaunchArgs,
  antigravityLoginResponse,
  authorizationUrlFromLine,
  forwardAntigravityCallback,
  parseAntigravityAuthorizationUrl,
  validateAntigravityCallbackUrl,
  type AntigravityProfile,
} from "./antigravity-acp.ts";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";

const AUTH_TIMEOUT_MS = 5 * 60_000;
const LOGIN_LINE_MAX_CHARS = 64 * 1024;

const EXPIRED = "Google sign-in expired. Start sign-in again.";
const CANCELLED = "Google sign-in was cancelled.";
const FAILED = "Google sign-in failed. Start sign-in again.";
const NOT_APPROVED = "Google sign-in was not approved. Start sign-in again.";
const NOT_ELIGIBLE = "Google requires an eligible Antigravity subscription for this account.";
const NOT_DELIVERED = "Could not deliver the sign-in response. If Google already finished in your browser, wait a moment. Otherwise send it again.";
const ALREADY_SENT = "The sign-in response was already sent. Wait for Google to finish.";
const NOT_A_CODE = "Paste the code from the Antigravity page, or that page's full address.";

class SignInExpired extends Error {}

/** Only these fixed lines reach the person: the runtime's own words can carry an authorization code. */
function failureLine(error: unknown): { phase: "failed" | "expired"; message: string } {
  if (error instanceof SignInExpired) return { phase: "expired", message: EXPIRED };
  const words = error instanceof Error ? error.message : "";
  if (words.includes("SUBSCRIPTION_REQUIRED")) return { phase: "failed", message: NOT_ELIGIBLE };
  if (/access_denied|denied access|cancelled/iu.test(words)) return { phase: "failed", message: NOT_APPROVED };
  return { phase: "failed", message: FAILED };
}

interface AuthFlow {
  id: string;
  /** Rejects with one of the fixed lines. */
  completed: Promise<void>;
  pending: { redirectUri: string; state: string };
  expiresAt: number;
  /** The runtime takes one response: a second would be read as another sign-in's. Cleared when a delivery fails, which
   * the listener having closed after the browser's own redirect also looks like. */
  callbackSent: boolean;
  /** What the person pasted, checked against this sign-in; throws a line for the person when it does not answer it. */
  accept(pasted: string): string;
  /** Hands an accepted answer to the runtime. */
  send(accepted: string): Promise<void>;
  close(): void;
}

export class AntigravityAuthController {
  private flow: AuthFlow | null = null;
  private ended: ProviderAuthenticationStatus | null = null;
  private readonly onSignedIn: () => void;

  constructor(onSignedIn: () => void = () => {}) {
    this.onSignedIn = onSignedIn;
  }

  /** The native CLI signs in through `--login`; the pinned runtime through `authenticate` and its loopback listener. */
  start(runtime: AntigravityRuntime, profile: AntigravityProfile): Promise<ProviderAuthenticationStart> {
    return runtime.harnessPath === null ? this.startCodeLogin(runtime, profile) : this.startLoopback(runtime, profile);
  }

  private async startLoopback(runtime: AntigravityRuntime, profile: AntigravityProfile): Promise<ProviderAuthenticationStart> {
    this.cancel();
    let foundUrl!: (value: ReturnType<typeof parseAntigravityAuthorizationUrl>) => void;
    let failUrl!: (error: Error) => void;
    const urlPromise = new Promise<ReturnType<typeof parseAntigravityAuthorizationUrl>>((resolveUrl, reject) => {
      foundUrl = resolveUrl;
      failUrl = reject;
    });
    const relay = await botBox.openRelay();
    let client: AntigravityAcpClient;
    try {
      client = new AntigravityAcpClient(runtime, profile, profile.directory, (url) => {
        try { foundUrl(parseAntigravityAuthorizationUrl(url)); }
        catch (error) { failUrl(error instanceof Error ? error : new Error(String(error))); }
      }, relay ?? undefined);
    } catch (error) {
      relay?.close();
      throw error;
    }
    const closeAll = () => {
      client.close();
      relay?.close();
    };
    try {
      await client.initialize();
      const expiresAt = Date.now() + AUTH_TIMEOUT_MS;
      const authenticated = client.request("authenticate", { methodId: "oauth-personal" }, AUTH_TIMEOUT_MS, async () => new SignInExpired());
      const outcome = await raceStartup([
        urlPromise.then((request) => ({ kind: "url" as const, request })),
        authenticated.then(() => ({ kind: "done" as const })),
      ]);
      if (outcome.kind === "done") {
        closeAll();
        this.onSignedIn();
        return { phase: "succeeded", flowId: null, authorizationUrl: null, expiresAt: null };
      }
      const pending = { redirectUri: outcome.request.redirectUri, state: outcome.request.state };
      const flow: AuthFlow = {
        id: randomUUID(),
        completed: this.settle(() => flow, authenticated).finally(closeAll),
        pending,
        expiresAt,
        callbackSent: false,
        accept: (pasted) => validateAntigravityCallbackUrl(pending, pasted).href,
        send: (accepted) => forwardAntigravityCallback(new URL(accepted), relay ?? undefined),
        close: closeAll,
      };
      flow.completed.catch(() => {});
      this.flow = flow;
      return { phase: "waiting", flowId: flow.id, authorizationUrl: outcome.request.authorizationUrl, expiresAt: new Date(flow.expiresAt).toISOString() };
    } catch (error) {
      closeAll();
      throw error;
    }
  }

  /** `agy acp --login`: Google's link on its output, then the code the Antigravity page shows on its input. It needs no
   * listener here, so a sign-in from another computer and one inside a bot box work the same way. */
  private async startCodeLogin(runtime: AntigravityRuntime, profile: AntigravityProfile): Promise<ProviderAuthenticationStart> {
    this.cancel();
    // Without a display it prints the link only, instead of opening a browser on this machine.
    const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, ...env } = profile.environment;
    const child = spawnCli(
      runtime.executablePath,
      [...antigravityLaunchArgs(runtime, profile.directory), "--login"],
      { cwd: profile.directory, env, stdio: ["pipe", "pipe", "pipe"], box: { ro: [join(profile.directory, "omb-skills")] } },
      "bot",
    );
    let foundUrl!: (value: ReturnType<typeof parseAntigravityAuthorizationUrl>) => void;
    const urlPromise = new Promise<ReturnType<typeof parseAntigravityAuthorizationUrl>>((resolveUrl) => { foundUrl = resolveUrl; });
    const exited = new Promise<number | null>((resolveExit) => {
      child.once("close", (code) => resolveExit(code));
      child.once("error", () => resolveExit(null));
    });
    // Nothing the CLI prints reaches the person or a log: only a Google link is taken out of it.
    const watch = (stream: NodeJS.ReadableStream) => {
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        const lines = (buffer + chunk).split("\n");
        buffer = lines.pop() ?? "";
        if (buffer.length > LOGIN_LINE_MAX_CHARS) buffer = "";
        for (const raw of lines) {
          const line = raw.replace(/\r$/u, "").trim();
          const candidate = line.startsWith("https://accounts.google.com/") ? line : authorizationUrlFromLine(line);
          if (!candidate) continue;
          try { foundUrl(parseAntigravityAuthorizationUrl(candidate, "code")); } catch {}
        }
      });
    };
    watch(child.stdout!);
    watch(child.stderr!);
    const stop = () => {
      try { child.stdin?.end(); } catch {}
      void killCliTree(child).catch(() => false);
    };
    try {
      const outcome = await raceStartup([
        urlPromise.then((request) => ({ kind: "url" as const, request })),
        exited.then((code) => ({ kind: "exit" as const, code })),
      ]);
      if (outcome.kind === "exit") {
        // Exiting at once with success means it found a sign-in it could use.
        if (outcome.code === 0 && await signInFile(profile)) {
          this.onSignedIn();
          return { phase: "succeeded", flowId: null, authorizationUrl: null, expiresAt: null };
        }
        throw new Error("Antigravity could not start Google sign-in. Start sign-in again.");
      }
      const expiresAt = Date.now() + AUTH_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = new Promise<void>((resolveFinished, reject) => {
        timer = setTimeout(() => reject(new SignInExpired()), AUTH_TIMEOUT_MS);
        timer.unref?.();
        void exited.then(async (code) => {
          if (code === 0 && await signInFile(profile)) resolveFinished();
          else reject(new Error("The Antigravity CLI did not finish the sign-in."));
        });
      }).finally(() => clearTimeout(timer));
      const pending = { redirectUri: outcome.request.redirectUri, state: outcome.request.state };
      const flow: AuthFlow = {
        id: randomUUID(),
        completed: this.settle(() => flow, finished).finally(stop),
        pending,
        expiresAt,
        callbackSent: false,
        accept: (pasted) => {
          const response = antigravityLoginResponse(pending, pasted);
          if (response === undefined) throw new Error(NOT_A_CODE);
          return response;
        },
        send: (accepted) => new Promise<void>((resolveWrite, reject) => {
          child.stdin!.write(`${accepted}\n`, (error) => error ? reject(error) : resolveWrite());
        }),
        close: stop,
      };
      flow.completed.catch(() => {});
      this.flow = flow;
      return {
        phase: "waiting", flowId: flow.id, authorizationUrl: outcome.request.authorizationUrl,
        expiresAt: new Date(flow.expiresAt).toISOString(), pasteCode: true,
      };
    } catch (error) {
      stop();
      throw error;
    }
  }

  /** The flow's end: signed in, or one of the fixed lines. */
  private settle(flow: () => AuthFlow, signedIn: Promise<unknown>): Promise<void> {
    return signedIn.then(
      () => {
        if (this.end(flow(), "succeeded")) this.onSignedIn();
      },
      (error) => {
        const { phase, message } = failureLine(error);
        this.end(flow(), phase, message);
        throw new Error(message);
      },
    );
  }

  /** False when another outcome already ended this sign-in. */
  private end(flow: AuthFlow, phase: Exclude<ProviderAuthenticationStatus["phase"], "waiting" | "verifying">, message?: string): boolean {
    if (this.flow !== flow) return false;
    this.flow = null;
    this.ended = { phase, flowId: flow.id, authorizationUrl: null, expiresAt: null, ...(message ? { message } : {}) };
    return true;
  }

  async get(flowId: string): Promise<ProviderAuthenticationStatus> {
    const flow = this.flow;
    if (flow && flow.id === flowId) {
      return {
        phase: flow.callbackSent ? "verifying" : "waiting",
        flowId,
        authorizationUrl: null,
        expiresAt: new Date(flow.expiresAt).toISOString(),
      };
    }
    if (this.ended?.flowId === flowId) return { ...this.ended };
    return { phase: "expired", flowId, authorizationUrl: null, expiresAt: null, message: EXPIRED };
  }

  async complete(flowId: string, pasted: string): Promise<void> {
    const flow = this.flow;
    if (!flow || flow.id !== flowId || Date.now() >= flow.expiresAt) {
      throw new Error("This Google sign-in is no longer active. Start again.");
    }
    if (flow.callbackSent) throw new Error(ALREADY_SENT);
    const accepted = flow.accept(pasted);
    flow.callbackSent = true;
    try {
      await flow.send(accepted);
    } catch {
      flow.callbackSent = false;
      throw new Error(NOT_DELIVERED);
    }
    await flow.completed;
  }

  cancel(): void {
    const flow = this.flow;
    if (!flow || !this.end(flow, "cancelled", CANCELLED)) return;
    flow.close();
  }
}

async function signInFile(profile: AntigravityProfile): Promise<boolean> {
  const info = await stat(profile.tokenPath).catch(() => null);
  return info !== null && info.isFile() && info.size > 0;
}

async function raceStartup<A, B>(outcomes: [Promise<A>, Promise<B>]): Promise<A | B> {
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const startupTimeout = new Promise<never>((_resolve, reject) => {
    startupTimer = setTimeout(() => reject(new Error("Google sign-in did not start in time.")), STARTUP_TIMEOUT_MS);
    startupTimer.unref?.();
  });
  return Promise.race([...outcomes, startupTimeout]).finally(() => {
    if (startupTimer) clearTimeout(startupTimer);
  });
}
