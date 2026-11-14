import { CdpConnection, sessionKindOf, type CdpSession, type Params } from "./connection.ts";
import { Downloads, type DownloadLimits } from "./downloads.ts";
import { DriverError, isGone } from "./errors.ts";
import { valueInWorld } from "./evaluate.ts";
import { identityOverride, type Identity } from "./identity.ts";
import { CdpPage, type PageHost, type TargetInfo } from "./page.ts";
import { RefCounter } from "./refs.ts";
import { applyPermissions, releaseSession, setUpWorkerSession, type TargetSetup } from "./targets.ts";
import type { CdpTransport } from "./transport.ts";

/** The page size a headless browser connected without one is fitted to; setViewport changes it. */
export const VIEWPORT = { width: 1280, height: 720 } as const;
const FIT_ROUNDS = 3;

export interface BrowserOptions {
  /** The binary's calibrated headed identity, applied to every page, frame and worker. Null in a window, which is natively that identity. */
  identity?: Identity | null;
  acceptLanguage?: string;
  /** Headless: focus emulation and intercepted file pickers. */
  headless?: boolean;
  downloadDir?: string | null;
  downloadLimits?: DownloadLimits;
  /** Applies the default permission grants and denials. */
  permissions?: boolean;
  /** The platform the browser runs on decides ControlOrMeta and the macOS editing commands. */
  platform?: NodeJS.Platform;
  /** Popups past this many tabs are closed. */
  maxPages?: number;
  /** The page size every headless window is fitted to; null leaves the window as Chrome made it. */
  viewport?: { width: number; height: number } | null;
  /** The screen pages are told about, in CSS pixels: a window never grows past it, as no real window can. */
  screen?: { width: number; height: number } | null;
  /** Tabs hold HTTP authentication challenges for an answer instead of failing them. */
  handleAuth?: boolean;
  /** The person's own browser: only tabs this driver opens are attached to; theirs are left alone. */
  ownTabsOnly?: boolean;
  timeoutMs?: number;
}

type PageListener = (page: CdpPage) => void;

/** One Chrome over one CDP connection: its tabs, downloads and permissions. */
export class CdpBrowser implements PageHost {
  readonly connection: CdpConnection;
  readonly refCounter = new RefCounter();
  readonly setup: TargetSetup;
  readonly mac: boolean;
  readonly downloads: Downloads | null;
  /** Permission names this Chrome did not accept. */
  unsupportedPermissions: string[] = [];
  readonly #options: BrowserOptions;
  readonly #pages = new Map<string, CdpPage>();
  readonly #pageListeners = new Set<PageListener>();
  readonly #closeListeners = new Set<PageListener>();
  readonly #failureListeners = new Set<(page: CdpPage, error: unknown) => void>();
  readonly #failures: Array<{ page: CdpPage; error: unknown }> = [];
  readonly #running = new WeakMap<CdpPage, Promise<void>>();
  readonly #ready = new WeakSet<CdpPage>();
  /** Targets a viewer is attaching its own session to: that session is not a new tab. */
  readonly #viewerAttaches = new Map<string, number>();
  #active: CdpPage | null = null;
  #viewport: { width: number; height: number } | null;

