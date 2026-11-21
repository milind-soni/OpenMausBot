// One profile's desktop panes as one browser-level CDP connection. Each pane is an Electron webContents whose debugger
// speaks page-level CDP only (no Browser domain, no Target.createTarget): this endpoint answers the browser-level
// commands itself and asks the main process for tabs, so the CDP driver runs on it unchanged.
import type { Params } from "../cdp/connection.ts";
import type { CdpTransport, SendMeta } from "../cdp/transport.ts";

export interface PaneTab {
  tab: string;
  /** The page's main frame id: the driver takes it as the target id and the main frame's id. */
  target: string;
  url: string;
  title: string;
  opener?: string;
}

/** What the main process does for one profile's panes. */
export interface PaneChannel {
  readonly version: string;
  readonly userAgent: string;
  create(url: string, background: boolean): Promise<PaneTab>;
  command(tab: string, method: string, params: Params, session?: string): Promise<Params>;
  front(tab: string): void;
  closeTab(tab: string): void;
  cancelDownload(guid: string): void;
  close(): void;
}

/** A download in a pane, as the main process saved it (never through a Save dialog). */
export interface PaneDownload {
  tab: string;
  guid: string;
  state: "begin" | "inProgress" | "completed" | "canceled";
  url?: string;
  name?: string;
  received?: number;
  total?: number;
  path?: string;
}

export interface PaneEndpointOptions {
  /** The bot's own input waits until the person has been still this long. */
  quietMs?: number;
  /** and never longer than this. */
  maxHoldMs?: number;
  /** How long the event re-enabling before a navigation may take. */
  primeMs?: number;
}

interface Command {
  id: number;
  method: string;
  params: Params;
  sessionId?: string;
  readOnly?: boolean;
}

interface TabState extends PaneTab {
  announced: boolean;
  viewers: Set<string>;
  casting: Set<string>;
  /** Commands of the tab's own session go out in order behind a held input. */
  gate: Promise<void>;
  /** The person holds the tab: the bot's input is refused until they let go. */
  held: boolean;
  lastPerson: number;
  lastBot: number;
}

/** Who acted last in a tab, the person holding it counting as the person. */
export type PaneOwner = "person" | "bot" | null;

export const PERSON_HOLDS_TAB = "The person is using this tab. Wait until they hand it back, then take a fresh snapshot before acting.";

class Refusal extends Error {}

const PAGE_PREFIX = "pane-";
/** All a held tab lets the bot send, on its page and on its frames: reads, and the setup each new frame needs. */
const HELD_READS = new Set([
  "Page.getFrameTree", "Page.getLayoutMetrics", "Page.captureScreenshot", "Page.getNavigationHistory",
  "DOM.getDocument", "DOM.describeNode", "DOM.resolveNode", "DOM.querySelector", "DOM.getContentQuads", "DOM.getBoxModel",
  "DOM.getNodeForLocation", "DOM.getFrameOwner", "Accessibility.getFullAXTree", "Accessibility.queryAXTree", "Network.getCookies",
  "Target.detachFromTarget",
  // Fronting the held tab itself shows the person the page they hold.
  "Page.bringToFront",
]);
const HELD_SETUP = /^(?:[A-Za-z]+\.(?:enable|disable)$|Page\.(?:setLifecycleEventsEnabled|setInterceptFileChooserDialog|addScriptToEvaluateOnNewDocument|removeScriptToEvaluateOnNewDocument|createIsolatedWorld)$|Emulation\.(?:setFocusEmulationEnabled|setUserAgentOverride)$|Network\.setUserAgentOverride$|Target\.setAutoAttach$|Fetch\.|WebAuthn\.|Runtime\.(?:runIfWaitingForDebugger|releaseObject|releaseObjectGroup)$)/;
/** Runtime calls change whatever their script changes: only those the driver marked read-only pass a hold. */
const RUNTIME_CALLS = new Set(["Runtime.evaluate", "Runtime.callFunctionOn"]);

