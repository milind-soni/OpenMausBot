// The bots' browsers on the CDP driver: one Chrome per profile, started on a bot's first call and closed when idle,
// tools and people's viewers on top. A person holding the browser holds all of it; one bot call runs at a time.
//
// The tab lifecycle, popups, downloads and the per-server limits follow pingdotgg/t3code@00cdceb1
// apps/server/src/preview/ServerBrowser.ts (dropTab, adoptPopup, saveDownload, closeIdleAgentTabs), MIT License,
// Copyright (c) 2026 T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified: a Chrome per profile behind the
// CDP driver instead of Playwright contexts, and OpenMausBot's idle close, caps and person/bot control rules.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { scrubHeldSecrets } from "../../shared/redact.ts";
import { BrowserLanes } from "../browser-lane.ts";
import { BROWSER_CALL_DEFAULTS, type BrowserTiming } from "../browser-runtime.ts";
import { SecretHolds, type SecretHold } from "../browser-secret-hold.ts";
import { scrubBrowserResult } from "../browser-tool-shape.ts";
import type { FillLoginDeps } from "../login-fill.ts";
import type { Backend, OpenedBrowser } from "./backends.ts";
import type { CdpBrowser } from "./cdp/browser.ts";
import type { Download } from "./cdp/downloads.ts";
import { isUnanswered } from "./cdp/errors.ts";
import type { CdpPage } from "./cdp/page.ts";
import { browserRoot, profileDir, profileHash, profileKind, removeProfile, workspaceId } from "./chrome/profile.ts";
import { BROWSER_CONTROL_REFUSAL, ProfileControl, type TakeResult } from "./control.ts";
import { executeTool, personUrl, toolFailure, type ToolContext } from "./dispatch.ts";
import { HealthShown, pageHealthLine } from "./health.ts";
import type { HoldLimits } from "./hold.ts";
import { errorResult, shapeResult, textResult, withParts, type ToolResult } from "./shape.ts";
import { TabRegistry, type Tab } from "./tabs.ts";
import { parseToolCall, RESTART_TOOL, TOOL_LIST } from "./tools.ts";
import { ViewerHub, type Viewer, type ViewerOptions, type ViewerOutput } from "./viewers/core.ts";

/** One profile's browser as the server names it: the session (bot-<id>, a profile's partition, guest-…) and its key. */
export interface BrowserTarget {
  session: string;
  key: string;
}

export const LANE_BUSY = "Your previous browser call is still running; wait for it to finish, then call again.";
export const BROWSER_STUCK = `The browser engine is stuck. Press Restart in the Browser panel, or call ${RESTART_TOOL}, before using browser tools again.`;
const RESTART_COST = "a restart closes every tab and loses page state such as form input";
const PROBE_MS = 5_000;
const CAPACITY_WAIT_MS = 30_000;
const SERVER_TAB_LIMIT = 32;
const PROFILE_TAB_LIMIT = 8;

export interface BrowserServiceOptions {
  dataDir: string;
  backend(key: string): Backend;
  /** Browsers running at once on this server. */
  maxRunning: number;
  idleMs(): number;
  scrub?: (text: string) => string;
  /** What the egress gate of this profile's browser refused since it was last asked, as one line. */
  egressNotice?: (key: string) => string | null;
  onTiming?: (timing: BrowserTiming) => void;
  callBudgetMs?: number;
  laneWaitMs?: number;
  takeoverMs?: number;
  capacityWaitMs?: number;
  /** How long a person's hold lasts without a hand-back; the standard limits when unset. */
  holdLimits?: HoldLimits;
  log?: (line: string) => void;
}

interface Running {
  readonly opened: OpenedBrowser;
  readonly browser: CdpBrowser;
  readonly offs: Array<() => void>;
  closing: boolean;
}

type Reopened = { kind: "idle" | "restart" | "crash"; pages: string[] } | null;

