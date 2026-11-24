// Finding and running GitHub CLI for the sign-in (sign-in.ts). Two copies can run:
//   - the person's own `gh` on This computer, found on PATH: read for their own sign-in, and run for OpenMausBot's sign-in
//     when it is new enough (GH_SIGN_IN_FLOOR) to take every flag below;
//   - the app's pinned copy (gh-release.ts), downloaded and checked on the first sign-in that needs it.
// Security: gh keeps a sign-in in the OS credential store under one name whatever its config folder, and its login and
// logout delete entries there. OpenMausBot's own runs therefore get a private HOME (macOS finds no login keychain
// through it), a D-Bus session address that leads nowhere (godbus uses a set address as it is, and without one it would
// find /run/user/<uid>/bus by the uid: the person's Secret Service) and `--insecure-storage`, so the token is only ever
// in the private config folder; and they never run `gh auth logout` (sign-in.ts deletes the folder instead). Windows'
// Credential Manager cannot be redirected: there sign-in.ts starts a sign-in only when the person's own gh positively
// has none and Credential Manager holds no gh entry (windowsGhCredentials).
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";

import { stripWorkspaceCredentialEnv } from "../credential-env.ts";
import { installStandaloneEngine, standaloneCurrentVersion, standaloneRoot, type StandaloneInstallOptions } from "../engine-standalone.ts";
import { augmentedPath, findCliCandidates } from "../env-path.ts";
import { GH_STANDALONE } from "./gh-release.ts";
import { parseGhVersion, versionAtLeast } from "./gh-output.ts";

/** The first release recorded taking `--clipboard=false` and `--insecure-storage` (fixtures/2.102.0); 2.40.1 refuses
 * `--clipboard`, and without it 2.102.0 copies the code to the computer's clipboard. */
export const GH_SIGN_IN_FLOOR = [2, 102, 0] as const;
/** From here gh takes `--expiring=false`, which asks GitHub for a token that does not expire. */
const EXPIRING_FLAG_FROM = [2, 103, 0] as const;
const OUTPUT_MAX = 64 * 1024;
export const GH_CALL_TIMEOUT_MS = 30_000;

export interface GhRun { code: number; stdout: string; stderr: string }
export interface GhChild {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  once(event: "close", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Everything sign-in.ts asks of the machine, so its tests can stand a fake gh in. */
export interface GhTools {
  /** The person's own gh on This computer, never the app's copy; null where their own may not be used (a Cloud home, a
   * boxed server) or there is none. */
  personal(): string | null;
  version(file: string): Promise<[number, number, number] | null>;
  /** The app's pinned copy when it is installed and checked in this run, without downloading. */
  pinnedReady(): string | null;
  /** The app's folder names the pinned version as installed (not checked): a sign-in would not download. */
  pinnedOnDisk(): boolean;
  /** The app's pinned copy, downloading and checking it when needed. */
  install(): Promise<string>;
  spawn(file: string, args: readonly string[], env: Record<string, string>): GhChild;
  run(file: string, args: readonly string[], env: Record<string, string>, timeoutMs?: number): Promise<GhRun>;
  /** Windows only: the gh entries in the person's Credential Manager (`cmdkey /list`), null when it could not be read. */
  windowsGhCredentials(): Promise<string[] | null>;
}

/** Where GitHub CLI's own Windows installers put gh, which a server started before the install may not have on PATH:
 * the MSI, WinGet's links and scoop's shims. */
export function windowsGhDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return [join(env.ProgramFiles ?? "C:\\Program Files", "GitHub CLI"), join(localAppData, "Microsoft", "WinGet", "Links"), join(env.SCOOP ?? join(home, "scoop"), "shims")];
}

/** gh's Credential Manager targets in `cmdkey /list` output: `gh:github.com:<login>`, `gh:_refreshable:github.com:...`. */
export function ghCredentialTargets(output: string): string[] {
  const found = new Set<string>();
  for (const match of output.matchAll(/Target:\s*(?:LegacyGeneric:target=)?(gh:(?:_refreshable:)?github\.com\S*)/giu)) found.add(match[1]!);
  return [...found];
}

/** gh's `auth login` for OpenMausBot's own sign-in. */
export function loginArgs(version: readonly number[] | null): string[] {
  return ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--insecure-storage", "--clipboard=false",
    ...(versionAtLeast(version, EXPIRING_FLAG_FROM) ? ["--expiring=false"] : [])];
}

