// The Chrome agent-browser starts for the bots, prepared once per binary: found or downloaded, its identity read, and a
// launcher written that gives it that identity. The engine's own browser stays when nothing here applies, or with
// OMB_BROWSER_LEGACY_SHELL=1; once a machine's choice is made it is not switched while the server runs.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";

import { browserEngineStatus } from "../../browser-engine.ts";
import { attachesToChrome, ownsBrowserViewport, type BrowserLaunch } from "../../browser-runtime.ts";
import { DATA_DIR } from "../../config.ts";
import { calibrateIdentity, chromeFingerprint, loadOrCalibrateIdentity, type CalibratedIdentity } from "./calibrate.ts";
import { needsNoSandbox, type ChromeIdentity } from "./identity.ts";
import { installChromeForTesting, type ChromeForTestingPin, type DownloadProgress } from "./install.ts";
import { chromeHost, resolveChromePlan, type ChromeEngine, type ChromeHost, type ChromePlan, type FoundChrome } from "./resolve.ts";
import { IdentitySidecars } from "./sidecar.ts";
import { browserLanguage, browserTimeZone, languageList, launcherPath, primaryScreen, writeLauncher, type LauncherBox, type LauncherSettings, type Screen } from "./wrapper.ts";

type Ready = { kind: "ready"; chrome: FoundChrome; identity: ChromeIdentity; product: string; fingerprint: string; launcher?: LauncherSettings };
type State =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "downloading"; pin: ChromeForTestingPin; progress: DownloadProgress }
  | Ready
  | { kind: "failed"; reason: string };

type LaunchSpec = { command: string; env?: Record<string, string | undefined> };

const SOURCES: Record<FoundChrome["source"], string> = {
  installed: "installed",
  downloaded: "downloaded",
  named: "named by OMB_CHROME_PATH or AGENT_BROWSER_EXECUTABLE_PATH",
  "agent-browser": "installed by agent-browser",
};

const megabytes = (bytes: number) => Math.round(bytes / 1_048_576);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export { chromeFingerprint };

/** A data dir on a volume mounted noexec cannot run the launcher; finding that out before the engine needs it keeps the
 * engine's own browser instead of a browser that never starts. A check that only ran out of time still ran: a noexec
 * volume refuses the launcher at once. That happens on a Cloud machine in its first seconds after a restart, starved of
 * CPU, and must not cost it this launcher until the next restart. */
export function runsLauncher(path: string, env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(path, ["--version"], { env, timeout: timeoutMs, windowsHide: true }, (error) => {
      if (!error || error.killed) return resolve();
      reject(new Error(`the browser launcher does not run here: ${error.message}`));
    });
  });
}

export interface ChromeLauncherOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  host?: ChromeHost;
  engine?: () => ChromeEngine | null;
  calibrate?: (executable: string, env: NodeJS.ProcessEnv) => Promise<ChromeIdentity>;
  install?: typeof installChromeForTesting;
  screen?: () => Promise<Screen>;
  checkLauncher?: (path: string, env: NodeJS.ProcessEnv) => Promise<void>;
  sidecars?: IdentitySidecars;
  readyWaitMs?: number;
  log?: (line: string) => void;
  /** False for OpenMausBot's own driver, which needs the binary and its identity but no launcher for agent-browser. */
  wrapper?: boolean;
  /** Chrome's sandbox while its identity is read; by default off only where agent-browser turns it off. */
  sandbox?: boolean;
}

export class ChromeLauncher implements BrowserLaunch {
  /** The executable agent-browser is given; the same path for every browser this data dir starts. */
  readonly path: string;
  private state: State = { kind: "idle" };
  private preparing: Promise<void> | null = null;
  private screen: Promise<Screen> | null = null;
  private readonly options: Required<Pick<ChromeLauncherOptions, "dataDir" | "env" | "platform" | "readyWaitMs">> & ChromeLauncherOptions;
  private readonly host: ChromeHost;
  private readonly sidecars: IdentitySidecars;
  private box: (() => LauncherBox | null) | null = null;

