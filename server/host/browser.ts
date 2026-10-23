// The bots' browser as the server hosts it: the engine's runtime and live view, which session a bot's browser is, and
// the integration a turn mounts. browserEngine.engine picks agent-browser (the default) or the new Chrome engine; a
// person's own Chrome (My Chrome) stays on agent-browser either way.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { Audience } from "../audience.ts";
import type { AppConfig } from "../config.ts";
import { browserEngineAttachCdpUrl, browserProfilePartitionId, browserProfilePartitionTarget, builtInBrowserEnabled, DATA_DIR } from "../config.ts";
import { BrowserRuntime, TransportError, attachesToChrome, browserRuntimeEnv, formatBrowserTiming } from "../browser-runtime.ts";
import { RelayTimeout, relay, relayCommand, relayInput } from "../browser-relay.ts";
import { browserSteps } from "../browser-steps.ts";
import { BrowserLive } from "../browser-live.ts";
import { browserEgress, type EgressSetup } from "../browser/egress/registry.ts";
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
import { BrowserSweep, browserIdleMs, type BrowserCleanupWireRequest } from "../browser-lifecycle-cleanup.ts";
import { AudienceBrowsers, audienceBrowserSuffix } from "../browser/audience.ts";
import type { BrowserSitesTarget } from "../browser-sites.ts";
import { namedUploadPaths } from "../browser-upload.ts";
import type { BrowserSitesRef } from "../routes/browser-sites.ts";
import { chromeLauncher } from "../browser/chrome/launcher.ts";
import { LAUNCHER_SECCOMP_FD, type LauncherBox } from "../browser/chrome/wrapper.ts";
import type { HostKind } from "../browser/chrome/flags.ts";
import { browserEngineKind, type BrowserEngineKind } from "../browser/config.ts";
import { ChromeEngine, chromeTarget, LiveRouter, profileKey, RuntimeRouter } from "../browser/engines.ts";
import { CHROME_BROWSER_SYSTEM_PROMPT } from "../browser/prompt.ts";
import { passkeyAnnotation } from "../browser/passkey-notice.ts";
import type { EngineBrowsers } from "../engine-memory.ts";
import { augmentedPath } from "../env-path.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import type { FillLoginDeps } from "../login-fill.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { Store } from "../store.ts";
import type { TurnOwner, TurnResources } from "../turn-resources.ts";

