// Bitwarden's own command line tool, `bw` (GPL-3.0, github.com/bitwarden/clients), is never bundled, imported or shipped
// with OpenMausBot: it is downloaded on first use from Bitwarden's GitHub release, checked against the size and SHA-256
// pinned here, kept in the data folder, and only ever run as a separate process. The "oss" build is the one made from
// the GPL code alone. Security: every secret reaches it in its environment, never its arguments, which any local user
// can list.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { downloadArchive } from "../browser/chrome/install.ts";
import { extractZipMember, readZipDirectory } from "../zip-archive.ts";

export const BITWARDEN_CLI_VERSION = "2026.10.1";

export interface BitwardenCliPin { asset: string; bytes: number; sha256: string; executable: string }

/** The release's own digests (GitHub's `sha256:` for each asset of cli-v2026.10.1). */
const PINS: Record<string, BitwardenCliPin> = {
  "darwin-arm64": { asset: "bw-oss-macos-arm64", bytes: 41_861_655, sha256: "8b64bc7887f03c8d3ee10be2d720f3904ab632553434a47703f428d8ece9c9f2", executable: "bw" },
  "darwin-x64": { asset: "bw-oss-macos", bytes: 44_129_496, sha256: "faa5c6ec794bb2b3c969e2f08cba04a0f0ff8f1b2c10c5cf7b88911eaa0c1f4b", executable: "bw" },
  "linux-x64": { asset: "bw-oss-linux", bytes: 45_802_496, sha256: "53384064abe7555039281bc2e6fe51846368ba60db9b7ba89de183409d7f6738", executable: "bw" },
  "linux-arm64": { asset: "bw-oss-linux-arm64", bytes: 44_326_018, sha256: "9413e412ba2f8d3b179c54314c3d2d51c0b2ec25ed17b96a98b7c2d404b6d2a7", executable: "bw" },
  "win32-x64": { asset: "bw-oss-windows", bytes: 39_074_173, sha256: "8ec2a4235c6c8db93cf42b444161882842e28f14dd6116369dea61efde8a418f", executable: "bw.exe" },
};

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const OUTPUT_MAX = 32 * 1024 * 1024;

export function bitwardenCliPin(platform: string = process.platform, arch: string = process.arch): BitwardenCliPin | null {
  return PINS[`${platform}-${arch}`] ?? null;
}

export function bitwardenCliUrl(pin: BitwardenCliPin): string {
  return `https://github.com/bitwarden/clients/releases/download/cli-v${BITWARDEN_CLI_VERSION}/${pin.asset}-${BITWARDEN_CLI_VERSION}.zip`;
}

export function bitwardenCliPath(dataDir: string, pin: BitwardenCliPin): string {
  return join(dataDir, "tools", "bitwarden", BITWARDEN_CLI_VERSION, pin.executable);
}

/** The tool could not be put in place on this computer: never the person's account or password. */
export class BitwardenCliUnavailable extends Error {
  constructor(reason: string) {
    super(`Bitwarden's command line tool could not be set up on this computer (${reason}). Try again in a few minutes.`);
    this.name = "BitwardenCliUnavailable";
  }
}

const installs = new Map<string, Promise<string>>();

/** The tool's path, downloading it the first time; one download per folder at a time. */
export function installBitwardenCli(options: { dataDir: string; pin?: BitwardenCliPin | null; fetchImpl?: typeof fetch; url?: string }): Promise<string> {
  const pin = options.pin === undefined ? bitwardenCliPin() : options.pin;
  if (!pin) return Promise.reject(new BitwardenCliUnavailable(`Bitwarden publishes none for ${process.platform} ${process.arch}`));
  const executable = bitwardenCliPath(options.dataDir, pin);
  if (existsSync(executable)) return Promise.resolve(executable);
  let running = installs.get(executable);
  if (!running) {
    running = install(executable, pin, options).finally(() => installs.delete(executable));
    installs.set(executable, running);
  }
  return running;
}

async function install(executable: string, pin: BitwardenCliPin, options: { fetchImpl?: typeof fetch; url?: string }): Promise<string> {
  const root = join(executable, "..");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(root)) {
    const part = join(root, name);
    if (name.endsWith(".part") && Date.now() - statSync(part).mtimeMs > DOWNLOAD_TIMEOUT_MS) rmSync(part, { force: true });
  }
  const tag = randomBytes(6).toString("hex");
  const archive = join(root, `${pin.asset}.${tag}.zip.part`);
  const staged = join(root, `${pin.executable}.${tag}.part`);
  try {
    const digest = await downloadArchive(options.url ?? bitwardenCliUrl(pin), archive, pin.bytes,
      { fetchImpl: options.fetchImpl, timeoutMs: DOWNLOAD_TIMEOUT_MS, label: "Bitwarden command line tool" });
    if (digest !== pin.sha256) throw new Error("the download failed its SHA-256 check; nothing was installed");
    const member = (await readZipDirectory(archive, 4)).find((entry) => entry.name === pin.executable);
    if (!member) throw new Error("the archive did not hold the tool; nothing was installed");
    await extractZipMember(archive, member, staged, 0o700);
    renameSync(staged, executable);
    return executable;
  } catch (error) {
    throw new BitwardenCliUnavailable(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(archive, { force: true });
    rmSync(staged, { force: true });
  }
}

export interface BwResult { code: number; stdout: string; stderr: string; timedOut: boolean }
/** One `bw` call: `env` carries every secret (BW_CLIENTID, BW_CLIENTSECRET, BW_PASSWORD, BW_SESSION). */
export type BwRun = (args: readonly string[], env?: Record<string, string>, timeoutMs?: number) => Promise<BwResult>;

/** Runs the tool with only what it needs: its own settings folder, no prompts, and nothing of the server's environment. */
export function bitwardenRunner(options: { executable: () => Promise<string>; appDataDir: string }): BwRun {
  return async (args, env = {}, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) => {
    const file = await options.executable();
    mkdirSync(options.appDataDir, { recursive: true, mode: 0o700 });
    return new Promise((resolve) => {
      execFile(file, [...args], {
        env: {
          PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          HOME: options.appDataDir, BITWARDENCLI_APPDATA_DIR: options.appDataDir, BW_NOINTERACTION: "true", NODE_OPTIONS: "", ...env,
        },
        timeout: timeoutMs, maxBuffer: OUTPUT_MAX, windowsHide: true, encoding: "utf8",
      }, (error, stdout, stderr) => {
        const failed = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        if (failed?.code === "ENOENT") { resolve({ code: 127, stdout: "", stderr: "ENOENT", timedOut: false }); return; }
        resolve({ code: failed ? (typeof failed.code === "number" ? failed.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: Boolean(failed?.killed) });
      });
    });
  };
}

/** Leaves the folder clean when the person disconnects: the tool's own settings and cached vault go with the account. */
export function forgetBitwardenAppData(appDataDir: string): void {
  rmSync(appDataDir, { recursive: true, force: true });
}
