// Chrome for Testing's full browser, never its headless shell: a download is pinned by size and SHA-256 per platform, checked
// before it is unpacked, and unpacked beside its final folder so a reader only ever sees a complete browser.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { pipeline } from "node:stream/promises";

import { renameWithRetry } from "../../atomic.ts";

export const CHROME_FOR_TESTING_VERSION = "153.0.8010.47";

export interface ChromeForTestingPin {
  version: string;
  /** Chrome for Testing's own platform name, as in its download URLs. */
  platform: string;
  bytes: number;
  sha256: string;
}

/** A platform without a SHA-256 here downloads nothing; scripts/pin-chrome-for-testing.ts measures new pins. */
const PINS: Record<string, Omit<ChromeForTestingPin, "version">> = {
  "darwin-arm64": { platform: "mac-arm64", bytes: 190878359, sha256: "939ef9dc3aa74240c929d793e123edab0fda89c5a9cfeb029686c34141d2ed58" },
};

const EXECUTABLES: Record<string, string> = {
  "mac-arm64": "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  "mac-x64": "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  win64: "chrome-win64/chrome.exe",
  linux64: "chrome-linux64/chrome",
  "linux-arm64": "chrome-linux-arm64/chrome",
};

const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
const EXTRACT_TIMEOUT_MS = 10 * 60_000;

export function chromeForTestingPin(platform: NodeJS.Platform = process.platform, arch: string = process.arch): ChromeForTestingPin | null {
  const pin = PINS[`${platform}-${arch}`];
  return pin ? { version: CHROME_FOR_TESTING_VERSION, ...pin } : null;
}

export function chromeForTestingUrl(pin: Pick<ChromeForTestingPin, "version" | "platform">): string {
  return `https://storage.googleapis.com/chrome-for-testing-public/${pin.version}/${pin.platform}/chrome-${pin.platform}.zip`;
}

export function chromeForTestingDirectory(dataDir: string, pin: Pick<ChromeForTestingPin, "version" | "platform">): string {
  return join(dataDir, "tools", "chrome", pin.version, pin.platform);
}

export function chromeForTestingExecutable(dataDir: string, pin: Pick<ChromeForTestingPin, "version" | "platform">): string {
  const relative = EXECUTABLES[pin.platform];
  if (!relative) throw new Error(`Chrome for Testing has no known layout for ${pin.platform}.`);
  return join(chromeForTestingDirectory(dataDir, pin), relative);
}

export interface DownloadProgress { received: number; total: number }

/** Streams to `destination`, hashing on the way; a body longer than `bytes` is cut off. Resolves to the SHA-256 it read. */
export async function downloadArchive(
  url: string,
  destination: string,
  bytes: number,
  options: { fetchImpl?: typeof fetch; onProgress?: (progress: DownloadProgress) => void; timeoutMs?: number } = {},
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  const hash = createHash("sha256");
  let received = 0;
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { redirect: "follow", signal: controller.signal });
    const body = response.body;
    if (!response.ok || !body) throw new Error(`the Chrome download failed (HTTP ${response.status})`);
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared !== bytes) throw new Error("the Chrome download did not match its pinned size; nothing was installed");
    const file = createWriteStream(destination, { mode: 0o600 });
    file.once("error", () => controller.abort());
    await pipeline(async function* () {
      for await (const chunk of body) {
        received += chunk.byteLength;
        if (received > bytes) throw new Error("the Chrome download was larger than its pinned size; nothing was installed");
        hash.update(chunk);
        yield chunk;
        options.onProgress?.({ received, total: bytes });
      }
    }, file);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (received !== bytes) throw new Error("the Chrome download ended early; nothing was installed");
  return hash.digest("hex");
}

export type Extract = (archive: string, directory: string) => Promise<void>;

/** Git Bash puts GNU tar, which cannot read a zip, ahead of Windows' own bsdtar on PATH; name System32's. */
export const extractZip: Extract = (archive, directory) => new Promise((resolve, reject) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const [file, args] = process.platform === "win32"
    ? [win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", archive, "-C", directory]]
    : ["unzip", ["-q", archive, "-d", directory]];
  execFile(file, args, { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error) => {
    if (error) reject(new Error(`the Chrome archive could not be unpacked: ${error.message}`));
    else resolve();
  });
});

const installs = new Map<string, Promise<string>>();

/** One download per folder at a time; resolves to the browser executable. */
export function installChromeForTesting(options: {
  dataDir: string;
  pin: ChromeForTestingPin;
  fetchImpl?: typeof fetch;
  extract?: Extract;
  onProgress?: (progress: DownloadProgress) => void;
  url?: string;
}): Promise<string> {
  const directory = chromeForTestingDirectory(options.dataDir, options.pin);
  let running = installs.get(directory);
  if (!running) {
    running = install(options).finally(() => installs.delete(directory));
    installs.set(directory, running);
  }
  return running;
}

async function install(options: Parameters<typeof installChromeForTesting>[0]): Promise<string> {
  const { dataDir, pin } = options;
  const executable = chromeForTestingExecutable(dataDir, pin);
  if (existsSync(executable)) return executable;
  const directory = chromeForTestingDirectory(dataDir, pin);
  const root = dirname(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Only what an interrupted install left: a download still running elsewhere keeps writing, so its files stay recent.
  for (const name of readdirSync(root)) {
    const part = join(root, name);
    if (name.endsWith(".part") && Date.now() - statSync(part).mtimeMs > DOWNLOAD_TIMEOUT_MS) rmSync(part, { recursive: true, force: true });
  }
  const tag = randomBytes(6).toString("hex");
  const archive = join(root, `${pin.platform}.${tag}.zip.part`);
  const staging = join(root, `${pin.platform}.${tag}.part`);
  try {
    const digest = await downloadArchive(options.url ?? chromeForTestingUrl(pin), archive, pin.bytes, options);
    if (digest !== pin.sha256) throw new Error("the Chrome download failed its SHA-256 check; nothing was installed");
    await (options.extract ?? extractZip)(archive, staging);
    if (!existsSync(join(staging, EXECUTABLES[pin.platform]!))) throw new Error("the Chrome archive did not hold the browser; nothing was installed");
    rmSync(directory, { recursive: true, force: true });
    renameWithRetry(staging, directory);
    return executable;
  } finally {
    rmSync(archive, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}
