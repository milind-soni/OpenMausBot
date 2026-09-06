import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { DATA_DIR, stripWorkspaceCredentialEnv } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import type { ModelCatalog } from "../contracts.ts";
import type { ChildProcess } from "node:child_process";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";

// Printed on stderr by Google's server, not stdout.
export const ANTIGRAVITY_AUTH_PREFIX = "Open the following link to authenticate the ACP server: ";
const AUTH_TIMEOUT_MS = 5 * 60_000;
// Google's packaged server can take tens of seconds to cold-start, especially
// on Windows. Match T3 Code's bounded setup allowance, not a fast CLI probe.
const STARTUP_TIMEOUT_MS = 90_000;
const MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024;
// Past the 16 KiB ceiling parseAntigravityAuthorizationUrl accepts, so a
// partial stderr line is never dropped while it could still become a link.
const MAX_DIAGNOSTIC_LINE_CHARS = 64 * 1024;

export interface AntigravityProfile {
  directory: string;
  tokenPath: string;
  environment: NodeJS.ProcessEnv;
}

const REMOVED_ENVIRONMENT_KEYS = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "ANTIGRAVITY_HARNESS_PATH",
  "BROWSER",
  "PYTHONUNBUFFERED",
  "ELECTRON_RUN_AS_NODE",
]);

const BROWSER_MARKER = "__OPENMAUS_ANTIGRAVITY_AUTH_URL__";
const browserHelperSource =
  `process.stderr.on("error",()=>process.exit(0)).write(` +
  `"${BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",` +
  `()=>process.exit(0))`;

function quoteBrowserArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Complete lines in a stream buffer, plus the unterminated tail to keep. */
function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((line) => line.replace(/\r$/u, "")), rest };
}

/** Only fixed, allowlisted startup hints leave stderr. Native output can
 * contain OAuth codes and credentials in arbitrary formats, so generic
 * text redaction is not enough to safely echo a diagnostic tail. */
function startupHint(line: string): string | undefined {
  if (/no space left|not enough (?:space|disk)|disk (?:is )?full|winerror\s*112/iu.test(line)) {
    return "The runtime reported insufficient disk space while starting.";
  }
  if (/failed to (?:extract|load (?:python|embedded python))|could not load python/iu.test(line)) {
    return "The runtime reported a problem unpacking or loading its bundled Python runtime.";
  }
  if (/permission denied|access is denied|winerror\s*5\b/iu.test(line)) {
    return "The runtime reported a file or process permission failure.";
  }
  if (/address family not supported|failed to create.*(?:socket|listener)|failed to bind/iu.test(line)) {
    return "The runtime reported a local network listener failure.";
  }
  return undefined;
}

/** The sign-in link in a server output line, or null for anything else.
 * Google announces it two ways and both land on stderr: it hands the link to
 * $BROWSER — our helper re-emits it JSON-encoded behind a private marker — and
 * it also prints the link in plain text for terminal users. Either is enough;
 * the marker form is preferred because JSON delimits the URL exactly. */
export function authorizationUrlFromLine(line: string): string | null {
  if (line.startsWith(ANTIGRAVITY_AUTH_PREFIX)) return line.slice(ANTIGRAVITY_AUTH_PREFIX.length).trim();
  if (!line.startsWith(BROWSER_MARKER)) return null;
  try {
    const url = JSON.parse(line.slice(BROWSER_MARKER.length));
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

export function antigravityProfileDirectory(instanceId: string, baseDir = DATA_DIR): string {
  return join(baseDir, "providers", "antigravity", createHash("sha256").update(instanceId).digest("hex"));
}

/** Every configured Antigravity instance gets an isolated Google profile.
 * Foreign Google credentials are deliberately stripped so selecting this
 * provider can never silently change the account or billing path. */
export async function prepareAntigravityProfile(input: {
  instanceId: string;
  runtime: AntigravityRuntime;
  baseEnv?: NodeJS.ProcessEnv;
  baseDir?: string;
  profileDirectory?: string;
}): Promise<AntigravityProfile> {
  const directory = resolve(input.profileDirectory ?? antigravityProfileDirectory(input.instanceId, input.baseDir));
  const acpDirectory = join(directory, "antigravity-acp");
  await mkdir(acpDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(directory, 0o700);
    await chmod(acpDirectory, 0o700);
  }
  writeFileAtomic(
    join(acpDirectory, "settings.json"),
    `${JSON.stringify({ auth: { type: "oauth-personal" } })}\n`,
    { mode: 0o600 },
  );

  const executable = process.platform === "win32" ? process.execPath.replaceAll("\\", "/") : process.execPath;
  if (/\r|\n|\0|%s/u.test(executable) || executable.includes(delimiter)) {
    throw new Error("The OpenMausBot runtime path cannot safely suppress Antigravity browser launches.");
  }
  const browserCommand = [executable, "-e", browserHelperSource, "--", "%s"]
    .map(quoteBrowserArgument)
    .join(" ");
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.baseEnv ?? process.env)) {
    if (!REMOVED_ENVIRONMENT_KEYS.has(key.toUpperCase())) environment[key] = value;
  }
  stripWorkspaceCredentialEnv(environment);
  Object.assign(environment, {
    GEMINI_HOME: directory,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    ANTIGRAVITY_HARNESS_PATH: input.runtime.harnessPath,
    BROWSER: browserCommand,
    PYTHONUNBUFFERED: "1",
    ELECTRON_RUN_AS_NODE: "1",
  });
  return { directory, tokenPath: join(acpDirectory, "acp_token.json"), environment };
}

