// The provider/turn integrations — extracted verbatim from index.ts: the
// direct-turn dispatch registry (retired provider turns, cancelled-provider
// handshake quarantines, staged generated images, the dispatch-claim phase
// helpers), the browser runtime with its live viewer bridge and temporary
// guest sessions, the per-turn browser/phone/connected-apps integration
// builders, and the computer-control record the proxies poll over loopback.
// index.ts wires createTurnIntegrations just before createDelegationWatch,
// the earliest module-level by-value consumer (retireProviderTurn); every
// dep index.ts declares after that site — broadcast, the deferred-resume
// canceller, the computer-lifecycle helper, and the browser-engine install
// lets the install endpoint owns — is passed as a thunk and called as dep().
import { z } from "zod";
import { deleteAttachment } from "./attachments.ts";
import {
  agentBrowserIntegration,
  browserEngineEncryptionKey,
  browserEngineStatus,
  browserSessionId,
  clearBrowserSessionState,
  describeBrowserEngine,
  prepareBrowserSessionState,
} from "./browser-engine.ts";
import { BrowserLive } from "./browser-live.ts";
import { BrowserRuntime } from "./browser-runtime.ts";
import type { LocalVmTarget } from "./container-computer.ts";
import { browserEngineAttachCdpUrl, browserProfilePartitionTarget, builtInBrowserEnabled } from "./config.ts";
import * as composio from "./composio.ts";
import { ComputerControl } from "./computer-control.ts";
import { augmentedPath } from "./env-path.ts";
import { activeInternalGenerationByThread, mintInternalCapability } from "./internal-capabilities.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { cfg, store, teamComputerTurns } from "./runtime.ts";
import type { RuntimeEvent } from "./contracts.ts";
import type { BotRecord, Message } from "./store.ts";
import type { TeamComputerRecord } from "./team-computers.ts";
import { directTurnDispatchClaims, threadBusy, type DirectTurnDispatchClaim } from "./turn-admission.ts";
import { PendingTurnCancellations, RetiredTurnRegistry, isTurnEventQuarantined } from "./turn-dispatch-guard.ts";

/** Everything the integrations read from their host. The lateBound family
 * holds wrapper thunks for the functions/lets index.ts declares after the
 * factory is wired (broadcast and cancelTeamSetupResumesForThread come from
 * further down index.ts, inheritedTeamComputer from createComputerLifecycle
 * just below the wiring site, and the install lets stay with the endpoint
 * that writes them); helpers are hoisted index.ts functions, safe to pass
 * by value; constants are consts declared above the wiring site. */
export interface TurnIntegrationsDeps {
  lateBound: {
    broadcast(payload: Record<string, unknown>): void;
    cancelTeamSetupResumesForThread(threadId: string): void;
    inheritedTeamComputer(bot: Pick<BotRecord, "section" | "computer" | "cloudBackend">): TeamComputerRecord | undefined;
    browserEngineInstall(): Promise<void> | null;
    // null maps to undefined at the wiring site: the summary's spread only
    // reads this when truthy, so the key is absent exactly as before.
    browserEngineInstallError(): string | undefined;
  };
  helpers: {
    postDesktopPrivateMessage(message: { type: "openmausbot:browser-control"; botId: string; held: true }): boolean;
  };
  constants: {
    PORT: number;
    AGENTS_NODE_FLAG: { ELECTRON_RUN_AS_NODE: string };
    phoneProxyPath: string;
  };
}

