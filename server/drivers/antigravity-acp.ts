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
import { acpVariantOption } from "./acp/config-options.ts";
import {
  VERIFICATION_TEMP_KEY,
  antigravityTempDir,
  folderBytes,
  setAntigravityTempEnvironment,
  sweepAntigravityTemp,
} from "./antigravity-temp.ts";

// Printed on stderr by Google's server, not stdout.
export const ANTIGRAVITY_AUTH_PREFIX = "Open the following link to authenticate the ACP server: ";
const AUTH_TIMEOUT_MS = 5 * 60_000;
// Google's packaged server can take tens of seconds to cold-start, especially on Windows.
const STARTUP_TIMEOUT_MS = 90_000;
// The Windows runtime is silent while it unpacks ~1 GB into TEMP, which antivirus scanning can stretch past one window:
// startup gets another window while that folder grows, up to this cap.
const STARTUP_CAP_MS = 5 * 60_000;
const UNPACK_COUNT_BUDGET_MS = 5_000;
const MAX_PROTOCOL_LINE_BYTES = 16 * 1024 * 1024;
// Past the 16 KiB ceiling parseAntigravityAuthorizationUrl accepts, so no partial link is dropped.
const MAX_DIAGNOSTIC_LINE_CHARS = 64 * 1024;
// A forced stop on Windows skips the runtime's cleanup of what it unpacked; exiting on its own removes it.
const GRACEFUL_EXIT_MS = 5_000;

export interface AntigravityProfile {
  directory: string;
  tokenPath: string;
  environment: NodeJS.ProcessEnv;
  tempDirectory?: string;
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
  "AGY_ACP_DEFAULT_MODEL",
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

function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((line) => line.replace(/\r$/u, "")), rest };
}

/** Only fixed, allowlisted hints leave stderr: native output can carry OAuth codes in any format. */
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

/** Google announces the link two ways, both on stderr: through $BROWSER (our helper re-emits it
 * JSON-encoded behind a private marker, preferred) and in plain text for terminal users. */
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

/** A removed account's Google sign-in goes with its profile, so no refresh token outlives the account. Best effort:
 * the account is already gone from the config, and Windows refuses while a retiring process still holds a file. */
export async function removeAntigravityProfile(instanceId: string, baseDir = DATA_DIR): Promise<void> {
  await rm(antigravityProfileDirectory(instanceId, baseDir), { recursive: true, force: true, maxRetries: 4, retryDelay: 250 })
    .catch((error) => {
      console.warn(`antigravity: could not remove a removed account's profile: ${error instanceof Error ? error.message : String(error)}`);
    });
}

/** An isolated Google profile per instance; foreign Google credentials are stripped so the account
 * and billing never change silently. */
