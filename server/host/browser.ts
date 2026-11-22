// The bots' browser as the server hosts it: the engine's runtime and live view, which session a bot's browser is, and
// the integration a turn mounts. browserEngine.engine picks agent-browser (the default) or the new Chrome engine; a
// person's own Chrome (My Chrome) stays on agent-browser either way.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { Audience } from "../audience.ts";
import type { CloudLendingRefusal } from "../cloud-lending.ts";
import type { AppConfig } from "../config.ts";
import { browserEngineAttachCdpUrl, browserProfilePartitionId, browserProfilePartitionTarget, builtInBrowserEnabled, DATA_DIR } from "../config.ts";
import { BrowserRuntime, TransportError, attachesToChrome, browserRuntimeEnv, formatBrowserTiming } from "../browser-runtime.ts";
import { RelayTimeout, relay, relayCommand, relayInput } from "../browser-relay.ts";
import { browserSteps } from "../browser-steps.ts";
import { BrowserLive } from "../browser-live.ts";
import { browserEgress, type EgressSetup } from "../browser/egress/registry.ts";
import { releaseEndedGates } from "../browser/egress/release-ended.ts";
import {
  agentBrowserIntegration,
  BUILT_IN_BROWSER_SYSTEM_PROMPT,
  browserDaemonFile,
  browserEngineEncryptionKey,
  prepareBrowserSessionState,
  clearBrowserSessionState,
  closeBrowserSession,
  browserEngineStatus,
  inRunningBrowser,
  browserSessionId, isTemporaryBrowserSession, browserProfileDirectory,
  noteBrowserEngineUnavailable,
  setBrowserViewport,
} from "../browser-engine.ts";
import { BrowserRoom, defaultBrowserRoomSize, spareForRoom } from "../browser-room.ts";
import { BrowserSweep, browserIdleMs, type BrowserCleanupWireRequest } from "../browser-lifecycle-cleanup.ts";
import { AudienceBrowsers, audienceBrowserSuffix } from "../browser/audience.ts";
import type { BrowserSitesTarget } from "../browser-sites.ts";
import { namedUploadPaths } from "../browser-upload.ts";
import { createBrowserDaemons } from "./browser-daemons.ts";
import type { BrowserSitesRef } from "../routes/browser-sites.ts";
import { chromeLauncher } from "../browser/chrome/launcher.ts";
import { LAUNCHER_SECCOMP_FD, browserLanguage, type LauncherBox } from "../browser/chrome/wrapper.ts";
import type { HostKind } from "../browser/chrome/flags.ts";
import { browserEngineKind, browserPaneWanted, cloudDisplayWanted, type BrowserEngineKind } from "../browser/config.ts";
import { parseSocks5Proxy } from "../browser/egress/policy.ts";
import { ChromeEngine, chromeTarget, LiveRouter, profileKey, RuntimeRouter } from "../browser/engines.ts";
import { CEILING_TICK_MS, ceilingLines, createBrowserCeiling } from "../browser/memory-ceiling.ts";
import { browserProcessTree } from "../browser-processes.ts";
import { pssBytes } from "../bot-memory-cap.ts";
import { boxMemory } from "../box-memory.ts";
import { CHROME_BROWSER_SYSTEM_PROMPT } from "../browser/prompt.ts";
import { PaneBackend } from "../browser/pane/backend.ts";
import { desktopPaneLink } from "../browser/pane/link.ts";
import { cookieRequests } from "../browser/cookies/requests.ts";
import { keyStoreFor, systemFiles } from "../browser/cookies/sources.ts";
import { sweep as sweepCookieCopies } from "../browser/cookies/snapshot.ts";
import { passkeyAnnotation } from "../browser/passkey-notice.ts";
import { LentChromeDoors, lentChromeGuidance, type ChromeLender } from "../browser/lent-chrome.ts";
import type { ChromeRoute } from "../device-links.ts";
import type { EngineBrowsers } from "../engine-memory.ts";
import { createBrowserReclaim, reclaimable } from "./browser-reclaim.ts";
import { BROWSER_TASKS, processBudget } from "../process-room.ts";
import { idleAfter } from "../drivers/session-idle.ts";
import { augmentedPath } from "../env-path.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import type { FillLoginDeps } from "../login-fill.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { Store } from "../store.ts";
import type { TurnOwner, TurnResources } from "../turn-resources.ts";

export interface BrowserHostDeps {
  cfg: AppConfig;
  /** Current application language for every built-in browser launch. */
  language?(): string | undefined;
  /** The store is built after this host, so it is read when used. */
  store(): Pick<Store, "bots" | "bot" | "botByThread">;
  turnResources: Pick<TurnResources, "free" | "holder" | "onClaim">;
  activeInternalGenerationByThread: ReadonlyMap<string, string>;
  mintInternalCapability(capability: {
    botId: string; threadId: string; generation: string; browserSession: string; kind: "browser";
    depth: number; skillAuthoring: boolean; createdBots: number; openedThreads: number;
  }): string;
  DESKTOP_MANAGED: boolean;
  CLOUD_HOME: unknown;
  /** A shared company workspace: the server's network is the operator's, so the stored local-sites switch and allow-list are ignored. */
  HOSTED_WORKSPACE?: boolean;
  PORT: number;
  /** A Cloud home's way out through the person's own lent computer. */
  device?: EgressSetup["device"];
  /** Why a turn may not use the person's lent computer (cloud-lending.ts plus the memory check), or null when it may.
   * Without it, no browser a turn holds may. */
  lendRefusal?(turn: TurnOwner): LendRefusal | null;
  /** My Cloud's way to the person's own Chrome on the computer that lends it, and which computer that is. */
  lentChrome?: { route(): ChromeRoute | null; lender(): ChromeLender | null };
  /** The engine memory guard, told which browsers each thread's turn starts or holds. */
  /** `selfHosted`: turns wait for room on this server, under its pids limit, and so do its bots' browsers. */
  engineMemory?: { useBrowsers(browsers: EngineBrowsers): void; selfHosted?(): boolean; roomFactor?(): number; reclaimIdle?(): Promise<boolean> };
  /** Whose browser a conversation's turns use on a Team Cloud: the member's, the group chat's or the team's. Every
   * browser is the bot's own without it. */
  audienceOf?(threadId: string): Audience;
  /** The box every Chrome of the bots' browsers runs in (a Team Cloud's), or none. */
  browserBox?(seccompFd: number, ro: readonly string[]): LauncherBox | null;
  /** How many agent-browser browsers run at once; sized by this server's limits without it. */
  browsersAtOnce?(): number;
}

