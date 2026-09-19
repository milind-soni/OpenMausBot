// The bot wire views and approval-policy predicates — extracted verbatim
// from index.ts: the wireTask/wireBot/wireTrustedApprovalBot/publicBot
// family that renders a bot as a client sees it (plus the queued-steer
// snapshot), the settings-preview system prompt and bot-overview builders
// behind their inspection routes, and the approval-mode-for-one-turn family
// (approvalModeForTurn, fullAccessForSource, peerReviewRequired,
// delegatedFullAccess, grantDelegatedFullAccess, roomTurnApprovalMode) with
// storedAvatarExists. index.ts wires createBotViews at the cluster's
// original site — turnInstance, inheritedTeamComputer and teamComputerPrompt
// from createComputerLifecycle above it arrive by value; connectorThread,
// roomHandoffs, routines and webhooks, which index.ts declares after that
// site, arrive as thunks. activeCoordinationForThread is module state here,
// bound to roomHandoffs.activeDirect through setActiveCoordinationForThread
// at the original assignment site in index.ts.
import {
  approvalModeFor,
  supportsApprovalMode,
  type ApprovalMode,
} from "../shared/approval-mode.ts";
import type { WireBot, WireTask } from "../shared/wire.ts";
import { attachmentExists } from "./attachments.ts";
import { approvalModeForOrigin, delegationInheritsFullAccess } from "./auto-approve.ts";
import { buildBotOverview, type BotOverview, connectedAppsFacts } from "./bot-overview.ts";
import { BUILT_IN_BROWSER_SYSTEM_PROMPT } from "./browser-engine.ts";
import { chiefOfStaffSystemPrompt } from "./chief-of-staff.ts";
import { computerBackendFor } from "./computer-backend.ts";
import {
  builtInBrowserEnabled,
  customMcpServers,
  localVmMode,
  skillAuthoringEnabled,
} from "./config.ts";
import * as composio from "./composio.ts";
import type { createComputerLifecycle } from "./computer-lifecycle.ts";
import type { createDeferredResumes } from "./deferred-resumes.ts";
import type { GroupTurnOrchestration } from "./group-turn.ts";
import { openMausStatusSystemPrompt } from "./openmaus-status-capsule.ts";
import { peerRosterSystemPrompt, reachablePeers } from "./peer-roster.ts";
import { flushProfileHistory, readHistory } from "./profile-versions.ts";
import type { RoomHandoffs } from "./room-handoffs.ts";
import { cfg, registry, store } from "./runtime.ts";
import type { RoutineManager } from "./routines.ts";
import { sectionContextSystemPrompt } from "./section-context.ts";
import { setupModeActive, setupSystemPrompt } from "./setup-mode.ts";
import { listSkills, skillsSystemPrompt } from "./skills.ts";
import { toWireTask, type BotRecord, type TaskRecord } from "./store.ts";
import { queuedSteerSnapshot } from "./steer-queue.ts";
import {
  buildSystemPrompt,
  computerPrompt,
  COMPOSIO_PROMPT,
  customMcpPrompt,
  CREDENTIAL_PROMPT,
  PROFILE_PROMPT,
  ROUTINE_PROMPT,
  type ComputerPromptKind,
} from "./system-prompt.ts";
import { resolveSurface, surfacePrompt } from "./surface.ts";
import { supportsWorkspaceFiles, memorySystemPrompt } from "./workspace.ts";
import type { WebhookManager } from "./webhooks.ts";

/** A bot as a client may see it: no provider session bookkeeping.
 *
 * `resumeCursors` is the harness's own bookkeeping — the native session id
 * to resume, per instance, per task. No client has ever used it, and a
 * paired phone has even less business holding provider session identifiers
 * than the desktop window did. Stripped here rather than at each call site
 * so a new broadcast cannot forget. */
let activeCoordinationForThread = (_threadId: string): boolean => false;

/** Bind the coordination predicate index.ts derives from its room-handoff
 * registry; until then every thread reports uncoordinated. */
export function setActiveCoordinationForThread(fn: (threadId: string) => boolean): void {
  activeCoordinationForThread = fn;
}