export async function prepareAntigravityProfile(input: {
  instanceId: string;
  runtime: AntigravityRuntime;
  baseEnv?: NodeJS.ProcessEnv;
  baseDir?: string;
  profileDirectory?: string;
  tempDirectory?: string;
  platform?: NodeJS.Platform;
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
  // On Windows the runtime unpacks 0.34-1.26 GB into TEMP per launch: one OMB folder per instance,
  // stable so the pooled spawn contract (which hashes this env) holds.
  let tempDirectory: string | undefined;
  if ((input.platform ?? process.platform) === "win32") {
    tempDirectory = resolve(input.tempDirectory ?? antigravityTempDir(input.baseDir ?? DATA_DIR, input.instanceId));
    await mkdir(tempDirectory, { recursive: true });
    setAntigravityTempEnvironment(environment, tempDirectory, "win32");
  }
  return {
    directory,
    tokenPath: join(acpDirectory, "acp_token.json"),
    environment,
    ...(tempDirectory ? { tempDirectory } : {}),
  };
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
  private stopping?: Promise<boolean>;
  private readonly onAuthorizationUrl?: (url: string) => void;
  private readonly tempDirectory?: string;
  /** On Windows a running executable pins its file and directory: do not rename or delete before this settles. */
  readonly exited: Promise<void>;

  constructor(
    runtime: AntigravityRuntime,
    profile: AntigravityProfile,
    cwd: string,
    onAuthorizationUrl?: (url: string) => void,
  ) {
    this.onAuthorizationUrl = onAuthorizationUrl;
    this.tempDirectory = profile.tempDirectory;
    this.child = spawnCli(
      runtime.executablePath,
      process.platform === "linux" ? ["--uid="] : [],
      { cwd, env: profile.environment, stdio: ["pipe", "pipe", "pipe"] },
      "bot",
    );
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.consume(chunk));
    // Never surface raw stderr: it can contain authorization codes.
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
      // Failed spawns also emit `close`; an `error` alone can mean a failed kill.
    });
  }

  private consume(chunk: string) {
    if (this.closed) return;
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

  /** Lines are matched and released at once and the tail is capped, so no authorization code is held. */
  private consumeDiagnostics(chunk: string) {
    if (!this.initializationComplete) this.startupDiagnosticBytes += Buffer.byteLength(chunk);
    const { lines, rest } = takeLines(this.diagnosticBuffer + chunk);
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

  /** When `timeoutMs` passes, `expired` decides: a number waits that many milliseconds more, an Error fails the request. */
  request(
    method: string,
    params: unknown,
    timeoutMs = 30_000,
    expired: () => Promise<number | Error> = async () => new Error(`${method} timed out.`),
  ): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Antigravity ACP is closed."));
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      const arm = (milliseconds: number) => {
        const timer = setTimeout(async () => {
          const outcome = await expired();
          const pending = this.pending.get(id);
          if (!pending) return;
          if (typeof outcome === "number") {
            pending.timer = arm(outcome);
            return;
          }
          this.pending.delete(id);
          reject(outcome);
        }, milliseconds);
        timer.unref?.();
        return timer;
      };
      this.pending.set(id, { resolve: resolveRequest, reject, timer: arm(timeoutMs) });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** `complete` is false when the count ran out of time: `bytes` is then only a lower bound. */
  private async unpackedBytes(): Promise<{ bytes: number; complete: boolean }> {
    if (!this.tempDirectory) return { bytes: 0, complete: true };
    return folderBytes(this.tempDirectory, Date.now() + UNPACK_COUNT_BUDGET_MS);
  }

  async initialize(windowMs = STARTUP_TIMEOUT_MS, deadline = Date.now() + STARTUP_CAP_MS): Promise<any> {
    const started = Date.now();
    const counting = this.unpackedBytes();
    let unpacked: number | undefined;
    const expired = async (): Promise<number | Error> => {
      const before = (await counting).bytes;
      const count = await this.unpackedBytes();
      const now = count.bytes;
      const progressing = !count.complete || now > (unpacked ?? before);
      if (count.complete) unpacked = now;
      const left = deadline - Date.now();
      if (progressing && left > 0) return Math.min(windowMs, left);
      this.noteStartupDiagnostic(this.diagnosticBuffer);
      return new Error(
        `Antigravity initialization timed out after ${Math.ceil((Date.now() - started) / 1_000)} seconds (${process.platform}-${process.arch}). ` +
        "The executable was found, but did not finish starting. " +
        (this.nativeStartupHint ? `${this.nativeStartupHint} ` : "") +
        `Startup output: ${this.startupOutputBytes} bytes; diagnostic output: ${this.startupDiagnosticBytes} bytes. ` +
        (this.tempDirectory ? `Unpacked into temp: ${Math.round(Math.max(0, now - before) / 1_000_000)} MB. ` : "") +
        "Retry setup. If it still fails, share this error and your OpenMausBot version; do not paste Google sign-in links or tokens.",
      );
    };
    const initialized = await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "openmausbot", version: "0.0.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, Math.min(windowMs, Math.max(0, deadline - Date.now())), expired);
    this.initializationComplete = true;
    this.nativeStartupHint = undefined;
    return initialized;
  }

  /** End input so the runtime exits by itself and removes what it unpacked; force-stop after
   * GRACEFUL_EXIT_MS. On Windows killCliTree does nothing once the runtime exited. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("Antigravity ACP was closed."));
    this.stopping = this.stopGracefully();
  }

  private async stopGracefully(): Promise<boolean> {
    try {
      this.child.stdin?.end();
    } catch {}
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, GRACEFUL_EXIT_MS);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    return killCliTree(this.child);
  }

  async closeAndWait(timeoutMs = 12_000): Promise<boolean> {
    this.close();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.stopping!, timedOut]);
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
  const defaultModel = options.some((option) => option.id === fallbackDefault) ? fallbackDefault : current || options[0]!.id;
  const selectedModel = current || defaultModel;
  const variants = acpVariantOption({ configOptions })?.options;
  return {
    default: defaultModel,
    options: options.map((option) => option.id === selectedModel && variants?.length ? { ...option, variants } : option),
  };
}

export async function probeAntigravityModels(input: {
  runtime: AntigravityRuntime;
  profile: AntigravityProfile;
  cwd?: string;
  fallbackDefault: string;
  timeoutMs?: number;
}): Promise<ModelCatalog> {
  const deadline = Date.now() + (input.timeoutMs ?? STARTUP_CAP_MS);
  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error("Antigravity model discovery timed out.");
    return Math.min(milliseconds, STARTUP_TIMEOUT_MS);
  };
  const client = new AntigravityAcpClient(input.runtime, input.profile, input.cwd ?? input.profile.directory);
  try {
    await client.initialize(remaining(), deadline);
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
  // ACP advertises optional operations as capability objects (even empty); older runtimes send booleans.
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

export async function validateAntigravityRuntime(runtime: AntigravityRuntime, expectedVersion: string): Promise<void> {
  const profileDirectory = await mkdtemp(join(tmpdir(), "openmaus-antigravity-verify-"));
  let client: AntigravityAcpClient | undefined;
  let tempDirectory: string | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const profile = await prepareAntigravityProfile({
      instanceId: `verify-${randomUUID()}`,
      runtime,
      profileDirectory,
      tempDirectory: antigravityTempDir(DATA_DIR, VERIFICATION_TEMP_KEY),
    });
    tempDirectory = profile.tempDirectory;
    client = new AntigravityAcpClient(runtime, profile, profileDirectory);
    const initialized = await client.initialize();
    if (!isValidAntigravityInitializeResult(initialized, expectedVersion)) {
      throw new Error("The download did not identify as the expected Google Antigravity ACP release.");
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  // The caller is about to rename this executable's directory: touch nothing before a confirmed close.
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
        console.warn(`antigravity: could not remove verification files ${profileDirectory}: ${error instanceof Error ? error.message : String(error)}`);
      });
    if (tempDirectory) {
      await sweepAntigravityTemp(VERIFICATION_TEMP_KEY).catch((error) => {
        console.warn(`antigravity: could not clear verification files: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
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