/** The lent computer's connection for a browser's pages, under the rule for everything it lends: only while the last
 * turn to hold that browser may use the lent computer. A browser no turn has held is the person's own. */
function lentDevice(device: NonNullable<EgressSetup["device"]>, holder: (session: string) => TurnOwner | undefined, mayLend: (turn: TurnOwner) => boolean) {
  const lends = new Map<string, boolean>();
  return (session: string) => {
    const turn = holder(session);
    if (turn) lends.set(session, mayLend(turn));
    return lends.get(session) === false ? null : device(session);
  };
}

type Spec = { command: string; args?: readonly string[]; env: Record<string, string> };
type LendRefusal = CloudLendingRefusal | "memory-changed" | "memory-changed-here";
const BOT_SESSION = /^bot-[A-Za-z0-9_.-]+$/;
/** However short of room the server is, a bot's browser stays this long after its last use: a turn's next browser call is
 * seldom further apart. */
const BROWSER_IDLE_FLOOR_MS = 60_000;

export function createBrowserHost(deps: BrowserHostDeps) {
  const { cfg, turnResources, activeInternalGenerationByThread, mintInternalCapability, DESKTOP_MANAGED, CLOUD_HOME, PORT } = deps;
  chromeLauncher.setLanguageProvider(deps.language);
  const store: Pick<Store, "bots" | "bot" | "botByThread"> = { get bots() { return deps.store().bots; }, bot: (id: string) => deps.store().bot(id),
    botByThread: (threadId: string) => deps.store().botByThread(threadId) };

  // Where turns wait for room (a self-hosted server under its pids limit), a new browser also waits for room for its
  // processes. `runs` is read only when a browser call asks, after usedBrowserSessions exists.
  const processRoom = deps.engineMemory?.selfHosted?.() ? processBudget.browserRoom((session) => browserRunning(session, usedBrowserSessions.get(session))) : null;
  // Only a bot waiting for a slot closes a browser a running turn holds; the idle sweep below never does.
  const browserRoom = new BrowserRoom({
    max: deps.browsersAtOnce ?? (() => defaultBrowserRoomSize()),
    spare: (session) => spareForRoom(agentBrowserRuntime.spare(session), { holds: !turnResources.free(`browser:${session}`), idleMs: idleMs() }),
    close: (session) => agentBrowserRuntime.closeIfIdle(session, 1),
    // Short of room for its processes, an idle engine goes before this browser waits or is refused (session-idle.ts).
    ...(processRoom ? { admit: async (session: string) => {
      if (processBudget.short(BROWSER_TASKS, 0)) await deps.engineMemory?.reclaimIdle?.().catch(() => false);
      return processRoom.enter(session);
    } } : {}),
  });
  const agentBrowserRuntime: BrowserRuntime = new BrowserRuntime({
    closeBrowser: (session, spec) => closeBrowserSession(spec.command, browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session })),
    applyViewport: (spec, size) => setBrowserViewport(spec.command, spec.env, size),
    // A browser a person's view started counts toward the limit too. It is not refused, so a bot's next new one waits.
    launch: {
      ready: (spec) => chromeLauncher.ready(spec),
      started: (session, spec) => {
        if (!attachesToChrome(spec.env ?? {})) browserRoom.entered(session);
        return chromeLauncher.started(session, spec);
      },
      stopped: (session) => chromeLauncher.stopped(session),
    },
    room: browserRoom,
    relayCommand: (spec, session, command, timeoutMs) => relayCommand(spec, session, command, timeoutMs).catch((error: unknown) => {
      throw error instanceof RelayTimeout ? new TransportError(error.message) : error;
    }),
    steps: browserSteps,
    onTiming: process.env.OMB_BROWSER_TIMING === "1" ? (timing) => console.info(formatBrowserTiming(timing)) : undefined,
  });
  const browserBox = deps.browserBox;
  const boxed = Boolean(browserBox?.(LAUNCHER_SECCOMP_FD, []));
  if (browserBox) chromeLauncher.boxWith(() => browserBox(LAUNCHER_SECCOMP_FD, []));
  const agentBrowserLive = new BrowserLive({ runtime: agentBrowserRuntime, devTools: {
    url: (port) => relay(port, { action: "cdp_url" }, { timeoutMs: 5_000, maxBytes: 65_536 }).then((answer) => answer.data?.cdpUrl),
  } });
  const host: HostKind = DESKTOP_MANAGED ? "desktop" : CLOUD_HOME || existsSync("/.dockerenv") ? "container" : "server";
  // per-bot: a bot's browser, kept for any of its conversations; shorter as the server runs short of room (session-idle.ts).
  const idleMs = () => {
    const configured = browserIdleMs(cfg, { cloudHome: Boolean(CLOUD_HOME) });
    return idleAfter(configured, Math.min(configured, BROWSER_IDLE_FLOOR_MS), deps.engineMemory?.roomFactor?.() ?? 1);
  };
  const paneLink = desktopPaneLink(DESKTOP_MANAGED);
  const chromeEngine = new ChromeEngine({
    dataDir: DATA_DIR,
    host,
    ...(paneLink ? { pane: { backend: new PaneBackend(paneLink, DATA_DIR, (key) => browserEgress.open(key), { identity: () => cfg.browserEngine?.paneIdentity ?? "native" }), wanted: () => browserPaneWanted(cfg) } } : {}),
    egressPort: (key) => browserEgress.open(key),
    egressNotice: (key) => browserEgress.takeNotice(key),
    idleMs,
    language: deps.language,
    cloudDisplay: () => cloudDisplayWanted(cfg, host),
    held: (session) => !turnResources.free(`browser:${session}`),
    log: (line) => console.warn(line),
  });
  const lendRefusal = deps.lendRefusal ?? ((): LendRefusal => "unproven");
  const mayLend = (turn: TurnOwner) => lendRefusal(turn) === null;
  const lentChrome = deps.lentChrome;
  const chromeRefusals = new Map<string, LendRefusal | null>();
  /** lentDevice's rule for the lent Chrome: the last holder's verdict, and a browser no turn has held is the person's own. */
  function chromeRefusal(session: string): LendRefusal | null {
    const turn = turnResources.holder(`browser:${session}`);
    if (turn) chromeRefusals.set(session, lendRefusal(turn));
    return chromeRefusals.get(session) ?? null;
  }
  const lentChromeAllowed = (session: string) => chromeRefusal(session) === null;
  /** Each refusal has its own way out: a new conversation can't undo a memory change, for one. */
  const refusedAs = (session: string) => chromeRefusals.get(session) ?? "not-allowed";
  // The desktop's idle time, not a Cloud home's shorter one: each reconnect may make Chrome ask the person to Allow again.
  const doors = lentChrome ? new LentChromeDoors({ route: () => lentChrome.route(), allowed: lentChromeAllowed, idleMs: () => browserIdleMs(cfg, { cloudHome: false }) }) : undefined;
  const doorUrls = new Map<string, string>();
  const leftovers = new Map<string, Promise<void>>();
  async function lentChromeDoor(session: string): Promise<string | undefined> {
    if (!doors) return undefined;
    // A browser already running when this server first opens the session's door was told another address: an earlier
    // server's door, gone after a restart, or none. An attached browser is never swept or idle-closed, so it is closed
    // before anything uses the new door.
    if (!doors.owns(session)) leftovers.set(session, closeLeftover(session));
    const url = await doors.door(session);
    await leftovers.get(session);
    doorUrls.set(session, url);
    return url;
  }
  async function closeLeftover(session: string): Promise<void> {
    const engine = browserEngineStatus();
    if (engine.kind !== "ready" || !browserRunning(session, undefined)) return;
    const closed = await closeBrowserSession(engine.binaryPath, browserRuntimeEnv({ AGENT_BROWSER_SESSION: session })).catch(() => false);
    if (!closed) console.warn(`browser ${session}: could not close the browser left running before its door to your Chrome opened`);
  }
  /** A profile switched back to the built-in browser keeps its session name and its door, but its calls no longer use it. */
  function viaDoor(session: string, spec: { env: NodeJS.ProcessEnv }): boolean {
    const url = doorUrls.get(session);
    return url !== undefined && spec.env.AGENT_BROWSER_CDP === url;
  }
  // A tool call that would open Reddit from MausBot Cloud is refused before it reaches the browser. My Chrome is the
  // person's own, outside the egress gate too; on My Cloud a call that can't reach it now says why instead.
  const browserRuntime = new RuntimeRouter(agentBrowserRuntime, chromeEngine, {
    refusal: (_session, spec, params) => (attachesToChrome(spec.env) ? null : browserEgress.callRefusal(params)),
    // The opt-in engine's browsers wait for the server's room here; agent-browser's wait in browserRoom above. The
    // person's own Chrome runs outside this server, and a close frees room.
    room: (session, spec, params) => (!processRoom || attachesToChrome(spec.env) || (params as { name?: unknown } | null)?.name === "agent_browser_close"
      ? Promise.resolve(null) : processRoom.enter(session)),
    // After beforeDispatch's claim the holder is this call's own turn, so the verdict is the caller's, not the last
    // holder's. Only a caller who may use the computer learns whether it lends Chrome or is online.
    afterClaim: (session, spec) => {
      if (!viaDoor(session, spec)) return null;
      const lender = lentChrome?.lender() ?? null;
      if (!lentChromeAllowed(session)) return lentChromeGuidance(refusedAs(session), lender);
      if (!lender) return lentChromeGuidance("not-lent", null);
      return lender.online ? null : lentChromeGuidance("offline", lender);
    },
    annotate: (spec, result) => passkeyAnnotation(chromeEngine.onPane(spec) ? "pane" : CLOUD_HOME ? "cloud" : DESKTOP_MANAGED ? "desktop" : "server")(spec, result),
    // agent-browser's own error names only the CDP connection; the door knows what went wrong on the way.
    afterCall: (session, spec, answer) => {
      const result = withCeilingNote(session, answer);
      const failed = result as { isError?: unknown; content?: unknown };
      const found = failed?.isError === true && viaDoor(session, spec) ? doors?.problem(session) : null;
      // A door refused under an earlier holder says nothing about a caller that may use it.
      const problem = found === "not-allowed" && lentChromeAllowed(session) ? null : found;
      if (!problem) return result;
      const content = Array.isArray(failed.content) ? failed.content : [];
      return { ...failed, content: [...content, { type: "text", text: lentChromeGuidance(problem === "not-allowed" ? refusedAs(session) : problem, lentChrome?.lender() ?? null) }] };
    },
  });
  // agent-browser keeps its Chrome connection across turns, so a turn that may not lend must not inherit an open one.
  if (doors) turnResources.onClaim((resource, owner) => {
    const session = resource.startsWith("browser:") ? resource.slice("browser:".length) : null;
    if (session === null || !doors.owns(session)) return;
    const refused = lendRefusal(owner);
    if (refused === null) return;
    chromeRefusals.set(session, refused);
    doors.drop(session);
  });
  const browserLive = new LiveRouter(agentBrowserLive, chromeEngine);
  const usedBrowserSessions = new Map<string, Spec>();
  const audiences = new AudienceBrowsers(join(DATA_DIR, "browser", "audiences.json"));
  const browserAudience = (threadId: string | undefined): Audience => (threadId && deps.audienceOf ? deps.audienceOf(threadId) : "team");
  const device = deps.device && lentDevice(deps.device, (session) => turnResources.holder(`browser:${session}`), mayLend);
  const egressHost = DESKTOP_MANAGED ? "desktop" : CLOUD_HOME ? "cloud" : "server";
  // Self-hosted servers only: the owner's switch for this server's own sites and its local network. A shared company
  // workspace's network is the operator's, so its stored switch and allow-list are ignored, like MausBot Cloud's.
  const hostedServer = egressHost === "server" && Boolean(deps.HOSTED_WORKSPACE);
  const sitesSwitch = egressHost === "server" && !hostedServer;
  browserEgress.configure({ host: egressHost, config: () => (hostedServer ? undefined : cfg.browserEngine?.egress), ...(device ? { device } : {}) });
  /** A live bot's, profile's or temporary browser of this data dir, for any audience. */
  const belongs = (session: string) => isTemporaryBrowserSession(session) || audiences.variants().some((suffix) =>
    store.bots.some((bot) => browserSessionId(bot.id + suffix, "") === session)
    || (cfg.browserProfiles ?? []).some((profile) => !usesMyChrome(profile.id) && browserSessionId("", browserProfilePartitionId(profile) + suffix) === session));
  // The agent-browser daemon outlives its MCP transport and this server; My Chrome is the person's own. A Cloud home's
  // HOME is this server's alone, so a deleted bot's browser there is closed too.
  const agentBrowserSweep = new BrowserSweep({
    engine: () => { const engine = browserEngineStatus(); return engine.kind === "ready" ? engine.binaryPath : null; },
    owns: (session) => belongs(session) || (Boolean(CLOUD_HOME) && BOT_SESSION.test(session)),
    live: (session) => usedBrowserSessions.has(session) && belongs(session),
    held: (session) => !turnResources.free(`browser:${session}`),
    closeIdle: (session) => browserRuntime.closeIfIdle(session, idleMs(), usedBrowserSessions.get(session)),
  });
  // A browser that has ended keeps no loopback listener: its gate opens again with it, on the same port where it can, and
  // the session's launch settings are worked out again then.
  const releaseGates = () => releaseEndedGates({ sessions: () => browserEgress.sessions(), release: async (session) => { usedBrowserSessions.delete(session); await browserEgress.release(session); },
    env: (session) => { const spec = usedBrowserSessions.get(session); return spec && !chromeTarget(session, spec) ? spec.env : null; },
    running: (session) => browserRunning(session, usedBrowserSessions.get(session)),
    inUse: (session) => !turnResources.free(`browser:${session}`) || agentBrowserRuntime.working(session) });
  let gateTimer: ReturnType<typeof setInterval> | undefined;
  let ceilingTimer: ReturnType<typeof setInterval> | undefined;
  const browserSweep = {
    start() {
      gateTimer = setInterval(() => void releaseGates().catch(() => undefined), 60_000);
      gateTimer.unref?.();
      if (browserCeiling) {
        ceilingTimer = setInterval(() => void browserCeiling.tick().catch(() => undefined), CEILING_TICK_MS);
        ceilingTimer.unref?.();
      }
      agentBrowserSweep.start();
      chromeEngine.start({ inUse: browserEngineKind(cfg) === "chrome", prepare: builtInBrowserEnabled(cfg) });
      return browserSweep;
    },
    closeAll: () => {
      clearInterval(gateTimer);
      clearInterval(ceilingTimer);
      doors?.close();
      doorUrls.clear();
      leftovers.clear();
      return agentBrowserSweep.closeAll();
    },
  };
  // Linux servers only: there a browser's proportional size can be read, and its memory is the home's.
  const browserCeiling = process.platform === "linux" && !DESKTOP_MANAGED ? createBrowserCeiling({
    lines: ceilingLines(boxMemory().bytes),
    browsers: async () => (await Promise.all(browserOwners().map(async ({ pid, session }) => {
      const spec = usedBrowserSessions.get(session);
      const tree = spec ? await browserProcessTree(spec.command, pid, session) : null;
      return tree ? [{ session, pids: [...tree.members.keys()] }] : [];
    }))).flat(),
    pss: (pid) => pssBytes(pid),
    quiet: (session) => !agentBrowserRuntime.working(session),
    tabs: async (session) => {
      const tabs = (await inRunningSession(session, ["tab", "list"]))?.tabs;
      return Array.isArray(tabs) ? tabs.flatMap((tab: { tabId?: unknown; title?: unknown; url?: unknown; active?: unknown }) =>
        typeof tab.tabId === "string" ? [{ tabId: tab.tabId, title: String(tab.title ?? ""), url: String(tab.url ?? ""), active: tab.active === true }] : []) : null;
    },
    closeTab: async (session, tabId) => (await inRunningSession(session, ["tab", "close", tabId])) !== null,
    // Memory relief's rules under ordinary shortage; which bots have a turn running is not known here.
    close: async (session) => {
      const spec = usedBrowserSessions.get(session);
      if (!spec) return false;
      const working = agentBrowserRuntime.working(session), spare = agentBrowserRuntime.spare(session);
      const candidate = { session, held: !turnResources.free(`browser:${session}`), working, running: browserRunning(session, spec),
        attached: Boolean(chromeTarget(session, spec)) || attachesToChrome(spec.env), watched: spare === null && !working, turnRunning: false,
        savesSignIns: spare?.savesSignIns ?? spec.env.AGENT_BROWSER_RESTORE_SAVE === "auto" };
      return reclaimable(candidate, false) && browserRuntime.closeUnused(session, spec);
    },
  }) : null;
  function inRunningSession(session: string, args: string[]): Promise<Record<string, unknown> | null> {
    const spec = usedBrowserSessions.get(session);
    return spec ? inRunningBrowser(spec.command, browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session }), args).catch(() => null) : Promise.resolve(null);
  }
  /** The ceiling's word on what it closed, added to the bot's next call in that browser. */
  function withCeilingNote(session: string, result: unknown): unknown {
    const content = (result as { content?: unknown } | null)?.content;
    const note = Array.isArray(content) ? browserCeiling?.takeNote(session) : null;
    if (!note || !Array.isArray(content)) return result;
    return { ...(result as object), content: [...content, { type: "text", text: note }] };
  }
  // The viewer and the agent must address the SAME temporary browser.
  const temporaryBrowserSessions = new Map<string, string>();
  /** The suffix an audience gives a browser's name, remembered so a deletion erases every audience's browser. */
  function noted(audience: Audience): string {
    const suffix = audienceBrowserSuffix(audience);
    audiences.note(suffix);
    return suffix;
  }
  function sessionFor(botId: string, profile: string | undefined, suffix: string): string {
    if (profile === "guest") {
      const key = botId + suffix;
      let session = temporaryBrowserSessions.get(key);
      if (!session) {
        session = browserSessionId(key, "guest");
        temporaryBrowserSessions.set(key, session);
      }
      return session;
    }
    const target = profile ? browserProfilePartitionTarget(cfg, profile) : null;
    return browserSessionId(botId + suffix, target ? target.partitionId + suffix : "");
  }
  function currentBrowserSession(botId: string, profile: string | undefined, audience: Audience = "team"): string {
    return sessionFor(botId, profile, noted(audience));
  }
  /** Every audience's browser of a bot as it is named now; a temporary one only once it started. */
  function browserSessionsOf(botId: string, profile: string | undefined): string[] {
    return audiences.variants().flatMap((suffix) => {
      if (profile !== "guest") return [sessionFor(botId, profile, suffix)];
      const session = temporaryBrowserSessions.get(botId + suffix);
      return session ? [session] : [];
    });
  }
  async function forgetTemporaryBrowser(botId: string): Promise<void> {
    await Promise.all(audiences.variants().map((suffix) => forgetTemporaryKey(botId + suffix)));
  }
  async function forgetTemporaryKey(key: string): Promise<void> {
    const session = temporaryBrowserSessions.get(key);
    if (!session) return;
    temporaryBrowserSessions.delete(key);
    const spec = usedBrowserSessions.get(session);
    usedBrowserSessions.delete(session);
    if (chromeTarget(session, spec)) {
      await chromeEngine.service.close(session);
      return;
    }
    const engine = browserEngineStatus();
    if (engine.kind !== "ready") return;
    const closed = await clearBrowserSessionState(engine.binaryPath, session, {
      env: { PATH: augmentedPath() }, encryptionKey: browserEngineEncryptionKey(),
    });
    if (closed) await browserRuntime.close(session);
    else console.warn(`temporary browser ${session}: could not close its session; run agent-browser --session ${session} close on this server`);
  }
  function myChromeAvailable(): boolean {
    return DESKTOP_MANAGED || browserEngineAttachCdpUrl(cfg) !== null || Boolean(lentChrome?.lender());
  }
  /** A My Chrome profile on My Cloud: the person's lent Chrome, through this session's door. */
  function lentChromeSession(profileId: string | undefined): boolean {
    return !DESKTOP_MANAGED && browserEngineAttachCdpUrl(cfg) === null && doors !== undefined && usesMyChrome(profileId);
  }
  /** Where My Chrome is on My Cloud: the computer that lends it, or that one could. */
  function lentChromeSummary(): { myChromeOn?: ChromeLender; myChromeLendable?: true } {
    const lender = lentChrome?.lender() ?? null;
    if (lender) return { myChromeOn: lender };
    return lentChrome ? { myChromeLendable: true } : {};
  }
  /** On My Cloud a My Chrome profile stays the person's Chrome while no computer lends it: its calls say so, and never
   * fall back to the built-in browser, whose sign-ins differ. */
  function usesMyChrome(profileId: string | undefined): boolean {
    return Boolean(profileId) && (myChromeAvailable() || lentChrome !== undefined)
      && cfg.browserProfiles?.some((profile) => profile.id === profileId && profile.browser === "chrome") === true;
  }
  function browserSessionSpec(binaryPath: string, session: string, profile: string | undefined, egressPort?: number, cdpUrl?: string) {
    const attachCdpUrl = cdpUrl ?? browserEngineAttachCdpUrl(cfg);
    const locale = browserLanguage(process.env, deps.language?.());
    return agentBrowserIntegration({
      binaryPath, session, encryptionKey: browserEngineEncryptionKey(), persistent: profile !== "guest", egressPort,
      env: { ...process.env, PATH: augmentedPath(), ...(locale ? { OMB_BROWSER_LANG: locale } : {}) },
      launcher: chromeLauncher.env(),
      ...(usesMyChrome(profile) ? { attach: attachCdpUrl ? { cdpUrl: attachCdpUrl } : {} } : {}),
    });
  }
  function browserProfileIdOf(profile: string | undefined): string | undefined {
    const target = profile && profile !== "guest" ? browserProfilePartitionTarget(cfg, profile) : null;
    return target?.profileId ?? profile;
  }
  /** The new engine runs a bot's browser when the flag is on, except in the person's own Chrome. */
  function onChrome(profile: string | undefined): boolean {
    return browserEngineKind(cfg) === "chrome" && !usesMyChrome(browserProfileIdOf(profile));
  }
  function chromeSpec(botId: string, profile: string | undefined, audience: Audience): { session: string; spec: ReturnType<ChromeEngine["spec"]> } {
    const suffix = noted(audience);
    const session = sessionFor(botId, profile, suffix);
    const target = profile && profile !== "guest" ? browserProfilePartitionTarget(cfg, profile) : null;
    return { session, spec: chromeEngine.spec(session, profileKey(botId + suffix, session, { guest: profile === "guest", partitionId: target ? target.partitionId + suffix : null })) };
  }
  /** The profile a bot's panel shows as desktop panes, or null when its browser is not one. */
  paneLink?.resolveWith((botId, threadId) => {
    const bot = store.bot(botId);
    if (!bot || bot.browser === false || !browserPaneWanted(cfg) || !onChrome(bot.browserProfile)) return null;
    const { session, spec } = chromeSpec(botId, bot.browserProfile, browserAudience(threadId ?? undefined));
    return chromeTarget(session, spec)?.key ?? null;
  });
  // A person's sign-in import, from their own browsers into a bot's. agent-browser keeps its profiles in its own encrypted
  // saved state, which only its running daemon writes: it takes none, and neither do temporary browsers or My Chrome.
  const cookieScratch = join(DATA_DIR, "browser", "cookie-import");
  // A copy an import left when the server stopped mid-read holds another browser's cookies in plain text.
  if (paneLink) void sweepCookieCopies(cookieScratch);
  paneLink?.answerCookieRequests(cookieRequests({
    files: systemFiles,
    keys: () => keyStoreFor(process.env),
    scratch: cookieScratch,
    destination: (botId, threadId) => {
      const bot = store.bot(botId);
      if (!bot || bot.browser === false || bot.browserProfile === "guest" || !onChrome(bot.browserProfile)) return null;
      const { session, spec } = chromeSpec(botId, bot.browserProfile, browserAudience(threadId ?? undefined));
      const target = chromeTarget(session, spec);
      return target ? chromeEngine.cookieSink(target) : null;
    },
    log: (line) => console.warn(line),
  }));
  /** Chrome for the new engine, the installed agent-browser otherwise. */
  function browserReady(profile: string | undefined): boolean {
    return onChrome(profile) ? chromeEngine.summary().kind === "engine" : browserEngineStatus().kind === "ready";
  }
  function turnIntegration(botId: string, session: string, turn: { threadId: string; generation: string }) {
    const token = mintInternalCapability({ botId, ...turn, browserSession: session,
      kind: "browser", depth: 0, skillAuthoring: false, createdBots: 0, openedThreads: 0 });
    return {
      command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "browser"], env: {
        ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("browser")]: token, OMB_HARNESS_URL: `http://127.0.0.1:${PORT}`,
      },
    };
  }
  async function browserIntegration(botId: string, profile: string | undefined, turn?: { threadId: string; generation: string }, audience = browserAudience(turn?.threadId)) {
    const profileTarget = profile && profile !== "guest" ? browserProfilePartitionTarget(cfg, profile) : null;
    const partitionId = profile === "guest" ? "guest" : (profileTarget?.partitionId ?? "");
    const browserProfileId = profileTarget?.profileId ?? profile;
    if (onChrome(profile)) {
      const { session, spec } = chromeSpec(botId, profile, audience);
      usedBrowserSessions.set(session, spec);
      return { profile: partitionId, session, spec, integration: turn ? turnIntegration(botId, session, turn) : spec };
    }
    const status = browserEngineStatus();
    if (status.kind !== "ready") {
      noteBrowserEngineUnavailable(status);
      return null;
    }
    const session = currentBrowserSession(botId, profile, audience);
    const cdpUrl = lentChromeSession(browserProfileId) ? await lentChromeDoor(session) : undefined;
    const spec = browserSessionSpec(status.binaryPath, session, browserProfileId, usesMyChrome(browserProfileId) ? undefined : await browserEgress.open(session), cdpUrl);
    usedBrowserSessions.set(session, spec);
    await prepareBrowserSessionState(status.binaryPath, session, { env: spec.env, persistent: profile !== "guest" && !attachesToChrome(spec.env), isCurrent: () => {
      const current = store.bot(botId);
      return !!current && current.browser !== false && builtInBrowserEnabled(cfg)
        && currentBrowserSession(current.id, current.browserProfile, audience) === session
        && (!turn || activeInternalGenerationByThread.get(turn.threadId) === turn.generation);
    } });
    if (!turn) return { profile: partitionId, session, spec, integration: spec };
    return { profile: partitionId, session, spec, integration: turnIntegration(botId, session, turn) };
  }
  /** A bot's browser as it runs or would run now, without preparing it; null while its engine is not installed. */
  async function currentBrowserSpec(botId: string, profile: string | undefined, audience: Audience = "team"): Promise<{ session: string; spec: Spec } | null> {
    if (onChrome(profile)) return chromeSpec(botId, profile, audience);
    const engine = browserEngineStatus();
    if (engine.kind !== "ready") return null;
    const session = currentBrowserSession(botId, profile, audience);
    const used = usedBrowserSessions.get(session);
    if (used) return { session, spec: used };
    const profileId = browserProfileIdOf(profile);
    const cdpUrl = lentChromeSession(profileId) ? await lentChromeDoor(session) : undefined;
    return { session, spec: browserSessionSpec(engine.binaryPath, session, profileId, usesMyChrome(profileId) ? undefined : await browserEgress.open(session), cdpUrl) };
  }
  /** fill_login's reads and typing, on whichever engine runs the session. */
  function loginInput(session: string, spec: Spec, env: NodeJS.ProcessEnv): Pick<FillLoginDeps, "engine" | "insertText" | "press" | "click"> {
    if (chromeTarget(session, spec)) {
      const deps = chromeEngine.loginDeps(session);
      if (deps) return deps;
    }
    return { engine: (args) => inRunningBrowser(spec.command, env, args), ...relayInput(spec, session) };
  }
  function browserSystemPrompt(profile: string | undefined): string {
    return onChrome(profile) ? CHROME_BROWSER_SYSTEM_PROMPT : BUILT_IN_BROWSER_SYSTEM_PROMPT;
  }
  /** The signed-in sites list reads agent-browser's saved state, which My Chrome and the new browser do not keep. */
  function signedInSitesRefusal(profile: string | undefined): string | null {
    if (usesMyChrome(profile)) return "This profile uses your own Chrome. Sign in and out of sites there.";
    return onChrome(profile) ? "The new browser does not list signed-in sites yet. Sign out in the browser itself, or turn off New browser in Settings." : null;
  }
  async function closeBrowser(session: string, spec: Spec): Promise<boolean> {
    if (!chromeTarget(session, spec)) return closeBrowserSession(spec.command, browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session }));
    await chromeEngine.service.close(session);
    return true;
  }
  /** After browserEngine.engine changed: viewers reconnect and each bot's next call starts its browser on the engine now chosen. */
  function browserEngineSwitched(): void {
    browserLive.closeAll();
    for (const [session, spec] of usedBrowserSessions) {
      if (attachesToChrome(spec.env)) continue;
      usedBrowserSessions.delete(session);
      void closeBrowser(session, spec).then((closed) => {
        if (!closed) console.warn(`browser ${session}: could not close it after the browser engine changed`);
      });
    }
    if (browserEngineKind(cfg) !== "chrome") void chromeEngine.service.closeAll().catch(() => undefined);
    chromeEngine.start({ inUse: browserEngineKind(cfg) === "chrome", prepare: builtInBrowserEnabled(cfg) });
  }
  function browserRunning(session: string, spec: Spec | undefined): boolean {
    if (chromeTarget(session, spec)) return chromeEngine.service.runs(session);
    return existsSync(browserDaemonFile(browserRuntimeEnv({ ...spec?.env, AGENT_BROWSER_SESSION: session }), ".pid"));
  }
  const browserDaemons = createBrowserDaemons();
  /** Each running agent-browser daemon (its session's pid file) with the bots whose browser it is: one bot's own, or a
   * profile's several bots share. For the per-bot footprint (perf/bot-footprint.ts): one small file read a session. */
  function browserOwners(): Array<{ pid: number; start?: string; session: string; botIds: string[]; kind: "browser" }> {
    return [...usedBrowserSessions].flatMap(([session, spec]) => {
      // A browser attached to the person's own Chrome is theirs, not a bot's.
      if (chromeTarget(session, spec) || attachesToChrome(spec.env)) return [];
      let pid: number;
      try { pid = Number(readFileSync(browserDaemonFile(browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session }), ".pid"), "utf8").trim()); } catch { return []; }
      // Only a pid checked to run this session's daemon (the file may outlive it on a Cloud's volume): browser-daemons.ts.
      const daemon = browserDaemons.owner(spec.command, session, pid);
      if (!daemon) return [];
      const botIds = store.bots.filter((bot) => browserSessionsOf(bot.id, bot.browserProfile).includes(session)).map((bot) => bot.id);
      return [{ ...daemon, session, botIds, kind: "browser" as const }];
    });
  }
  /** Closes the browsers of the conversations whose engine the memory cap stopped (bot-memory-cap.ts), as one stopped for
   * memory is: each conversation's own session, so on a Team Cloud the same bot's browsers for other members stay open;
   * never one on the person's own Chrome, never a profile another bot uses. */
  async function closeCapBrowsers(threadIds: readonly string[]): Promise<void> {
    const sessions = new Map<string, Spec>();
    for (const threadId of threadIds) {
      const browser = threadBrowser(threadId), botId = store.botByThread(threadId)?.id;
      const { session, spec } = browser ?? {};
      if (session === undefined || !spec || chromeTarget(session, spec) || attachesToChrome(spec.env)) continue;
      if (store.bots.some((other) => other.id !== botId && browserSessionsOf(other.id, other.browserProfile).includes(session))) continue;
      sessions.set(session, spec);
    }
    await Promise.all([...sessions].map(([session, spec]) => closeForMemory(session, spec)));
  }
  /** The browser a thread's bot would start; a temporary one has no session until its first call. My Chrome is the person's own. */
  function threadBrowser(threadId: string): { session: string | undefined; spec: Spec | undefined } | null {
    const bot = store.botByThread(threadId);
    if (!bot || bot.browser === false || bot.computer === "off" || !builtInBrowserEnabled(cfg) || usesMyChrome(bot.browserProfile)) return null;
    const audience = browserAudience(threadId);
    const session = bot.browserProfile === "guest" ? temporaryBrowserSessions.get(bot.id + audienceBrowserSuffix(audience)) : currentBrowserSession(bot.id, bot.browserProfile, audience);
    return { session, spec: session === undefined ? undefined : usedBrowserSessions.get(session) };
  }
  /** Tried until no turn holds the browser and no call runs in it, or for 30 s: the stopped turn may still be settling. */
  async function closeForMemory(session: string, spec: Spec): Promise<void> {
    for (let attempt = 0; attempt < 15 && browserRunning(session, spec); attempt++) {
      if (turnResources.free(`browser:${session}`) && await browserRuntime.closeUnused(session, spec)) {
        console.info(`browser ${session}: closed to free memory after its bot was stopped`);
        return;
      }
      await sleep(2_000);
    }
  }
  // Memory relief's early close of unused browsers (host/browser-reclaim.ts): attached and Chrome-engine ones never.
  const browserReclaim = createBrowserReclaim({
    candidates: (busy) => {
      const busySessions = new Set(busy.flatMap((threadId) => threadBrowser(threadId)?.session ?? []));
      return [...usedBrowserSessions].map(([session, spec]) => {
        const working = agentBrowserRuntime.working(session), spare = agentBrowserRuntime.spare(session);
        return { session, held: !turnResources.free(`browser:${session}`), working, running: browserRunning(session, spec),
          attached: Boolean(chromeTarget(session, spec)) || attachesToChrome(spec.env), watched: spare === null && !working, turnRunning: busySessions.has(session),
          savesSignIns: spare?.savesSignIns ?? spec.env.AGENT_BROWSER_RESTORE_SAVE === "auto" };
      });
    },
    close: (session) => { const spec = usedBrowserSessions.get(session); return spec ? browserRuntime.closeUnused(session, spec) : Promise.resolve(false); },
  });
  const engineBrowsers: EngineBrowsers = {
    starts: (threadId) => {
      const browser = threadBrowser(threadId);
      return browser !== null && (browser.session === undefined || !browserRunning(browser.session, browser.spec));
    },
    which: (threadId) => threadBrowser(threadId)?.session,
    running: (threadId) => {
      const browser = threadBrowser(threadId);
      return browser?.session !== undefined && browserRunning(browser.session, browser.spec);
    },
    stopped: (threadId) => {
      const browser = threadBrowser(threadId);
      return browser?.session !== undefined && browser.spec ? closeForMemory(browser.session, browser.spec) : undefined;
    },
    reclaimUnused: (pressure) => browserReclaim.reclaim(pressure),
    anyRunning: () => [...usedBrowserSessions].some(([session, spec]) => browserRunning(session, spec)),
  };
  deps.engineMemory?.useBrowsers(engineBrowsers);
  /** A deleted bot's or profile's browser on the new engine, whatever the flag says now. */
  function eraseChromeBrowser(request: { type: string; botId?: string; partitionId?: string }): Promise<boolean> {
    if (request.type === "openmausbot:browser-bot-deleted" && request.botId) return chromeEngine.erase({ kind: "bot", id: request.botId, partitionId: "" });
    if (request.partitionId) return chromeEngine.erase({ kind: "profile", id: request.partitionId, partitionId: request.partitionId });
    return Promise.resolve(true);
  }
  /**
   * The agent-browser whose saved sessions a deletion erases: the one OpenMausBot installed, or on a Cloud home the
   * image's own. Another one on PATH may be a wrapper whose failing close would hold the cleanup journal forever, so
   * it only closes the running browser.
   */
  function cleanupEngine(): { binaryPath: string } | null {
    const managed = browserEngineStatus({ managedOnly: true });
    if (managed.kind === "ready") return managed;
    const used = browserEngineStatus();
    return CLOUD_HOME && used.kind === "ready" ? used : null;
  }
  /** A deleted bot's or profile's browser on both engines, for every audience: stopped and its saved sign-ins erased;
   * true once that is done. */
  async function eraseDeletedBrowser(request: BrowserCleanupWireRequest): Promise<boolean> {
    const results = await Promise.all(audiences.variants().map((suffix) => eraseOneBrowser({
      ...request, ...(request.botId ? { botId: request.botId + suffix } : {}), ...(request.partitionId ? { partitionId: request.partitionId + suffix } : {}),
    })));
    return results.every(Boolean);
  }
  async function eraseOneBrowser(request: BrowserCleanupWireRequest): Promise<boolean> {
    const session = request.type === "openmausbot:browser-bot-deleted" && request.botId ? browserSessionId(request.botId, "")
      : request.partitionId ? browserSessionId("", request.partitionId) : null;
    const engine = cleanupEngine();
    const erased = async (name: string) => {
      if (!engine) {
        const used = browserEngineStatus();
        if (used.kind === "ready") void closeBrowserSession(used.binaryPath, browserRuntimeEnv({ AGENT_BROWSER_SESSION: name }));
        return true;
      }
      const ok = await clearBrowserSessionState(engine.binaryPath, name, { encryptionKey: browserEngineEncryptionKey() });
      if (!ok) console.warn(`browser cleanup: could not clear saved state for session ${name}; restart OpenMausBot to retry this profile's cleanup. Do not use state clear --all: it erases other profiles too.`);
      return ok;
    };
    const results = await Promise.all([eraseChromeBrowser(request), ...session ? [erased(session)] : []]);
    return results.every(Boolean);
  }
  /** A person who left a Team Cloud: their own browser of every bot and every shared profile, stopped and its saved
   * sign-ins and profile folder erased. True once that is done. */
  async function eraseAudienceBrowsers(audience: Audience): Promise<boolean> {
    const suffix = audienceBrowserSuffix(audience);
    if (!suffix || !audiences.variants().includes(suffix)) return true;
    const requests: BrowserCleanupWireRequest[] = [
      ...store.bots.map((bot) => ({ type: "openmausbot:browser-bot-deleted" as const, requestId: "team-member-left", botId: bot.id + suffix })),
      ...(cfg.browserProfiles ?? []).filter((profile) => !usesMyChrome(profile.id)).map((profile) => ({
        type: "openmausbot:browser-profile-deleted" as const, requestId: "team-member-left", partitionId: browserProfilePartitionId(profile) + suffix })),
    ];
    return (await Promise.all(requests.map((request) => eraseOneBrowser(request)))).every(Boolean);
  }
  /** Chrome receives private copies; a boxed agent-browser reads them from its own profile's folder. */
  function uploadPaths(files: ReadonlyArray<{ file: string; name: string | null }>, session: string, spec: Spec): Promise<string[]> {
    const chrome = chromeTarget(session, spec);
    const folder = boxed && !chrome ? join(browserProfileDirectory(session), "omb-uploads") : join(DATA_DIR, "browser-uploads");
    return namedUploadPaths(files, folder, Date.now(), { everyFile: boxed || Boolean(chrome) });
  }
  /** The saved sign-ins of a bot's or a shared profile's browser, for one audience. */
  async function signedInSitesTarget(which: BrowserSitesRef, audience: Audience = "team"): Promise<BrowserSitesTarget | { status: number; error: string }> {
    const engine = browserEngineStatus();
    if (engine.kind !== "ready") return { status: 409, error: engine.reason };
    let session: string;
    let profile: string | undefined;
    if ("profile" in which) {
      const target = browserProfilePartitionTarget(cfg, which.profile);
      if (!target) return { status: 404, error: "This browser profile was removed." };
      session = browserSessionId("", target.partitionId + noted(audience));
      profile = target.profileId;
    } else {
      const bot = store.bot(which.bot);
      if (!bot) return { status: 404, error: "no such bot" };
      if (bot.browserProfile === "guest") return { status: 409, error: "A temporary browser saves no sign-ins." };
      session = currentBrowserSession(bot.id, bot.browserProfile, audience);
      profile = bot.browserProfile;
    }
    const refusal = signedInSitesRefusal(profile);
    if (refusal) return { status: 409, error: refusal };
    return { binaryPath: engine.binaryPath, session, env: browserSessionSpec(engine.binaryPath, session, profile, await browserEgress.open(session)).env, encryptionKey: browserEngineEncryptionKey() };
  }
  /** What Settings shows of the engine that runs bots' browsers here; My Chrome stays on agent-browser. */
  function engineSummary<T extends { kind: "engine" | "unavailable"; myChrome: boolean }>(agentBrowser: T): (T | (ReturnType<ChromeEngine["summary"]> & { myChrome: boolean })) & { engine: BrowserEngineKind; pane?: true; cookieImport?: true; noChrome?: true; serverSites?: boolean; proxyConfigured?: boolean; proxySaved?: boolean } {
    const serverSites = sitesSwitch ? { serverSites: cfg.browserEngine?.egress?.localNetwork === true } : {};
    const engine = browserEngineKind(cfg);
    const proxyValue = cfg.browserEngine?.egress?.proxy;
    const proxySaved = typeof proxyValue === "string" && proxyValue.trim().length > 0;
    const proxyConfigured = builtInBrowserEnabled(cfg) && !hostedServer && parseSocks5Proxy(proxyValue) !== null;
    return {
      ...(engine === "chrome" ? { ...chromeEngine.summary(), myChrome: agentBrowser.myChrome, ...lentChromeSummary(), engine } : { ...agentBrowser, engine }),
      ...(paneLink?.available && browserPaneWanted(cfg) ? { pane: true as const } : {}),
      ...(paneLink?.available && engine === "chrome" ? { cookieImport: true as const } : {}),
      ...(engine !== "chrome" && agentBrowser.kind === "engine" && chromeLauncher.runsShellForWantOfChrome() ? { noChrome: true as const } : {}),
      ...serverSites,
      ...(proxyConfigured ? { proxyConfigured: true } : {}),
      ...(proxySaved ? { proxySaved: true } : {}),
    };
  }

  return {
    browserRuntime, browserLive, browserRoom, usedBrowserSessions, browserSweep, temporaryBrowserSessions, browserIdleMs: idleMs,
    currentBrowserSession, forgetTemporaryBrowser, myChromeAvailable, lentChromeSummary, usesMyChrome, browserSessionSpec, browserIntegration,
    browserReady, currentBrowserSpec, loginInput, browserSystemPrompt, signedInSitesRefusal, closeBrowser, browserEngineSwitched,
    eraseDeletedBrowser, engineSummary, engineBrowsers, browserAudience, browserSessionsOf, signedInSitesTarget, uploadPaths,
    eraseAudienceBrowsers, browserOwners, closeCapBrowsers,
  };
}
