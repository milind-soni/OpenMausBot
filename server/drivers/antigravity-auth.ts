// One Google sign-in at a time for an Antigravity account on the pinned runtime, run by its own `authenticate`. The native
// CLI signs in through `acp --login` (antigravity-native-login.ts).
//
// Adapted from pingdotgg/t3code@b9bc03869e, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified:
//   - apps/server/src/provider/AntigravityAuth.ts:33-47, 117-141, 231-250,
//     321-333, 434-480 (the sign-in's phases, its fixed failure lines, expiry,
//     and one accepted redirect per sign-in), on promises instead of fibers;
//     the link is returned by `start` and the redirect can go through a
//     relay into a boxed runtime.
import { randomUUID } from "node:crypto";

import { botBox } from "../bot-box/box.ts";
import type { ProviderAuthenticationStart, ProviderAuthenticationStatus } from "../contracts.ts";
import {
  AntigravityAcpClient,
  STARTUP_TIMEOUT_MS,
  forwardAntigravityCallback,
  parseAntigravityAuthorizationUrl,
  validateAntigravityCallbackUrl,
  type AntigravityProfile,
} from "./antigravity-acp.ts";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";

const AUTH_TIMEOUT_MS = 5 * 60_000;

const EXPIRED = "Google sign-in expired. Start sign-in again.";
const CANCELLED = "Google sign-in was cancelled.";
const FAILED = "Google sign-in failed. Start sign-in again.";
const NOT_APPROVED = "Google sign-in was not approved. Start sign-in again.";
const NOT_ELIGIBLE = "Google requires an eligible Antigravity subscription for this account.";
const NOT_DELIVERED = "Could not deliver the sign-in response. If Google already finished in your browser, wait a moment. Otherwise send it again.";
const ALREADY_SENT = "The sign-in response was already sent. Wait for Google to finish.";

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

  async start(runtime: AntigravityRuntime, profile: AntigravityProfile): Promise<ProviderAuthenticationStart> {
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
