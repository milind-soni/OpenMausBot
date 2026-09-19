// Prompt-building phases for the direct-turn engine (server/start-turn.ts).
import { localVmMode, type AppConfig } from "../../config.ts";
import { peerName, peerRosterSystemPrompt, reachablePeers } from "../../peer-roster.ts";
import { mentionedBots, type BotRecord, type Message, type Store } from "../../store.ts";
import { chiefOfStaffSystemPrompt } from "../../chief-of-staff.ts";
import { openMausStatusSystemPrompt } from "../../openmaus-status-capsule.ts";
import { sectionContextSystemPrompt } from "../../section-context.ts";
import { recentWork, recentWorkPrompt } from "../../recent-work.ts";
import { memorySystemPrompt, SESSION_SEARCH_SYSTEM_PROMPT, workspaceLocationsPrompt } from "../../workspace.ts";
import { skillsSystemPrompt } from "../../skills.ts";
import { setupSystemPrompt } from "../../setup-mode.ts";
import {
  buildSystemPrompt,
  computerPrompt,
  COMPOSIO_PROMPT,
  CREDENTIAL_PROMPT,
  customMcpPrompt,
  LEARN_PROMPT,
  mentionPrompt,
  PROFILE_PROMPT,
  ROUTINE_EXECUTION_PROMPT,
  ROUTINE_PROMPT,
  THREADS_PROMPT,
  WEBHOOK_PROMPT,
  type ComputerPromptKind,
} from "../../system-prompt.ts";
import { BUILT_IN_BROWSER_SYSTEM_PROMPT } from "../../browser-engine.ts";
import { computerSelectionTurns } from "../../internal-capabilities.ts";
import { surfaceOfComputerKind, surfacePrompt, type SurfacePlan } from "../../surface.ts";
import type { ProviderInstance } from "../../contracts.ts";
import type { TeamComputerRecord } from "../../team-computers.ts";
import type { StartTurnOptions } from "../../start-turn.ts";
import type { ComputerKind, Deps, TurnIntegrations } from "./shared.ts";

/** Prompt fragments: agents integration, roster/mention resolution and the gated prompt blocks. */
export function buildCoordinationPrompts({
  bot,
  opts,
  threadId,
  userMessage,
  providerText,
  commsDepth,
  skillAuthoring,
  agentsMounted,
  boundedCoordination,
  dispatchClaimId,
  integrations,
  store,
  agentsIntegration,
}: {
  bot: BotRecord;
  opts: StartTurnOptions | undefined;
  threadId: string;
  userMessage: Message;
  providerText: string;
  commsDepth: number;
  skillAuthoring: boolean;
  agentsMounted: boolean;
  boundedCoordination: boolean;
  dispatchClaimId: string;
  integrations: TurnIntegrations;
  store: Store;
  agentsIntegration: Deps["computers"]["agentsIntegration"];
}) {
  // Agent control tools include peer comms and the secure credential
  // request card. A comms-invoked turn (depth ≥ cap) gets none — hard recursion
  // stop, so the user's tokens can't be burned by a bot-to-bot loop.
  // Only drivers that mount the tools get the integration (and, via the
  // integrations.agents gate below, the prompt hint) — a bot on a driver
  // without it must not be told about tools it cannot call. Any bot can
  // still be the TARGET of ask_bot regardless of its driver.
  // One reachability rule for the roster, list_bots and @mention
  // resolution: a bot is never told about — or nudged toward — a peer
  // that ask_bot and delegate_bot would then refuse.
  const sectionPeers = reachablePeers(store.bots, bot);
  if (agentsMounted) {
    // Only a direct human request can create separate self-owned jobs.
    // Coordinated children and self-opened jobs stay inside their scope;
    // a later real user message on the same task is a fresh request.
    const origin = opts?.cardContinuation
      ? store.activePath(threadId).findLast(message => message.role === "user" && message.kind === "text")
      : userMessage;
    const ownThreadCreation = boundedCoordination && !opts?.coordination && Boolean(origin && !origin.peerAsk);
    integrations.agents = agentsIntegration(bot.id, threadId, commsDepth, skillAuthoring, dispatchClaimId, opts?.coordination?.id, boundedCoordination, ownThreadCreation);
  }
  // @mentions in the user's message (the composer's tagging UI) become
  // an explicit coordination nudge. The agent still chooses the matching
  // peer tool, so the harness stays the single owner of turns/permissions.
  const tagged = integrations.agents
    ? mentionedBots(
        providerText,
        sectionPeers,
      )
    : [];
  const coordinationPrompt = bot.chiefOfStaff
    ? chiefOfStaffSystemPrompt(
        bot.id,
        store.bots,
        Boolean(integrations.agents),
        openMausStatusSystemPrompt(),
        boundedCoordination,
      )
    : integrations.agents && sectionPeers.length > 0
      // Ordinary bots could always CALL the peer tools; until now the
      // one generic sentence they got never named a teammate, so the
      // first move of any collaboration was a list_bots round trip the
      // model mostly did not think to make.
      ? peerRosterSystemPrompt(sectionPeers, boundedCoordination)
      : "";
  const credentialPrompt = integrations.agents ? CREDENTIAL_PROMPT + (boundedCoordination ? "" : THREADS_PROMPT) : "";
  const routinePrompt = integrations.agents ? ROUTINE_PROMPT : "";
  const profilePrompt = integrations.agents ? PROFILE_PROMPT : "";
  const recallPrompt = integrations.agents ? SESSION_SEARCH_SYSTEM_PROMPT : "";
  const learnPrompt = skillAuthoring ? LEARN_PROMPT : "";
  return { tagged, coordinationPrompt, credentialPrompt, routinePrompt, profilePrompt, recallPrompt, learnPrompt };
}


