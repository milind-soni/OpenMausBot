// Google's Antigravity ACP server as a child process: its isolated profile and launch environment, the sign-in link it
// announces, the redirect it waits for, and its model catalog.
//
// Adapted from pingdotgg/t3code@b9bc03869e, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified:
//   - apps/server/src/provider/antigravityAuthSupport.ts:56-84, 196-233,
//     336-411, 500-531 (the browser helper and its check, the launch
//     environment, the Linux certificate bundle, and the sign-in link's
//     validation);
//   - apps/server/src/provider/antigravityCallback.ts (the redirect's
//     validation and delivery);
//   - apps/server/src/provider/acp/AntigravityAcpSupport.ts:55-79, 108-121
//     (the session setup for releases that write a workflow skill file);
//   - apps/server/src/provider/acp/AntigravityAcpSupport.ts:89-90, 123-129
//     at b732621b51 (the client name by runtime version);
//   - apps/server/src/provider/antigravityAuthSupport.ts:467-477,
//     apps/server/src/provider/acp/AntigravityAcpSupport.ts:186-193 and
//     apps/server/src/provider/AntigravityInstallation.ts:501-503 at
//     b732621b51 (the native CLI's launch, its session mode and its name);
//   - apps/server/src/provider/antigravityAuthSupport.ts:167-177, 222-244 at
//     38067630229 (the native CLI's environment: no self-update and the
//     SSH_CONNECTION value that keeps each profile's sign-in in its own file).
// The temp folder stays one per instance, the redirect can go through a relay into a boxed runtime, and startup waits
// while a Windows unpack is still growing.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import { DATA_DIR, stripWorkspaceCredentialEnv } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import { BOX_SSH_CONNECTION } from "../bot-box/env.ts";
import type { BoxRelay } from "../bot-box/relay.ts";
import type { ModelCatalog } from "../contracts.ts";
import type { ChildProcess } from "node:child_process";
import type { AntigravityRuntime } from "./antigravity-runtime.ts";
import { ANTIGRAVITY_CLI_TOKEN_FILE } from "./antigravity-cli-install.ts";
import { acpVariantOption, surveyModelVariants } from "./acp/config-options.ts";
import type { AcpPromptSteer } from "./acp/steer.ts";
import { StderrTail, exitDetail } from "./acp/exit-report.ts";
import {
  VERIFICATION_TEMP_KEY,
  antigravityTempDir,
  folderBytes,
  setAntigravityTempEnvironment,
  sweepAntigravityTemp,
} from "./antigravity-temp.ts";

// Printed on stderr by Google's server, not stdout.
export const ANTIGRAVITY_AUTH_PREFIX = "Open the following link to authenticate the ACP server: ";
// Google's packaged server can take tens of seconds to cold-start, especially on Windows.
export const STARTUP_TIMEOUT_MS = 90_000;
// The Windows runtime is silent while it unpacks ~1 GB into TEMP, which antivirus scanning can stretch past one window:
// startup gets another window while that folder grows, up to this cap.
const STARTUP_CAP_MS = 5 * 60_000;
const UNPACK_COUNT_BUDGET_MS = 5_000;
// A new session names thinking levels only for its current model, so discovery switches through the rest (~1.5 s each).
const VARIANT_SURVEY_MS = 15_000;
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
  // An inherited pipe whose owner exited makes Electron-as-Node print Crashpad errors to stderr.
  "CHROME_CRASHPAD_PIPE_NAME",
]);

const BROWSER_MARKER = "__OPENMAUS_ANTIGRAVITY_AUTH_URL__";
const browserHelperSource =
  `process.stderr.on("error",()=>process.exit(0)).write(` +
  `"${BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",` +
  `()=>process.exit(0))`;

const BROWSER_PREFLIGHT_URL = "https://example.invalid/openmaus-antigravity-browser-preflight";
const BROWSER_PREFLIGHT_MS = 30_000;
const verifiedBrowserHelpers = new Set<string>();

/** Bundled Python may look for certificates at paths absent on this distribution. */
const LINUX_CA_BUNDLES = [
  "/etc/ssl/certs/ca-bundle.crt",
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/cert.pem",
];