export interface BrowserHostDeps {
  cfg: AppConfig;
  /** The store is built after this host, so it is read when used. */
  store(): Pick<Store, "bots" | "bot" | "botByThread">;
  turnResources: Pick<TurnResources, "free" | "holder">;
  activeInternalGenerationByThread: ReadonlyMap<string, string>;
  mintInternalCapability(capability: {
    botId: string; threadId: string; generation: string; browserSession: string; kind: "browser";
    depth: number; skillAuthoring: boolean; createdBots: number; openedThreads: number;
  }): string;
  DESKTOP_MANAGED: boolean;
  CLOUD_HOME: unknown;
  PORT: number;
  /** A Cloud home's way out through the person's own lent computer. */
  device?: EgressSetup["device"];
  /** Whether a turn may use the person's lent computer (cloud-lending.ts). Without it, no browser a turn holds may. */
  mayLend?(turn: TurnOwner): boolean;
  /** The engine memory guard, told which browsers each thread's turn starts or holds. */
  engineMemory?: { useBrowsers(browsers: EngineBrowsers): void };
  /** Whose browser a conversation's turns use on a Team Cloud: the member's, the group chat's or the team's. Every
   * browser is the bot's own without it. */
  audienceOf?(threadId: string): Audience;
  /** The box every Chrome of the bots' browsers runs in (a Team Cloud's), or none. */
  browserBox?(seccompFd: number, ro: readonly string[]): LauncherBox | null;
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
const BOT_SESSION = /^bot-[A-Za-z0-9_.-]+$/;

export function createBrowserHost(deps: BrowserHostDeps) {
  const { cfg, turnResources, activeInternalGenerationByThread, mintInternalCapability, DESKTOP_MANAGED, CLOUD_HOME, PORT } = deps;
  const store: Pick<Store, "bots" | "bot" | "botByThread"> = { get bots() { return deps.store().bots; }, bot: (id: string) => deps.store().bot(id),
    botByThread: (threadId: string) => deps.store().botByThread(threadId) };

  const agentBrowserRuntime = new BrowserRuntime({
    closeBrowser: (session, spec) => closeBrowserSession(spec.command, browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session })),
    applyViewport: (spec) => setBrowserViewport(spec.command, spec.env),
    launch: chromeLauncher,
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
  const idleMs = () => browserIdleMs(cfg, { cloudHome: Boolean(CLOUD_HOME) });
  const chromeEngine = new ChromeEngine({
    dataDir: DATA_DIR,
    host,
    egressPort: (key) => browserEgress.open(key),
    egressNotice: (key) => browserEgress.takeNotice(key),
    idleMs,
    log: (line) => console.warn(line),
  });
  // A tool call that would open Reddit from MausBot Cloud is refused before it reaches the browser. My Chrome is the
  // person's own, outside the egress gate too.
  const browserRuntime = new RuntimeRouter(agentBrowserRuntime, chromeEngine, {
    refusal: (spec, params) => (attachesToChrome(spec.env) ? null : browserEgress.callRefusal(params)),
    annotate: passkeyAnnotation(CLOUD_HOME ? "cloud" : DESKTOP_MANAGED ? "desktop" : "server"),
  });
  const browserLive = new LiveRouter(agentBrowserLive, chromeEngine);
  const usedBrowserSessions = new Map<string, Spec>();
  const audiences = new AudienceBrowsers(join(DATA_DIR, "browser", "audiences.json"));
  const browserAudience = (threadId: string | undefined): Audience => (threadId && deps.audienceOf ? deps.audienceOf(threadId) : "team");
  const device = deps.device && lentDevice(deps.device, (session) => turnResources.holder(`browser:${session}`), deps.mayLend ?? (() => false));
  browserEgress.configure({ host: DESKTOP_MANAGED ? "desktop" : CLOUD_HOME ? "cloud" : "server", config: () => cfg.browserEngine?.egress, ...(device ? { device } : {}) });
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
  const browserSweep = {
    start() {
      agentBrowserSweep.start();
      chromeEngine.start({ inUse: browserEngineKind(cfg) === "chrome", prepare: builtInBrowserEnabled(cfg) });
      return browserSweep;
    },
    closeAll: () => agentBrowserSweep.closeAll(),
  };
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
    return DESKTOP_MANAGED || browserEngineAttachCdpUrl(cfg) !== null;
  }
  function usesMyChrome(profileId: string | undefined): boolean {
    return Boolean(profileId) && myChromeAvailable()
      && cfg.browserProfiles?.some((profile) => profile.id === profileId && profile.browser === "chrome") === true;
  }
  function browserSessionSpec(binaryPath: string, session: string, profile: string | undefined, egressPort?: number) {
    const attachCdpUrl = browserEngineAttachCdpUrl(cfg);
    return agentBrowserIntegration({
      binaryPath, session, encryptionKey: browserEngineEncryptionKey(), persistent: profile !== "guest", egressPort,
      env: { ...process.env, PATH: augmentedPath() },
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
    const spec = browserSessionSpec(status.binaryPath, session, browserProfileId, usesMyChrome(browserProfileId) ? undefined : await browserEgress.open(session));
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
    return { session, spec: usedBrowserSessions.get(session) ?? browserSessionSpec(engine.binaryPath, session, browserProfileIdOf(profile), await browserEgress.open(session)) };
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
  const engineBrowsers: EngineBrowsers = {
    starts: (threadId) => {
      const browser = threadBrowser(threadId);
      return browser !== null && (browser.session === undefined || !browserRunning(browser.session, browser.spec));
    },
    stopped: (threadId) => {
      const browser = threadBrowser(threadId);
      if (browser?.session !== undefined && browser.spec) void closeForMemory(browser.session, browser.spec);
    },
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
  /** Where a page's file input finds the files a turn uploads: a boxed Chrome sees only its own profile's folder. */
  function uploadPaths(files: ReadonlyArray<{ file: string; name: string | null }>, session: string, spec: Spec): string[] {
    if (!boxed || chromeTarget(session, spec)) return namedUploadPaths(files, join(DATA_DIR, "browser-uploads"));
    return namedUploadPaths(files, join(browserProfileDirectory(session), "omb-uploads"), Date.now(), { everyFile: true });
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
  function engineSummary<T extends { myChrome: boolean }>(agentBrowser: T): (T | (ReturnType<ChromeEngine["summary"]> & { myChrome: boolean })) & { engine: BrowserEngineKind } {
    if (browserEngineKind(cfg) !== "chrome") return { ...agentBrowser, engine: "agent-browser" };
    return { ...chromeEngine.summary(), myChrome: agentBrowser.myChrome, engine: "chrome" };
  }

  return {
    browserRuntime, browserLive, usedBrowserSessions, browserSweep, temporaryBrowserSessions, browserIdleMs: idleMs,
    currentBrowserSession, forgetTemporaryBrowser, myChromeAvailable, usesMyChrome, browserSessionSpec, browserIntegration,
    browserReady, currentBrowserSpec, loginInput, browserSystemPrompt, signedInSitesRefusal, closeBrowser, browserEngineSwitched,
    eraseDeletedBrowser, engineSummary, engineBrowsers, browserAudience, browserSessionsOf, signedInSitesTarget, uploadPaths,
    eraseAudienceBrowsers,
  };
}
