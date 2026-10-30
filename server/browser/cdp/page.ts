import * as actions from "./actions.ts";
import type { ActionContext, Target } from "./actions.ts";
import { sessionKindOf, type CdpSession, type Params } from "./connection.ts";
import { AuthChallenges, type AuthChallenge } from "./auth.ts";
import { Dialogs, type PendingDialog } from "./dialogs.ts";
import { DriverError, parseNetError } from "./errors.ts";
import { evaluate, valueInWorld, type EvaluateOptions } from "./evaluate.ts";
import { FileChoosers, setInputFiles } from "./files.ts";
import { FrameTree, type FrameTreeNode } from "./frames.ts";
import { PageHealth, type HealthReport } from "./health.ts";
import { Mouse, type Point } from "./input.ts";
import { Navigations } from "./navigations.ts";
import { Keyboard } from "./keyboard.ts";
import { RefTable, type RefCounter } from "./refs.ts";
import { captureScreenshot, type Screenshot, type ScreenshotOptions } from "./screencast.ts";
import { SecretGuard } from "./secrets.ts";
import { resolveElement } from "./selectors.ts";
import { takeSnapshot, visibleText, type Snapshot } from "./snapshot.ts";
import { releaseSession, setUpDocumentSession, setUpWorkerSession, type TargetSetup } from "./targets.ts";
import { Lifecycle, waitFor, type LoadState, type WaitConditions, type WaitContext } from "./wait.ts";

export const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
  openerId?: string;
}

/** What a page needs from the browser that owns it. */
export interface PageHost {
  readonly refCounter: RefCounter;
  readonly setup: TargetSetup;
  readonly mac: boolean;
  bringToFront(page: CdpPage): Promise<void>;
  closePage(page: CdpPage): Promise<void>;
}

export interface NavigateOptions {
  readiness?: LoadState | "none";
  timeoutMs?: number;
}

export interface NavigationResult {
  url: string;
  /** The main document's HTTP status, when one arrived. */
  status: number | null;
  /** The site asked for an HTTP sign-in, which now waits for an answer; the navigation goes on once it has one. */
  signInPrompt?: { origin: string; realm: string };
}

export interface PageSnapshot extends Snapshot {
  url: string;
  title: string;
  image?: Screenshot;
}

/** Agent navigation goes to web pages, blank pages and inline documents only. */
export function navigable(url: string): boolean {
  return /^https?:\/\//i.test(url) || url === "about:blank" || /^data:/i.test(url);
}

/** One tab, driven without the Runtime domain. */
export class CdpPage implements ActionContext, WaitContext {
  readonly targetId: string;
  readonly session: CdpSession;
  readonly openerId: string | null;
  readonly frames: FrameTree;
  readonly refs: RefTable;
  readonly keyboard: Keyboard;
  readonly mouse: Mouse;
  readonly dialogs = new Dialogs();
  readonly auth = new AuthChallenges();
  readonly fileChoosers = new FileChoosers();
  readonly health: PageHealth;
  readonly lifecycle: Lifecycle;
  readonly navigations: Navigations;
  readonly secrets = new SecretGuard();
  /** Resolves once the tab is configured and running. */
  readonly ready: Promise<void>;
  readonly #host: PageHost;
  #url: string;
  #title: string;
  #crashed = false;
  #devicePixelRatio: number | null = null;
  #documentStatus: { loaderId: string; status: number } | null = null;
  #emulated: { width: number; height: number; zoom: number } | null = null;