/** Everything the wire views and approval predicates read from their host.
 * The lateBound family holds thunks for the values index.ts binds after
 * the factory is wired (connectorThread and roomHandoffs, plus the
 * routines and webhooks managers); the helpers are values available
 * there — turnInstance, inheritedTeamComputer and teamComputerPrompt from
 * createComputerLifecycle further up index.ts. */
type ComputerLifecycle = ReturnType<typeof createComputerLifecycle>;
type DeferredResumes = ReturnType<typeof createDeferredResumes>;

export interface BotViewsDeps {
  lateBound: {
    connectorThread: DeferredResumes["connectorThread"];
    roomHandoffs(): RoomHandoffs;
    routines(): RoutineManager | null;
    webhooks(): WebhookManager;
  };
  helpers: {
    turnInstance: ComputerLifecycle["turnInstance"];
    inheritedTeamComputer: ComputerLifecycle["inheritedTeamComputer"];
    teamComputerPrompt: ComputerLifecycle["teamComputerPrompt"];
  };
}

export function createBotViews(deps: BotViewsDeps) {
  const { turnInstance, inheritedTeamComputer, teamComputerPrompt } = deps.helpers;
  const connectorThread = (botId: string, threadId: string) => deps.lateBound.connectorThread(botId, threadId);
  const roomHandoffs = () => deps.lateBound.roomHandoffs();
  const routines = () => deps.lateBound.routines();
  const webhooks = () => deps.lateBound.webhooks();

const wireTask = (task: TaskRecord): WireTask =>
  activeCoordinationForThread(task.threadId) && !task.busy
    ? { ...toWireTask(task), busy: true, activity: "working" as const }
    : toWireTask(task);

const wireBot = (bot: BotRecord): WireBot => {
  const { resumeCursors: _resumeCursors, tasks, approvalGrant, lastProfileRequestId: _lastProfileRequestId, lastTeamSetupReceipt: _lastTeamSetupReceipt, ...rest } = bot;
  // An elevated selection is inert until the desktop confirms its exact
  // private reply. Every ordinary client sees the effective Ask state during
  // that two-phase window, never a grant that may still roll back.
  const visible = approvalGrant && !approvalGrant.threadOnly
    ? { ...rest, approvalMode: "ask" as const, autoApprove: false }
    : rest;
  return { ...visible, ...(activeCoordinationForThread(bot.threadId) && !visible.busy ? { busy: true, activity: "working" as const } : {}),
    avatarUrl: visible.avatarUrl ?? null, ...(tasks ? { tasks: tasks.map(wireTask) } : {}) };
};

/** The correlated private response carries the requested value so Electron
 * can validate it before sending the confirmation that makes it effective. */
const wireTrustedApprovalBot = (bot: NonNullable<ReturnType<typeof store.bot>>) => {
  const { resumeCursors: _resumeCursors, tasks, approvalGrant: _approvalGrant, lastProfileRequestId: _lastProfileRequestId, lastTeamSetupReceipt: _lastTeamSetupReceipt, ...rest } = bot;
  return { ...rest, approvalMode: approvalModeFor(rest), avatarUrl: rest.avatarUrl ?? null, ...(tasks ? { tasks: tasks.map(wireTask) } : {}) };
};

/** A settings-based preview, not a receipt of a dispatched turn. No
 * provisioning or credentials are needed to inspect it. The selected engine
 * bounds advertised tools; task-specific context is added only at dispatch. */
function previewSystemPrompt(bot: BotRecord) {
  // `cfg` is the module-level config (`const cfg = loadConfig()` near the
  // top of index.ts), the same object the turn code reads.
  const persona = [
    `You are ${bot.name}, a personal bot in OpenMausBot.`,
    bot.title && `Role: ${bot.title}.`,
    bot.description && `About: ${bot.description}`,
  ]
    .filter(Boolean)
    .join(" ");
  const instance = turnInstance(bot);
  const caps = instance?.adapter.capabilities;
  const teamComputer = inheritedTeamComputer(bot);
  const previewComputer = teamComputer ? "cloud" : bot.computer;
  const computerPromptKind: ComputerPromptKind | null =
    previewComputer === "vm"
      ? caps?.computerMcp ? localVmMode(cfg) === "per-bot" ? "vm-private" : "vm-shared" : null
      : previewComputer === "cloud"
        ? instance?.driverKind === "boxAgent" ? "box-agent" : caps?.computerMcp ? computerBackendFor(bot).kind : null
        : previewComputer === "local"
          ? caps?.localComputerMcp ? "local" : null
          : null;
  const peers = reachablePeers(store.bots, bot);
  const coordination = bot.chiefOfStaff
    ? chiefOfStaffSystemPrompt(bot.id, store.bots, true, openMausStatusSystemPrompt())
    : peers.length > 0
      ? peerRosterSystemPrompt(peers)
      : "";
  // Same gate a real turn applies: the block only goes to a bot whose
  // engine actually mounts agent tools, since it names propose_profile,
  // propose_routine and request_credential.
  const agentsMounted = caps?.agentsMcp === true;
  // The preview asks the same question a dispatch asks, through the same
  // policy, so "what the model sees" cannot drift from what a turn sends.
  // Spelling the browser rule out a second time here is what let Off keep a
  // browser in one place while the preview said it had none.
  const previewPlan = resolveSurface({
    destination: previewComputer,
    browserOn: caps?.browserMcp === true && builtInBrowserEnabled(cfg) && bot.browser !== false,
  });
  const privateWorkspace = instance && supportsWorkspaceFiles(instance.driverKind);
  const built = buildSystemPrompt(persona, bot.soul ?? "", [
    {
      id: "setup",
      label: "Setup",
      text: setupSystemPrompt(agentsMounted && setupModeActive({ soul: bot.soul, description: bot.description, text: "" }), {
        skills: skillAuthoringEnabled(cfg),
        cwd: bot.cwd,
      }),
    },
    { id: "computer", label: "Computer", text: computerPrompt(computerPromptKind) },
    { id: "team-computer", label: "Team computer", text: teamComputerPrompt(teamComputer) },
    // Auto cannot know its place until dispatch, so the preview stays silent
    // there and only carries the note; explicit settings preview the paragraph.
    { id: "plan", label: "Surface", text: previewPlan.computer === undefined ? "" : surfacePrompt({
      computer: previewPlan.computer && previewPlan.computer !== "off" && computerPromptKind ? previewPlan.computer : null,
      browser: previewPlan.computer === undefined ? false : previewPlan.browser,
    }, { note: previewPlan.note }) },
    { id: "composio", label: "Connected apps", text: caps?.composioMcp && bot.composio !== false && composio.configured(cfg) ? COMPOSIO_PROMPT : "" },
    { id: "mcp", label: "MCP servers", text: caps?.customMcp ? customMcpPrompt(Object.keys(customMcpServers(cfg, bot.mcpServers))) : "" },
    { id: "browser", label: "Browser", text: previewPlan.browser ? BUILT_IN_BROWSER_SYSTEM_PROMPT : "" },
    { id: "coordination", label: "Team", text: agentsMounted && coordination ? ` ${coordination}` : "" },
    { id: "credential", label: "Credentials", text: agentsMounted ? CREDENTIAL_PROMPT : "" },
    { id: "routine", label: "Routines", text: agentsMounted ? ROUTINE_PROMPT : "" },
    { id: "profile", label: "Profile changes", text: agentsMounted ? PROFILE_PROMPT : "" },
    { id: "section-context", label: "Section context", text: sectionContextSystemPrompt(bot.section) },
    { id: "memory", label: "Memory", text: memorySystemPrompt(bot.id, { managedWrites: agentsMounted, fileTools: Boolean(privateWorkspace) }) },
    { id: "skills", label: "Skills index", text: privateWorkspace ? skillsSystemPrompt(bot.id) : "" },
  ]);
  const totalBytes = built.sections.reduce((n, s) => n + s.bytes, 0);
  return {
    sections: built.sections,
    totalBytes,
    approxTokens: Math.ceil(totalBytes / 4),
    note:
      "Preview from current bot settings, not the exact prompt of a running task. Task folders, notes, recall, selected skills and available connections can change the dispatched prompt. Token count is an estimate.",
  };
}

/** The plain-language "what does this bot do" facts, gathered once from
 * every server-only source (engine capabilities, connected-apps inventory,
 * routines/webhooks/skills, and recent history) and handed to the pure
 * sentence builder. The phones (step 5) and the web settings dialog both
 * read this same route, so they can never disagree about what a bot does. */
async function botOverview(bot: BotRecord): Promise<BotOverview> {
  const connectedApps = await connectedAppsFacts(
    composio.configured(cfg),
    composio.connectorAvailability(cfg),
    () => composio.connectedServices(cfg),
  );
  const engine = registry.get(bot.modelSelection.instanceId)?.adapter.capabilities ?? null;
  const sectionPeers = reachablePeers(store.bots, bot).length;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Same flush as GET /history: profile-change rows queue in
  // profile-versions.ts and land asynchronously, so a client checking the
  // overview right after causing a change must see its own row.
  await flushProfileHistory(bot.id);
  const recent = readHistory(bot.id, 5).map((r) => ({ at: r.at, summary: r.summary }));
  return buildBotOverview({
    bot: {
      name: bot.name,
      title: bot.title,
      description: bot.description,
      soul: bot.soul,
      computer: bot.computer,
      cloudBackend: bot.cloudBackend,
      cwd: bot.cwd,
      autoApprove: bot.autoApprove,
      approvalMode: approvalModeForTurn(bot),
      approvePeerComms: bot.approvePeerComms,
      peers: bot.peers,
      composio: bot.composio,
      browser: bot.browser,
      chiefOfStaff: bot.chiefOfStaff,
      managedSections: bot.managedSections,
    },
    routines: routines()!.listRoutines()
      .filter((routine) => routine.botId === bot.id)
      .map((routine) => ({
        id: routine.id,
        name: routine.name,
        enabled: routine.enabled,
        schedule: routine.schedule,
        nextRunAt: routine.nextRunAt,
      })),
    runs: routines()!.listRuns()
      .filter((run) => run.botId === bot.id)
      .map((run) => ({
        routineId: run.routineId,
        status: run.status,
        finishedAt: run.finishedAt,
        startedAt: run.startedAt,
        scheduledFor: run.scheduledFor,
      })),
    webhooks: webhooks().list()
      .filter((webhook) => webhook.botId === bot.id)
      .map((webhook) => ({ name: webhook.name, enabled: webhook.enabled })),
    skills: listSkills(bot.id).map((skill) => ({
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
    })),
    engine,
    browserEnabled: builtInBrowserEnabled(cfg),
    connectedApps,
    sectionPeers,
    timeZone,
    recent,
  });
}

/** Defense in depth for hand-edited/corrupt durable records: elevated
 * approval semantics require an implemented provider mapping. The trusted transition enforces
 * this too, but no provider dispatch or later permission callback relies on
 * persistence having been produced exclusively by that route. Delegation
 * uses the receiving bot's grant, never the sender's (approvalModeForOrigin) —
 * with one deliberate exception: a Chief of Staff with Full access makes the
 * threads it delegates Full too (delegatedFullAccess), so the grant the
 * person gave the Chief covers the work the Chief hands out. */
const approvalModeForTurn = (bot: BotRecord, peerInitiated = false): ApprovalMode => {
  const mode = approvalModeForOrigin(approvalModeFor(bot), { peerInitiated });
  if (!supportsApprovalMode(registry.cliTarget(bot.modelSelection.instanceId)?.driverKind, mode)) {
    return "ask";
  }
  return mode;
};

/** Full belongs to the requesting conversation, not whichever sibling is
 * selected in the UI or the bot's default for future conversations. */
function fullAccessForSource(botId: string, threadId: string): boolean {
  const owner = connectorThread(botId, threadId);
  if (!owner) return false;
  const bot = store.projectBotForTask(botId, threadId) ?? owner.bot;
  // Origin changes Custom to Auto, never Full; no live-turn state is needed.
  return approvalModeForTurn(bot) === "full";
}

function peerReviewRequired(bot: BotRecord, threadId: string): boolean {
  return Boolean(bot.approvePeerComms && !fullAccessForSource(bot.id, threadId));
}

/** Full access flows down a Chief of Staff's delegation. The person gave the
 * Chief Full access so its work runs without prompts; a teammate stopping
 * that same work to ask defeats the grant — and in practice the person was
 * answering every one of those cards, all day, for the whole team. So a
 * teammate a Full-access Chief delegates to runs Full for that work: the
 * recipient switches, whatever its own level says. The recipient's engine
 * has to implement Full (supportsApprovalMode); otherwise the work keeps the
 * recipient's own level, as before. Only a Chief passes access on — an
 * ordinary bot's delegation still uses the recipient's setting. */
function delegatedFullAccess(from: BotRecord, fromThreadId: string, target: BotRecord): boolean {
  return delegationInheritsFullAccess({
    senderIsChief: Boolean(from.chiefOfStaff),
    senderHasFullAccess: fullAccessForSource(from.id, fromThreadId),
    sameBot: from.id === target.id,
    recipientDriverKind: registry.cliTarget(target.modelSelection.instanceId)?.driverKind,
  });
}

/** Make a delegated thread Full and say so in it once, so the level the
 * chip shows and the level the turns run at agree, and the person can see
 * where the access came from. Idempotent: a pair conversation is reused
 * across delegations and must not collect a chip per request. */
function grantDelegatedFullAccess(from: BotRecord, target: BotRecord, threadId: string): void {
  if (store.taskByThread(target.id, threadId)?.approvalMode === "full") return;
  store.patchTask(target.id, threadId, { approvalMode: "full", autoApprove: false, alwaysAllow: [] });
  store.appendMessage(threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Full access — delegated by ${from.name}, a Chief of Staff with Full access`, ok: true },
  });
}

/** A room member's level for one turn. Work a Full-access Chief hands out
 * in a room runs Full for that turn: the room thread is shared, so the
 * level is not stored on it — it rides the handoff. */
function roomTurnApprovalMode(bot: BotRecord, orchestration?: GroupTurnOrchestration): ApprovalMode {
  const handoff = orchestration?.roomHandoffId ? roomHandoffs().nodes.get(orchestration.roomHandoffId) : undefined;
  const source = handoff?.parentId ? roomHandoffs().nodes.get(handoff.parentId) : undefined;
  const from = source ? store.bot(source.botId) : undefined;
  if (from && source && delegatedFullAccess(from, source.threadId, bot)) return "full";
  return approvalModeForTurn(bot, Boolean(orchestration?.roomHandoffId));
}

// The Electron-only trusted approval state machine (this handler) lives in
// ./desktop-approval.ts; createDesktopApproval is wired near the top of
// index.ts, just before the parentPort listener that dispatches to it.

/** Profile URLs are app-owned references, not merely strings with a trusted
 * prefix. Resolve them before persistence so every accepted avatar can be
 * fetched immediately and a deleted/guessed attachment id cannot become a
 * dangling profile reference. */
const storedAvatarExists = (avatarUrl: string): boolean =>
  attachmentExists(avatarUrl.slice("/api/attachments/".length));

const publicBot = (bot: NonNullable<ReturnType<typeof store.bot>>) => ({
  ...wireBot(bot),
  messages: store.messagesFor(bot.threadId),
  activeLeafId: store.activeLeaf(bot.threadId),
  tasks: store.tasks(bot.id).map(wireTask),
});
const publicBotQueuedMessages = () => queuedSteerSnapshot((botId, threadId) => Boolean(store.taskByThread(botId, threadId)));
  return {
    wireTask,
    wireBot,
    wireTrustedApprovalBot,
    previewSystemPrompt,
    botOverview,
    approvalModeForTurn,
    fullAccessForSource,
    peerReviewRequired,
    delegatedFullAccess,
    grantDelegatedFullAccess,
    roomTurnApprovalMode,
    storedAvatarExists,
    publicBot,
    publicBotQueuedMessages,
  };
}