  constructor(options: ChromeLauncherOptions) {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    this.options = { ...options, env, platform, readyWaitMs: options.readyWaitMs ?? 45_000 };
    this.host = options.host ?? chromeHost({ dataDir: options.dataDir, env, platform, arch: options.arch });
    this.sidecars = options.sidecars ?? new IdentitySidecars();
    this.path = launcherPath(options.dataDir, platform);
  }

  /** Every Chrome started from now on runs in the box this returns (a Team Cloud's); the launcher is written again. */
  boxWith(box: () => LauncherBox | null): void {
    this.box = box;
    if (this.state.kind === "ready" && this.state.launcher) {
      const launcher = { ...this.state.launcher, ...this.boxed() };
      writeLauncher(this.path, launcher, this.options.platform);
      this.state = { ...this.state, launcher };
    }
  }

  private boxed(): { box?: LauncherBox } {
    const box = this.box?.() ?? null;
    return box ? { box } : {};
  }

  plan(): ChromePlan {
    return resolveChromePlan(this.host, this.options.engine ? this.options.engine() : this.managedEngine());
  }

  /** What agent-browser's environment gains: nothing while the engine keeps its own browser. */
  env(): Record<string, string> {
    if (this.state.kind === "failed" || this.plan().kind === "legacy") return {};
    void this.prepare();
    this.followTimeZone();
    return { AGENT_BROWSER_EXECUTABLE_PATH: this.path, AGENT_BROWSER_HIDE_SCROLLBARS: "0" };
  }

  /** The owner's app can give a Cloud its time zone at any time (server/time-zone.ts): the next Chrome this starts tells
   * time in it too, rather than the zone the server had when the launcher was written. */
  private followTimeZone(): void {
    const state = this.state;
    if (state.kind !== "ready" || !state.launcher) return;
    const timeZone = browserTimeZone(this.options.env, this.options.platform);
    if (timeZone === state.launcher.timeZone) return;
    const launcher = { ...state.launcher, timeZone };
    try {
      writeLauncher(this.path, launcher, this.options.platform);
      this.state = { ...state, launcher };
      this.log(`browser: the next browser started tells time in ${timeZone ?? "the system's zone"}`);
    } catch (error) {
      this.log(`browser: could not move the browser to ${timeZone ?? "the system's zone"} (${message(error)})`);
    }
  }

  start(): void {
    if (this.plan().kind !== "legacy") void this.prepare();
  }

  prepare(): Promise<void> {
    if (this.preparing) return this.preparing;
    if (this.state.kind === "failed" || (this.state.kind === "ready" && this.fresh(this.state))) return Promise.resolve();
    const plan = this.plan();
    if (plan.kind === "legacy") return Promise.resolve();
    const previous = this.state.kind === "ready" ? this.state : null;
    if (!previous) this.state = { kind: "preparing" };
    this.preparing = this.prepareFor(plan).then((ready) => {
      this.state = ready;
      this.log(`browser: ${this.describe()}`);
    }, (error: unknown) => {
      // A launcher that already works is kept as it is: switching browsers under a running session would lose its pages.
      this.state = previous ? { ...previous, fingerprint: this.fingerprintOr(previous) } : { kind: "failed", reason: message(error) };
      this.log(`browser: Chrome could not be prepared (${message(error)}); ${previous ? "keeping the browser already set up" : "bots keep the engine's own browser"}`);
    }).finally(() => { this.preparing = null; });
    return this.preparing;
  }