  private constructor(connection: CdpConnection, options: BrowserOptions) {
    this.connection = connection;
    this.#options = options;
    this.mac = (options.platform ?? process.platform) === "darwin";
    const identity = options.identity ? identityOverride(options.identity, options.acceptLanguage) : null;
    const headless = options.headless ?? true;
    this.setup = { identity, focusEmulation: headless, interceptFileChooser: headless, handleAuth: options.handleAuth === true, noPasskeys: headless };
    this.#viewport = options.viewport === undefined ? (headless ? VIEWPORT : null) : options.viewport;
    this.downloads = options.downloadDir
      ? new Downloads(connection.root, options.downloadDir, { ownerOf: (frameId) => this.#ownerOf(frameId), ...(options.downloadLimits ? { limits: options.downloadLimits } : {}) })
      : null;
  }

  /** Takes over a fresh connection. The handshake id 0 belongs to the launcher. */
  static async connect(transport: CdpTransport, options: BrowserOptions = {}): Promise<CdpBrowser> {
    const connection = new CdpConnection(transport, { defaultTimeoutMs: options.timeoutMs ?? 30_000, firstId: 1 });
    const browser = new CdpBrowser(connection, options);
    await browser.#start();
    return browser;
  }

  get connected(): boolean {
    return !this.connection.closed;
  }

  async #start(): Promise<void> {
    const root = this.connection.root;
    root.on("Target.attachedToTarget", (params) => this.#attached(params));
    root.on("Target.targetInfoChanged", (params) => {
      const info = params.targetInfo as TargetInfo;
      this.#pages.get(info.targetId)?.updateInfo(info);
    });
    root.on("Target.targetCrashed", (params) => this.#pages.get(String(params.targetId))?.markCrashed());
    root.on("Target.detachedFromTarget", (params) => {
      for (const page of this.#pages.values()) if (page.session.id === params.sessionId) this.#gone(page.targetId);
    });
    root.on("Target.targetDestroyed", (params) => this.#gone(String(params.targetId ?? "")));
    await root.send("Target.setDiscoverTargets", { discover: true, filter: [{ type: "page" }, { exclude: true }] });
    if (!this.#options.ownTabsOnly) await root.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: "page" }, { type: "service_worker" }, { type: "shared_worker" }, { exclude: true }],
    });
    const pending: Array<Promise<unknown>> = [];
    if (this.downloads) pending.push(this.downloads.enable());
    if (this.#options.permissions ?? true) pending.push(applyPermissions(root).then((unknown) => { this.unsupportedPermissions = unknown; }));
    await Promise.all(pending);
  }

  #attached(params: Params): void {
    const info = params.targetInfo as TargetInfo;
    const session = typeof params.sessionId === "string" ? this.connection.session(params.sessionId) : undefined;
    if (!session) return;
    const viewerAttaches = this.#viewerAttaches.get(info.targetId) ?? 0;
    if (info.type === "page" && viewerAttaches > 0) {
      this.#viewerAttaches.set(info.targetId, viewerAttaches - 1);
      return;
    }
    if (info.type !== "page") {
      if (sessionKindOf(info.type) === "worker") setUpWorkerSession(session, this.setup.identity);
      else releaseSession(session);
      return;
    }
    const page = new CdpPage(this, session, info);
    this.#pages.set(info.targetId, page);
    this.#active = page;
    const running = page.ready.then(async () => { await this.#fitWindow(page); });
    this.#running.set(page, running);
    void running.then(
      () => {
        this.#ready.add(page);
        if (page.closed) return;
        if (page.openerId && this.#options.maxPages !== undefined && this.#pages.size > this.#options.maxPages) {
          void this.closePage(page).catch(() => {});
          return;
        }
        for (const listener of this.#pageListeners) {
          try { listener(page); } catch {}
        }
      },
      (error: unknown) => {
        if (!isGone(error)) {
          this.#failures.push({ page, error });
          if (this.#failures.length > 8) this.#failures.shift();
          for (const listener of this.#failureListeners) {
            try { listener(page, error); } catch {}
          }
        }
        this.#gone(info.targetId);
      },
    );
  }

  /**
   * The page a headless window shows differs by platform (--window-size=1280,863
   * gives 1280x720 on macOS and Linux, 1264x712 on Windows) and by tab: Google
   * Chrome's startup tab carries a 56 px bar the others lack (measured on the
   * Linux and Windows runners). So the tab in front is measured, when it opens
   * and whenever it comes to the front, and its window resized until the page
   * is the viewport, a few rounds at most. Answers the page's size as it ends
   * up, which a window held to its screen can leave smaller.
   */
  async #fitWindow(page: CdpPage): Promise<{ width: number; height: number } | null> {
    const viewport = this.#viewport;
    if (!viewport || page.closed || page.emulated) return null;
    const root = this.connection.root;
    const measure = () => valueInWorld<[number, number]>(page.frames, page.frames.mainFrameId, "[innerWidth, innerHeight]");
    try {
      const { windowId } = await root.send<{ windowId: number }>("Browser.getWindowForTarget", { targetId: page.targetId });
      let size = await measure();
      const screen = this.#options.screen;
      for (let round = 0; round < FIT_ROUNDS && (size[0] !== viewport.width || size[1] !== viewport.height); round++) {
        const { bounds } = await root.send<{ bounds: { width?: number; height?: number } }>("Browser.getWindowBounds", { windowId });
        if (!bounds.width || !bounds.height) break;
        const width = Math.min(bounds.width + viewport.width - size[0], screen?.width ?? Infinity);
        const height = Math.min(bounds.height + viewport.height - size[1], screen?.height ?? Infinity);
        if (width === bounds.width && height === bounds.height) break;
        await root.send("Browser.setWindowBounds", { windowId, bounds: { width, height } });
        const before = size;
        for (let poll = 0; poll < 20 && size[0] === before[0] && size[1] === before[1]; poll++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          size = await measure();
        }
        if (size[0] === before[0] && size[1] === before[1]) break;
      }
      return { width: size[0], height: size[1] };
    } catch (error) {
      if (!isGone(error)) throw error;
      return null;
    }
  }

  /** The page size headless windows are fitted to, or null when Chrome sizes them. */
  get viewport(): { width: number; height: number } | null {
    return this.#viewport;
  }

  /**
   * Resizes the window the tab in front sits in, so its page is `size` and the
   * outer and inner sizes stay what a real window of that size reports. Chrome
   * keeps a window at least 500 CSS pixels wide (measured on 153). Answers the
   * size that page got, or null when no page was fitted.
   */
  async setViewport(size: { width: number; height: number } | null): Promise<{ width: number; height: number } | null> {
    this.#viewport = size ? { width: Math.round(size.width), height: Math.round(size.height) } : null;
    const page = this.#active;
    return page && !page.closed ? this.#fitWindow(page) : null;
  }

  /**
   * A second session on a tab, for a viewer's own screencast and input: it
   * gets no setup and never becomes a tab. Detach it with detachSession.
   */
  async attachSession(page: CdpPage): Promise<CdpSession> {
    this.#viewerAttaches.set(page.targetId, (this.#viewerAttaches.get(page.targetId) ?? 0) + 1);
    try {
      const { sessionId } = await this.connection.root.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      const session = this.connection.session(sessionId);
      if (!session) throw new DriverError("closed", "The tab closed before its viewer could attach.");
      return session;
    } catch (error) {
      const left = (this.#viewerAttaches.get(page.targetId) ?? 1) - 1;
      if (left > 0) this.#viewerAttaches.set(page.targetId, left);
      else this.#viewerAttaches.delete(page.targetId);
      throw error;
    }
  }

  async detachSession(session: CdpSession): Promise<void> {
    if (session.detached || session.id === null) return;
    await this.connection.root.send("Target.detachFromTarget", { sessionId: session.id }).catch(() => {});
  }

  #gone(targetId: string): void {
    const page = this.#pages.get(targetId);
    if (!page) return;
    this.#pages.delete(targetId);
    if (this.#active === page) this.#active = null;
    for (const listener of this.#closeListeners) {
      try { listener(page); } catch {}
    }
  }

  #ownerOf(frameId: string): string | null {
    for (const page of this.#pages.values()) if (page.frames.get(frameId)) return page.targetId;
    return null;
  }

  pages(): CdpPage[] {
    return [...this.#pages.values()].filter((page) => !page.closed);
  }

  page(targetId: string): CdpPage | undefined {
    return this.#pages.get(targetId);
  }

  get activePage(): CdpPage | null {
    return this.#active;
  }

  /** Called with every new tab once it runs, popups included. */
  onPage(listener: PageListener): () => void {
    this.#pageListeners.add(listener);
    return () => this.#pageListeners.delete(listener);
  }

  onPageClosed(listener: PageListener): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  /** The first running tab `match` accepts, now or when it opens; rejects if that tab cannot be set up. */
  waitForPage(match: (page: CdpPage) => boolean = () => true, timeoutMs = 15_000): Promise<CdpPage> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (page: CdpPage | null, error?: unknown) => {
        if (settled) return;
        settled = true;
        off();
        offFailure();
        clearTimeout(timer);
        if (page) resolve(page);
        else reject(error);
      };
      const off = this.onPage((page) => {
        if (match(page)) finish(page);
      });
      const failed = (page: CdpPage, error: unknown) => {
        if (match(page)) finish(null, error);
      };
      this.#failureListeners.add(failed);
      const offFailure = () => this.#failureListeners.delete(failed);
      const timer = setTimeout(() => finish(null, new DriverError("timeout", `No matching tab opened within ${timeoutMs} ms.`)), timeoutMs);
      for (const page of this.#pages.values()) {
        void (this.#running.get(page) ?? page.ready).then(() => {
          if (!page.closed && match(page)) finish(page);
        }, () => {});
      }
      const earlier = this.#failures.find(({ page }) => match(page));
      if (earlier) finish(null, earlier.error);
    });
  }

  async newPage(url = "about:blank", { timeoutMs = 15_000 }: { timeoutMs?: number } = {}): Promise<CdpPage> {
    const { targetId } = await this.connection.root.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    if (this.#options.ownTabsOnly) await this.connection.root.send("Target.attachToTarget", { targetId, flatten: true });
    const page = await this.waitForPage((candidate) => candidate.targetId === targetId, timeoutMs);
    this.#active = page;
    if (url !== "about:blank") await page.navigate(url, { timeoutMs });
    return page;
  }

  /** Input reaches only the tab in front: a person switching tabs does the same. */
  async bringToFront(page: CdpPage): Promise<void> {
    if (this.#active === page) return;
    await page.session.send("Page.bringToFront");
    this.#active = page;
    await this.#fitWindow(page);
  }

  async closePage(page: CdpPage): Promise<void> {
    if (page.closed) return;
    await this.connection.root.send("Target.closeTarget", { targetId: page.targetId });
  }

  /** Titles a page sets after it loads reach no event (measured on 153); Target.getTargets has them. */
  async refreshTargets(): Promise<void> {
    const { targetInfos } = await this.connection.root.send<{ targetInfos: TargetInfo[] }>("Target.getTargets", {});
    for (const info of targetInfos) this.#pages.get(info.targetId)?.updateInfo(info);
  }

  /** Pages Chrome has attached that are still being set up, such as a popup a click just opened. */
  settingUp(): CdpPage[] {
    return [...this.#pages.values()].filter((page) => !page.closed && !this.#ready.has(page));
  }

  async version(): Promise<{ product: string; userAgent: string; protocolVersion: string; revision: string }> {
    return this.connection.root.send("Browser.getVersion");
  }

  /** Closes Chrome the way its own quit does, so session restore keeps tabs and session cookies. */
  async close(): Promise<void> {
    if (this.connection.closed) return;
    await this.connection.root.send("Browser.close", {}, { timeoutMs: 5_000 }).catch(() => {});
    this.connection.close();
  }

  disconnect(): void {
    this.connection.close();
  }
}
