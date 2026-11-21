// Where a profile's browser runs. Everything above the CDP connection (tools, control, viewers) is the same on every
// backend; a backend only decides how that connection is made and what the browser it reaches can do.
import { CdpBrowser, type BrowserOptions } from "./cdp/browser.ts";
import { loopbackPage, openOwnPage } from "./chrome/calibrate.ts";
import type { Identity } from "./cdp/identity.ts";
import { webSocketTransport } from "./cdp/transport.ts";
import { fitPage, pageLimit, type BrowserMode, type HostKind, type ScreenSpec } from "./chrome/flags.ts";
import { ChromeLaunchError, launchChrome, type ChromeProcess, type LaunchOptions } from "./chrome/launch.ts";
import { clearSingleton, staleSingletonLock, type ProcessRegistry } from "./chrome/processes.ts";
import { languageList } from "./chrome/wrapper.ts";
import type { DesktopDisplay } from "./desktop/displays.ts";
import { downgradeRefusal, ensureProfile, forgetOpenTabs, markCleanExit, profileDir, profileHash, recordOpenedBy, versionOf, workspaceId } from "./chrome/profile.ts";

export type BackendKind = "local" | "my-chrome" | "cdp-url" | "pane";

export interface BackendCaps {
  persistentProfile: boolean;
  window: boolean;
  egressGate: boolean;
  identityOverride: boolean;
  /** False for the person's own Chrome: the bot acts only in tabs it opened. */
  ownsAllTabs: boolean;
  downloads: "local" | "none";
  uploads: "path" | "inject";
  botPasskeys: boolean;
}

export interface SiteRefusal {
  kind: "google-rejected" | "passkey";
  url: string;
  targetId: string;
}

export interface OpenRequest {
  key: string;
  mode: BrowserMode;
  /** Opens on one blank tab instead of reopening the last session's tabs. */
  fresh: boolean;
  viewport: { width: number; height: number };
  downloadDir: string;
}

export interface OpenedBrowser {
  readonly browser: CdpBrowser;
  /** The largest page its windows may show, as no real window is larger than its screen; null where OpenMausBot sizes no window. */
  readonly pageLimit?: { width: number; height: number } | null;
  readonly pid: number | null;
  /** The Chrome version that answered, e.g. 155.0.8059.80. */
  readonly version: string;
  readonly exited: Promise<void>;
  /** Chrome's own quit: session restore keeps the tabs and session cookies. */
  close(): Promise<void>;
  /** "pane" for the desktop app's native panes. */
  readonly surface?: "pane";
  /** A site turned this browser away (Google's refused sign-in, a passkey it cannot serve): the person's own Chrome is the
   * way on. Google sign-ins are never imported, so an import is no answer to Google's refusal. */
  onSiteRefusal?(listener: (refusal: SiteRefusal) => void): () => void;
  /** Where the person uses the page directly: called as they press, type or scroll in it. */
  onPersonInput?(listener: () => void): () => void;
  /** Where the person uses the page directly: holds the bot's input to a tab while the person has it (refs drop on
   * release), says who acted last in it, whether it holds a tab, and whether the person holds any tab. */
  personControl?: { hold(targetId: string, held: boolean): void; owner(targetId: string): "person" | "bot" | null; held(targetId: string): boolean; holding(): boolean };
  /** The private display its window is on, which a person sees as a remote desktop; absent when it runs headless. */
  readonly display?: DesktopDisplay | null;
}

export interface Backend {
  readonly kind: BackendKind;
  readonly caps: BackendCaps;
  open(request: OpenRequest): Promise<OpenedBrowser>;
}

export interface ResolvedBinary {
  path: string;
  identity: Identity;
}

