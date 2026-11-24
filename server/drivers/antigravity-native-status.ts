// What the native Antigravity CLI says about the Google account an instance is signed in with, and signing it out.
//
// The CLI keeps its sign-in in the profile's file (antigravity-acp.ts starts it as over SSH) and has no status command,
// and the file says nothing of whether Google still honours it: the answer is
// whether `session/new` is accepted. `-32000 Authentication required` is signed out; anything else that stops the
// answer (a timeout, a crash) says nothing, and is thrown, never counted as signed out.
import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  AntigravityAcpClient,
  antigravitySessionSetup,
  type AntigravityProfile,
} from "./antigravity-acp.ts";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";
import { ANTIGRAVITY_CLI_TOKEN_FILE } from "./antigravity-cli-install.ts";
import { acpVendorMessage } from "./acp/rpc-error.ts";

export type NativeSignIn = "in" | "out";

export interface NativeProbeTiming {
  initializeMs?: number;
  capMs?: number;
  requestMs?: number;
  /** Every CLI process started, so a sign-out can wait for it. */
  onProcess?: (child: ChildProcess) => void;
}

const INITIALIZE_WINDOW_MS = 20_000;
const INITIALIZE_CAP_MS = 60_000;
const REQUEST_MS = 30_000;
const SESSION_CLOSE_MS = 5_000;
/** How long a signed-out answer stands, so a sign-in made at a terminal shows. */
export const SIGN_IN_CACHE_MS = 30_000;

/** The native CLI's own answer to a session it will not start without a sign-in (1.5.14: `-32000 Authentication
 * required`). Another `-32000`, such as a sign-in service that is down, says nothing about the sign-in. */
export function antigravityCliRefusedSession(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown } | null;
  const message = acpVendorMessage(error) ?? value?.message;
  return value?.code === -32000 && typeof message === "string" && /^\s*(?:.*?\bbackground\s+)?(?:authentication|sign[- ]?in|log[- ]?in) (?:is )?required[.!]?\s*$/iu.test(message);
}

const advertised = (value: unknown) => value === true || (typeof value === "object" && value !== null && !Array.isArray(value));

/** The CLI's own file store for the sign-in: the only one it uses as this app starts it. */
export const antigravityNativeTokenPath = (profile: Pick<AntigravityProfile, "directory">) =>
  join(profile.directory, "antigravity-acp", ANTIGRAVITY_CLI_TOKEN_FILE);

/** Runs `work` on a new CLI process and ends it; with `waitForExit` the process is gone before this resolves, or it throws. */
async function withCli<T>(
  runtime: AntigravityRuntime,
  profile: AntigravityProfile,
  timing: NativeProbeTiming & { waitForExit?: boolean },
  work: (client: AntigravityAcpClient) => Promise<T>,
): Promise<T> {
  const client = new AntigravityAcpClient(runtime, profile, profile.directory);
  timing.onProcess?.(client.child);
  const result = await work(client).then((value) => ({ value }), (error: unknown) => ({ error }));
  if (!timing.waitForExit) client.close();
  else if (!(await client.closeAndWait())) throw new Error("Antigravity did not shut down when asked to.");
  if ("error" in result) throw result.error;
  return result.value;
}

/** `waitForExit`: the process is gone before this resolves, for a check that must not race what the CLI may still write. */
export async function antigravityCliSignIn(
  runtime: AntigravityRuntime,
  profile: AntigravityProfile,
  timing: NativeProbeTiming & { waitForExit?: boolean } = {},
): Promise<NativeSignIn> {
  return await withCli(runtime, profile, timing, async (client) => {
    const initialized = await client.initialize(timing.initializeMs ?? INITIALIZE_WINDOW_MS, Date.now() + (timing.capMs ?? INITIALIZE_CAP_MS));
    let session: { sessionId?: unknown } | undefined;
    try {
      session = await client.request(
        "session/new",
        { cwd: profile.directory, mcpServers: [], ...antigravitySessionSetup(initialized) },
        timing.requestMs ?? REQUEST_MS,
      );
    } catch (error) {
      if (antigravityCliRefusedSession(error)) return "out";
      throw error;
    }
    if (advertised(initialized?.agentCapabilities?.sessionCapabilities?.close) && typeof session?.sessionId === "string") {
      await client.request("session/close", { sessionId: session.sessionId }, SESSION_CLOSE_MS).catch(() => {});
    }
    return "in";
  });
}

