// The agents server on one turn of a conversation. Providers cache a prompt from its start, tool definitions first, so a
// tool that came or went between two turns of one conversation would re-bill the whole conversation at the uncached
// price: what the server lists comes from the conversation alone, and a turn that may not use a listed tool is told why
// when it calls it.
import { AGENTS_PROXY_ENV } from "./agents-bridge-switch.ts";
import { roleToolEnv } from "./chief-level.ts";

/** The facts of a conversation that decide its agents tools. A settings change may change them; a turn never does. */
export interface AgentsConversation {
  threadId: string;
  bot: NonNullable<Parameters<typeof roleToolEnv>[0]> & { id: string; computer?: string; memoryEnabled?: boolean; xResearch?: boolean };
  /** A room's thread: rooms refuse widgets, pages and a computer pick. */
  room: boolean;
  /** The bot works on its team's cloud computer, so it has no computer of its own to pick. */
  teamComputer: boolean;
  /** `x`: a research credential is held (a treg key or a plan's); `research`: research works for it too. */
  host: { skillAuthoring: boolean; sharedComputers: boolean; cloudHome: boolean; team: boolean; escalations: boolean; voiceNotes: boolean; x: boolean; research: boolean };
}

/** What one turn may do. Its bearer carries this to the harness, which checks it on every call. */
export interface AgentsTurn {
  generation: string;
  depth: number;
  /** In a room only the first answer to a person's message may list or write skills. */
  skillAuthoring: boolean;
  roomHandoffId?: string;
  deliversSavedFiles?: boolean;
}

const flag = (on: boolean) => (on ? "1" : "0");

export function agentsServerEnv(conversation: AgentsConversation, turn: AgentsTurn, bearer: (turn: AgentsTurn) => string, harnessUrl: string): Record<string, string> {
  const { bot, host } = conversation;
  return {
    ...AGENTS_PROXY_ENV,
    OMB_HARNESS_URL: harnessUrl,
    OMB_BOT_ID: bot.id,
    OMB_THREAD_ID: conversation.threadId,
    OMB_COMMS_TOKEN: bearer(turn),
    OMB_TURN_DEPTH: String(turn.depth),
    OMB_SKILL_AUTHORING_ENABLED: flag(host.skillAuthoring),
    OMB_MEMORY_ENABLED: flag(bot.memoryEnabled !== false),
    OMB_SHARED_COMPUTERS_ENABLED: flag(host.sharedComputers),
    OMB_CLOUD_HOME: flag(host.cloudHome), OMB_TEAM_PEOPLE: flag(host.team), OMB_ROOM: flag(conversation.room),
    OMB_VOICE_NOTES: flag(host.voiceNotes),
    OMB_X_RESEARCH: flag(host.x && bot.xResearch !== false),
    OMB_RESEARCH: flag(host.x && host.research && bot.xResearch !== false),
    ...roleToolEnv(bot),
    OMB_ESCALATIONS: flag(host.escalations),
    OMB_COMPUTER_SELECTION: flag(!conversation.room && bot.computer !== "off" && !conversation.teamComputer),
  };
}

/** What started a direct turn, in the words a refusal uses. */
export type TurnKind = "person" | "routine" | "webhook" | "handoff" | "continuation";

export function directTurnKind(turn: {
  automationSource?: string; commsDepth?: number; coordination?: unknown; peerAsk?: unknown;
  cardContinuation?: boolean; computerSelectionContinuation?: boolean; unattended?: boolean; compactOnly?: boolean;
}): TurnKind {
  if (turn.automationSource === "webhook") return "webhook";
  if (turn.automationSource !== undefined) return "routine";
  if (turn.commsDepth || turn.coordination || turn.peerAsk) return "handoff";
  if (turn.cardContinuation || turn.computerSelectionContinuation || turn.unattended || turn.compactOnly) return "continuation";
  return "person";
}

const THIS_TURN: Record<Exclude<TurnKind, "person">, string> = {
  routine: "This turn is a routine run",
  webhook: "This turn was started by a webhook",
  handoff: "This turn is a teammate's hand-off",
  continuation: "This turn continues earlier work",
};

export const COMPUTER_OFF_REFUSAL = "This bot's Works on setting is Off, so it has no computer to pick. Work without one, or ask the person to choose a place in this bot's settings.";

/** select_computer on a turn that may not pick, `kind` being what started it. */
export function computerPickRefusal(kind: TurnKind | undefined): string {
  if (kind === undefined || kind === "person") return "Picking a computer works only once per request, on a person's own message. Carry on with the computer already in use.";
  return `Picking a computer works only on a person's own message. ${THIS_TURN[kind]}, so carry on with the computer already in use.`;
}

/** skills_list or skill_manage on a room turn that is not the first answer to a person's message. */
export function roomSkillsRefusal(handoff: boolean): string {
  return `In a room, only the first bot answering a person's message can list or write skills. ${handoff ? THIS_TURN.handoff : "This turn is a follow-up"}, so carry on without changing skills.`;
}