  async ready(spec: LaunchSpec): Promise<void> {
    if (!this.uses(spec)) return;
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([
      this.prepare().then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.options.readyWaitMs); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
    if (!done) {
      const state = this.state;
      throw new Error(state.kind === "downloading"
        ? `Getting the browser ready (${megabytes(state.progress.received)} of ${megabytes(state.progress.total)} MB). Try again in a minute.`
        : "Getting the browser ready. Try again in a moment.");
    }
    if (this.state.kind === "failed") throw new Error(`Chrome could not be started (${this.state.reason}). Try again: your next browser call uses the built-in browser.`);
  }

  async started(session: string, spec: LaunchSpec): Promise<void> {
    if (this.state.kind !== "ready" || !this.uses(spec) || !ownsBrowserViewport(spec.env ?? {})) return;
    await this.sidecars.ensure(session, spec, { ...this.state.identity, acceptLanguage: languageList(browserLanguage(this.options.env)) });
  }

  stopped(session: string): void {
    this.sidecars.forget(session);
  }

  /** For the browser status, e.g. "Google Chrome 153 (installed)". */
  describe(): string {
    const state = this.state;
    if (state.kind === "ready") return `${product(state.chrome, state.identity)} ${state.identity.userAgentMetadata.fullVersion.split(".")[0]} (${SOURCES[state.chrome.source]})`;
    const plan = this.plan();
    if (plan.kind === "legacy") return `${this.engineBrowser()} (${plan.reason})`;
    if (state.kind === "failed") return `${this.engineBrowser()} (Chrome could not be started: ${state.reason})`;
    if (state.kind === "downloading") return `Chrome for Testing ${state.pin.version} (downloading: ${megabytes(state.progress.received)} of ${megabytes(state.progress.total)} MB)`;
    if (plan.kind === "download") return `Chrome for Testing ${plan.pin.version} (not downloaded yet)`;
    return `${product(plan.chrome)} (${SOURCES[plan.chrome.source]}; not started yet)`;
  }

  /** On macOS every Chrome this starts gets the person's own home, whatever HOME the server runs with (a test fixture's is
   * temporary): elsewhere a "keychain cannot be found" dialog would appear on their screen. */
  private chromeEnv(): NodeJS.ProcessEnv {
    return this.options.platform === "darwin" ? { ...this.options.env, HOME: userInfo().homedir } : this.options.env;
  }

  private uses(spec: LaunchSpec): boolean {
    return spec.env?.AGENT_BROWSER_EXECUTABLE_PATH === this.path && !attachesToChrome(spec.env);
  }

  private fresh(state: Ready): boolean {
    try { return chromeFingerprint(state.chrome.path) === state.fingerprint; } catch { return false; }
  }

  private fingerprintOr(state: Ready): string {
    try { return chromeFingerprint(state.chrome.path); } catch { return state.fingerprint; }
  }

  private async prepareFor(plan: Exclude<ChromePlan, { kind: "legacy" }>): Promise<Ready> {
    let chrome = plan.kind === "download" ? await this.download(plan.pin) : plan.chrome;
    let identity: CalibratedIdentity;
    try {
      identity = await this.identityOf(chrome);
    } catch (error) {
      if (plan.kind !== "chrome" || plan.chrome.source !== "installed" || !plan.fallback) throw error;
      this.log(`browser: Google Chrome at ${chrome.path} could not start headless (${message(error)}); using Chrome for Testing`);
      chrome = await this.download(plan.fallback);
      identity = await this.identityOf(chrome);
    }
    const { env, platform } = this.options;
    let launcher: LauncherSettings | undefined;
    if (this.options.wrapper !== false) {
      this.screen ??= this.options.screen ? this.options.screen() : primaryScreen(platform, env);
      launcher = {
        chrome: chrome.path, userAgent: identity.userAgent, screen: await this.screen,
        language: browserLanguage(env), timeZone: browserTimeZone(env, platform),
        ...(platform === "darwin" ? { home: userInfo().homedir } : {}),
        ...this.boxed(),
      };
      writeLauncher(this.path, launcher, platform);
      if (platform !== "win32") await (this.options.checkLauncher ?? runsLauncher)(this.path, this.chromeEnv());
    }
    return { kind: "ready", chrome, identity: { userAgent: identity.userAgent, userAgentMetadata: identity.userAgentMetadata }, product: identity.product, fingerprint: chromeFingerprint(chrome.path), ...(launcher ? { launcher } : {}) };
  }

  private async download(pin: ChromeForTestingPin): Promise<FoundChrome> {
    this.state = { kind: "downloading", pin, progress: { received: 0, total: pin.bytes } };
    const path = await (this.options.install ?? installChromeForTesting)({
      dataDir: this.options.dataDir, pin,
      onProgress: (progress) => { if (this.state.kind === "downloading") this.state = { ...this.state, progress }; },
    });
    return { path, source: "downloaded" };
  }

  /** Read once per binary version and kept, since starting a browser to read it takes about a second. */
  private async identityOf(chrome: FoundChrome): Promise<CalibratedIdentity> {
    const env = this.chromeEnv();
    const injected = this.options.calibrate;
    const calibrate = injected
      ? async (options: { executablePath: string }): Promise<CalibratedIdentity> => {
        const read = await injected(options.executablePath, env);
        return { ...read, product: `Chrome/${read.userAgentMetadata.fullVersion}`, fingerprint: chromeFingerprint(options.executablePath), calibratedAt: new Date().toISOString() };
      }
      : calibrateIdentity;
    const host = this.options.platform === "linux" && existsSync("/.dockerenv") ? "container" : "desktop";
    const options = { executablePath: chrome.path, host, env, sandbox: this.options.sandbox ?? !needsNoSandbox(env) } as const;
    return (await loadOrCalibrateIdentity(this.options.dataDir, options, calibrate)).identity;
  }

  /** The Chrome and its identity for OpenMausBot's own driver: found or downloaded once, and read once per version. */
  async binary(): Promise<{ path: string; identity: ChromeIdentity; product: string; source: FoundChrome["source"] }> {
    const plan = this.plan();
    if (plan.kind === "legacy") throw new Error(`no Chrome to run here (${plan.reason})`);
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([
      this.prepare().then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.options.readyWaitMs); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
    const state = this.state;
    if (!done) {
      throw new Error(state.kind === "downloading"
        ? `Getting the browser ready (${megabytes(state.progress.received)} of ${megabytes(state.progress.total)} MB). Try again in a minute.`
        : "Getting the browser ready. Try again in a moment.");
    }
    if (state.kind === "failed") throw new Error(`Chrome could not be started (${state.reason}).`);
    if (state.kind !== "ready") throw new Error("Chrome is not ready yet. Try again in a moment.");
    return { path: state.chrome.path, identity: state.identity, product: state.product, source: state.chrome.source };
  }

  private managedEngine(): ChromeEngine | null {
    const status = browserEngineStatus({ dataDir: this.options.dataDir, env: this.options.env, platform: this.options.platform, arch: this.options.arch });
    return status.kind === "ready" ? { managed: status.managed } : null;
  }

  private engineBrowser(): string {
    const named = this.options.env.AGENT_BROWSER_EXECUTABLE_PATH?.trim();
    if (named) return named;
    return this.options.env.OMB_RESOURCES_PATH ? "the bundled Chromium headless shell" : "agent-browser's own browser";
  }

  private log(line: string): void {
    (this.options.log ?? console.log)(line);
  }
}

function product(chrome: FoundChrome, identity?: ChromeIdentity): string {
  if (identity?.userAgentMetadata.brands.some(({ brand }) => brand === "Google Chrome")) return "Google Chrome";
  if (chrome.source === "installed") return "Google Chrome";
  return chrome.source === "downloaded" || /for Testing|chrome-(?:linux|mac|win)/iu.test(chrome.path) ? "Chrome for Testing" : "Chromium";
}

export const chromeLauncher = new ChromeLauncher({ dataDir: DATA_DIR });