/** Absolute, since the runtime resolves a relative path against the bot's folder. */
export function linuxCaBundle(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): string | undefined {
  if (env.SSL_CERT_FILE !== undefined || env.SSL_CERT_DIR !== undefined) return undefined;
  return [env.NIX_SSL_CERT_FILE, ...LINUX_CA_BUNDLES].find((candidate) => candidate && isAbsolute(candidate) && exists(candidate));
}

/** A sign-in must hand its link to the app and never open a browser on the server: run the helper once the way the
 * runtime will, and refuse the sign-in unless it prints the marked link. Other stderr lines (a runtime warning) pass. */
/** Why the helper fails the check, or null when it passes. The helper is a program started without a shell; one that
 * cannot be started that way (Windows refuses a script with EINVAL) is a reason like any other. */
export function antigravityBrowserHelperProblem(environment: NodeJS.ProcessEnv, helper: string): Promise<string | null> {
  return new Promise((resolveRun) => {
    try {
      execFile(helper, ["-e", browserHelperSource, "--", BROWSER_PREFLIGHT_URL],
        { env: environment, timeout: BROWSER_PREFLIGHT_MS, maxBuffer: 64 * 1024, windowsHide: true },
        (error, _stdout, stderr) => {
          if (error) return resolveRun(error.killed ? "it did not answer in 30 seconds" : typeof error.code === "string" ? "it could not be started" : "it stopped with an error");
          const marked = String(stderr).split(/\r?\n/u).includes(`${BROWSER_MARKER}"${BROWSER_PREFLIGHT_URL}"`);
          resolveRun(marked ? null : "it did not hand the sign-in link to the app");
        }).once("error", () => resolveRun("it could not be started"));
    } catch {
      resolveRun("it could not be started");
    }
  });
}

export async function verifyAntigravityBrowserHelper(profile: AntigravityProfile, executable = process.execPath): Promise<void> {
  const helper = process.platform === "win32" ? executable.replaceAll("\\", "/") : executable;
  if (verifiedBrowserHelpers.has(helper)) return;
  const reason = await antigravityBrowserHelperProblem(profile.environment, helper);
  if (reason) {
    throw new Error(`Google sign-in cannot start: the helper that passes the sign-in link to OpenMausBot failed a check (${reason}). Restart OpenMausBot and try again. If it keeps failing, share this message.`);
  }
  verifiedBrowserHelpers.add(helper);
}

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

export const ANTIGRAVITY_SSH_CONNECTION = BOX_SSH_CONNECTION;

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

/** The pinned runtime's sign-in. */
export function antigravityTokenPath(instanceId: string, baseDir = DATA_DIR): string {
  return join(antigravityProfileDirectory(instanceId, baseDir), "antigravity-acp", "acp_token.json");
}

/** The native CLI's sign-in. */
export function antigravityCliTokenPath(instanceId: string, baseDir = DATA_DIR): string {
  return join(antigravityProfileDirectory(instanceId, baseDir), "antigravity-acp", ANTIGRAVITY_CLI_TOKEN_FILE);
}

/** Both runtimes' sign-in files. An account that switched to the CLI keeps the Classic runtime's file. */
export function antigravitySignInPaths(instanceId: string, baseDir = DATA_DIR): string[] {
  return [antigravityCliTokenPath(instanceId, baseDir), antigravityTokenPath(instanceId, baseDir)];
}

/** Signing out forgets only this account's stored Google sign-ins, both runtimes'; its profile stays for the next one. */
export async function removeAntigravitySignIn(instanceId: string, baseDir = DATA_DIR): Promise<void> {
  for (const path of antigravitySignInPaths(instanceId, baseDir)) await rm(path, { force: true, maxRetries: 4, retryDelay: 250 });
}

/** The runtime asked for a Google sign-in although a token file is stored (a revoked or ineligible account). */
export class AntigravitySignInRequired extends Error {
  constructor() {
    super("Antigravity asked for a new Google sign-in.");
  }
}

const refusedTokens = new Map<string, string>();
const tokenStamp = (info: { mtimeMs: number; size: number; ino: number | bigint }) => `${info.mtimeMs}:${info.size}:${info.ino}`;

/** The stored token no longer signs this account in. It counts as signed out until a sign-in succeeds or writes the
 * file again. */
