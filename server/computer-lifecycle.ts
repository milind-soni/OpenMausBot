// The computer/VM lifecycle — extracted verbatim from index.ts: the local-VM
// lease/idle/thread registries and seen-set, the Box/VPS provider busy-sets
// with their claim lanes, team-computer control accounting and payload, the
// turn surface/provider/instance resolution helpers, and the preview and
// selection readers over all of it. index.ts wires createComputerLifecycle
// just before createScreenPollers, the earliest module-level by-value
// consumer (botComputerControlSnapshot); every dep index.ts declares after
// that site is passed as a thunk and called as dep().
import * as box from "./box.ts";
import * as vps from "./vps-computer.ts";
import type { AutoVmClaimTable } from "./auto-vm-claims.ts";
import { boxCreateRecoverySnapshot } from "./box-create-idempotency.ts";
import { boxDeletionSnapshot } from "./box-delete-journal.ts";
import { browserEngineStatus } from "./browser-engine.ts";
import { computerBackendFor } from "./computer-backend.ts";
import type { ComputerControl } from "./computer-control.ts";
import {
  autoLocalVmAttachable,
  containerComputerAction,
  containerComputerStatus,
  containerRuntimeStatus,
  perBotLocalVmTarget,
  SHARED_LOCAL_VM_TARGET,
  type ContainerComputerStatus,
  type LocalVmTarget,
} from "./container-computer.ts";
import { builtInBrowserEnabled, localVmMaxInstances, localVmMode } from "./config.ts";
import { computerSelectionTurns } from "./internal-capabilities.ts";
import { discoverExistingPerBotLocalVms, localVmInventoryEntry } from "./local-vm-inventory.ts";
import { LocalVmIdleTimer } from "./local-vm-idle.ts";
import { LocalVmLease, LocalVmLeasePool } from "./local-vm-lease.ts";
import { readCuaConnection } from "./local-computer.ts";
import { shouldMountLocalComputer } from "./local-routing.ts";
import { cfg, registry, store, teamComputerTurns } from "./runtime.ts";
import { queuedThreadPosition } from "./steer-queue.ts";
import { teamComputerOwner, type TeamComputers, type TeamComputerRecord } from "./team-computers.ts";
import { directTurnBots, hasDirectDispatch, threadBusy, turnResourceOwners, turnResources } from "./turn-admission.ts";
import { resolveSurface, surfaceLabel } from "./surface.ts";
import type { RoutineManager, RoutineRunOn } from "./routines.ts";
import type { TurnOwner } from "./turn-resources.ts";
import { sectionKey, type BotRecord, type GroupRecord, type Message } from "./store.ts";
import type { TeamComputersPayload } from "../shared/team-computer.ts";

/** The remote computer providers whose settings transitions gate lifecycle work. */
export type RemoteComputerProvider = "box" | "vps";

/** Everything the lifecycle reads from its host. The lateBound family holds
 * thunks for the consts/lets index.ts declares after the factory is wired;
 * helpers are hoisted function declarations, safe to pass by value. */
export interface ComputerLifecycleDeps {
  lateBound: {
    routines(): RoutineManager | null;
    computerControl(): ComputerControl;
    teamComputers(): TeamComputers;
    autoVmClaims(): AutoVmClaimTable;
    localVmImageBusy(): boolean;
    startTurn(botId: string, text: string, opts?: { threadId?: string; userMessage?: Message; computerSelectionContinuation?: boolean }): Promise<unknown>;
  };
  helpers: {
    bindTurnComputer(owner: TurnOwner, resource: string, exclusive?: boolean): Promise<void>;
    controlIntegration(botId: string, threadId: string, generation: string, localVmTarget?: LocalVmTarget): { url: string; token: string };
    activeGroupTurnForBot(botId: string): { group: GroupRecord; threadId: string } | null;
  };
  state: {
    directTurnGenerationByThread: Map<string, string>;
  };
}