function heldAllows(method: string, readOnly: boolean): boolean {
  return HELD_READS.has(method) || HELD_SETUP.test(method) || (readOnly && RUNTIME_CALLS.has(method));
}
const PRIMED = ["Network.enable", "Page.enable", "Page.setLifecycleEventsEnabled"] as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class PaneEndpoint implements CdpTransport {
  readonly #channel: PaneChannel;
  readonly #tabs = new Map<string, TabState>();
  readonly #messages = new Set<(message: string) => void>();
  readonly #closes = new Set<(reason: string) => void>();
  readonly #quietMs: number;
  readonly #maxHoldMs: number;
  readonly #primeMs: number;
  #autoAttach = false;
  #viewerCount = 0;
  #lastInput = 0;
  #closed: string | null = null;

  constructor(channel: PaneChannel, tabs: readonly PaneTab[] = [], options: PaneEndpointOptions = {}) {
    this.#channel = channel;
    this.#quietMs = options.quietMs ?? 1_000;
    this.#maxHoldMs = options.maxHoldMs ?? 10_000;
    this.#primeMs = options.primeMs ?? 1_000;
    for (const tab of tabs) this.tabOpened(tab);
  }

  // CdpTransport.
  send(message: string, meta?: SendMeta): void {
    if (this.#closed !== null) return;
    let command: Command;
    try {
      command = { ...(JSON.parse(message) as Command), readOnly: meta?.readOnly === true };
    } catch {
      return;
    }
    void this.#run(command).then(
      (result) => this.#emit({ id: command.id, result, ...(command.sessionId ? { sessionId: command.sessionId } : {}) }),
      (error: unknown) => this.#emit({ id: command.id, error: errorOf(error), ...(command.sessionId ? { sessionId: command.sessionId } : {}) }),
    );
  }

  onMessage(listener: (message: string) => void): void {
    this.#messages.add(listener);
  }

  onClose(listener: (reason: string) => void): void {
    if (this.#closed !== null) listener(this.#closed);
    else this.#closes.add(listener);
  }

  close(): void {
    this.closed("closed by the driver");
  }

  // From the main process.

  tabOpened(tab: PaneTab): void {
    const known = this.#tabs.get(tab.tab);
    if (known) {
      known.target = tab.target;
      known.url = tab.url;
      known.title = tab.title;
      this.#event("Target.targetInfoChanged", { targetInfo: this.#info(known) });
      return;
    }
    const state: TabState = { ...tab, announced: false, viewers: new Set(), casting: new Set(), gate: Promise.resolve(), held: false, lastPerson: 0, lastBot: 0 };
    this.#tabs.set(tab.tab, state);
    if (this.#autoAttach) this.#announce(state);
  }

  tabGone(tab: string, crashed = false): void {
    const state = this.#tabs.get(tab);
    if (!state) return;
    this.#tabs.delete(tab);
    if (crashed) this.#event("Target.targetCrashed", { targetId: state.target, status: "crashed", errorCode: 0 });
    for (const sessionId of [...state.viewers, ...(state.announced ? [pageSession(tab)] : [])]) {
      this.#event("Target.detachedFromTarget", { sessionId, targetId: state.target });
    }
    this.#event("Target.targetDestroyed", { targetId: state.target });
  }

  /** A page-level event of one pane's debugger; `session` names a child (an iframe or worker) of that page. */
  pageEvent(tab: string, method: string, params: Params, session?: string): void {
    const state = this.#tabs.get(tab);
    if (!state) return;
    const page = pageSession(tab);
    if (session) {
      this.#event(method, renamed(method, params, page), `${page}:${session}`);
      return;
    }
    if (method === "Target.attachedToTarget" || method === "Target.detachedFromTarget") {
      if (state.announced) this.#event(method, renamed(method, params, page), page);
      return;
    }
    if (method === "Page.screencastFrame") {
      for (const viewer of state.casting) this.#event(method, params, viewer);
      return;
    }
    if (state.announced) this.#event(method, params, page);
    for (const viewer of state.viewers) this.#event(method, params, viewer);
  }

  /** The person pressed, typed or scrolled in one of these panes (`tab` when the app knows which). */
  personInput(tab?: string): void {
    this.#lastInput = Date.now();
    const state = tab ? this.#tabs.get(tab) : undefined;
    if (state) state.lastPerson = this.#lastInput;
  }

  /** A pane's download, as the driver's download tracking hears of one. */
  download(event: PaneDownload): void {
    const tab = this.#tabs.get(event.tab);
    if (event.state === "begin") {
      this.#event("Browser.downloadWillBegin", { frameId: tab?.target ?? "", guid: event.guid, url: event.url ?? "", suggestedFilename: event.name ?? "" });
      return;
    }
    this.#event("Browser.downloadProgress", {
      guid: event.guid, receivedBytes: event.received ?? 0, totalBytes: event.total ?? 0, state: event.state, ...(event.path ? { filePath: event.path } : {}),
    });
  }

  /** While held, the bot may only read that tab, and may not bring another tab to the front. */
  hold(targetId: string, held: boolean): void {
    for (const tab of this.#tabs.values()) if (tab.target === targetId) tab.held = held;
  }

  owner(targetId: string): PaneOwner {
    for (const tab of this.#tabs.values()) {
      if (tab.target !== targetId) continue;
      if (tab.held || (tab.lastPerson > 0 && tab.lastPerson >= tab.lastBot)) return "person";
      return tab.lastBot > 0 ? "bot" : null;
    }
    return null;
  }

  closed(reason: string): void {
    if (this.#closed !== null) return;
    this.#closed = reason;
    for (const listener of this.#closes) {
      try { listener(reason); } catch {}
    }
    this.#closes.clear();
  }

  get tabs(): string[] {
    return [...this.#tabs.keys()];
  }

  // Commands.

  async #run(command: Command): Promise<Params> {
    const params = command.params ?? {};
    if (!command.sessionId) return this.#browser(command.method, params);
    const route = this.#route(command.sessionId);
    if (route.kind !== "viewer" && route.tab.held && !heldAllows(command.method, command.readOnly === true)) throw new Refusal(PERSON_HOLDS_TAB);
    if (route.kind === "child") return this.#channel.command(route.tab.tab, command.method, unrenamed(command.method, params), route.child);
    if (route.kind === "viewer") return this.#viewer(route.tab, command.sessionId, command.method, params);
    return this.#page(route.tab, command.method, params);
  }

  #route(sessionId: string): { kind: "page" | "viewer"; tab: TabState } | { kind: "child"; tab: TabState; child: string } {
    const match = /^pane-(p\d+)(?:(~v\d+)|:(.+))?$/.exec(sessionId);
    const tab = match ? this.#tabs.get(match[1]!) : undefined;
    if (!match || !tab) throw new Refusal("No session with given id");
    if (match[3]) return { kind: "child", tab, child: match[3] };
    if (match[2]) {
      if (!tab.viewers.has(sessionId)) throw new Refusal("No session with given id");
      return { kind: "viewer", tab };
    }
    return { kind: "page", tab };
  }

  async #browser(method: string, params: Params): Promise<Params> {
    switch (method) {
      case "Target.setDiscoverTargets":
        return {};
      case "Target.setAutoAttach":
        this.#autoAttach = true;
        for (const tab of this.#tabs.values()) this.#announce(tab);
        return {};
      case "Target.getTargets":
        return { targetInfos: [...this.#tabs.values()].map((tab) => this.#info(tab)) };
      case "Target.getTargetInfo":
        return { targetInfo: this.#info(this.#tab(String(params.targetId))) };
      case "Target.createTarget": {
        const created = await this.#channel.create(typeof params.url === "string" ? params.url : "about:blank", params.background === true || this.#anyHeld());
        this.tabOpened(created);
        return { targetId: created.target };
      }
      case "Target.closeTarget": {
        const tab = this.#tab(String(params.targetId));
        if (tab.held) throw new Refusal(PERSON_HOLDS_TAB);
        this.#channel.closeTab(tab.tab);
        return { success: true };
      }
      case "Target.activateTarget": {
        const tab = this.#tab(String(params.targetId));
        this.#refuseFront(tab);
        this.#channel.front(tab.tab);
        return {};
      }
      case "Target.attachToTarget": {
        const tab = this.#tab(String(params.targetId));
        const sessionId = `${pageSession(tab.tab)}~v${++this.#viewerCount}`;
        tab.viewers.add(sessionId);
        this.#event("Target.attachedToTarget", { sessionId, targetInfo: this.#info(tab), waitingForDebugger: false });
        return { sessionId };
      }
      case "Target.detachFromTarget": {
        const sessionId = String(params.sessionId);
        for (const tab of this.#tabs.values()) {
          if (!tab.viewers.delete(sessionId)) continue;
          if (tab.casting.delete(sessionId) && tab.casting.size === 0) await this.#channel.command(tab.tab, "Page.stopScreencast", {}).catch(() => undefined);
          this.#event("Target.detachedFromTarget", { sessionId, targetId: tab.target });
        }
        return {};
      }
      case "Browser.getVersion":
        return { protocolVersion: "1.3", product: `Chrome/${this.#channel.version}`, revision: "", userAgent: this.#channel.userAgent, jsVersion: "" };
      case "Browser.setPermission":
      case "Browser.resetPermissions":
      case "Browser.setDownloadBehavior":
        return {};
      case "Browser.cancelDownload":
        this.#channel.cancelDownload(String(params.guid));
        return {};
      case "Browser.getWindowForTarget":
        return { windowId: 1, bounds: {} };
      case "Browser.getWindowBounds":
        return { bounds: {} };
      case "Browser.close":
        this.#channel.close();
        return {};
      default:
        throw new Refusal(`${method} is not available on a desktop pane.`);
    }
  }

  async #page(tab: TabState, method: string, params: Params): Promise<Params> {
    if (method === "Page.bringToFront") {
      this.#refuseFront(tab);
      this.#channel.front(tab.tab);
      return {};
    }
    if (method === "Page.close") {
      this.#channel.closeTab(tab.tab);
      return {};
    }
    if (method === "Emulation.setDeviceMetricsOverride") throw new Refusal("A desktop pane is sized by the app window.");
    const ahead = tab.gate;
    const input = method.startsWith("Input.");
    if (input) {
      const released = ahead.then(() => this.#personStill());
      tab.gate = released;
      await released;
      if (tab.held) throw new Refusal(PERSON_HOLDS_TAB);
      tab.lastBot = Date.now();
    } else {
      await ahead;
    }
    // Real input follows window focus; a pane the person is not in must still take the bot's keys.
    if (method === "Page.enable") void this.#channel.command(tab.tab, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
    if (method === "Page.navigate" || method === "Page.reload") await this.#prime(tab.tab);
    // The person's page outlives this server: a frame paused for it would stay frozen after a server restart.
    const sent = method === "Target.setAutoAttach" ? { ...params, waitForDebuggerOnStart: false } : params;
    return this.#channel.command(tab.tab, method, sent);
  }

  async #viewer(tab: TabState, sessionId: string, method: string, params: Params): Promise<Params> {
    if (method === "Emulation.setDeviceMetricsOverride") throw new Refusal("A desktop pane is sized by the app window.");
    if (method === "Page.startScreencast") tab.casting.add(sessionId);
    if (method === "Page.stopScreencast") {
      tab.casting.delete(sessionId);
      if (tab.casting.size > 0) return {};
    }
    if (method === "Page.bringToFront") {
      this.#channel.front(tab.tab);
      return {};
    }
    return this.#channel.command(tab.tab, method, params);
  }

  /** Electron loses a page's event subscriptions when a navigation swaps its renderer process. */
  async #prime(tab: string): Promise<void> {
    const priming = (async () => {
      for (const method of PRIMED) await this.#channel.command(tab, method, method === "Page.setLifecycleEventsEnabled" ? { enabled: true } : {});
    })().catch(() => undefined);
    await Promise.race([priming, sleep(this.#primeMs)]);
  }

  async #personStill(): Promise<void> {
    const until = Date.now() + this.#maxHoldMs;
    for (let wait = this.#lastInput + this.#quietMs - Date.now(); wait > 0 && Date.now() < until; wait = this.#lastInput + this.#quietMs - Date.now()) {
      await sleep(Math.min(wait, until - Date.now()));
    }
  }

  #anyHeld(): boolean {
    for (const tab of this.#tabs.values()) if (tab.held) return true;
    return false;
  }

  /** Bringing a tab to the front while the person holds another would take the page they use away from them. */
  #refuseFront(tab: TabState): void {
    for (const other of this.#tabs.values()) if (other.held && other !== tab) throw new Refusal(PERSON_HOLDS_TAB);
  }

  #tab(targetId: string): TabState {
    for (const tab of this.#tabs.values()) if (tab.target === targetId) return tab;
    throw new Refusal("No target with given id found");
  }

  #info(tab: TabState) {
    const opener = tab.opener ? this.#tabs.get(tab.opener)?.target : undefined;
    return { targetId: tab.target, type: "page", url: tab.url, title: tab.title, attached: true, ...(opener ? { openerId: opener } : {}) };
  }

  #announce(tab: TabState): void {
    if (tab.announced) return;
    tab.announced = true;
    this.#event("Target.attachedToTarget", { sessionId: pageSession(tab.tab), targetInfo: this.#info(tab), waitingForDebugger: false });
  }

  #event(method: string, params: Params, sessionId?: string): void {
    this.#emit({ method, params, ...(sessionId ? { sessionId } : {}) });
  }

  #emit(message: Record<string, unknown>): void {
    queueMicrotask(() => {
      if (this.#closed !== null) return;
      const text = JSON.stringify(message);
      for (const listener of this.#messages) {
        try { listener(text); } catch {}
      }
    });
  }
}

function pageSession(tab: string): string {
  return `${PAGE_PREFIX}${tab}`;
}

/** Child session ids are the pane debugger's own: two panes' iframes must never share one on this connection. */
function renamed(method: string, params: Params, page: string): Params {
  if ((method === "Target.attachedToTarget" || method === "Target.detachedFromTarget") && typeof params.sessionId === "string") {
    return { ...params, sessionId: `${page}:${params.sessionId}` };
  }
  return params;
}

function unrenamed(method: string, params: Params): Params {
  if (method === "Target.detachFromTarget" && typeof params.sessionId === "string") {
    return { ...params, sessionId: params.sessionId.replace(/^pane-p\d+:/, "") };
  }
  return params;
}

function errorOf(error: unknown): { message: string; code?: number } {
  if (error instanceof Refusal) return { message: error.message, code: -32000 };
  const code = (error as { code?: unknown } | null)?.code;
  return { message: error instanceof Error ? error.message : String(error), ...(typeof code === "number" ? { code } : {}) };
}