export async function antigravityProfileAuthenticated(profile: AntigravityProfile): Promise<boolean> {
  try {
    const info = await stat(profile.tokenPath);
    if (!info.isFile() || info.size <= 0 || info.size > 1024 * 1024) return false;
    await readFile(profile.tokenPath, { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

interface PendingRpc {
  resolve(value: any): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Tiny dependency-free ACP client for setup/model probes. Actual chat turns
 * continue to use the shared provider-neutral ACP runtime. */
export class AntigravityAcpClient {
  readonly child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private buffer = "";
  private diagnosticBuffer = "";
  private initializationComplete = false;
  private startupOutputBytes = 0;
  private startupDiagnosticBytes = 0;
  private nativeStartupHint?: string;
  private closed = false;
  private readonly onAuthorizationUrl?: (url: string) => void;
  /** Settles once the runtime process is gone. On Windows a running
   * executable pins its file and its directory, so an installer must not
   * rename or delete either until this settles. */
  readonly exited: Promise<void>;

  constructor(
    runtime: AntigravityRuntime,
    profile: AntigravityProfile,
    cwd: string,
    onAuthorizationUrl?: (url: string) => void,
  ) {
    this.onAuthorizationUrl = onAuthorizationUrl;
    this.child = spawnCli(
      runtime.executablePath,
      process.platform === "linux" ? ["--uid="] : [],
      { cwd, env: profile.environment, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.consume(chunk));
    // Keep only sign-in announcements and fixed startup failure categories;
    // never surface raw stderr, which can contain authorization codes.
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => this.consumeDiagnostics(chunk));
    this.child.once("error", (error) => this.failAll(error));
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.noteStartupDiagnostic(this.diagnosticBuffer);
        this.diagnosticBuffer = "";
        if (!this.closed) this.failAll(new Error(
          `Antigravity ACP exited ${code ?? signal ?? "unexpectedly"}.${this.nativeStartupHint ? ` ${this.nativeStartupHint}` : ""}`,
        ));
        resolve();
      });
      // Failed spawns also emit `close`. An `error` alone can instead mean
      // a failed kill, and is not evidence that the runtime stopped.
    });
  }

  private consume(chunk: string) {
    if (!this.initializationComplete) this.startupOutputBytes += Buffer.byteLength(chunk);
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_PROTOCOL_LINE_BYTES) {
      this.failAll(new Error("Antigravity sent a protocol line that is too large."));
      this.close();
      return;
    }
    const { lines, rest } = takeLines(this.buffer);
    this.buffer = rest;
    for (const line of lines) {
      if (this.announceAuthorizationUrl(line)) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message?.id !== "number") continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message ?? "Antigravity ACP request failed.");
        Object.assign(error, { code: message.error.code, data: message.error.data });
        pending.reject(error);
      } else pending.resolve(message.result);
    }
  }

  /** Report a sign-in link if this line carries one. Returns whether the line
   * was an announcement, so callers can skip protocol parsing for it. */
  private announceAuthorizationUrl(line: string): boolean {
    const raw = authorizationUrlFromLine(line);
    if (raw === null) return false;
    try {
      this.onAuthorizationUrl?.(parseAntigravityAuthorizationUrl(raw).authorizationUrl);
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  /** Read stderr only far enough to spot the sign-in link. Lines are matched
   * and released immediately and the tail is capped, so no authorization code
   * is ever held. Draining also keeps the pipe from stalling the server. */
  private consumeDiagnostics(chunk: string) {
    if (!this.initializationComplete) this.startupDiagnosticBytes += Buffer.byteLength(chunk);
    const { lines, rest } = takeLines(this.diagnosticBuffer + chunk);
    // A partial line already longer than any legal link cannot become one.
    this.diagnosticBuffer = rest.length > MAX_DIAGNOSTIC_LINE_CHARS ? "" : rest;
    for (const line of lines) {
      if (!this.announceAuthorizationUrl(line)) this.noteStartupDiagnostic(line);
    }
  }

  private noteStartupDiagnostic(line: string) {
    if (!this.initializationComplete) this.nativeStartupHint ??= startupHint(line);
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Antigravity ACP is closed."));
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (method === "initialize") {
          this.noteStartupDiagnostic(this.diagnosticBuffer);
          reject(new Error(
            `Antigravity initialization timed out after ${Math.ceil(timeoutMs / 1_000)} seconds (${process.platform}-${process.arch}). ` +
            "The executable was found, but did not finish starting. " +
            (this.nativeStartupHint ? `${this.nativeStartupHint} ` : "") +
            `Startup output: ${this.startupOutputBytes} bytes; diagnostic output: ${this.startupDiagnosticBytes} bytes. ` +
            "Retry setup. If it still fails, share this error and your OpenMausBot version; do not paste Google sign-in links or tokens.",
          ));
        } else reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async initialize(timeoutMs = STARTUP_TIMEOUT_MS): Promise<any> {
    const initialized = await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "openmausbot", version: "0.0.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, timeoutMs);
    this.initializationComplete = true;
    this.nativeStartupHint = undefined;
    return initialized;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("Antigravity ACP was closed."));
    killCliTree(this.child);
  }

  /** Close, then wait (bounded) for the process to be gone. `killCliTree`
   * on Windows asks taskkill and returns at once; the exit lands later. */
  async closeAndWait(timeoutMs = 5_000): Promise<boolean> {
    this.close();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.exited.then(() => true), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseAntigravityAuthorizationUrl(authorizationUrl: string): {
  authorizationUrl: string;
  redirectUri: string;
  state: string;
} {
  if (authorizationUrl.length > 16_384 || /\s/u.test(authorizationUrl)) {
    throw new Error("Antigravity returned an invalid Google sign-in URL.");
  }
  const url = new URL(authorizationUrl);
  const state = url.searchParams.get("state");
  const redirectUri = url.searchParams.get("redirect_uri");
  if (
    url.origin !== "https://accounts.google.com" ||
    url.pathname !== "/o/oauth2/v2/auth" ||
    url.username || url.password || url.hash ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.getAll("redirect_uri").length !== 1 ||
    url.searchParams.getAll("response_type").length !== 1 ||
    url.searchParams.get("response_type") !== "code" ||
    !state || state.length > 512 || /\s/u.test(state) ||
    !redirectUri || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/u.test(redirectUri)
  ) throw new Error("Antigravity returned an invalid Google sign-in URL.");
  const redirect = new URL(redirectUri);
  if (Number(redirect.port) < 1024 || Number(redirect.port) > 65535) {
    throw new Error("Antigravity returned an invalid Google sign-in URL.");
  }
  return { authorizationUrl, redirectUri, state };
}

export function validateAntigravityCallbackUrl(
  pending: { redirectUri: string; state: string },
  callbackUrl: string,
): URL {
  if (callbackUrl.length > 16_384) throw new Error("The sign-in response URL is too long.");
  let callback: URL;
  try { callback = new URL(callbackUrl); }
  catch { throw new Error("Paste the complete redirect URL from Google."); }
  const expected = new URL(pending.redirectUri);
  const states = callback.searchParams.getAll("state");
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  const issuers = callback.searchParams.getAll("iss");
  if (
    callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" ||
    callback.origin !== expected.origin || callback.pathname !== expected.pathname ||
    callback.username || callback.password || callback.hash ||
    states.length !== 1 || states[0] !== pending.state ||
    !((codes.length === 1 && codes[0] && errors.length === 0) ||
      (errors.length === 1 && errors[0] && codes.length === 0)) ||
    issuers.length > 1 || (issuers.length === 1 && issuers[0] !== "https://accounts.google.com")
  ) throw new Error("This redirect URL does not belong to the current sign-in.");
  return callback;
}

export function forwardAntigravityCallback(callback: URL): Promise<void> {
  return new Promise((resolveForward, reject) => {
    const req = httpRequest({
      protocol: "http:",
      hostname: "127.0.0.1",
      port: callback.port,
      path: `${callback.pathname}${callback.search}`,
      method: "GET",
      agent: false,
      timeout: 10_000,
    }, (response) => {
      response.resume();
      response.once("end", () => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) resolveForward();
        else reject(new Error("Could not deliver the Google sign-in response."));
      });
      response.once("error", reject);
    });
    req.once("timeout", () => req.destroy(new Error("The Google sign-in response timed out.")));
    req.once("error", reject);
    req.end();
  });
}

function modelOptions(value: unknown): ModelCatalog["options"] {
  if (!Array.isArray(value)) return [];
  const result: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  const visit = (entry: any) => {
    if (Array.isArray(entry?.options)) return entry.options.forEach(visit);
    const id = typeof entry?.value === "string" ? entry.value : "";
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push({ id, label: typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : id });
  };
  value.forEach(visit);
  return result;
}

export function catalogFromAntigravityConfigOptions(
  configOptions: unknown,
  fallbackDefault: string,
): ModelCatalog | null {
  const model = Array.isArray(configOptions)
    ? configOptions.find((option: any) => option?.id === "model" && option?.type === "select")
    : null;
  const options = modelOptions(model?.options);
  if (!options.length) return null;
  const current = typeof model?.currentValue === "string" ? model.currentValue : "";
  return { default: options.some((option) => option.id === fallbackDefault) ? fallbackDefault : current || options[0]!.id, options };
}

export async function probeAntigravityModels(input: {
  runtime: AntigravityRuntime;
  profile: AntigravityProfile;
  cwd?: string;
  fallbackDefault: string;
  timeoutMs?: number;
}): Promise<ModelCatalog> {
  const deadline = Date.now() + (input.timeoutMs ?? STARTUP_TIMEOUT_MS);
  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error("Antigravity model discovery timed out.");
    return milliseconds;
  };
  const client = new AntigravityAcpClient(input.runtime, input.profile, input.cwd ?? input.profile.directory);
  try {
    await client.initialize(remaining());
    await client.request("authenticate", { methodId: "oauth-personal" }, remaining());
    const session = await client.request(
      "session/new",
      { cwd: input.cwd ?? input.profile.directory, mcpServers: [] },
      remaining(),
    );
    const catalog = catalogFromAntigravityConfigOptions(session?.configOptions, input.fallbackDefault);
    if (!catalog) throw new Error("Antigravity did not return a model catalog for this Google account.");
    return catalog;
  } finally {
    client.close();
  }
}