  constructor(host: PageHost, session: CdpSession, info: TargetInfo) {
    this.#host = host;
    this.session = session;
    this.targetId = info.targetId;
    this.openerId = info.openerId ?? null;
    this.#url = info.url;
    this.#title = info.title;
    this.frames = new FrameTree(session, info.targetId);
    this.refs = new RefTable(host.refCounter);
    this.keyboard = new Keyboard(session, { mac: host.mac });
    this.mouse = new Mouse(session, this.keyboard);
    this.health = new PageHealth(() => this.url());
    this.lifecycle = new Lifecycle(session, info.targetId);
    this.navigations = new Navigations(session, this.frames, this.lifecycle);
    this.dialogs.watch(session);
    if (host.setup.handleAuth) this.auth.watch(session);
    this.fileChoosers.watch(session);
    this.health.watch(session);
    this.frames.onChange((change) => {
      if (change.kind === "navigated" && change.frameId === this.frames.mainFrameId) {
        this.refs.invalidateAll();
        this.fileChoosers.forget();
      } else {
        this.refs.invalidateFrames(change.affected);
      }
    });
    this.dialogs.onClose(() => this.refs.invalidateAll());
    session.on("Target.attachedToTarget", (params) => this.#child(params));
    session.on("Network.responseReceived", (params) => {
      const response = params.response as { status?: number } | undefined;
      if (params.type === "Document" && params.frameId === this.targetId && typeof params.loaderId === "string" && typeof response?.status === "number") {
        this.#documentStatus = { loaderId: params.loaderId, status: response.status };
      }
    });
    this.ready = setUpDocumentSession(session, host.setup, { isPage: true }).then(() => this.#adoptDocument());
  }

  async #adoptDocument(): Promise<void> {
    if (this.frames.main?.loaderId !== null) return;
    try {
      const { frameTree } = await this.session.send<{ frameTree: FrameTreeNode }>("Page.getFrameTree");
      if (this.frames.main?.loaderId !== null) return;
      this.frames.adopt(frameTree);
      const loaderId = frameTree.frame.loaderId;
      if (!loaderId || this.lifecycle.loaderId !== null) return;
      const state = await valueInWorld<string>(this.frames, this.frames.mainFrameId, "document.readyState").catch(() => "loading");
      this.lifecycle.adopt(loaderId, state === "complete");
    } catch {}
  }

  get closed(): boolean {
    return this.session.detached;
  }

  get crashed(): boolean {
    return this.#crashed;
  }

  url(): string {
    return this.frames.main?.url || this.#url;
  }

  title(): string {
    return this.#title;
  }

  updateInfo(info: Pick<TargetInfo, "url" | "title">): void {
    this.#url = info.url;
    this.#title = info.title;
  }

  markCrashed(): void {
    this.#crashed = true;
  }

  #child(params: Params): void {
    const info = params.targetInfo as TargetInfo | undefined;
    const child = typeof params.sessionId === "string" ? this.session.connection.session(params.sessionId) : undefined;
    if (!info || !child) return;
    if (info.type === "iframe") {
      this.frames.watch(child, info.targetId);
      this.health.watch(child);
      this.fileChoosers.watch(child);
      this.dialogs.watch(child);
      child.on("Target.attachedToTarget", (nested) => this.#child(nested));
      child.onDetach(() => {
        this.refs.invalidateSession(child);
        this.fileChoosers.forget(child);
      });
      void setUpDocumentSession(child, this.#host.setup, { isPage: false }).catch(() => {});
    } else if (sessionKindOf(info.type) === "worker") {
      setUpWorkerSession(child, this.#host.setup.identity);
    } else {
      releaseSession(child);
    }
  }

  #usable(): void {
    if (this.closed) throw new DriverError("closed", "This tab is closed.");
    if (this.#crashed) throw new DriverError("closed", "This tab's page crashed. Reload it or open it again.");
  }

  #noDialog(): void {
    const dialog = this.dialogs.pending;
    if (dialog) {
      throw new DriverError("dialog-pending", `A ${dialog.type} dialog is open on this tab: "${dialog.message.slice(0, 200)}". Answer it first.`, { dialog });
    }
  }

  #ready(): void {
    this.#usable();
    this.#noDialog();
  }

  bringToFront(): Promise<void> {
    return this.#host.bringToFront(this);
  }

  async navigate(url: string, { readiness = "load", timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS }: NavigateOptions = {}): Promise<NavigationResult> {
    if (!navigable(url)) throw new DriverError("refused", `Only http(s), about:blank and data: addresses open here, not ${url.slice(0, 80)}.`);
    this.#usable();
    await this.bringToFront();
    return this.dialogs.acceptingBeforeUnload(async () => {
      const sameDocument = this.session.waitFor("Page.navigatedWithinDocument", { match: (params) => params.frameId === this.targetId, timeoutMs });
      sameDocument.catch(() => {});
      const navigating = this.session.send<{ loaderId?: string; errorText?: string; isDownload?: boolean }>("Page.navigate", { url }, { timeoutMs });
      navigating.catch(() => {});
      let stopAsking = () => {};
      const asked = new Promise<AuthChallenge>((resolve) => {
        stopAsking = this.auth.onChange((challenge) => { if (challenge) resolve(challenge); });
      });
      const first = await Promise.race([navigating, asked]).finally(() => stopAsking());
      if ("origin" in first) return { url, status: 401, signInPrompt: { origin: first.origin, realm: first.realm } };
      const result = first;
      if (result.isDownload) {
        throw new DriverError("navigation", `${url} is a file this browser cannot show, so it was downloaded instead. The tab's downloads list it.`, { download: true });
      }
      if (result.errorText) {
        const { description } = parseNetError(result.errorText);
        throw new DriverError("navigation", `Navigation to ${url} failed: ${description}`, { netError: description });
      }
      if (!result.loaderId) await sameDocument;
      else if (readiness !== "none") await this.lifecycle.waitFor(readiness, { loaderId: result.loaderId, timeoutMs });
      const status = result.loaderId && this.#documentStatus?.loaderId === result.loaderId ? this.#documentStatus.status : null;
      return { url: this.url(), status };
    });
  }

  /** Runs `start` and waits for the main frame to commit a new document (and reach `readiness`) or move within this one. */
  async #settle(start: () => Promise<unknown>, readiness: LoadState | "none", timeoutMs: number): Promise<NavigationResult> {
    const deadline = Date.now() + timeoutMs;
    const nextDocument = this.lifecycle.nextDocument(timeoutMs);
    const sameDocument = this.session.waitFor("Page.navigatedWithinDocument", { match: (params) => params.frameId === this.targetId, timeoutMs });
    nextDocument.catch(() => {});
    sameDocument.catch(() => {});
    await this.dialogs.acceptingBeforeUnload(async () => {
      await start();
      const loaderId = await Promise.race([nextDocument, sameDocument.then(() => null)]);
      if (loaderId && readiness !== "none") await this.lifecycle.waitFor(readiness, { loaderId, timeoutMs: Math.max(1, deadline - Date.now()) });
    });
    return { url: this.url(), status: null };
  }