export class ProfileState {
  readonly key: string;
  readonly session: string;
  readonly tabs = new TabRegistry();
  readonly control: ProfileControl<Tab>;
  readonly hub: ViewerHub;
  readonly downloadDir: string;
  readonly shown = new WeakMap<Tab, HealthShown>();
  run: Running | null = null;
  starting: Promise<Running> | null = null;
  /** The Chrome the pending start is opening; a stop waits for it. */
  opening: Promise<Running> | null = null;
  stopping: Promise<void> | null = null;
  /** Bumped by every stop: a start begun before it closes what it opened. */
  epoch = 0;
  lastUsed = Date.now();
  calls = 0;
  reopened: Reopened = null;
  /** The next start opens one blank tab rather than the last session's. */
  fresh = false;

  constructor(target: BrowserTarget, dataDir: string, hub: (profile: ProfileState) => ViewerHub, takeoverMs: number) {
    this.key = target.key;
    this.session = target.session;
    this.control = new ProfileControl<Tab>(() => this.tabs.list(), { takeoverMs });
    this.downloadDir = join(browserRoot(dataDir), "downloads", profileHash(workspaceId(dataDir), target.key));
    this.hub = hub(this);
  }

  get temporary(): boolean {
    return profileKind(this.key) === "temp";
  }

  active(): Tab | null {
    const page = this.run?.browser.activePage;
    return (page && this.tabs.byPage(page)) ?? this.tabs.list().at(-1) ?? null;
  }
}

