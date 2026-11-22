// What the native Antigravity CLI says about the Google account an instance is signed in with, and signing it out.
//
// The CLI keeps its sign-in in the OS keyring (or a file in the profile) and has no status command: the answer is
// whether `session/new` is accepted. `-32000 Authentication required` is signed out; anything else that stops the
// answer (a timeout, a crash) says nothing, and is thrown, never counted as signed out.
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  AntigravityAcpClient,
  antigravitySessionSetup,
  antigravitySignInError,
  type AntigravityProfile,
} from "./antigravity-acp.ts";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";

export type NativeSignIn = "in" | "out";

export interface NativeProbeTiming {
  initializeMs?: number;
  capMs?: number;
  requestMs?: number;
}

const INITIALIZE_WINDOW_MS = 20_000;
const INITIALIZE_CAP_MS = 60_000;
const REQUEST_MS = 30_000;
const SESSION_CLOSE_MS = 5_000;
export const SIGN_IN_CACHE_MS = 30_000;

const advertised = (value: unknown) => value === true || (typeof value === "object" && value !== null && !Array.isArray(value));

/** The CLI's own file store for the sign-in, which it falls back to when the keyring is unavailable. */
export const antigravityNativeTokenPath = (profile: Pick<AntigravityProfile, "directory">) =>
  join(profile.directory, "antigravity-acp", "antigravity-oauth-token");

/** `waitForExit`: the process is gone before this resolves, for a check that must not race what the CLI may still write. */
export async function antigravityCliSignIn(
  runtime: AntigravityRuntime,
  profile: AntigravityProfile,
  timing: NativeProbeTiming & { waitForExit?: boolean } = {},
): Promise<NativeSignIn> {
  const client = new AntigravityAcpClient(runtime, profile, profile.directory);
  try {
    const initialized = await client.initialize(timing.initializeMs ?? INITIALIZE_WINDOW_MS, Date.now() + (timing.capMs ?? INITIALIZE_CAP_MS));
    let session: { sessionId?: unknown } | undefined;
    try {
      session = await client.request(
        "session/new",
        { cwd: profile.directory, mcpServers: [], ...antigravitySessionSetup(initialized) },
        timing.requestMs ?? REQUEST_MS,
      );
    } catch (error) {
      if (antigravitySignInError(error)) return "out";
      throw error;
    }
    if (advertised(initialized?.agentCapabilities?.sessionCapabilities?.close) && typeof session?.sessionId === "string") {
      await client.request("session/close", { sessionId: session.sessionId }, SESSION_CLOSE_MS).catch(() => {});
    }
    return "in";
  } finally {
    if (timing.waitForExit) await client.closeAndWait();
    else client.close();
  }
}

/** Asks the CLI to forget its sign-in, then removes the file store it may have used. A refused `logout` is not final:
 * the sign-out is judged by a new session afterwards. */
async function logoutAndForget(runtime: AntigravityRuntime, profile: AntigravityProfile, timing: NativeProbeTiming): Promise<void> {
  const client = new AntigravityAcpClient(runtime, profile, profile.directory);
  try {
    const initialized = await client.initialize(timing.initializeMs ?? INITIALIZE_WINDOW_MS, Date.now() + (timing.capMs ?? INITIALIZE_CAP_MS));
    if (advertised(initialized?.agentCapabilities?.auth?.logout)) await client.request("logout", {}, timing.requestMs ?? REQUEST_MS).catch(() => {});
  } finally {
    await client.closeAndWait();
  }
  for (const file of [antigravityNativeTokenPath(profile), profile.tokenPath]) {
    await rm(file, { force: true, maxRetries: 4, retryDelay: 250 });
  }
}

/** Signs the profile out through the CLI and confirms with a new process that it no longer accepts a session. */
export async function signOutAntigravityCli(runtime: AntigravityRuntime, profile: AntigravityProfile, timing: NativeProbeTiming = {}): Promise<void> {
  await logoutAndForget(runtime, profile, timing);
  let state: NativeSignIn | "unknown";
  try {
    state = await antigravityCliSignIn(runtime, profile, { ...timing, waitForExit: true });
  } catch {
    state = "unknown";
  }
  if (state === "in") throw new Error("Antigravity still reports a Google sign-in for this account. Update Antigravity and check its sign-in before trying again.");
  if (state === "unknown") throw new Error("Antigravity could not confirm the sign-out for this account. Update Antigravity and check its sign-in before trying again.");
}

interface Entry {
  state: NativeSignIn;
  at: number;
  generation: number;
  runtime: string;
}

/** What the CLI last said about each instance, kept for `ttlMs`. A read that began before `forget` never writes back
 * after it, so a sign-out cannot be undone by a check that started earlier. */
export class NativeSignInCache {
  readonly #entries = new Map<string, Entry>();
  readonly #generations = new Map<string, number>();
  readonly #reading = new Map<string, { generation: number; runtime: string; read: Promise<NativeSignIn> }>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? SIGN_IN_CACHE_MS;
    this.#now = options.now ?? Date.now;
  }

  #generation(instanceId: string): number {
    return this.#generations.get(instanceId) ?? 0;
  }

  /** `runtime` names the executable and version asked, so a switch of runtime is a new question. A failed read is not kept. */
  async state(instanceId: string, runtime: string, read: () => Promise<NativeSignIn>): Promise<NativeSignIn> {
    const generation = this.#generation(instanceId);
    const known = this.#entries.get(instanceId);
    if (known && known.generation === generation && known.runtime === runtime && this.#now() - known.at < this.#ttlMs && this.#now() >= known.at) return known.state;
    const running = this.#reading.get(instanceId);
    if (running && running.generation === generation && running.runtime === runtime) return running.read;
    const current = { generation, runtime, read: read().then((state) => {
      if (this.#generation(instanceId) === generation) this.#entries.set(instanceId, { state, at: this.#now(), generation, runtime });
      return state;
    }) };
    this.#reading.set(instanceId, current);
    const clear = () => { if (this.#reading.get(instanceId) === current) this.#reading.delete(instanceId); };
    current.read.then(clear, clear);
    return current.read;
  }

  /** The next question asks the CLI again: a sign-in, sign-out, runtime switch or refusal changed the answer. */
  forget(instanceId: string): void {
    this.#generations.set(instanceId, this.#generation(instanceId) + 1);
    this.#entries.delete(instanceId);
    this.#reading.delete(instanceId);
  }
}
