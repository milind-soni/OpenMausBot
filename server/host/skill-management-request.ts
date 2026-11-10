import type { DirectApply } from "../direct-apply.ts";
import { isSkillManagementAction } from "../../shared/skill-request.ts";
import { isSkillName } from "../../shared/skill-md.ts";
import type { BotRecord } from "../store.ts";
import type { SkillsLibraryHost } from "./skills-library.ts";

export function skillManagementRequest(
  host: Pick<SkillsLibraryHost, "transferMaintainer" | "manageAssignment">,
  from: BotRecord, threadId: string, body: Record<string, unknown>, direct: DirectApply | null,
): [number, Record<string, unknown>] {
  const name = typeof body.skill_name === "string" ? body.skill_name.trim() : "";
  const target = typeof body.target_bot_id === "string" ? body.target_bot_id.trim() : "";
  const revision = typeof body.base_revision === "string" ? body.base_revision.trim() : "";
  if (!isSkillManagementAction(body.action) || !isSkillName(name) || !target || !revision) return [400, { state: "failed", error: "a valid skill_name, target_bot_id and the management_revision from skills_list are required" }];
  return body.action === "transfer_maintainer"
    ? host.transferMaintainer(from, threadId, name, target, revision, direct)
    : host.manageAssignment(from, threadId, body.action, name, target, revision, direct);
}