export function createTurnIntegrations(deps: TurnIntegrationsDeps) {
  const { broadcast, cancelTeamSetupResumesForThread, inheritedTeamComputer } = deps.lateBound;
  const browserEngineInstall = () => deps.lateBound.browserEngineInstall();
  const browserEngineInstallError = () => deps.lateBound.browserEngineInstallError();
  const { postDesktopPrivateMessage } = deps.helpers;
  const { PORT, AGENTS_NODE_FLAG, phoneProxyPath } = deps.constants;

const retiredProviderTurns = new RetiredTurnRegistry();
const pendingCancelledProviderHandshakes = new PendingTurnCancellations();
const generatedImagesByTurn = new Map<
  string,
  Array<NonNullable<Message["attachments"]>[number]>
>();

function generatedImageTurnKey(threadId: string, turnId?: string): string {
  return `${threadId}:${turnId ?? "active"}`;
}

function purgeGeneratedImagesForThread(threadId: string): void {
  for (const [key, attachments] of generatedImagesByTurn) {
    if (!key.startsWith(`${threadId}:`)) continue;
    generatedImagesByTurn.delete(key);
    for (const attachment of attachments) {
      deleteAttachment(attachment.path);
    }
  }
}

function markCancelledProviderHandshake(threadId: string, ownerId: string): void {
  pendingCancelledProviderHandshakes.mark(threadId, ownerId);
}

function clearCancelledProviderHandshake(threadId: string, ownerId: string): void {
  pendingCancelledProviderHandshakes.clear(threadId, ownerId);
}

function retireProviderTurn(turnId: string): void {
  retiredProviderTurns.retire(turnId);
  // A stopped/replaced turn is never folded again. Delete only image files
  // that were staged for that exact provider turn so unattached output does
  // not accumulate invisibly on disk.
  for (const [key, attachments] of generatedImagesByTurn) {
    if (!key.endsWith(`:${turnId}`)) continue;
    generatedImagesByTurn.delete(key);
    for (const attachment of attachments) {
      deleteAttachment(attachment.path);
    }
  }
}

function shouldIgnoreProviderEvent(event: RuntimeEvent): boolean {
  // Some adapters publish completion/error synchronously just before their
  // sendTurn promise resolves. Stop can already have cancelled that handshake,
  // but its returned turn id is not available to retire yet. Quarantine the
  // narrow pre-id window and tombstone any id it reveals; the broad gate is
  // time-bounded so a broken promise cannot suppress a later turn forever.
  if (isTurnEventQuarantined(pendingCancelledProviderHandshakes, retiredProviderTurns, event)) return true;
  if (event.type !== "session.exited" || event.turnId !== undefined) return false;
  const bot = store.botByThread(event.threadId);
  return Boolean(bot && threadBusy(bot.id, event.threadId)) || Boolean(store.groupByThread(event.threadId)?.busyBotId);
}

function directTurnClaimIsCurrent(botId: string, claimId: string, threadId: string): boolean {
  const claim = directTurnDispatchClaims.get(threadId);
  return claim?.id === claimId && claim.botId === botId && store.taskByThread(botId, threadId)?.busy === true;
}

function directTurnClaimExists(botId: string, claimId: string, threadId: string): boolean {
  const claim = directTurnDispatchClaims.get(threadId);
  return claim?.id === claimId && claim.botId === botId;
}

function markDirectTurnDispatching(botId: string, claimId: string, threadId: string): boolean {
  if (!directTurnClaimIsCurrent(botId, claimId, threadId)) return false;
  directTurnDispatchClaims.set(threadId, { id: claimId, botId, threadId, phase: "dispatching" });
  return true;
}

function clearDirectTurnDispatch(threadId: string, claimId: string): void {
  if (directTurnDispatchClaims.get(threadId)?.id === claimId) directTurnDispatchClaims.delete(threadId);
}

function cancelDirectTurnDispatch(botId: string, expectedThreadId?: string): DirectTurnDispatchClaim | null {
  const threadId = expectedThreadId ?? store.bot(botId)?.threadId;
  if (!threadId) return null;
  cancelTeamSetupResumesForThread(threadId);
  const claim = directTurnDispatchClaims.get(threadId);
  if (!claim || claim.botId !== botId) return null;
  directTurnDispatchClaims.delete(threadId);
  // Setup has not called the adapter yet, so there is no provider handshake
  // (and no unknown turn id) to quarantine. Dispatching is the only phase in
  // which a late provider event can exist.
  if (claim.phase === "dispatching") {
    markCancelledProviderHandshake(claim.threadId, `direct:${claim.id}`);
  }
  // Keep setup ownership until the guarded send resolves and retires its
  // provider turn id. Some adapters can emit completion synchronously just
  // before sendTurn returns; making the bot idle here would let a replacement
  // start early enough for those old events to settle the replacement.
  return claim;
}

/** The bot's browser for this turn: agent-browser, one isolated session per
 * browser profile or per bot (docs/plans/browser-engine.md). Null, with the
 * reason logged once, when the engine is not on this machine. */
const browserRuntime = new BrowserRuntime();
const browserLive = new BrowserLive({ runtime: browserRuntime });
// Temporary profiles last for this server run, but are never saved to disk.
// The viewer and the agent must address the SAME temporary browser.
const temporaryBrowserSessions = new Map<string, string>();
function currentBrowserSession(botId: string, profile: string | undefined): string {
  if (profile === "guest") {
    let session = temporaryBrowserSessions.get(botId);
    if (!session) {
      session = browserSessionId(botId, "guest");
      temporaryBrowserSessions.set(botId, session);
    }
    return session;
  }
  const target = profile ? browserProfilePartitionTarget(cfg, profile) : null;
  return browserSessionId(botId, target?.partitionId ?? "");
}
async function forgetTemporaryBrowser(botId: string): Promise<void> {
  const session = temporaryBrowserSessions.get(botId);
  if (!session) return;
  temporaryBrowserSessions.delete(botId);
  const engine = browserEngineStatus();
  if (engine.kind !== "ready") return;
  const closed = await clearBrowserSessionState(engine.binaryPath, session, {
    env: { PATH: augmentedPath() }, encryptionKey: browserEngineEncryptionKey(),
  });
  if (closed) await browserRuntime.close(session);
  else console.warn(`temporary browser ${session}: could not close its session; run agent-browser --session ${session} close on this server`);
}
async function browserIntegration(botId: string, profile: string | undefined, turn?: { threadId: string; generation: string }) {
  const status = browserEngineStatus();
  if (status.kind !== "ready") {
    if (!engineUnavailableLogged) {
      engineUnavailableLogged = true;
      console.warn(`${describeBrowserEngine(status)}; bots get no browser tools until it is installed`);
    }
    return null;
  }
  // A profile that no longer exists falls back to the bot's own session.
  const profileTarget = profile && profile !== "guest" ? browserProfilePartitionTarget(cfg, profile) : null;
  const partitionId = profile === "guest" ? "guest" : (profileTarget?.partitionId ?? "");
  const session = currentBrowserSession(botId, profile);
  const spec = agentBrowserIntegration({
      binaryPath: status.binaryPath,
      session,
      encryptionKey: browserEngineEncryptionKey(),
      persistent: profile !== "guest",
      env: { ...process.env, PATH: augmentedPath() },
      attachCdpUrl: browserEngineAttachCdpUrl(cfg) ?? undefined,
    });
  await prepareBrowserSessionState(status.binaryPath, session, { env: spec.env, persistent: profile !== "guest", isCurrent: () => {
    const current = store.bot(botId);
    return !!current && current.browser !== false && builtInBrowserEnabled(cfg)
      && currentBrowserSession(current.id, current.browserProfile) === session
      && (!turn || activeInternalGenerationByThread.get(turn.threadId) === turn.generation);
  } });
  if (!turn) return { profile: partitionId, session, spec, integration: spec };
  const token = mintInternalCapability({ botId, ...turn, browserSession: session,
    kind: "browser", depth: 0, skillAuthoring: false, createdBots: 0, openedThreads: 0 });
  return { profile: partitionId, session, spec, integration: {
    command: process.execPath, args: [SPAWNED_PROXIES.browser], env: {
      ...AGENTS_NODE_FLAG, OMB_BROWSER_TOKEN: token, OMB_HARNESS_URL: `http://127.0.0.1:${PORT}`,
    },
  } };
}
let engineUnavailableLogged = false;

function browserEngineSummary(): { kind: "engine" | "unavailable"; reason?: string; installable?: boolean; version?: string; installing?: boolean; installError?: string } {
  const status = browserEngineStatus();
  const progress = { ...(browserEngineInstall() ? { installing: true } : {}), ...(browserEngineInstallError() ? { installError: browserEngineInstallError() } : {}) };
  return status.kind === "ready"
    ? { kind: "engine", version: status.version, ...progress }
    : { kind: "unavailable", reason: status.reason, installable: status.installable, ...progress };
}

function phoneIntegration() {
  const env: Record<string, string> = { ...AGENTS_NODE_FLAG };
  if (process.env.OMB_ADB_PATH) env.OMB_ADB_PATH = process.env.OMB_ADB_PATH;
  if (process.env.OMB_RESOURCES_PATH) env.OMB_RESOURCES_PATH = process.env.OMB_RESOURCES_PATH;
  if (process.env.PH_ANDROID_SERIAL) env.PH_ANDROID_SERIAL = process.env.PH_ANDROID_SERIAL;
  return { command: process.execPath, args: [phoneProxyPath], env };
}

function connectedAppsIntegration(botId: string, threadId: string, generation: string) {
  const token = mintInternalCapability({
    botId,
    threadId,
    generation,
    depth: 0,
    kind: "connectors",
    skillAuthoring: false,
    createdBots: 0,
    openedThreads: 0,
  });
  return composio.mcpIntegration(cfg, {
    harnessUrl: `http://127.0.0.1:${PORT}`,
    commsToken: token,
    botId,
    threadId,
  });
}

// ── computer control (who is driving) ──────────────────────────────────
// The person can take the wheel of a bot's computer from the panel; while
// they hold it, the bot's computer proxies refuse every action. The record
// lives here; the proxies consult it over loopback with the boot token.
const computerControlRevision = new Map<string, number>();
const computerControl = new ComputerControl((key, snapshot) => {
  const members = key.startsWith("computer_")
    ? store.bots.filter(bot => inheritedTeamComputer(bot)?.id === key.slice("computer_".length)).map(bot => bot.id)
    : [key];
  for (const botId of members) {
  computerControlRevision.set(botId, (computerControlRevision.get(botId) ?? 0) + 1);
  // One-way, fail-closed mirror into the Electron process that owns the
  // native browser. Never send release: a loopback caller can influence the
  // server record, while only the trusted Browser panel may clear Electron's
  // local gate after its server-first release succeeds.
  if (snapshot.held && /^[A-Za-z0-9_-]{1,120}$/.test(botId)) {
    postDesktopPrivateMessage({ type: "openmausbot:browser-control", botId, held: true });
  }
  broadcast({ kind: "computer-control", botId, held: snapshot.held, helpReason: snapshot.helpReason });
  }
});
const controlLeaseIdSchema = z.string().min(16).max(120).regex(/^[A-Za-z0-9_-]+$/);

/** The loopback endpoint a bot's computer proxy polls before acting. */
function controlIntegration(botId: string, threadId: string, generation: string, localVmTarget?: LocalVmTarget) {
  return {
    url: `http://127.0.0.1:${PORT}/api/internal/computer-control?botId=${encodeURIComponent(botId)}`,
    token: mintInternalCapability({
      botId,
      threadId,
      generation,
      depth: 0,
      kind: "computer",
      ...(localVmTarget ? { localVmTarget } : {}),
      ...(teamComputerTurns.get(threadId) ? { teamComputerId: teamComputerTurns.get(threadId)!.computerId } : {}),
      skillAuthoring: false,
      createdBots: 0,
      openedThreads: 0,
    }),
  };
}

  return {
    retiredProviderTurns, pendingCancelledProviderHandshakes, generatedImagesByTurn,
    generatedImageTurnKey, purgeGeneratedImagesForThread,
    markCancelledProviderHandshake, clearCancelledProviderHandshake,
    retireProviderTurn, shouldIgnoreProviderEvent,
    directTurnClaimIsCurrent, directTurnClaimExists, markDirectTurnDispatching,
    clearDirectTurnDispatch, cancelDirectTurnDispatch,
    browserRuntime, browserLive, temporaryBrowserSessions,
    currentBrowserSession, forgetTemporaryBrowser, browserIntegration,
    browserEngineSummary, phoneIntegration, connectedAppsIntegration,
    computerControlRevision, computerControl, controlLeaseIdSchema, controlIntegration,
  };
}