  async #history(delta: -1 | 1, { readiness = "load", timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS }: NavigateOptions): Promise<NavigationResult> {
    this.#ready();
    await this.bringToFront();
    const { currentIndex, entries } = await this.session.send<{ currentIndex: number; entries: Array<{ id: number }> }>("Page.getNavigationHistory");
    const entry = entries[currentIndex + delta];
    if (!entry) throw new DriverError("refused", delta < 0 ? "There is no earlier page in this tab's history." : "There is no later page in this tab's history.");
    return this.#settle(() => this.session.send("Page.navigateToHistoryEntry", { entryId: entry.id }), readiness, timeoutMs);
  }

  back(options: NavigateOptions = {}): Promise<NavigationResult> {
    return this.#history(-1, options);
  }

  forward(options: NavigateOptions = {}): Promise<NavigationResult> {
    return this.#history(1, options);
  }

  async reload({ readiness = "load", timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS }: NavigateOptions = {}): Promise<NavigationResult> {
    if (this.closed) throw new DriverError("closed", "This tab is closed.");
    this.#noDialog();
    await this.bringToFront();
    const result = await this.#settle(() => this.session.send("Page.reload", {}), readiness, timeoutMs);
    this.#crashed = false;
    return result;
  }

  /** The size the page is laid out at apart from its window's, and how many times larger it is drawn; null when it fills its window. */
  get emulated(): { width: number; height: number; zoom: number } | null {
    return this.#emulated;
  }

  /** Lays the page out at `size` whatever its window's size, drawn `zoom` times larger, as DevTools' device mode does; null ends that. */
  async emulateSize(size: { width: number; height: number } | null, zoom = 1): Promise<void> {
    if (!size) {
      this.#emulated = null;
      await this.session.send("Emulation.clearDeviceMetricsOverride");
      return;
    }
    const ratio = await this.devicePixelRatio().catch(() => 1);
    await this.session.send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: ratio * zoom, mobile: false });
    this.#emulated = { width: size.width, height: size.height, zoom };
  }

  async devicePixelRatio(): Promise<number> {
    if (this.#devicePixelRatio === null) {
      const ratio = await valueInWorld<number>(this.frames, this.frames.mainFrameId, "devicePixelRatio");
      this.#devicePixelRatio = typeof ratio === "number" && ratio > 0 ? ratio : 1;
    }
    return this.#devicePixelRatio;
  }

  async snapshot({ includeImage = false, maskValue }: { includeImage?: boolean; maskValue?: (value: string) => boolean } = {}): Promise<PageSnapshot> {
    this.#ready();
    if (includeImage) await this.secrets.refuseWhilePresent(this.frames);
    const mask = (value: string) => this.secrets.holds(value) || maskValue?.(value) === true;
    const snapshot = await takeSnapshot(this.frames, this.refs, { maskValue: mask });
    const image = includeImage ? await this.screenshot() : undefined;
    return { url: this.url(), title: this.#title, ...snapshot, ...(image ? { image } : {}) };
  }

  async visibleText(maxChars?: number): Promise<string> {
    this.#ready();
    return visibleText(this.frames, maxChars);
  }

  async screenshot(options: ScreenshotOptions & { target?: Exclude<Target, Point> } = {}): Promise<Screenshot> {
    this.#ready();
    await this.secrets.refuseWhilePresent(this.frames);
    let clip = options.clip;
    if (options.target) {
      const handle = await resolveElement(this.frames, this.refs, options.target);
      await handle.session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: handle.backendNodeId }).catch(() => {});
      const { model } = await handle.session.send<{ model: { border: number[] } }>("DOM.getBoxModel", { backendNodeId: handle.backendNodeId });
      const offset = await this.frames.localRootOffset(handle.session);
      const xs = [model.border[0]!, model.border[2]!, model.border[4]!, model.border[6]!];
      const ys = [model.border[1]!, model.border[3]!, model.border[5]!, model.border[7]!];
      const metrics = await this.session.send<{ cssVisualViewport: { pageX: number; pageY: number } }>("Page.getLayoutMetrics");
      clip = {
        x: Math.min(...xs) + offset.x + metrics.cssVisualViewport.pageX,
        y: Math.min(...ys) + offset.y + metrics.cssVisualViewport.pageY,
        width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
        height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
      };
    }
    return captureScreenshot(this.session, (await this.devicePixelRatio()) * (this.#emulated?.zoom ?? 1), { ...options, ...(clip ? { clip } : {}) });
  }

  async evaluate(expression: string, options: EvaluateOptions = {}): Promise<unknown> {
    this.#ready();
    await this.secrets.refuseWhilePresent(this.frames);
    return evaluate(this.frames, expression, options);
  }

  async waitFor(conditions: WaitConditions): Promise<void> {
    this.#usable();
    return waitFor(this, conditions);
  }

  async click(target: Target, options: actions.ClickOptions = {}): Promise<actions.PointerResult> {
    this.#ready();
    return actions.click(this, target, options);
  }

  async hover(target: Target, options: { timeoutMs?: number; pointer?: actions.PointerReporter } = {}): Promise<Point> {
    this.#ready();
    return actions.hover(this, target, options);
  }

  async fill(target: Exclude<Target, Point>, text: string): Promise<void> {
    this.#ready();
    return actions.fill(this, target, text);
  }

  /** A saved secret: typed with Input.insertText only, and screenshots and evaluation stay refused while it is on the page. */
  async fillSecret(target: Exclude<Target, Point>, secret: string): Promise<void> {
    this.#ready();
    this.secrets.arm(this.frames, [secret]);
    await actions.fill(this, target, secret);
  }

  async type(target: Exclude<Target, Point> | null, text: string): Promise<void> {
    this.#ready();
    return actions.type(this, target, text);
  }

  async press(chord: string): Promise<{ dialog: boolean }> {
    this.#ready();
    return actions.press(this, chord);
  }

  async select(target: Exclude<Target, Point>, values: readonly string[]): Promise<{ selected: string[] }> {
    this.#ready();
    return actions.select(this, target, values);
  }

  async check(target: Exclude<Target, Point>, checked = true, options: { timeoutMs?: number } = {}): Promise<{ checked: boolean; changed: boolean }> {
    this.#ready();
    return actions.check(this, target, checked, options);
  }

  async drag(from: Target, to: Target, options: { timeoutMs?: number; pointer?: actions.PointerReporter } = {}): Promise<{ from: Point; to: Point; dropped: "html5" | "mouse" }> {
    this.#ready();
    return actions.drag(this, from, to, options);
  }

  async scroll(target: Target | null, deltaX: number, deltaY: number, options: { timeoutMs?: number } = {}): Promise<Point> {
    this.#ready();
    return actions.scroll(this, target, deltaX, deltaY, options);
  }

  /** Files for a named file input, or else for the picker the page opened. */
  async upload(paths: readonly string[], target?: Exclude<Target, Point>): Promise<void> {
    this.#ready();
    if (target) await setInputFiles(this.frames, await resolveElement(this.frames, this.refs, target), paths);
    else await this.fileChoosers.answer(paths);
  }

  async answerDialog(answer: { accept: boolean; promptText?: string }): Promise<PendingDialog> {
    this.#usable();
    return this.dialogs.answer(answer);
  }

  takeHealth(): HealthReport {
    return this.health.take(this.frames.all());
  }

  /** What a copy or cut key press just put on the page's clipboard, from any frame. */
  async takeCopiedText(): Promise<string> {
    const copies = await Promise.all(this.frames.all().map((frame) =>
      valueInWorld<string>(this.frames, frame.id, "typeof __ombTakeCopy === 'function' ? __ombTakeCopy() : ''").catch(() => "")));
    return copies.find((text) => typeof text === "string" && text.length > 0) ?? "";
  }

  /** A takeover revokes every ref, even when the document stays the same. */
  invalidateRefs(): void {
    this.refs.invalidateAll();
  }

  /** Lets go of every key and button, so whoever acts next starts clean. */
  async releaseInput(): Promise<void> {
    await this.keyboard.releaseAll();
    await this.mouse.releaseAll();
  }

  close(): Promise<void> {
    return this.#host.closePage(this);
  }
}