/**
 * Validates whether an ACP initialization response matches an official Google Antigravity release.
 *
 * @param initialized - The raw initialization response payload returned by the ACP client.
 * @param expectedVersion - The expected release version tag or semver string.
 * @returns `true` if the initialize result satisfies protocol, agent identity, capability, and auth requirements.
 */
export function isValidAntigravityInitializeResult(
  initialized: any,
  expectedVersion: string,
): boolean {
  if (!initialized || initialized.protocolVersion !== 1) return false;
  const name = initialized.agentInfo?.name;
  if (name !== "antigravity-acp" && name !== "Google Antigravity") return false;
  const actualVersion = initialized.agentInfo?.version;
  if (typeof actualVersion !== "string") return false;
  const normalizedActual = actualVersion.replace(/^agy_acp_server_/u, "").trim();
  const normalizedExpected = expectedVersion.replace(/^agy_acp_server_/u, "").trim();
  if (actualVersion !== expectedVersion && normalizedActual !== normalizedExpected) return false;
  // ACP advertises these optional operations as capability objects (including
  // empty objects). Keep accepting the boolean form used by older runtimes.
  const advertised = (value: unknown) => value === true
    || (typeof value === "object" && value !== null && !Array.isArray(value));
  if (
    initialized.agentCapabilities?.loadSession !== true ||
    !advertised(initialized.agentCapabilities?.sessionCapabilities?.resume) ||
    !advertised(initialized.agentCapabilities?.auth?.logout)
  ) {
    return false;
  }
  if (!Array.isArray(initialized.authMethods) || !initialized.authMethods.some((method: any) => method?.id === "oauth-personal")) {
    return false;
  }
  return true;
}