export function createComputerLifecycle(deps: ComputerLifecycleDeps) {
  const { routines, computerControl, teamComputers, autoVmClaims, localVmImageBusy, startTurn } = deps.lateBound;
  const { bindTurnComputer, controlIntegration, activeGroupTurnForBot } = deps.helpers;
  const { directTurnGenerationByThread } = deps.state;
const localVmOwnerBusy = (botId: string) => store.bot(botId)?.busy === true;
const localVmLeases = new LocalVmLeasePool(30 * 60_000);
const localVmLifecycleBusy = new Set<string>();
const localVmThreadTargets = new Map<string, LocalVmTarget>();
const localVmActiveThreads = new Map<string, string>();
/** Local VM targets this process has seen ready or recreatable — at boot, in
 * the inventory, or in a turn. Auto probes the container runtime for a VM
 * only when one of these exists, so an ordinary Auto turn on a machine with
 * no VM never pays for a docker or podman call. */
const localVmSeen = new Set<string>();
function noteLocalVmSeen(target: LocalVmTarget, status: ContainerComputerStatus | null | undefined): void {
  if (status && autoLocalVmAttachable(status)) localVmSeen.add(target.key);
}

/** Threads running with a bot's VPS computer mounted, per bot. Several run
 * at once — only the desktop lease is exclusive, and it is claimed on the
 * first screen call (see the VPS mount in dispatch) — so the alias and
 * backend guards ask "any thread?", and a settling thread removes only
 * itself, never a sibling still running. */
const activeVpsThreads = new Map<string, Set<string>>();
function vpsThreadStarted(botId: string, threadId: string): void {
  const threads = activeVpsThreads.get(botId) ?? new Set<string>();
  threads.add(threadId);
  activeVpsThreads.set(botId, threads);
}
function vpsThreadEnded(botId: string, threadId: string): void {
  const threads = activeVpsThreads.get(botId);
  if (!threads) return;
  threads.delete(threadId);
  if (!threads.size) activeVpsThreads.delete(botId);
}
const boxLifecycleBusyBots = new Set<string>();
// A refresh is a reader, not a lifecycle change. Keep its reservation until
// the provider settles even if the HTTP client leaves, and share it on retry.
const vpsPreviewRequests = new Map<string, ReturnType<typeof vps.vpsComputerScreenshot>>();
const orphanBoxLifecycleBusyIds = new Set<string>();
const boxInventoryRequestsBusyIds = new Set<string>();
const computerProviderConfigTransitions = new Set<RemoteComputerProvider>();
// A restore mutates and cleans a project work tree. Claim the bot across the
// entire async Git operation so a turn cannot start in that folder midway.
const checkpointRestoreLeases = new Set<string>();
const LOCAL_VM_IDLE_MS = 8 * 60 * 60_000;
/** How long a turn waits for Cua Driver after starting the container itself.
 * A cold XFCE desktop needs some seconds; past this the turn reports the
 * status it has rather than hanging on a container that will not come up. */
const LOCAL_VM_DESKTOP_WAIT_MS = 90_000;
const localVmIdles = new Map<string, LocalVmIdleTimer>();

function inheritedTeamComputer(bot: Pick<BotRecord, "section" | "computer" | "cloudBackend">): TeamComputerRecord | undefined {
  return teamComputers().forBot(bot);
}

function teamComputerPrompt(computer: TeamComputerRecord | undefined): string {
  return computer ? `Your team shares the Box computer ${JSON.stringify(computer.name)}. Its desktop files and desktop browser logins are shared with other Auto bots in your team; only one turn may drive it at a time. The separate built-in Browser is not this desktop and does not automatically share its logins.` : "";
}

function botComputerControlKey(bot: BotRecord): string {
  const computer = inheritedTeamComputer(bot);
  return computer ? teamComputerOwner(computer.id) : bot.id;
}

function botComputerControlSnapshot(botId: string, pinnedComputerId?: string) {
  const own = computerControl().snapshot(botId);
  const bot = store.bot(botId);
  const key = pinnedComputerId ? teamComputerOwner(pinnedComputerId) : bot ? botComputerControlKey(bot) : botId;
  const shared = computerControl().snapshot(key);
  return own.held ? own : shared.held || shared.helpReason ? shared : own;
}

function teamComputerInUse(computer: TeamComputerRecord): boolean {
  computer = teamComputers().get(computer.id) ?? computer;
  return computerControl().snapshot(teamComputerOwner(computer.id)).held ||
    [...teamComputerTurns.values()].some(turn => turn.computerId === computer.id) ||
    store.bots.some(bot => computer.section !== null && sectionKey(bot.section) === computer.section && (
      botHasActiveTurn(bot.id) || Boolean(routines()?.activeRunForBot(bot.id)) || computerControl().snapshot(bot.id).held
    ));
}

function assertTeamControlCanBeTaken(computerId: string): void {
  if ([...teamComputerTurns.values()].some(turn => turn.computerId === computerId && turn.remoteAgent)) {
    throw Object.assign(new Error("Stop the Computer engine's active turn before taking control of this shared desktop"), { status: 409 });
  }
}

function claimTeamComputerLifecycle(computer: TeamComputerRecord): () => void {
  if (computerProviderConfigTransitions.has("box")) throw Object.assign(new Error(providerTransitionMessage("box")), { status: 409 });
  if (teamComputerInUse(computer)) throw Object.assign(new Error("This team computer is in use; stop the team's work and release computer control first"), { status: 409 });
  return claimBotComputerLifecycle(teamComputerOwner(computer.id));
}

function assertTeamComputerChangeIdle(before: BotRecord, after: BotRecord): void {
  const previous = inheritedTeamComputer(before);
  const next = inheritedTeamComputer(after);
  if (previous?.id === next?.id) return;
  if (botHasActiveTurn(before.id) || routines()?.activeRunForBot(before.id) || botComputerControlSnapshot(before.id).held ||
      [previous, next].some(computer => computer && (teamComputerInUse(computer) || boxLifecycleBusyBots.has(teamComputerOwner(computer.id))))) {
    throw Object.assign(new Error("Stop the affected team's work and release computer control before changing its computer access"), { status: 409 });
  }
}

async function teamComputersPayload(): Promise<TeamComputersPayload> {
  const entries = teamComputers().list();
  const inventory = await box.listManagedBoxes(cfg, managedBoxOwners());
  return {
    configured: inventory.configured,
    ...(inventory.problem ? { problem: inventory.problem } : {}),
    computers: entries.map(entry => {
      const machine = inventory.instances.find(instance => instance.ownerBotId === teamComputerOwner(entry.id));
      return {
        id: entry.id, name: entry.name, section: entry.section,
        held: computerControl().snapshot(teamComputerOwner(entry.id)).held,
        state: boxLifecycleBusyBots.has(teamComputerOwner(entry.id)) ? "working" : machine?.state ?? (inventory.available ? "missing" : "unavailable"),
        ...(entry.problem || inventory.problem ? { problem: entry.problem || inventory.problem! } : {}),
      };
    }),
  };
}

/** The same named Box identity and whole-turn lease in chats and rooms.
 * Assignment authorizes waking, never replacing a missing paid machine. */
async function attachTeamBox(computer: TeamComputerRecord, botId: string, owner: TurnOwner, canMount: boolean, remoteAgent: boolean) {
  if (!canMount) throw new Error("This model engine cannot use the team's Box computer; choose an engine with computer tools or an explicit bot destination");
  if (!box.boxConfigured(cfg)) throw new Error("The team's Box account is not configured; reconnect it in Settings");
  const ownerId = teamComputerOwner(computer.id);
  if (boxLifecycleBusyBots.has(ownerId)) throw new Error("The team computer is being changed; wait for it to finish");
  if (computerControl().snapshot(ownerId).held) throw new Error("Release human control of the team computer before starting another turn");
  await bindTurnComputer(owner, `computer:box-bot:${ownerId}`, true);
  teamComputerTurns.set(owner.threadId, { owner, computerId: computer.id, botId, remoteAgent });
  let machine = await box.findBox(cfg, ownerId);
  if (!machine) throw new Error("The team's Box computer is missing; explicitly create or retry it from the Team map");
  await bindTurnComputer(owner, `computer:box:${machine.id}`, true);
  const action = box.boxTurnLifecycleAction({ explicitCloud: true, canMount: true, state: typeof machine.state === "string" ? machine.state : null });
  if (action === "wake") machine = await box.readyBox(cfg, ownerId);
  if (!machine || box.boxTurnLifecycleAction({ explicitCloud: true, canMount: true, state: typeof machine.state === "string" ? machine.state : null }) !== "attach") {
    throw new Error("The team computer is not ready; check it in the Team map");
  }
  if (turnResourceOwners.get(owner.threadId)?.generation !== owner.generation ||
      !turnResources.owns(`computer:box:${machine.id}`, owner)) throw new Error("This computer turn ended while its machine was starting");
  return {
    integration: { kind: "box" as const, boxId: machine.id, token: cfg.box!.token!, control: controlIntegration(botId, owner.threadId, owner.generation) },
    capture: () => box.screenshotBox(cfg, ownerId, machine!.id),
  };
}

function managedBoxOwners(): box.ManagedBoxOwner[] {
  return [...store.bots.map((bot) => ({
    botId: bot.id,
    name: bot.name,
    // A machine is not safe to mutate while any app-level work or human
    // control lease still names its owner. This is deliberately conservative
    // across destination changes: an old Box may still contain valuable state.
    inUse:
      bot.busy === true ||
      hasDirectDispatch(bot.id) ||
      activeGroupTurnForBot(bot.id) !== null ||
      Boolean(routines()?.activeRunForBot(bot.id)) ||
      activeVpsThreads.has(bot.id) ||
      computerControl().snapshot(bot.id).held,
  })), ...teamComputers().list().map(computer => ({
    botId: teamComputerOwner(computer.id), name: computer.name, inUse: teamComputerInUse(computer),
  }))];
}

function botHasActiveTurn(botId: string): boolean {
  const bot = store.bot(botId);
  return bot?.busy === true ||
    hasDirectDispatch(botId) ||
    activeGroupTurnForBot(botId) !== null;
}

function providerTransitionMessage(provider: RemoteComputerProvider): string {
  return provider === "box"
    ? "Box account settings are being updated — wait for them to finish"
    : "VPS connection settings are being updated — wait for them to finish";
}

/** Work which started first wins. This is intentionally conservative: a
 * control lease or detached routine can still refer to a durable computer
 * after the bot record's current destination changes. */
function providerOperationConflict(provider: RemoteComputerProvider): string | null {
  if (provider === "vps" && activeVpsThreads.size > 0) {
    return "stop the active VPS turn before changing the SSH config alias";
  }
  if (managedBoxOwners().some((owner) => owner.inUse)) {
    return `stop active bot work and computer control before changing ${provider === "box" ? "the Box account" : "the VPS connection"}`;
  }
  if (boxLifecycleBusyBots.size > 0 || vpsPreviewRequests.size > 0) {
    return "wait for cloud computer actions to finish before changing provider settings";
  }
  if (provider === "box") {
    if (boxInventoryRequestsBusyIds.size > 0 || orphanBoxLifecycleBusyIds.size > 0) {
      return "wait for cloud computer actions to finish before changing the Box account";
    }
    const deletingBoxIds = new Set(boxDeletionSnapshot().map((entry) => entry.boxId));
    if (boxCreateRecoverySnapshot().some(
      (entry) => !entry.resolved && (!entry.boxId || !deletingBoxIds.has(entry.boxId)),
    )) {
      return "finish reconciling pending cloud computer creation before changing the Box account";
    }
  } else if (vps.vpsLifecycleBusy()) {
    return "wait for VPS computer actions to finish before changing the SSH config alias";
  }
  return null;
}

function turnSurfacePlan(bot: BotRecord, runOn?: RoutineRunOn, threadId?: string) {
  const instance = registry.get(bot.modelSelection.instanceId);
  const forcedBox = runOn === "cloud" || Boolean(inheritedTeamComputer(bot));
  return resolveSurface({
    destination: forcedBox ? "cloud" : bot.computer,
    pinnedSurface: forcedBox || !threadId ? null : store.taskByThread(bot.id, threadId)?.surface,
    browserOn: builtInBrowserEnabled(cfg) && bot.browser !== false && instance?.adapter.capabilities.browserMcp === true,
  });
}

function turnProvider(bot: BotRecord, runOn?: RoutineRunOn, threadId?: string): RemoteComputerProvider | null {
  if (runOn === "cloud" || inheritedTeamComputer(bot)) return "box";
  const wants = turnSurfacePlan(bot, runOn, threadId).computer;
  if (wants !== undefined && wants !== "cloud") return null;
  if (registry.get(bot.modelSelection.instanceId)?.driverKind === "boxAgent") return "box";
  return computerBackendFor(bot).kind === "vps" ? "vps" : wants === "cloud" ? "box" : null;
}

/** A turn on the cloud computer runs ON the cloud computer: the Box runs the
 * bot's own harness there with the computer tools built in, so nothing on this
 * machine relays clicks and screenshots. Every start/interrupt of a turn asks
 * here which engine owns it. */
function turnInstance(bot: BotRecord, runOn?: RoutineRunOn, threadId?: string): ReturnType<typeof registry.get> {
  const onBox = turnProvider(bot, runOn, threadId) === "box";
  return onBox
    ? registry.instances().find((candidate) => candidate.driverKind === "boxAgent") ?? null
    : registry.get(bot.modelSelection.instanceId);
}

/** Preview requests carry the selected conversation, not whichever thread
 * happens to be the bot's default. A query never grants lifecycle authority. */
function computerPreviewBot(botId: string, url: URL): BotRecord | null {
  const threadId = url.searchParams.get("threadId");
  if (!threadId) return store.bot(botId);
  const bot = store.projectBotForTask(botId, threadId);
  if (!bot) throw Object.assign(new Error("no such task"), { status: 404 });
  return directTurnBots.get(threadId) ?? bot;
}

async function computerPreviewSurface(bot: BotRecord, threadId?: string) {
  const plan = turnSurfacePlan(bot, undefined, threadId);
  if (plan.computer !== undefined) return plan.computer === "off" && plan.browser ? "browser" : plan.computer;
  const instance = registry.get(bot.modelSelection.instanceId);
  if (instance?.driverKind === "boxAgent") return "cloud";
  const computerBackend = computerBackendFor(bot);
  if (computerBackend.kind === "vps") {
    const remote = await computerBackend.status(cfg, bot.id);
    if (remote.ready) return "cloud";
  }
  const target = localVmTargetForBot(bot.id);
  if (instance?.adapter.capabilities.computerMcp && localVmSeen.has(target.key)) {
    const vm = await containerComputerStatus(undefined, undefined, target).catch(() => null);
    if (vm && autoLocalVmAttachable(vm)) return "vm";
  }
  if (shouldMountLocalComputer({ requested: undefined, hostPlatform: process.platform,
    providerSupportsLocal: instance?.adapter.capabilities.localComputerMcp === true }) && readCuaConnection()) return "local";
  if (computerBackend.kind === "vps") return "cloud"; // show its unavailable reason
  return plan.browser ? "browser" : "off";
}

/** Discovery is read-only. Starting or creating a configured computer is
 * deferred until a chat tool selects it and the old turn releases its tools. */
async function selectableComputers(bot: BotRecord) {
  const caps = registry.get(bot.modelSelection.instanceId)?.adapter.capabilities;
  const computerBackend = computerBackendFor(bot);
  const off = bot.computer === "off";
  const localEngine = registry.get(bot.modelSelection.instanceId)?.driverKind !== "boxAgent";
  return Promise.all((["cloud", "vm", "local", "browser"] as const).map(async surface => {
    let ready = false;
    let canStart = false;
    let canCreate = false;
    let reason = "This computer is not configured or running. Open the Computer panel to set it up.";
    try {
      if (off) reason = "Computer access is Off in this bot's settings.";
      else if (surface === "cloud") {
        if (computerBackend.kind === "vps") {
          const status = localEngine && caps?.computerMcp ? await computerBackend.status(cfg, bot.id) : null;
          ready = status?.ready === true;
          canStart = Boolean(status?.daemonUp && status.managed && status.container === "stopped" &&
            status.image && status.imageMatches && status.network === "private" && status.mounts === "none" && status.security === "hardened");
          canCreate = Boolean(status?.configured && status.daemonUp && status.container === "missing");
          reason = status?.problem ?? reason;
        } else if (box.boxConfigured(cfg) && registry.instances().some(instance => instance.driverKind === "boxAgent")) {
          const status = await computerBackend.status(cfg, bot.id);
          const lifecycle = box.boxTurnLifecycleAction({ explicitCloud: true, canMount: true, state: status.box?.state ?? null });
          ready = lifecycle === "attach";
          canStart = lifecycle === "wake";
          canCreate = lifecycle === "provision";
        }
      } else if (surface === "vm" && localEngine && caps?.computerMcp) {
        const target = localVmTargetForBot(bot.id);
        const status = await containerComputerStatus(undefined, undefined, target);
        ready = status.ready;
        canCreate = !ready && autoLocalVmAttachable(status);
        if (ready || canCreate) noteLocalVmSeen(target, status);
        reason = status.problem ?? reason;
      } else if (surface === "local") {
        ready = shouldMountLocalComputer({ requested: "local", hostPlatform: process.platform,
          providerSupportsLocal: caps?.localComputerMcp === true }) && Boolean(readCuaConnection());
      } else if (surface === "browser") {
        ready = caps?.browserMcp === true && builtInBrowserEnabled(cfg) && bot.browser !== false && browserEngineStatus().kind === "ready";
        reason = "The built-in browser is disabled, not installed, or unsupported by this model engine.";
      }
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    const available = ready || canStart || canCreate;
    return { surface, label: surfaceLabel(surface), available, ready, canStart, canCreate, ...(!available ? { reason } : {}) };
  }));
}

function continueComputerSelection(threadId: string, generation: string | undefined, succeeded: boolean): boolean {
  const selection = computerSelectionTurns.get(threadId);
  if (!selection || selection.generation !== generation) return false;
  if (!succeeded || !selection.selected) { computerSelectionTurns.delete(threadId); return false; }
  const surface = selection.selected;
  setImmediate(() => {
    // Stop, deletion, a new user send, or any replacement generation wins.
    if (computerSelectionTurns.get(threadId) !== selection || directTurnGenerationByThread.get(threadId) !== generation) return;
    computerSelectionTurns.delete(threadId);
    const bot = store.projectBotForTask(selection.botId, threadId);
    if (!bot || bot.computer === "off" || threadBusy(bot.id, threadId)) return;
    if (store.taskByThread(bot.id, threadId)?.surface !== selection.previousSurface) return;
    if (queuedThreadPosition(bot.id, threadId) !== null) return;
    if (store.activePath(threadId).findLast(message => message.role === "user" && message.kind === "text")?.id !== selection.source.id) return;
    store.patchTask(bot.id, threadId, { surface });
    const text = `The computer selection is now ${surfaceLabel(surface)}. Continue the user's original request using the tools mounted for this turn; verify the result before claiming success.\n\n${selection.text}`;
    void startTurn(bot.id, text, { threadId, userMessage: selection.source, computerSelectionContinuation: true }).catch(error => {
      if (store.taskByThread(bot.id, threadId)) store.appendMessage(threadId, { role: "bot", kind: "activity",
        tool: { name: `Could not continue on ${surfaceLabel(surface)}: ${error instanceof Error ? error.message : String(error)}`, ok: false } });
    });
  });
  return true;
}

/** The engine that dispatched each live turn. A bot's settings may change
 * mid-turn; an interrupt or steer must reach the engine actually running. */
const runningTurnEngines = new Map<string, NonNullable<ReturnType<typeof registry.get>>>();
function runningTurnInstance(bot: NonNullable<ReturnType<typeof store.bot>>, threadId: string, runOn?: RoutineRunOn): ReturnType<typeof registry.get> {
  return runningTurnEngines.get(threadId) ?? turnInstance(bot, runOn, threadId);
}

function providerTransitionForTurn(
  bot: NonNullable<ReturnType<typeof store.bot>>,
  runOn?: RoutineRunOn,
  threadId?: string,
): string | null {
  const provider = turnProvider(bot, runOn, threadId);
  return provider && computerProviderConfigTransitions.has(provider)
    ? providerTransitionMessage(provider)
    : null;
}

function claimBoxInventoryRequest(boxId: string): () => void {
  if (boxInventoryRequestsBusyIds.has(boxId)) {
    throw Object.assign(new Error("this cloud computer is being changed — wait for it to finish"), { status: 409 });
  }
  boxInventoryRequestsBusyIds.add(boxId);
  return () => boxInventoryRequestsBusyIds.delete(boxId);
}

/** Claim the owning bot synchronously after Box revalidation and before the
 * provider mutation. startTurn checks the same set before doing any work, so
 * a new turn and an irreversible lifecycle action cannot pass each other. */
function claimManagedBoxMutation(instance: box.ManagedBoxInventoryInstance): () => void {
  const ownerBotId = instance.ownerBotId;
  const teamComputer = teamComputers().list().find(computer => teamComputerOwner(computer.id) === ownerBotId);
  if (teamComputer) return claimTeamComputerLifecycle(teamComputer);
  if (!ownerBotId) {
    if (orphanBoxLifecycleBusyIds.has(instance.boxId)) {
      throw Object.assign(new Error("this cloud computer is being changed — wait for it to finish"), { status: 409 });
    }
    orphanBoxLifecycleBusyIds.add(instance.boxId);
    return () => orphanBoxLifecycleBusyIds.delete(instance.boxId);
  }
  const owner = managedBoxOwners().find((candidate) => candidate.botId === ownerBotId);
  if (owner?.inUse) {
    throw Object.assign(new Error("this cloud computer is in use — stop its bot's work first"), { status: 409 });
  }
  return claimBotComputerLifecycle(ownerBotId);
}

/** One synchronous lane for cloud lifecycle consumers. Both Settings and
 * bot-scoped actions use it, so whichever operation starts first excludes the
 * other instead of relying on a stale check made before a provider await.
 * Only opening an existing VPS viewer may coexist with its pending preview. */
function claimBotComputerLifecycle(botId: string, allowPreview = false): () => void {
  if (boxLifecycleBusyBots.has(botId)) {
    throw Object.assign(new Error("this bot's cloud computer is being changed — wait for it to finish"), { status: 409 });
  }
  if (!allowPreview && vpsPreviewRequests.has(botId)) {
    throw Object.assign(new Error("a screen preview is still refreshing — wait before changing this computer"), { status: 409 });
  }
  boxLifecycleBusyBots.add(botId);
  return () => boxLifecycleBusyBots.delete(botId);
}

function claimManagedVpsMutation(containerName: string): () => void {
  const owner = store.bots.find((candidate) => vps.vpsContainerName(candidate.id) === containerName);
  if (!owner) return () => {};
  const ownerState = managedBoxOwners().find((candidate) => candidate.botId === owner.id);
  if (ownerState?.inUse) {
    throw Object.assign(new Error("this VPS computer is in use — stop its bot's work first"), { status: 409 });
  }
  return claimBotComputerLifecycle(owner.id);
}

function localVmTargetForBot(botId: string): LocalVmTarget {
  return localVmMode(cfg) === "per-bot" ? perBotLocalVmTarget(botId) : SHARED_LOCAL_VM_TARGET;
}

function localVmLeaseFor(target: LocalVmTarget): LocalVmLease {
  return localVmLeases.forTarget(target.key);
}

function localVmIdleFor(target: LocalVmTarget): LocalVmIdleTimer {
  let idle = localVmIdles.get(target.key);
  if (idle) return idle;
  idle = new LocalVmIdleTimer(
    LOCAL_VM_IDLE_MS,
    () => localVmImageBusy() || localVmLifecycleBusy.has(target.key) || localVmActiveThreads.has(target.key),
    async () => {
      localVmLifecycleBusy.add(target.key);
      try {
        const status = await containerComputerStatus(undefined, undefined, target);
        // The desktop leaves a stale X lock after stop, so idle cleanup
        // removes only the disposable container. Its target-specific durable
        // workspace and the shared prepared image remain.
        if (status.container === "running") {
          await containerComputerAction("remove", undefined, undefined, target);
        }
      } finally {
        localVmLifecycleBusy.delete(target.key);
      }
    },
  );
  localVmIdles.set(target.key, idle);
  return idle;
}

function releaseLocalVmThread(threadId: string): void {
  // Covers lazy claims too (issue #1361): every settle path funnels through
  // here or through releaseTurnResources, so a turn that ends before its
  // first screen call leaves no claim slot behind.
  autoVmClaims().delete(threadId);
  const target = localVmThreadTargets.get(threadId);
  if (!target) return;
  localVmLeaseFor(target).release(threadId);
  if (localVmActiveThreads.get(target.key) === threadId) localVmActiveThreads.delete(target.key);
  localVmThreadTargets.delete(threadId);
}

async function localVmInventoryPayload() {
  const runtime = await containerRuntimeStatus();
  if (!runtime.runtime || !runtime.daemonUp) {
    return {
      instances: [],
      maxInstances: localVmMaxInstances(cfg),
      available: false,
      problem: runtime.runtime ? `Start ${runtime.runtime} first` : "Install a supported container runtime first",
    };
  }
  const existing = await discoverExistingPerBotLocalVms(store.bots, runtime.runtime);
  const statuses = await Promise.all(existing.map(({ target }) =>
    containerComputerStatus(undefined, undefined, target),
  ));
  const instances = existing.flatMap(({ bot, target }, index) => {
    const status = statuses[index];
    if (!status) return [];
    noteLocalVmSeen(target, status);
    const inUse = localVmActiveThreads.has(target.key) ||
      localVmLeaseFor(target).current(localVmOwnerBusy) !== null;
    const entry = localVmInventoryEntry(bot, status, inUse);
    return entry ? [entry] : [];
  });
  return { instances, maxInstances: localVmMaxInstances(cfg), available: true, problem: null };
}
  return {
    localVmOwnerBusy, localVmLeases, localVmLifecycleBusy, localVmThreadTargets, localVmActiveThreads,
    localVmSeen, noteLocalVmSeen, activeVpsThreads, vpsThreadStarted, vpsThreadEnded, boxLifecycleBusyBots, vpsPreviewRequests,
    orphanBoxLifecycleBusyIds, boxInventoryRequestsBusyIds, computerProviderConfigTransitions,
    checkpointRestoreLeases, LOCAL_VM_IDLE_MS, LOCAL_VM_DESKTOP_WAIT_MS, localVmIdles,
    inheritedTeamComputer, teamComputerPrompt, botComputerControlKey, botComputerControlSnapshot,
    teamComputerInUse, assertTeamControlCanBeTaken, claimTeamComputerLifecycle, assertTeamComputerChangeIdle,
    teamComputersPayload, attachTeamBox, managedBoxOwners, botHasActiveTurn, providerTransitionMessage,
    providerOperationConflict, turnSurfacePlan, turnProvider, turnInstance, computerPreviewBot,
    computerPreviewSurface, selectableComputers, continueComputerSelection, runningTurnEngines,
    runningTurnInstance, providerTransitionForTurn, claimBoxInventoryRequest, claimManagedBoxMutation,
    claimBotComputerLifecycle, claimManagedVpsMutation, localVmTargetForBot, localVmLeaseFor, localVmIdleFor,
    releaseLocalVmThread, localVmInventoryPayload,
  };
}