export function noteAntigravitySignInRequired(tokenPath: string): void {
  try {
    refusedTokens.set(tokenPath, tokenStamp(statSync(tokenPath)));
  } catch {}
}

export function noteAntigravitySignedIn(tokenPath: string): void {
  refusedTokens.delete(tokenPath);
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
  const skillsDirectory = join(directory, "omb-skills");
  await mkdir(skillsDirectory, { recursive: true, mode: 0o700 });
  if (!(await lstat(skillsDirectory)).isDirectory()) throw new Error("Antigravity staging path must be a real directory.");
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
  const caBundle = (input.platform ?? process.platform) === "linux" ? linuxCaBundle(input.baseEnv ?? process.env) : undefined;
  const nativeCli = input.runtime.harnessPath === null;
  Object.assign(environment, {
    ...(caBundle ? { SSL_CERT_FILE: caBundle } : {}),
    GEMINI_HOME: directory,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    ...(nativeCli
      ? {
          // Updates come only through this app's updater; the release folder is read-only besides.
          AGY_CLI_DISABLE_AUTO_UPDATE: "1",
          // The CLI ignores AGY_ACP_FORCE_FILE_STORAGE and keeps one Google sign-in per computer in the OS keyring,
          // whatever --gemini-dir says (1.5.14), unless it believes it runs over SSH: then each profile keeps its own in
          // its file (1.5.15, signed in for real). So every account here has its own sign-in, the keychain and the CLI
          // in a terminal are never touched, and a box without a keyring works the same. A fixed value, so no address
          // of the host reaches the box.
          SSH_CONNECTION: ANTIGRAVITY_SSH_CONNECTION,
        }
      : { ANTIGRAVITY_HARNESS_PATH: input.runtime.harnessPath! }),
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
    const refused = refusedTokens.get(profile.tokenPath);
    if (refused === tokenStamp(info)) return false;
    if (refused !== undefined) refusedTokens.delete(profile.tokenPath);
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
  /** What it printed since it last answered, masked (sign-in links are taken out before), for the exit message. */
  private readonly stderrTail = new StderrTail();
  private closed = false;
  private stopping?: Promise<boolean>;
  private readonly onAuthorizationUrl?: (url: string) => void;
  private readonly tempDirectory?: string;
  private readonly runtimeVersion: string | null;
  /** On Windows a running executable pins its file and directory: do not rename or delete before this settles. */
  readonly exited: Promise<void>;

  constructor(
    runtime: AntigravityRuntime,
    profile: AntigravityProfile,
    cwd: string,
    onAuthorizationUrl?: (url: string) => void,
    relay?: BoxRelay,
  ) {
    this.onAuthorizationUrl = onAuthorizationUrl;
    this.tempDirectory = profile.tempDirectory;
    this.runtimeVersion = runtime.version;
    this.child = spawnCli(
      runtime.executablePath,
      antigravityLaunchArgs(runtime, profile.directory),
      { cwd, env: profile.environment, stdio: ["pipe", "pipe", "pipe"], box: { ro: [join(profile.directory, "omb-skills")], ...(relay ? { relay: relay.socketPath } : {}) } },
      "bot",
    );
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.consume(chunk));
    // Never surface raw stderr: it can contain authorization codes. Only masked last lines reach the exit message.
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => this.consumeDiagnostics(chunk));
    this.child.once("error", (error) => this.failAll(error));
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        if (authorizationUrlFromLine(this.diagnosticBuffer) === null) this.noteDiagnostic(this.diagnosticBuffer);
        this.diagnosticBuffer = "";
        if (!this.closed) this.failAll(new Error(
          `Antigravity ACP exited ${code ?? signal ?? "unexpectedly"}${exitDetail(code, signal, this.stderrTail.text)}.${this.nativeStartupHint ? ` ${this.nativeStartupHint}` : ""}`,
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
      const { authorizationUrl } = parseAntigravityAuthorizationUrl(raw);
      if (!this.onAuthorizationUrl) throw new AntigravitySignInRequired();
      this.onAuthorizationUrl(authorizationUrl);
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
      if (!this.announceAuthorizationUrl(line)) this.noteDiagnostic(line);
    }
  }

  private noteDiagnostic(line: string) {
    this.noteStartupDiagnostic(line);
    this.stderrTail.note(line);
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
      clientInfo: antigravityClientInfo(this.runtimeVersion),
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, Math.min(windowMs, Math.max(0, deadline - Date.now())), expired);
    this.initializationComplete = true;
    this.nativeStartupHint = undefined;
    this.stderrTail.clear();
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

/** Delivers the callback to the runtime's listener on 127.0.0.1, which is the box's own loopback when the runtime runs in
 * a bot box with its own network: `relay` reaches it there. */
export async function forwardAntigravityCallback(callback: URL, relay?: Pick<BoxRelay, "connect">): Promise<void> {
  const socket = relay ? await relay.connect(Number(callback.port)) : null;
  return new Promise((resolveForward, reject) => {
    const req = httpRequest({
      protocol: "http:",
      hostname: "127.0.0.1",
      port: callback.port,
      path: `${callback.pathname}${callback.search}`,
      method: "GET",
      ...(socket ? { createConnection: () => socket } : { agent: false }),
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
  onProcess?: (child: ChildProcess) => void;
}): Promise<ModelCatalog> {
  const deadline = Date.now() + (input.timeoutMs ?? STARTUP_CAP_MS);
  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error("Antigravity model discovery timed out.");
    return Math.min(milliseconds, STARTUP_TIMEOUT_MS);
  };
  const client = new AntigravityAcpClient(input.runtime, input.profile, input.cwd ?? input.profile.directory);
  try {
    input.onProcess?.(client.child);
    const initialized = await client.initialize(remaining(), deadline);
    // Native CLI 1.5.14 opens the system browser on `authenticate` and waits 300 s for it; its sign-in is `acp --login`.
    if (input.runtime.harnessPath !== null) await client.request("authenticate", { methodId: "oauth-personal" }, remaining());
    const session = await client.request(
      "session/new",
      { cwd: input.cwd ?? input.profile.directory, mcpServers: [], ...antigravitySessionSetup(initialized) },
      remaining(),
    );
    const catalog = catalogFromAntigravityConfigOptions(session?.configOptions, input.fallbackDefault);
    if (!catalog) throw new Error("Antigravity did not return a model catalog for this Google account.");
    const budget = Math.min(VARIANT_SURVEY_MS, deadline - Date.now());
    if (budget <= 0) return catalog;
    const surveyed = await surveyModelVariants((method, params) => client.request(method, params, budget), session, budget);
    return {
      ...catalog,
      options: catalog.options.map((option) => {
        const variants = surveyed.get(option.id);
        return !option.variants?.length && variants?.length ? { ...option, variants } : option;
      }),
    };
  } catch (error) {
    if (error instanceof AntigravitySignInRequired) noteAntigravitySignInRequired(input.profile.tokenPath);
    throw error;
  } finally {
    client.close();
  }
}

/** Whether runtimes that offer some models only to editors they know are told an editor's name. */
export const ANTIGRAVITY_EDITOR_CLIENT_NAME = true;
// `agy acp` 1.5.1 offers every model to every ACP client; older runtimes allowlist editors.
const OPEN_MODEL_ACCESS_RELEASE = [1, 5, 1] as const;

/** The `clientInfo` a runtime of `version` is started with. Before 1.5.1, and for a version that is not known, a runtime
 * offers its non-Gemini models only to clients on its allowlist, so it is given a name from that list. */
export function antigravityClientInfo(version: string | null | undefined, editorName = ANTIGRAVITY_EDITOR_CLIENT_NAME): { name: string; version: string } {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version?.trim() ?? "");
  const open = match !== null && OPEN_MODEL_ACCESS_RELEASE.reduce((difference, part, index) => difference || Number(match[index + 1]) - part, 0) >= 0;
  return open || !editorName ? { name: "openmausbot", version: "0.0.0" } : { name: "zed", version: "0.0.0" };
}

const runtimeVersion = (value: unknown) => typeof value === "string" ? value.replace(/^agy_acp_server_/u, "").trim() : "";

/** agy_acp_server 1.4.2 to 1.4.5 create or overwrite skills/system/run-workflow/SKILL.md in the session's folder unless
 * the session turns its `run_workflow` tool off. Sent with session/new, session/load and session/resume. */
export function antigravitySessionSetup(
  initialized: any,
  system?: string,
): { _meta?: { antigravity: { disabledTools?: string[]; systemPrompt?: { append: string } } } } {
  const match = /^1\.4\.(\d+)(?!\d)/u.exec(runtimeVersion(initialized?.agentInfo?.version));
  const patch = match ? Number(match[1]) : -1;
  const antigravity = {
    ...(patch >= 2 && patch <= 5 ? { disabledTools: ["run_workflow"] } : {}),
    ...(system === undefined ? {} : { systemPrompt: { append: system } }),
  };
  return Object.keys(antigravity).length > 0 ? { _meta: { antigravity } } : {};
}

/** The native CLI (1.5.14) advertises `_meta.antigravity.systemPrompt.append` in initialize: session/new, session/load and
 * session/resume then take the system prompt there, kept with the conversation, and it never reaches the scan that turns
 * a `/word` anywhere in a prompt's first text block into that command. */
export function antigravityTakesSystemPrompt(initialized: any): boolean {
  return initialized?.agentCapabilities?._meta?.antigravity?.systemPrompt?.append === true;
}

/** The agy CLI has no harness sibling and serves ACP through its `acp` subcommand. It joins `--app-data-dir` beneath
 * `--gemini-dir`, including when the value is absolute. */
export function antigravityLaunchArgs(runtime: Pick<AntigravityRuntime, "harnessPath">, profileDirectory: string, platform: NodeJS.Platform = process.platform): string[] {
  if (runtime.harnessPath === null) return ["acp", "--gemini-dir", profileDirectory, "--app-data-dir", "antigravity-acp"];
  return platform === "linux" ? ["--uid="] : [];
}

/** The native CLI (`agy acp`, "Antigravity ACP Server") from 1.5.0 takes a second `session/prompt` during a turn into it:
 * the running prompt answers `end_turn` at once with no usage, and the turn goes on under the new one, which answers at
 * its end with the whole turn's usage, or `cancelled` with that usage on session/cancel; a third prompt takes over from the
 * second the same way. Measured on 1.5.15, whose `initialize` does not announce it. While the turn waits on a permission or
 * question answer it rejects the prompt (-32603 "Can't add this prompt"), so a message then queues, including one sent
 * before the app has shown that question. agy_acp_server (the pinned runtime, "antigravity-acp") answers a second prompt with
 * an error and a second reply instead, so it keeps queueing. */
export const ANTIGRAVITY_STEER: AcpPromptSteer = {
  kind: "prompt",
  notWhileAsking: true,
  takeOver: { rejected: (error: any) => error?.code === -32603 && /^Can't add this prompt\b/u.test(String(error?.message ?? "")) },
  supported: (initialized: any) => {
    if (initialized?.agentInfo?.name !== "Antigravity ACP Server") return false;
    const match = /^(\d+)\.(\d+)\./u.exec(runtimeVersion(initialized.agentInfo.version));
    return match !== null && (Number(match[1]) > 1 || (Number(match[1]) === 1 && Number(match[2]) >= 5));
  },
};

/** The agy CLI rejects the pinned runtime's `yolo` and `auto_edit`. It stays in `default`, where it asks before acting
 * and the app answers by the turn's own approval level. */
export function antigravityCliSessionMode(mode: string): string {
  return mode === "yolo" || mode === "auto_edit" ? "default" : mode;
}

export function isValidAntigravityInitializeResult(
  initialized: any,
  expectedVersion: string,
  nativeCli = false,
): boolean {
  if (!initialized || initialized.protocolVersion !== 1) return false;
  const name = initialized.agentInfo?.name;
  if (nativeCli ? name !== "Antigravity ACP Server" : name !== "antigravity-acp" && name !== "Google Antigravity") return false;
  const actualVersion = initialized.agentInfo?.version;
  if (typeof actualVersion !== "string") return false;
  const normalizedActual = runtimeVersion(actualVersion);
  const normalizedExpected = runtimeVersion(expectedVersion);
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
    if (!isValidAntigravityInitializeResult(initialized, expectedVersion, runtime.harnessPath === null)) {
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
