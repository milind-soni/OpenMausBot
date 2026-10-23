import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CdpBrowser } from "../cdp/browser.ts";
import { DriverError, isUnanswered } from "../cdp/errors.ts";
import { IDENTITY_PROBE, type Identity, type IdentityProbe } from "../cdp/identity.ts";
import type { CdpPage } from "../cdp/page.ts";
import type { HostKind } from "./flags.ts";
import { headedIdentity, isChromeIdentity } from "./identity.ts";
import { FIRST_START_MS, launchChrome } from "./launch.ts";
import { browserRoot } from "./profile.ts";

export interface CalibratedIdentity extends Identity {
  /** The binary's fingerprint when it was read. */
  fingerprint: string;
  calibratedAt: string;
}

/** Changes when the browser is updated in place: Chrome's updater rewrites the bundle's Info.plist on macOS, the
 * executable elsewhere. */
export function chromeFingerprint(path: string): string {
  const real = realpathSync(path);
  const plist = /\.app[\\/]Contents[\\/]MacOS[\\/][^\\/]+$/u.test(real) ? join(real, "..", "..", "Info.plist") : null;
  const stat = statSync(plist && existsSync(plist) ? plist : real);
  return createHash("sha256").update(`${real}\0${stat.size}\0${stat.mtimeMs}`).digest("hex").slice(0, 24);
}

export function identityFile(dataDir: string, executablePath: string): string {
  return join(browserRoot(dataDir), "identity", `${chromeFingerprint(executablePath)}.json`);
}

/** A blank page on an ephemeral loopback port: loopback is a secure context, where navigator.userAgentData exists. */
export async function loopbackPage(): Promise<{ url: string; close: () => void }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>calibration</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

/**
 * Chrome on Windows now and then loses the first network navigation of a tab on a profile that never navigated. Chrome
 * for Testing 155 cancels it, net::ERR_ABORTED a moment after the request starts with nothing else navigating: on
 * GitHub's Windows runner 35 of 150 fresh starts, none of 90 second starts, none on macOS, and a data: page first did not
 * prevent it. The runner's Google Chrome 156 sometimes never answers Page.navigate instead, and the tab stays on
 * about:blank; that tab's next navigation went through. A second request went through every time, so a page of our own,
 * which has no side effects, is opened once more.
 */
export async function openOwnPage(tab: CdpPage, url: string, timeoutMs: number): Promise<void> {
  try {
    await tab.navigate(url, { timeoutMs });
  } catch (error) {
    if (!lostFirstNavigation(error)) throw error;
    await tab.navigate(url, { timeoutMs });
  }
}

function lostFirstNavigation(error: unknown): boolean {
  if (!(error instanceof DriverError)) return false;
  return error.detail?.netError === "ERR_ABORTED" || (isUnanswered(error) && error.detail?.method === "Page.navigate");
}

export interface CalibrateOptions {
  executablePath: string;
  host: HostKind;
  /** The browser's environment; its HOME is always the account's real one. */
  env?: NodeJS.ProcessEnv;
  /** Where the throwaway profile goes. */
  tmpRoot?: string;
  sandbox?: boolean;
  timeoutMs?: number;
  handshakeTimeoutMs?: number;
}

/**
 * Reads what this binary reports about itself, headless, with no override and
 * no gate: the user agent with "HeadlessChrome" made "Chrome" (what it sends
 * headed) and its own client-hint metadata, read in the isolated world. A build
 * that names itself headless anywhere else, such as the headless shell, is refused.
 */
export async function calibrateIdentity(options: CalibrateOptions): Promise<CalibratedIdentity> {
  const fingerprint = chromeFingerprint(options.executablePath);
  const userDataDir = mkdtempSync(join(options.tmpRoot ?? tmpdir(), "omb-calibrate-"));
  const page = await loopbackPage();
  const chrome = await launchChrome({
    executablePath: options.executablePath,
    userDataDir,
    mode: "headless",
    host: options.host,
    ...(options.env ? { env: options.env } : {}),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? FIRST_START_MS,
  }).catch((error: unknown) => {
    page.close();
    rmSync(userDataDir, { recursive: true, force: true });
    throw error;
  });
  try {
    const browser = await CdpBrowser.connect(chrome.transport, { identity: null, headless: true, permissions: false });
    const tab = await browser.waitForPage(() => true, options.timeoutMs ?? 15_000);
    await openOwnPage(tab, page.url, options.timeoutMs ?? 15_000);
    const probe = await tab.evaluate(IDENTITY_PROBE) as IdentityProbe;
    const identity = headedIdentity({ userAgent: probe.userAgent, hints: probe.high });
    await browser.close();
    return { ...identity, product: chrome.version.product.replace("HeadlessChrome/", "Chrome/"), fingerprint, calibratedAt: new Date().toISOString() };
  } finally {
    await chrome.close(3_000);
    page.close();
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function readCalibration(file: string, fingerprint: string): CalibratedIdentity | null {
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as CalibratedIdentity;
    const usable = stored.fingerprint === fingerprint && typeof stored.product === "string"
      && isChromeIdentity({ userAgent: stored.userAgent, userAgentMetadata: stored.userAgentMetadata });
    return usable ? stored : null;
  } catch {
    return null;
  }
}

/** Calibrates once per binary and version, about a second, and keeps the result in `browser/identity/`. */
export async function loadOrCalibrateIdentity(
  dataDir: string,
  options: CalibrateOptions,
  calibrate: (options: CalibrateOptions) => Promise<CalibratedIdentity> = calibrateIdentity,
): Promise<{ identity: CalibratedIdentity; file: string; calibrated: boolean }> {
  const fingerprint = chromeFingerprint(options.executablePath);
  const file = identityFile(dataDir, options.executablePath);
  const stored = readCalibration(file, fingerprint);
  if (stored) return { identity: stored, file, calibrated: false };
  const identity = { ...await calibrate(options), fingerprint };
  mkdirSync(join(browserRoot(dataDir), "identity"), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return { identity, file, calibrated: true };
}