/** Asks the CLI to forget its sign-in, then removes the file store it may have used, and with `files: "all"` the pinned
 * runtime's token file too. A refused `logout` is not final: the sign-out is judged by a new session afterwards. */
async function logoutAndForget(runtime: AntigravityRuntime, profile: AntigravityProfile, timing: NativeProbeTiming, files: NativeSignOutFiles): Promise<void> {
  await withCli(runtime, profile, { ...timing, waitForExit: true }, async (client) => {
    const initialized = await client.initialize(timing.initializeMs ?? INITIALIZE_WINDOW_MS, Date.now() + (timing.capMs ?? INITIALIZE_CAP_MS));
    if (advertised(initialized?.agentCapabilities?.auth?.logout)) await client.request("logout", {}, timing.requestMs ?? REQUEST_MS).catch(() => {});
  });
  for (const file of files === "all" ? [antigravityNativeTokenPath(profile), profile.tokenPath] : [antigravityNativeTokenPath(profile)]) {
    await rm(file, { force: true, recursive: true, maxRetries: 4, retryDelay: 250 });
  }
}

/** Signs the profile out through the CLI and confirms with a new process that it no longer accepts a session. */
export type NativeSignOutFiles = "all" | "native";

export async function signOutAntigravityCli(runtime: AntigravityRuntime, profile: AntigravityProfile, timing: NativeProbeTiming = {}, files: NativeSignOutFiles = "all"): Promise<void> {
  await logoutAndForget(runtime, profile, timing, files);
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

/** What the CLI last said about each instance. Signed out is kept for `ttlMs`; signed in stands until `forget`, since
 * asking starts a whole CLI that opens a conversation with Google (1.5.14). A read that began before `forget` never
 * writes back after it, so a sign-out cannot be undone by a check that started earlier. */
export class NativeSignInCache {
  readonly #entries = new Map<string, Entry>();
  readonly #generations = new Map<string, number>();
  readonly #reading = new Map<string, { generation: number; runtime: string; read: Promise<NativeSignIn> }>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? SIGN_IN_CACHE_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  #generation(instanceId: string): number {
    return this.#generations.get(instanceId) ?? 0;
  }

  #fresh(instanceId: string, runtime: string): Entry | undefined {
    const known = this.#entries.get(instanceId);
    const age = known ? this.#now() - known.at : -1;
    const standing = known?.state === "in" || (age >= 0 && age < this.#ttlMs);
    return known && known.generation === this.#generation(instanceId) && known.runtime === runtime && standing ? known : undefined;
  }

  /** What the CLI last said, while it still stands; undefined when it has to be asked. */
  known(instanceId: string, runtime: string): NativeSignIn | undefined {
    return this.#fresh(instanceId, runtime)?.state;
  }

  /** Keeps what another request to the CLI learned, such as a session it accepted, unless `forget` came after `seen` was
   * made. */
  seen(instanceId: string, runtime: string): (state: NativeSignIn) => void {
    const generation = this.#generation(instanceId);
    return (state) => {
      if (this.#generation(instanceId) === generation) this.#entries.set(instanceId, { state, at: this.#now(), generation, runtime });
    };
  }

  /** `runtime` names the executable and version asked, so a switch of runtime is a new question. A failed read is not kept. */
  async state(instanceId: string, runtime: string, read: () => Promise<NativeSignIn>): Promise<NativeSignIn> {
    const generation = this.#generation(instanceId);
    const known = this.#fresh(instanceId, runtime);
    if (known) return known.state;
    const running = this.#reading.get(instanceId);
    if (running && running.generation === generation && running.runtime === runtime) return running.read;
    const keep = this.seen(instanceId, runtime);
    const current = { generation, runtime, read: read().then((state) => { keep(state); return state; }) };
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
