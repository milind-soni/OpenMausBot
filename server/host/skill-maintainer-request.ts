import type { DirectApply } from "../direct-apply.ts";
import type { BotRecord } from "../store.ts";

export function skillMaintainerRequest(
  host: { transferMaintainer(from: BotRecord, threadId: string, name: string, targetId: string, revision: string, direct: DirectApply | null): [number, Record<string, unknown>] },
  from: BotRecord, threadId: string, body: Record<string, unknown>, direct: DirectApply | null,
): [number, Record<string, unknown>] {
  const name = typeof body.skill_name === "string" ? body.skill_name.trim() : "";
  const target = typeof body.target_bot_id === "string" ? body.target_bot_id.trim() : "";
  const revision = typeof body.base_revision === "string" ? body.base_revision.trim() : "";
  if (!name || !target || !revision) return [400, { state: "failed", error: "skill_name, target_bot_id and the management_revision from skills_list are required" }];
  return host.transferMaintainer(from, threadId, name, target, revision, direct);
}