/** System prompt assembly: the full section list built from the phase outputs. */
export function buildTurnSystemPrompt({
  bot,
  opts,
  threadId,
  plan,
  instance,
  persona,
  liveBot,
  setupMode,
  mountedComputer,
  computerKind,
  integrations,
  cwd,
  worksInWorkspace,
  privateWorkspace,
  skillInstructions,
  packagePlaybooks,
  teamComputer,
  skillAuthoring,
  boundedCoordination,
  tagged,
  coordinationPrompt,
  credentialPrompt,
  routinePrompt,
  profilePrompt,
  recallPrompt,
  learnPrompt,
  store,
  cfg,
  roomHandoffs,
  roomHandoffProblem,
  coordinationSystemInstructions,
  outstandingAssignmentsPrompt,
  teamComputerPrompt,
  DirectTurnSetupCancelled,
}: {
  bot: BotRecord;
  opts: StartTurnOptions | undefined;
  threadId: string;
  plan: SurfacePlan;
  instance: ProviderInstance;
  persona: string;
  liveBot: ReturnType<Store["bot"]>;
  setupMode: boolean;
  mountedComputer: ReturnType<typeof surfaceOfComputerKind>;
  computerKind: ComputerKind;
  integrations: TurnIntegrations;
  cwd: string | undefined;
  worksInWorkspace: boolean;
  privateWorkspace: string | undefined;
  skillInstructions: string;
  packagePlaybooks: string;
  teamComputer: TeamComputerRecord | undefined;
  skillAuthoring: boolean;
  boundedCoordination: boolean;
  tagged: BotRecord[];
  DirectTurnSetupCancelled: Deps["dispatch"]["DirectTurnSetupCancelled"];
  coordinationPrompt: string;
  credentialPrompt: string;
  routinePrompt: string;
  profilePrompt: string;
  recallPrompt: string;
  learnPrompt: string;
  store: Store;
  cfg: AppConfig;
  roomHandoffs: Deps["handoffs"]["roomHandoffs"];
  roomHandoffProblem: Deps["prompts"]["roomHandoffProblem"];
  coordinationSystemInstructions: Deps["prompts"]["coordinationSystemInstructions"];
  outstandingAssignmentsPrompt: Deps["prompts"]["outstandingAssignmentsPrompt"];
  teamComputerPrompt: Deps["prompts"]["teamComputerPrompt"];
}) {
  const computerPromptKind: ComputerPromptKind | null =
    computerKind === "vm"
      ? localVmMode(cfg) === "per-bot" ? "vm-private" : "vm-shared"
      : computerKind === "box"
        ? instance.driverKind === "boxAgent" ? "box-agent" : "box"
        : computerKind === "vps"
          ? "vps"
          : computerKind === "local"
            ? "local"
            : null;
  const coordinationNode = opts?.coordination ? roomHandoffs.nodes.get(opts.coordination.id) : undefined;
  if (opts?.coordination && (!coordinationNode || coordinationNode.status !== "running" || roomHandoffProblem(coordinationNode,
    coordinationNode.parentId ? roomHandoffs.nodes.get(coordinationNode.parentId) : undefined))) {
    throw new DirectTurnSetupCancelled("Coordination access changed before dispatch");
  }
  const prompt = buildSystemPrompt(persona, liveBot?.soul ?? bot.soul ?? "", [
    // first after the soul: the block names agent tools, so it only goes
    // to a turn whose engine actually mounted them (setupMode is already
    // false when they are not — see agentsMounted above)
    { id: "setup", label: "Setup", text: setupSystemPrompt(setupMode, { skills: skillAuthoring, cwd: liveBot?.cwd ?? bot.cwd }) },
    { id: "files", label: "File locations", text: worksInWorkspace && opts?.runOn !== "cloud" ? workspaceLocationsPrompt(bot.id, cwd, liveBot?.cwd ?? bot.cwd) : "" },
    { id: "computer", label: "Computer", text: computerPrompt(computerPromptKind) },
    { id: "team-computer", label: "Team computer", text: teamComputerPrompt(teamComputer) },
    { id: "plan", label: "Surface", text: surfacePrompt({ computer: mountedComputer, browser: Boolean(integrations.browser) }, { pinned: plan.pinned, note: plan.note, canSelect: computerSelectionTurns.has(threadId) }) },
    // gated on the integration, not the key: the hint only goes to a
    // bot whose driver actually mounted the tools
    { id: "composio", label: "Connected apps", text: integrations.composio ? COMPOSIO_PROMPT : "" },
    { id: "mcp", label: "MCP servers", text: customMcpPrompt(Object.keys(integrations.custom ?? {})) },
    { id: "browser", label: "Browser", text: integrations.browser ? BUILT_IN_BROWSER_SYSTEM_PROMPT : "" },
    { id: "coordination", label: "Team", text: coordinationPrompt ? ` ${coordinationPrompt}` : "" },
    { id: "assignment", label: "Teammate task", text: coordinationNode ? `\n${coordinationSystemInstructions()}` : "" },
    { id: "outstanding", label: "Outstanding teammate work", text: outstandingAssignmentsPrompt(threadId) },
    { id: "credential", label: "Credentials", text: credentialPrompt },
    { id: "recall", label: "Recall", text: recallPrompt },
    { id: "routine", label: "Routines", text: routinePrompt },
    { id: "routine-execution", label: "Routine execution", text: opts?.automationSource === "schedule" || opts?.automationSource === "manual" ? ROUTINE_EXECUTION_PROMPT : "" },
    { id: "profile", label: "Profile changes", text: profilePrompt },
    { id: "learn", label: "Skill authoring", text: learnPrompt },
    { id: "section-context", label: "Section context", text: sectionContextSystemPrompt(bot.section) },
    // what the bot said lately in its other conversations, so a task
    // never redoes — or forgets — what another one already did
    { id: "recent", label: "Recent work", text: recentWorkPrompt(recentWork(store, bot, { userName: cfg.profile?.name?.trim() || "User", currentThreadId: threadId })) },
    { id: "memory", label: "Memory", text: memorySystemPrompt(bot.id, { managedWrites: Boolean(integrations.agents), fileTools: worksInWorkspace }) },
    { id: "skills", label: "Skills index", text: privateWorkspace ? skillsSystemPrompt(bot.id) : "" },
    { id: "skill-instructions", label: "Skill instructions", text: skillInstructions },
    { id: "playbooks", label: "Playbooks", text: packagePlaybooks },
    { id: "webhook", label: "Webhook provenance", text: opts?.automationSource === "webhook" ? WEBHOOK_PROMPT : "" },
    { id: "mentions", label: "Mentions", text: boundedCoordination && tagged.length ? `The user named these existing teammates: ${tagged.map(b => `${peerName(b.name)} (${b.id})`).join(", ")}. Use coordinate_bots when their contribution is needed; do not substitute native helper agents for these bots.` : mentionPrompt(tagged) },
  ]);
  return prompt;
}