/** What the server passes on to OpenMausBot's own gh runs: where programs are, the proxy and certificate settings, and on
 * Windows what any program needs to start. Never a token (GH_TOKEN, GITHUB_TOKEN), a D-Bus address or the server's HOME. */
const PASSED = ["PATH", "LANG", "LC_ALL", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR"] as const;

/** The environment of OpenMausBot's own gh runs for one sign-in folder (`home` and `config` are private to it). */
export function ownGhEnv(folders: { home: string; config: string }, base: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED) {
    const value = base[name];
    if (typeof value === "string" && value) env[name] = value;
  }
  if (!env.PATH) env.PATH = platform === "win32" ? "" : "/usr/local/bin:/usr/bin:/bin";
  Object.assign(env, {
    HOME: folders.home,
    GH_CONFIG_DIR: folders.config,
    XDG_CONFIG_HOME: `${folders.home}/.config`,
    XDG_DATA_HOME: `${folders.home}/.local/share`,
    XDG_STATE_HOME: `${folders.home}/.local/state`,
    XDG_CACHE_HOME: `${folders.home}/.cache`,
    XDG_RUNTIME_DIR: `${folders.home}/.run`,
    // A session bus address that leads nowhere: godbus takes a set address as it is, so the keyring is simply unavailable.
    // Unset, it would find the person's session bus at /run/user/<uid>/bus by the uid and reach their Secret Service.
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${folders.home}/.run/no-bus`,
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_TELEMETRY: "false",
    DO_NOT_TRACK: "1",
    GH_PROMPT_DISABLED: "1",
    GH_SPINNER_DISABLED: "1",
    NO_COLOR: "1",
    // gh asks git to use it as git's credential helper; that setting lands in this private HOME, never the person's.
    GIT_CONFIG_NOSYSTEM: "1",
  });
  if (platform === "win32") Object.assign(env, { USERPROFILE: folders.home, APPDATA: `${folders.home}\\AppData\\Roaming`, LOCALAPPDATA: `${folders.home}\\AppData\\Local` });
  return env;
}

/** The person's own gh reads their own sign-in: their environment, without the workspace's credentials. */
export function personalGhEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string | undefined> = { ...base, PATH: augmentedPath(), GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1" };
  stripWorkspaceCredentialEnv(env);
  for (const name of Object.keys(env)) if (name.startsWith("OMB_")) delete env[name];
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export interface GhToolsOptions {
  dataDir: string;
  /** Whether the person's own gh may be used here: This computer, with no bot box. */
  personalAllowed(): boolean;
  install?: StandaloneInstallOptions;
}

export function createGhTools(options: GhToolsOptions): GhTools {
  let pinned: string | null = null;
  const versions = new Map<string, Promise<[number, number, number] | null>>();
  const run = (file: string, args: readonly string[], env: Record<string, string>, timeoutMs = GH_CALL_TIMEOUT_MS) => new Promise<GhRun>((resolve) => {
    execFile(file, [...args], { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: OUTPUT_MAX, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      const failed = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({ code: failed ? (typeof failed.code === "number" ? failed.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
  return {
    personal() {
      if (!options.personalAllowed()) return null;
      const own = standaloneRoot(options.dataDir);
      const path = process.platform === "win32" ? [augmentedPath(), ...windowsGhDirs()].join(delimiter) : augmentedPath();
      return findCliCandidates("gh", path).find((found) => !inside(own, found)) ?? null;
    },
    version(file) {
      let known = versions.get(file);
      if (!known) {
        known = run(file, ["--version"], { PATH: process.env.PATH ?? "", GH_NO_UPDATE_NOTIFIER: "1", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }).then((result) => (result.code === 0 ? parseGhVersion(result.stdout) : null));
        versions.set(file, known);
      }
      return known;
    },
    pinnedReady: () => pinned,
    pinnedOnDisk: () => standaloneCurrentVersion(GH_STANDALONE, options.dataDir) === GH_STANDALONE.version,
    async install() {
      const installed = await installStandaloneEngine(GH_STANDALONE, { baseDir: options.dataDir, ...options.install });
      pinned = installed.executablePath;
      return pinned;
    },
    spawn(file, args, env) {
      const child: ChildProcess = spawn(file, [...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      return child as unknown as GhChild;
    },
    run,
    async windowsGhCredentials() {
      const system = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
      const result = await run(join(system, "System32", "cmdkey.exe"), ["/list"], { SystemRoot: system, PATH: process.env.PATH ?? "" });
      return result.code === 0 ? ghCredentialTargets(result.stdout) : null;
    },
  };
}