export interface LocalBackendOptions {
  dataDir: string;
  host: HostKind;
  platform?: NodeJS.Platform;
  binary(): Promise<ResolvedBinary>;
  screen(): Promise<ScreenSpec>;
  /** The person's language, for --lang and the Accept-Language a page sees. */
  locale?: () => string | null;
  timezone?: () => string | null;
  /** The egress gate for this profile's Chrome; null runs it without one. */
  egressPort(key: string): Promise<number | null>;
  registry?: ProcessRegistry | null;
  /** False only when an operator turned Chrome's sandbox off. */
  sandbox?: boolean;
  sandboxHelper?: string | null;
  acceptLanguages?: () => string;
  handshakeTimeoutMs?: number;
  log?: (line: string) => void;
  /** Starts Chrome; tests pass a fake. */
  launch?: (options: LaunchOptions) => Promise<ChromeProcess>;
  /** A private display for this profile's window, or null to run it headless. */
  display?: (key: string) => Promise<DesktopDisplay | null>;
  /** Chrome could not start on its display, so it was started headless instead; `reason` is what Chrome said. */
  displayFailed?: (reason: string) => void;
}

/** Chrome did not start on its private display. */
class DisplayLaunchError extends Error {
  readonly reason: string;
  constructor(error: unknown) {
    const output = error instanceof ChromeLaunchError ? error.output.trim().split("\n").slice(-20).join("\n") : "";
    const reason = `${error instanceof Error ? error.message : String(error)}${output ? `\n${output}` : ""}`;
    super(reason);
    this.reason = reason;
  }
}

const LOCAL_CAPS: BackendCaps = { persistentProfile: true, window: true, egressGate: true, identityOverride: true, ownsAllTabs: true, downloads: "local", uploads: "path", botPasskeys: true };

/** A Chrome OpenMausBot launches on a profile folder of its own, driven over its DevTools pipe. */
export class LocalBackend implements Backend {
  readonly kind = "local" as const;
  readonly caps = LOCAL_CAPS;
  readonly #options: LocalBackendOptions;

  constructor(options: LocalBackendOptions) {
    this.#options = options;
  }

  async open(request: OpenRequest): Promise<OpenedBrowser> {
    const options = this.#options;
    const platform = options.platform ?? process.platform;
    const release = options.registry?.reserve(profileDir(options.dataDir, request.key));
    try {
      try {
        return await this.#open(request, platform, true);
      } catch (error) {
        if (!(error instanceof DisplayLaunchError)) throw error;
        // A host whose Chrome cannot keep its sandbox in the display's mount namespace (an AppArmor-confined bubblewrap)
        // still gets the bot's browser: headless, shown as pictures.
        options.displayFailed?.(error.reason);
        return await this.#open(request, platform, false);
      }
    } finally {
      release?.();
    }
  }