function toolNameOf(params: unknown): string | undefined {
  const name = (params as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : undefined;
}

function lostCallResult(call: string): ToolResult {
  return errorResult(`The browser did not answer this ${call} call. It may still be running, or it may already have taken effect. Do not repeat it yet: your next browser call first waits for the browser, then tells you where the page is. Call ${RESTART_TOOL} only if the browser stays busy, because ${RESTART_COST}.`);
}

function stillBusyResult(call: string): ToolResult {
  return errorResult(`The browser is still busy with an earlier ${call} call that did not answer. This call did not run. Try again in a moment. If the browser stays busy, call ${RESTART_TOOL}; ${RESTART_COST}.`);
}

function recoveredResult(call: string, url: string): ToolResult {
  return textResult(`The browser answers again: the earlier ${call} call that did not answer has ended, and it may have taken effect. This call did not run. The current page is ${url || "unknown"}. Check the page before you repeat the earlier action, then call again what you need.`);
}

function reopenedNote(reopened: NonNullable<Reopened>, temporary: boolean): string {
  const pages = reopened.pages.length ? ` It reopened your pages: ${reopened.pages.join(", ")}.` : "";
  const refs = " Refs from before are gone: take a snapshot before acting on refs.";
  if (reopened.kind === "restart") return `The browser was restarted; this call ran in the fresh browser, on one blank tab.${refs} Check whether an interrupted action already happened before repeating it.`;
  if (reopened.kind === "crash") return `Your browser stopped unexpectedly, and this call started it again.${pages}${refs}`;
  return `Your browser sat unused and was closed to free memory; this call opened it again.${temporary ? " It is a temporary browser, so its sign-ins are gone too." : pages}${refs}`;
}

export class BrowserService {
  readonly #options: Required<Pick<BrowserServiceOptions, "callBudgetMs" | "laneWaitMs" | "takeoverMs" | "capacityWaitMs">> & BrowserServiceOptions;
  readonly #profiles = new Map<string, ProfileState>();
  readonly #lanes = new BrowserLanes();
  readonly #holds = new SecretHolds((session, clear) => {
    const profile = this.#bySession(session);
    if (!profile) return Promise.resolve(false);
    return this.#lanes.run(profile.key, () => profile.control.agent(null, clear), this.#options.laneWaitMs).then((ran) => ran !== null);
  });
  readonly #scrub: (text: string) => string;

  constructor(options: BrowserServiceOptions) {
    this.#options = { callBudgetMs: BROWSER_CALL_DEFAULTS.callBudgetMs, laneWaitMs: BROWSER_CALL_DEFAULTS.laneWaitMs, takeoverMs: 15_000, capacityWaitMs: CAPACITY_WAIT_MS, ...options };
    this.#scrub = options.scrub ?? scrubHeldSecrets;
  }

  profile(target: BrowserTarget): ProfileState {
    let profile = this.#profiles.get(target.key);
    if (!profile) {
      profile = new ProfileState(target, this.#options.dataDir, (state) => new ViewerHub(this.#hubHost(state)), this.#options.takeoverMs);
      this.#profiles.set(target.key, profile);
    }
    return profile;
  }

  #bySession(session: string): ProfileState | undefined {
    for (const profile of this.#profiles.values()) if (profile.session === session) return profile;
    return undefined;
  }

  profiles(): ProfileState[] {
    return [...this.#profiles.values()];
  }

  // Browsers.

  /** The profile's running browser, started if it is not. */
  running(profile: ProfileState): Promise<Running> {
    if (profile.run && !profile.run.closing && profile.run.browser.connected) return Promise.resolve(profile.run);
    if (profile.starting) return profile.starting;
    const epoch = profile.epoch;
    const starting = (async () => {
      for (let stopping = profile.stopping; stopping; stopping = profile.stopping) await stopping;
      return this.#start(profile, epoch);
    })().finally(() => { if (profile.starting === starting) profile.starting = null; });
    profile.starting = starting;
    return starting;
  }

  async #start(profile: ProfileState, epoch: number): Promise<Running> {
    await this.#capacity(profile);
    this.#stillWanted(profile, epoch);
    const opening = this.#open(profile, epoch);
    profile.opening = opening;
    try {
      return await opening;
    } finally {
      if (profile.opening === opening) profile.opening = null;
    }
  }

  #stillWanted(profile: ProfileState, epoch: number): void {
    if (profile.epoch !== epoch || this.#profiles.get(profile.key) !== profile) throw new Error("The browser was closed while it was starting.");
  }

  async #open(profile: ProfileState, epoch: number): Promise<Running> {
    const fresh = profile.fresh;
    profile.fresh = false;
    mkdirSync(profile.downloadDir, { recursive: true, mode: 0o700 });
    const opened = await this.#options.backend(profile.key).open({ key: profile.key, mode: "headless", fresh, viewport: profile.hub.viewport(), downloadDir: profile.downloadDir });
    const run: Running = { opened, browser: opened.browser, offs: [], closing: false };
    const browser = opened.browser;
    const adopt = (page: CdpPage, origin: Tab["origin"]) => {
      if (page.closed || run.closing) return;
      const opener = page.openerId ? profile.tabs.list().find((tab) => tab.page.targetId === page.openerId) : undefined;
      const known = profile.tabs.byPage(page);
      const tab = known ?? profile.tabs.add(page, opener ? "page" : origin, opener?.id ?? null);
      if (known) return;
      profile.control.adopt(tab);
      page.auth.answerable = () => profile.hub.answersAuth();
      run.offs.push(page.auth.onChange(() => profile.hub.offerAuthPrompt()));
      run.offs.push(page.dialogs.onOpen(() => profile.hub.broadcastControl()), page.dialogs.onClose(() => profile.hub.broadcastControl()));
      run.offs.push(page.frames.onChange((change) => { if (change.frameId === page.frames.mainFrameId) profile.hub.urlChanged(tab); }));
      run.offs.push(page.session.on("Page.navigatedWithinDocument", (params) => { if (params.frameId === page.frames.mainFrameId) profile.hub.urlChanged(tab); }));
      run.offs.push(page.session.on("Page.loadEventFired", () => {
        if (profile.hub.size) void browser.refreshTargets().then(() => profile.hub.titlesChanged(), () => undefined);
      }));
      run.offs.push(page.session.on("Page.frameStartedLoading", (params) => { if (params.frameId === page.frames.mainFrameId) profile.hub.loading(tab, true); }));
      run.offs.push(page.session.on("Page.frameStoppedLoading", (params) => { if (params.frameId === page.frames.mainFrameId) profile.hub.loading(tab, false); }));
      run.offs.push(page.fileChoosers.onChange(() => void profile.hub.offerFileChooser()));
      if (opener && profile.control.owner !== null) {
        profile.hub.popup(tab);
        void browser.bringToFront(page).then(() => profile.hub.tabsChanged(), () => undefined);
      }
      profile.hub.tabsChanged();
    };
    run.offs.push(browser.onPage((page) => adopt(page, "agent")));
    run.offs.push(browser.onPageClosed((page) => {
      if (profile.tabs.remove(page.targetId)) profile.hub.tabsChanged();
    }));
    if (browser.downloads) run.offs.push(browser.downloads.onChange((download) => profile.hub.downloaded(download)));
    try {
      this.#stillWanted(profile, epoch);
      await browser.waitForPage(() => true, 15_000);
      for (const page of browser.pages()) await page.ready.then(() => adopt(page, "restored"), () => undefined);
      if (fresh) await this.#onlyBlankTab(profile, browser);
      this.#stillWanted(profile, epoch);
    } catch (error) {
      run.closing = true;
      for (const off of run.offs) off();
      await opened.close().catch(() => undefined);
      throw error;
    }
    profile.run = run;
    profile.lastUsed = Date.now();
    void opened.exited.then(() => this.#exited(profile, run));
    if (profile.reopened?.kind === "idle" || profile.reopened?.kind === "crash") {
      profile.reopened = { ...profile.reopened, pages: profile.tabs.list().filter((tab) => tab.page.url() !== "about:blank").map((tab) => `${tab.id} ${tab.page.url()}`) };
    }
    profile.hub.started();
    return run;
  }

  async #onlyBlankTab(profile: ProfileState, browser: CdpBrowser): Promise<void> {
    const tabs = profile.tabs.list();
    const keep = tabs.find((tab) => tab.page.url() === "about:blank") ?? tabs[0];
    for (const tab of tabs) if (tab !== keep) await browser.closePage(tab.page).catch(() => undefined);
    if (keep && keep.page.url() !== "about:blank") await keep.page.navigate("about:blank").catch(() => undefined);
  }

  /** Chrome went away while nobody was closing it: a crash, or it was killed. */
  #exited(profile: ProfileState, run: Running): void {
    if (profile.run !== run) return;
    for (const off of run.offs) off();
    profile.run = null;
    profile.tabs.clear();
    if (run.closing) return;
    profile.reopened = { kind: "crash", pages: [] };
    profile.control.settle();
    this.#options.log?.(`browser ${profile.key}: Chrome exited unexpectedly; the next call starts it again`);
    profile.hub.stopped("crashed");
  }

  /** Graceful: Chrome's own quit, so its next start reopens the tabs and keeps session cookies. */
  async #stop(profile: ProfileState, reopened: Reopened, { erase = false }: { erase?: boolean } = {}): Promise<void> {
    if (profile.stopping) return profile.stopping;
    profile.epoch++;
    const run = profile.run;
    const opening = profile.opening;
    const stopping = (async () => {
      profile.control.closing = true;
      profile.control.changed();
      try {
        if (run) {
          run.closing = true;
          for (const off of run.offs) off();
          profile.hub.stopped(reopened?.kind === "idle" ? "asleep" : "closed");
          await run.opened.close().catch(() => undefined);
        }
        await opening?.catch(() => undefined);
      } finally {
        if (profile.run === run) profile.run = null;
        profile.tabs.clear();
        if (reopened) profile.reopened = reopened;
        if (profile.temporary || erase) this.#erase(profile);
        profile.control.closing = false;
        profile.control.settle();
      }
    })().finally(() => { if (profile.stopping === stopping) profile.stopping = null; });
    profile.stopping = stopping;
    return stopping;
  }

  #erase(profile: ProfileState): void {
    this.#eraseFiles(profile.key);
  }

  #eraseFiles(key: string): void {
    const root = browserRoot(this.#options.dataDir);
    const hash = profileHash(workspaceId(this.#options.dataDir), key);
    removeProfile(profileDir(this.#options.dataDir, key));
    for (const folder of ["downloads", "screenshots"]) rmSync(join(root, folder, hash), { recursive: true, force: true });
  }

  #unused(profile: ProfileState, idleMs: number): boolean {
    return profile.run !== null && !profile.starting && !profile.stopping && profile.calls === 0
      && profile.control.owner === null && profile.control.agents === 0 && !this.#lanes.held(profile.key) && Date.now() - profile.lastUsed >= idleMs;
  }

  /** The least recently used unwatched idle browser makes room; with none, the call waits, then is told why it cannot start. */
  async #capacity(profile: ProfileState): Promise<void> {
    const until = Date.now() + this.#options.capacityWaitMs;
    for (;;) {
      const others = this.profiles().filter((other) => other !== profile && (other.run || other.starting));
      if (others.length < this.#options.maxRunning) return;
      const candidate = others.filter((other) => other.hub.size === 0 && this.#unused(other, 0)).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (candidate) {
        await this.#stop(candidate, { kind: "idle", pages: [] });
        continue;
      }
      if (Date.now() >= until) throw new Error(`${others.length} browsers are already open on this computer, the most it runs at once. Wait for another bot to finish with its browser, then try again.`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  runs(session: string): boolean {
    const profile = this.#bySession(session);
    return Boolean(profile && (profile.run || profile.starting));
  }

  /** Closes a session's browser now unless a call, an agent or a person is using it. */
  async closeUnused(session: string): Promise<boolean> {
    const profile = this.#bySession(session);
    if (!profile || !this.#unused(profile, 0)) return false;
    await this.#stop(profile, { kind: "idle", pages: [] });
    return true;
  }

  /** Every running browser no one has used for `idleMs` closes, watched or not; its bot hears why on its next call. */
  async closeIdle(idleMs = this.#options.idleMs()): Promise<string[]> {
    const closed: string[] = [];
    for (const profile of this.profiles()) {
      if (!(idleMs > 0) || !this.#unused(profile, idleMs)) continue;
      await this.#stop(profile, { kind: "idle", pages: [] });
      closed.push(profile.key);
    }
    return closed;
  }

  /** Closes a profile's browser; a temporary one is erased with it. */
  async close(session: string): Promise<void> {
    const profile = this.#bySession(session);
    this.#holds.drop(session);
    if (profile) await this.#stop(profile, null);
  }

  /** Stops the browser and deletes everything it kept: sign-ins, history, downloads. */
  async erase(key: string): Promise<void> {
    const profile = this.#profiles.get(key);
    if (profile) {
      await this.#stop(profile, null, { erase: true });
      this.#profiles.delete(key);
      this.#holds.drop(profile.session);
    } else {
      this.#eraseFiles(key);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.profiles().map((profile) => this.#stop(profile, null)));
  }

  // Bot calls.

  async agentRpc(target: BrowserTarget, method: "tools/list" | "tools/call", params: unknown, beforeDispatch?: () => void): Promise<unknown> {
    if (method === "tools/list") return { tools: TOOL_LIST.map((tool) => ({ ...tool })) };
    if (method !== "tools/call") throw new Error("Unsupported browser method.");
    const profile = this.profile(target);
    for (let stopping = profile.stopping; stopping; stopping = profile.stopping) await stopping;
    profile.calls++;
    const name = toolNameOf(params) ?? "browser";
    const deadline = Date.now() + this.#options.callBudgetMs;
    const started = performance.now();
    let result: ToolResult | null;
    try {
      const work = () => this.#call(profile, params, deadline, beforeDispatch);
      const call = name === RESTART_TOOL || profile.control.uncertain ? work() : this.#lanes.run(profile.key, work, this.#options.laneWaitMs);
      result = await this.#withinBudget(profile, name, call, deadline);
    } finally {
      profile.calls--;
      profile.lastUsed = Date.now();
    }
    const final = result ?? errorResult(LANE_BUSY);
    this.#options.onTiming?.({ session: profile.session, tool: name, outcome: final.isError ? "error" : "ok", totalMs: performance.now() - started, inFlight: profile.control.agents, chars: final.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0) });
    if (profile.reopened && profile.run) {
      const note = reopenedNote(profile.reopened, profile.temporary);
      profile.reopened = null;
      return scrubBrowserResult({ ...final, content: [{ type: "text", text: note }, ...final.content] }, this.#scrub);
    }
    return scrubBrowserResult(final, this.#scrub);
  }

  /** Work that outlasts the budget goes on, so its outcome is unknown: the call counts as lost until a probe answers. */
  async #withinBudget(profile: ProfileState, call: string, work: Promise<ToolResult | null>, deadline: number): Promise<ToolResult | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), Math.max(0, deadline - Date.now())); timer.unref?.(); });
    let outcome: ToolResult | null | "late";
    try { outcome = await Promise.race([work, late]); } finally { clearTimeout(timer); }
    if (outcome !== "late") return outcome;
    work.catch(() => undefined);
    profile.control.latch(call);
    return profile.control.lostCall === null ? errorResult(BROWSER_STUCK) : lostCallResult(call);
  }

  async #call(profile: ProfileState, params: unknown, deadline: number, beforeDispatch?: () => void): Promise<ToolResult> {
    const name = toolNameOf(params);
    const control = profile.control;
    if (name === RESTART_TOOL) {
      beforeDispatch?.();
      await this.#agentRestart(profile);
      return textResult("Browser restarted. Open pages were closed back to one blank tab; sign-ins are kept. Open the page you need again and check whether the interrupted action already happened before repeating it.");
    }
    if (control.uncertain) {
      if (control.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
      const lost = control.lostCall;
      if (lost === null) return errorResult(BROWSER_STUCK);
      beforeDispatch?.();
      const url = await this.#probe(profile);
      return url === null ? stillBusyResult(lost) : recoveredResult(lost, url);
    }
    const parsed = parseToolCall(name, (params as { arguments?: unknown } | null)?.arguments);
    if (!parsed.ok) return errorResult(parsed.error);
    let run: Running;
    try {
      run = await this.running(profile);
    } catch (error) {
      return errorResult(`The browser could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    beforeDispatch?.();
    if (control.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
    control.call = parsed.call.name;
    try {
      const result = await executeTool(this.#context(profile, run, deadline), parsed.call);
      beforeDispatch?.();
      return shapeResult(result, parsed.call.name);
    } catch (error) {
      if (isUnanswered(error)) {
        control.latch(parsed.call.name);
        return lostCallResult(parsed.call.name);
      }
      const failure = toolFailure(error);
      if (!failure) throw error;
      // A navigation the egress gate refused (a redirect into Reddit from the cloud) says why.
      return withParts(failure, this.#options.egressNotice?.(profile.key));
    } finally {
      if (control.call === parsed.call.name) control.call = null;
    }
  }

  #context(profile: ProfileState, run: Running, deadline: number): ToolContext {
    return {
      control: profile.control,
      tabs: profile.tabs,
      browser: run.browser,
      deadline,
      active: () => profile.active(),
      openTab: () => this.#openTab(profile, "agent"),
      closeTab: (tab) => this.#closeTab(profile, tab),
      closeBrowser: () => this.#stop(profile, null),
      pointer: (tab) => profile.hub.pointer(tab),
      paused: (tab, work) => profile.hub.paused(tab, work),
      health: (tab) => this.#health(profile, tab),
      secretOnPage: (tab) => this.#holds.refuses(profile.session, async () => tab.page.url(), tab.page.targetId),
      saveScreenshot: (data, pageUrl) => this.#saveScreenshot(profile, data, pageUrl),
      downloads: () => run.browser.downloads?.list() ?? [],
    };
  }

  #health(profile: ProfileState, tab: Tab): string | null {
    let shown = profile.shown.get(tab);
    if (!shown) profile.shown.set(tab, shown = new HealthShown());
    const line = pageHealthLine(tab.page.takeHealth(), { pageUrl: tab.page.url(), loaderId: tab.page.lifecycle.loaderId, shown });
    const gate = this.#options.egressNotice?.(profile.key) ?? null;
    return [line, gate].filter(Boolean).join(" ") || null;
  }

  #saveScreenshot(profile: ProfileState, data: Buffer, pageUrl: string): string {
    const folder = join(browserRoot(this.#options.dataDir), "screenshots", profileHash(workspaceId(this.#options.dataDir), profile.key));
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    let host = "page";
    try { host = new URL(pageUrl).hostname.replace(/[^a-z0-9]+/giu, "-").slice(0, 40) || "page"; } catch {}
    const path = join(folder, `browser-screenshot-${host}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.png`);
    writeFileSync(path, data, { mode: 0o600 });
    return path;
  }

  async #openTab(profile: ProfileState, origin: Tab["origin"]): Promise<Tab> {
    const run = await this.running(profile);
    if (profile.tabs.list().length >= PROFILE_TAB_LIMIT) throw new Error(`This browser already has ${PROFILE_TAB_LIMIT} tabs open, the most it keeps. Close one with agent_browser_tabs first.`);
    const open = this.profiles().reduce((sum, other) => sum + other.tabs.list().length, 0);
    if (open >= SERVER_TAB_LIMIT) throw new Error(`The browsers on this computer have ${SERVER_TAB_LIMIT} tabs open, the most they keep. Close a tab first.`);
    const page = await run.browser.newPage();
    const tab = profile.tabs.byPage(page) ?? profile.tabs.add(page, origin, null);
    profile.hub.tabsChanged();
    return tab;
  }

  async #closeTab(profile: ProfileState, tab: Tab): Promise<void> {
    const run = profile.run;
    if (!run) return;
    const last = profile.tabs.list().length <= 1;
    if (last) await this.#openTab(profile, "agent");
    await run.browser.closePage(tab.page);
  }

  /** A read that answers proves the call that did not has ended; it is never replayed. */
  async #probe(profile: ProfileState): Promise<string | null> {
    const control = profile.control;
    if (control.agents > 0) return null;
    const run = profile.run;
    if (!run) {
      control.settle();
      return "about:blank";
    }
    try {
      await run.browser.connection.root.send("Target.getTargets", {}, { timeoutMs: PROBE_MS });
      const tab = profile.active();
      if (tab) await tab.page.session.send("Page.getNavigationHistory", {}, { timeoutMs: PROBE_MS });
      control.settle();
      return tab ? tab.page.url().slice(0, 500) : "about:blank";
    } catch {
      return null;
    }
  }

  async #agentRestart(profile: ProfileState): Promise<void> {
    const control = profile.control;
    if (control.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
    if (control.closing || control.releasing || control.agents > 0 || control.humans > 0) throw new Error("The browser is busy. Wait for current work to finish before restarting.");
    profile.fresh = true;
    await this.#stop(profile, null);
    profile.reopened = null;
  }

  // Preview frames and fill_login.

  /** Never starts a browser, and never while a bot call, a person or a filled secret is on it. */
  async previewFrame(session: string): Promise<{ png: string; format: "jpeg" }> {
    const profile = this.#bySession(session);
    const tab = profile?.run ? profile.active() : null;
    if (!profile || !tab) throw new Error("the browser has no open page to picture");
    if (profile.control.agents > 0 || this.#lanes.held(profile.key)) throw new Error("The browser is busy with an agent action.");
    if (profile.control.owner !== null) throw new Error("a person holds the browser");
    return profile.control.agent(tab, async () => {
      if (await tab.page.secrets.present(tab.page.frames)) throw new Error("a filled secret is on the page");
      const shot = await profile.hub.paused(tab, () => tab.page.screenshot({ format: "jpeg", quality: 80 }));
      return { png: shot.data.toString("base64"), format: "jpeg" as const };
    });
  }

  /** Runs in the browser's lane, so no capture or read happens while a secret is typed; a hold it leaves is the typing tab's. */
  async withSecretInput<T extends { ok: boolean; text: string; held?: SecretHold }>(target: BrowserTarget, fn: () => Promise<T>): Promise<T> {
    const profile = this.profile(target);
    const outcome = await this.#lanes.run(profile.key, async () => {
      await this.running(profile);
      return profile.control.agent(null, async () => {
        const tab = profile.active();
        const filled = await fn();
        if (filled.held) this.#holds.hold(profile.session, { ...filled.held, ...(tab ? { tab: tab.page.targetId } : {}) });
        return filled;
      });
    }, this.#options.laneWaitMs);
    if (outcome === null) throw new Error(LANE_BUSY);
    return outcome;
  }

  /** fill_login's reads and typing, on the tab in front. */
  loginDeps(target: BrowserTarget): Pick<FillLoginDeps, "engine" | "insertText" | "press" | "click"> {
    const profile = this.profile(target);
    const tab = () => {
      const active = profile.run ? profile.active() : null;
      if (!active) throw new Error("The browser has no page open.");
      return active;
    };
    return {
      engine: async (args) => {
        const active = profile.run ? profile.active() : null;
        if (!active) return null;
        if (args[0] === "get" && args[1] === "url") return { url: active.page.url() };
        if (args[0] === "eval" && typeof args[1] === "string") return { result: await active.page.evaluate(args[1]) };
        return null;
      },
      insertText: (text) => tab().page.keyboard.insertText(text),
      press: async (key) => { await tab().page.press(key); },
      click: async (selector) => { await tab().page.click({ selector }); },
    };
  }

  // People.

  async attachViewer(target: BrowserTarget, options: ViewerOptions, push: (output: ViewerOutput) => void): Promise<Viewer> {
    const profile = this.profile(target);
    return profile.hub.attach(options, push);
  }

  heldBy(session: string): string | null {
    return this.#bySession(session)?.control.owner ?? null;
  }

  /** Whether the page's open picker was offered to `owner`'s view as `chooserId`: an upload for any other is refused unread. */
  fileChooserOffered(session: string, owner: string, chooserId: string): boolean {
    return this.#bySession(session)?.hub.fileChooserOffered(owner, chooserId) ?? false;
  }

  /** A person's files for the page's open picker, which their view was offered as `chooserId`. */
  answerFileChooser(session: string, owner: string, chooserId: string, paths: readonly string[]): Promise<boolean> {
    return this.#bySession(session)?.hub.answerFileChooser(owner, chooserId, paths) ?? Promise.resolve(false);
  }

  /** A file this session's browser finished downloading. */
  download(session: string, id: string): Download | undefined {
    const download = this.#bySession(session)?.run?.browser.downloads?.list().find((candidate) => candidate.id === id);
    return download?.state === "completed" && download.path ? download : undefined;
  }

  interrupted(session: string): boolean {
    return this.#bySession(session)?.control.uncertain === true;
  }

  interruptedCount(): number {
    return this.profiles().filter((profile) => profile.control.uncertain).length;
  }

  /** Done on a sign-in card, from any window or device: whoever holds this browser hands it back. */
  async handBack(session: string): Promise<void> {
    await this.#bySession(session)?.hub.handBack();
  }

  /** A person's restart: every tab closes and the browser comes back on one blank tab. */
  async restart(session: string, owner: string): Promise<void> {
    const profile = this.#bySession(session);
    if (!profile) return;
    const control = profile.control;
    if (control.closing || control.releasing || control.agents > 0 || control.humans > 0) throw new Error("The browser is busy. Wait for current work to finish before restarting.");
    if (control.owner !== null && control.owner !== owner) throw new Error("Another person controls this browser.");
    profile.fresh = true;
    await this.#stop(profile, { kind: "restart", pages: [] });
    if (control.owner === owner) {
      control.owner = null;
      control.ready = false;
      control.changed();
    }
  }

  #hubHost(profile: ProfileState) {
    return {
      control: profile.control,
      ...(this.#options.holdLimits ? { holdLimits: this.#options.holdLimits } : {}),
      browser: () => (profile.run && !profile.run.closing ? profile.run.browser : null),
      active: () => profile.active(),
      tabs: () => profile.tabs.list(),
      tab: (id: string) => profile.tabs.get(id),
      running: async () => { await this.running(profile); },
      used: () => { profile.lastUsed = Date.now(); },
      pageLimit: () => (profile.run && !profile.run.closing ? profile.run.opened.pageLimit ?? null : null),
      take: async (owner: string): Promise<TakeResult> => {
        await this.running(profile);
        const taken = await profile.control.take(owner);
        for (const tab of profile.tabs.list()) await tab.page.releaseInput().catch(() => undefined);
        return taken;
      },
      release: (owner: string, releaseInput: (tab: Tab) => Promise<boolean>) => profile.control.release(owner, releaseInput),
      openTab: async (url: string | null, owner: string) => {
        const tab = await this.#openTab(profile, "person");
        const address = url ? personUrl(url) : null;
        if (address) await profile.control.human(owner, tab, () => tab.page.navigate(address, { readiness: "none" }));
        return tab;
      },
      closeTab: (tab: Tab) => this.#closeTab(profile, tab),
      showTab: async (tab: Tab) => {
        await tab.page.bringToFront();
        await profile.hub.fit();
        profile.hub.tabsChanged();
      },
      download: (id: string): Download | undefined => profile.run?.browser.downloads?.list().find((download) => download.id === id),
    };
  }
}