/**
 * Starts a transient Antigravity ACP client against a temporary profile to verify
 * that the downloaded runtime binary starts properly and identifies as the expected release.
 *
 * @param runtime - The resolved Antigravity executable and harness paths.
 * @param expectedVersion - The expected version string or tag.
 * @returns A promise that resolves when verification succeeds, or rejects if initialization fails.
 */
export async function validateAntigravityRuntime(runtime: AntigravityRuntime, expectedVersion: string): Promise<void> {
  const profileDirectory = await mkdtemp(join(tmpdir(), "openmaus-antigravity-verify-"));
  let client: AntigravityAcpClient | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const profile = await prepareAntigravityProfile({
      instanceId: `verify-${randomUUID()}`,
      runtime,
      profileDirectory,
      // Google's Windows one-file executable expands a large Python runtime
      // into TEMP. Forced shutdown skips its own cleanup. Keep verification's
      // extraction inside the profile we already remove after confirmed close.
      baseEnv: process.platform === "win32"
        ? { ...process.env, TEMP: profileDirectory, TMP: profileDirectory }
        : undefined,
    });
    client = new AntigravityAcpClient(runtime, profile, profileDirectory);
    const initialized = await client.initialize();
    if (!isValidAntigravityInitializeResult(initialized, expectedVersion)) {
      throw new Error("The download did not identify as the expected Google Antigravity ACP release.");
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  // The caller is about to rename the directory this executable runs from.
  // Neither it nor the profile is safe to touch before confirmed close.
  let stopped = !client;
  try {
    if (client) {
      stopped = await client.closeAndWait();
      if (!stopped) throw new Error("Antigravity did not shut down after runtime verification.");
    }
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = error;
    }
  }
  if (stopped) {
    await rm(profileDirectory, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
      .catch((error) => {
        console.warn(`antigravity: could not remove verification profile ${profileDirectory}: ${error instanceof Error ? error.message : String(error)}`);
      });
  }
  if (failed) throw failure;
}

export interface AntigravityAuthStart {
  phase: "waiting" | "succeeded";
  flowId: string | null;
  authorizationUrl: string | null;
  expiresAt: string | null;
}

interface AuthFlow {
  id: string;
  client: AntigravityAcpClient;
  completed: Promise<void>;
  pending: { redirectUri: string; state: string };
  expiresAt: number;
}

/** One in-flight personal Google login per provider instance. */
export class AntigravityAuthController {
  private flow: AuthFlow | null = null;

  async start(runtime: AntigravityRuntime, profile: AntigravityProfile): Promise<AntigravityAuthStart> {
    this.cancel();
    let foundUrl!: (value: ReturnType<typeof parseAntigravityAuthorizationUrl>) => void;
    let failUrl!: (error: Error) => void;
    const urlPromise = new Promise<ReturnType<typeof parseAntigravityAuthorizationUrl>>((resolveUrl, reject) => {
      foundUrl = resolveUrl;
      failUrl = reject;
    });
    const client = new AntigravityAcpClient(runtime, profile, profile.directory, (url) => {
      try { foundUrl(parseAntigravityAuthorizationUrl(url)); }
      catch (error) { failUrl(error instanceof Error ? error : new Error(String(error))); }
    });
    try {
      await client.initialize();
      const authenticated = client.request("authenticate", { methodId: "oauth-personal" }, AUTH_TIMEOUT_MS);
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      const startupTimeout = new Promise<never>((_resolve, reject) => {
        startupTimer = setTimeout(() => reject(new Error("Google sign-in did not start in time.")), STARTUP_TIMEOUT_MS);
        startupTimer.unref?.();
      });
      const outcome = await Promise.race([
        urlPromise.then((request) => ({ kind: "url" as const, request })),
        authenticated.then(() => ({ kind: "done" as const })),
        startupTimeout,
      ]).finally(() => {
        if (startupTimer) clearTimeout(startupTimer);
      });
      if (outcome.kind === "done") {
        client.close();
        return { phase: "succeeded", flowId: null, authorizationUrl: null, expiresAt: null };
      }
      const flow: AuthFlow = {
        id: randomUUID(),
        client,
        completed: authenticated,
        pending: { redirectUri: outcome.request.redirectUri, state: outcome.request.state },
        expiresAt: Date.now() + AUTH_TIMEOUT_MS,
      };
      this.flow = flow;
      void authenticated.finally(() => {
        if (this.flow === flow) this.flow = null;
        client.close();
      }).catch(() => {});
      return {
        phase: "waiting",
        flowId: flow.id,
        authorizationUrl: outcome.request.authorizationUrl,
        expiresAt: new Date(flow.expiresAt).toISOString(),
      };
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async complete(flowId: string, callbackUrl: string): Promise<void> {
    const flow = this.flow;
    if (!flow || flow.id !== flowId || Date.now() >= flow.expiresAt) {
      throw new Error("This Google sign-in is no longer active. Start again.");
    }
    await forwardAntigravityCallback(validateAntigravityCallbackUrl(flow.pending, callbackUrl));
    await flow.completed;
  }

  cancel(): void {
    this.flow?.client.close();
    this.flow = null;
  }
}