  async #open(request: OpenRequest, platform: NodeJS.Platform, onDisplay: boolean): Promise<OpenedBrowser> {
    const options = this.#options;
    const binary = await options.binary();
    const { dir, record, created } = ensureProfile(options.dataDir, request.key, { acceptLanguages: options.acceptLanguages?.() ?? "en-US,en" });
    const binaryVersion = versionOf(binary.identity.product);
    const refusal = downgradeRefusal(record, binaryVersion);
    if (refusal) throw new Error(refusal);
    if (staleSingletonLock(dir)) clearSingleton(dir);
    markCleanExit(dir);
    if (request.fresh) forgetOpenTabs(dir);
    const display = onDisplay ? (await options.display?.(request.key)) ?? null : null;
    const mode = display ? "window" : request.mode;
    const headless = mode === "headless";
    const locale = options.locale?.() ?? null;
    const egressPort = await options.egressPort(request.key);
    const screen = headless ? await options.screen() : null;
    const limit = screen ? pageLimit(screen, platform) : null;
    const viewport = fitPage(request.viewport, limit);
    const chrome: ChromeProcess = await (options.launch ?? launchChrome)({
      executablePath: binary.path,
      userDataDir: dir,
      mode,
      host: options.host,
      platform,
      userAgent: headless ? binary.identity.userAgent : null,
      screen,
      locale,
      egressPort,
      sandbox: options.sandbox ?? true,
      startUrl: request.fresh || created ? "about:blank" : null,
      viewport,
      timezone: options.timezone?.() ?? null,
      sandboxHelper: options.sandboxHelper ?? null,
      profileMarker: profileHash(workspaceId(options.dataDir), request.key),
      registry: options.registry ?? null,
      ...(options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
      ...(display ? { env: { ...process.env, ...display.env }, fillScreen: display.size, wrap: display.wrap } : {}),
    }).catch(async (error: unknown) => {
      if (!display) throw error;
      await display.release();
      throw new DisplayLaunchError(error);
    });
    const version = versionOf(chrome.version.product);
    try {
      recordOpenedBy(dir, version);
      const browserOptions: BrowserOptions = {
        identity: headless ? binary.identity : null,
        acceptLanguage: locale ? languageList(locale) : undefined,
        // A window on a private display is still one nobody sits at: file pickers and passkeys go to the panel.
        headless: headless || display !== null,
        downloadDir: request.downloadDir,
        platform,
        maxPages: 8,
        viewport: headless ? viewport : null,
        screen: screen ? { width: screen.width, height: screen.height } : null,
        handleAuth: true,
      };
      const browser = await CdpBrowser.connect(chrome.transport, browserOptions);
      if (created && platform === "win32") await takeFirstNavigation(browser).catch(() => undefined);
      return {
        browser,
        pageLimit: limit,
        pid: chrome.pid,
        version,
        exited: chrome.exited.then(() => display?.release()),
        async close() {
          await browser.close();
          await chrome.close(5_000);
          await display?.release();
        },
        display,
      };
    } catch (error) {
      await chrome.kill();
      await display?.release();
      throw error;
    }
  }
}

/** A page of our own, in a tab of its own, takes the cancel `openOwnPage` describes before a bot's first page can: none of
 * 60 fresh starts on GitHub's Windows runner cancelled the bot's first navigation after it. */
async function takeFirstNavigation(browser: CdpBrowser): Promise<void> {
  const first = browser.activePage;
  const page = await loopbackPage();
  try {
    const tab = await browser.newPage();
    const gone = new Promise<void>((resolve) => {
      const off = browser.onPageClosed((closed) => { if (closed === tab) { off(); resolve(); } });
    });
    try {
      await openOwnPage(tab, page.url, 15_000);
    } finally {
      await browser.closePage(tab);
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
  } finally {
    page.close();
    if (first && !first.closed) await browser.bringToFront(first);
  }
}

const CONNECTED_CAPS: BackendCaps = { persistentProfile: true, window: false, egressGate: false, identityOverride: false, ownsAllTabs: false, downloads: "none", uploads: "inject", botPasskeys: false };

/**
 * A browser OpenMausBot reaches over a DevTools WebSocket: the person's own Chrome (My Chrome), or a cloud browser the
 * person brings. Nothing is changed about it: no identity, no gate, no permissions, no downloads.
 */
export class ConnectedBackend implements Backend {
  readonly kind: "my-chrome" | "cdp-url";
  readonly caps = CONNECTED_CAPS;
  readonly #url: () => Promise<string>;
  readonly #connect: typeof webSocketTransport;

  constructor(kind: "my-chrome" | "cdp-url", url: () => Promise<string>, connect: typeof webSocketTransport = webSocketTransport) {
    this.kind = kind;
    this.#url = url;
    this.#connect = connect;
  }

  async open(request: OpenRequest): Promise<OpenedBrowser> {
    if (request.mode !== "headless") throw new Error("A connected browser already has its own windows.");
    const transport = await this.#connect(await this.#url());
    const browser = await CdpBrowser.connect(transport, { identity: null, headless: false, permissions: false, downloadDir: null, viewport: null, ownTabsOnly: true });
    const version = versionOf((await browser.version()).product);
    let closed!: () => void;
    const exited = new Promise<void>((resolve) => { closed = resolve; });
    browser.connection.onClose(() => closed());
    return {
      browser,
      pid: null,
      version,
      exited,
      async close() {
        browser.disconnect();
      },
    };
  }
}
