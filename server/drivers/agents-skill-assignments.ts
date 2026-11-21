import type { SkillAssignmentAction } from "../../shared/skill-assignment.ts";
import type { HarnessClient, Json } from "./agents-client.ts";

type SkillContext = { botId: string; threadId: string; client: Pick<HarnessClient, "apiResponse"> };

function field(args: Json, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value.trim() : "";
}

export async function callSkillAssignmentList(args: Json, { client, botId, threadId }: SkillContext) {
  const target = field(args, "target_bot_id");
  if (!target) return null;
  const query = new URLSearchParams({ fromBotId: botId, fromThreadId: threadId, target_bot_id: target });
  const name = field(args, "query");
  if (name) query.set("query", name);
  const response = await client.apiResponse(`/api/internal/skills?${query.toString()}`);
  if (!response.ok) return { text: String(response.body.error ?? "Could not list the target's skill assignments."), isError: true };
  return { text: JSON.stringify(response.body) };
}

export async function callSkillAssignment(action: SkillAssignmentAction, args: Json, { client, botId, threadId }: SkillContext) {
  const name = field(args, "skill_name"), target = field(args, "target_bot_id"), revision = field(args, "base_revision");
  if (!name || !target || !revision) {
    return { text: "Call skills_list with target_bot_id first, then pass skill_name, target_bot_id and management_revision as base_revision.", isError: true };
  }
  const response = await client.apiResponse("/api/internal/skills/stage", { method: "POST", body: JSON.stringify({
    fromBotId: botId, fromThreadId: threadId, action, skill_name: name, target_bot_id: target, base_revision: revision,
  }) });
  const result = response.body.result;
  if (!response.ok || response.body.state !== "applied" || !result || typeof result !== "object" || Array.isArray(result)) {
    return { text: String(response.body.error ?? "Assignment not verified. List the target before retrying."), isError: true };
  }
  return { text: `Verified assignment result: ${JSON.stringify(result)}. Library scope, opt-outs, private skills and execution permissions are unchanged.` };
}
