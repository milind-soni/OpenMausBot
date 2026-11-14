import type { BotAvatarCrop } from "./bot-avatar.ts";
import type { ModelSelection } from "./wire.ts";

export interface TeamSetupFields {
  name?: string;
  title?: string;
  description?: string;
  soul?: string;
  /** Create only: the folder the new bot's tools work in. "" = private workspace. */
  cwd?: string;
  section?: string;
  modelSelection?: ModelSelection;
  chiefOfStaff?: boolean;
  /** A stored /api/attachments picture; "" returns to the mascot. */
  avatarUrl?: string;
  /** Set with avatarUrl: how the picture is cropped ("mascot" with no picture). */
  avatarCrop?: BotAvatarCrop;
}

export interface TeamSetupOperation {
  action: "create" | "update";
  botId: string;
  threadId?: string;
  fields: TeamSetupFields;
  expectedRevision?: string;
}

export interface TeamSetupResult {
  state: "applied" | "denied" | "cancelled" | "failed";
  bots: Array<{ id: string; name: string; action: "created" | "updated" | "deleted"; section?: string; modelSelection?: ModelSelection; chiefOfStaff?: boolean }>;
  newTeams: string[];
  error?: string;
}

/** The complete, reviewed operation. It never accepts executable permissions. */
export interface TeamSetupRequest {
  version: 1;
  requestId: string;
  botId: string;
  threadId: string;
  reason: string;
  createdAt: number;
  requesterRevision: string;
  operations: TeamSetupOperation[];
  newTeams: string[];
  deletion?: { botId: string; name: string; expectedRevision: string };
  result?: TeamSetupResult;
  resumed?: boolean;
  /** Set when the setup applied on its own (direct-apply.ts) and Undo can reverse it. */
  undo?: TeamSetupUndo;
}

/** Undo deletes the bots a setup created while still unused, gives each updated bot back the values the card showed and
 * the Chief its earlier teams; `revisions` pin every bot it touched as it applied, so a later change refuses Undo. */
export interface TeamSetupUndo {
  created: string[];
  before: Array<{ botId: string; fields: TeamSetupFields; managedSections?: string[] | null }>;
  revisions: Record<string, string>;
}

/** A new bot gets no cloud computer until the person writes in its chat, unless it is set to work on one (it then starts one on its first turn), uses a VPS or the team's computer. */
export function startsWithoutCloudComputer(bot: { computer?: string; cloudBackend?: string }, place: { cloudOn: boolean; teamComputer: boolean }): boolean {
  return place.cloudOn && !place.teamComputer && bot.cloudBackend !== "vps" && bot.computer !== "cloud";
}

/** Told to a Chief about a bot it just made that has no cloud computer of its own yet. */
export function noCloudComputerNote(name: string): string {
  return ` @${name} has no cloud computer yet: work you hand it runs without one until the person writes to it in its own chat, which sets one up. If its first job needs a computer, tell the person that in one line.`;
}

/** The Chief's resumed turn once its team setup card is decided. `lacksComputer` names newly created bots with no cloud computer yet. */
export function teamSetupDecisionText(request: TeamSetupRequest, lacksComputer: (botId: string) => boolean): string {
  const bare = request.result?.state === "applied" ? request.result.bots.filter((bot) => bot.action === "created" && lacksComputer(bot.id)) : [];
  return `OpenMausBot team setup decision ${request.requestId}: ${JSON.stringify(request.result)}. Report this exact result and continue the user's already requested work. Do not ask for confirmation again or repeat this setup/deletion. A denied or cancelled operation did not authorize any substitute action. Existing thread models were not changed.${bare.map((bot) => noCloudComputerNote(bot.name)).join("")}`;
}
