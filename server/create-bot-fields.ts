// create_bot's copyFromBotId: a Chief replacing a bot starts the new one from that bot's SOUL.md, role and model.
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";
import type { ModelSelection } from "./contracts.ts";
import { canManage, type RosterMember } from "./peer-roster.ts";

export interface CopySource extends RosterMember {
  soul?: string;
  modelSelection: ModelSelection;
}

export type CreateBotFields =
  | { name: string; role: string; instructions: string; soul: string; modelSelection?: ModelSelection }
  | { status: number; error: string };

/** The new bot's name, role and soul; with copyFromBotId, a bot the Chief manages lends its soul, role and model. */
export function createBotFields(body: Record<string, unknown>, chief: RosterMember, bots: readonly CopySource[]): CreateBotFields {
  const name = String(body.name ?? "").trim();
  const role = String(body.role ?? "").trim();
  const instructions = String(body.instructions ?? "").trim();
  if (body.copyFromBotId === undefined) return { name, role, instructions, soul: instructions };
  const id = typeof body.copyFromBotId === "string" ? body.copyFromBotId.trim() : "";
  const source = bots.find((bot) => bot.id === id);
  if (!source || !canManage(chief, source)) {
    return { status: 404, error: "copy_from_bot_id must be the exact id of a bot you look after; use list_bots" };
  }
  // Extra instructions come after the copied ones, so a handover note can add to them.
  const soul = [(source.soul ?? "").trim(), instructions].filter(Boolean).join("\n\n");
  if (Buffer.byteLength(soul) > BOT_PROFILE_LIMITS.soul) {
    return { status: 400, error: `the copied instructions plus yours are over ${BOT_PROFILE_LIMITS.soul} bytes; shorten instructions` };
  }
  return { name, role: role || source.title?.trim() || "", instructions, soul, modelSelection: source.modelSelection };
}
