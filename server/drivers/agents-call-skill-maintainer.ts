import type { Json, HarnessClient } from "./agents-client.ts";

export async function callSkillMaintainer(args: Json, client: HarnessClient, botId: string, threadId: string): Promise<{ text: string; isError?: boolean }> {
  const skillName = typeof args.skill_name === "string" ? args.skill_name.trim() : "";
  const target = typeof args.target_bot_id === "string" ? args.target_bot_id.trim() : "";
  const revision = typeof args.base_revision === "string" ? args.base_revision.trim() : "";
  if (!skillName || !target || !revision) return { text: "transfer_maintainer requires skill_name, target_bot_id and the management_revision from skills_list as base_revision.", isError: true };
  const response = await client.apiResponse("/api/internal/skills/stage", { method: "POST", body: JSON.stringify({
    fromBotId: botId, fromThreadId: threadId, action: "transfer_maintainer", skill_name: skillName,
    target_bot_id: target, base_revision: revision,
  }) });
  if (!response.ok) return { text: String(response.body.error ?? "The maintainer transfer failed. List the skill before retrying."), isError: true };
  const result = response.body.result;
  if (response.body.state !== "applied" || !result || typeof result !== "object" || Array.isArray(result)) {
    return { text: "The maintainer transfer did not return a verified result. List the skill before retrying.", isError: true };
  }
  return { text: `Maintainer designated for skill ${JSON.stringify(skillName)}. Result: ${JSON.stringify(result)}. Scope, assignments, enabled state, package and execution permissions were not changed. List the skill again to verify.` };
}
