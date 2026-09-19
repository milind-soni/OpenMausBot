// Skill listing and staged skill writes. Bodies moved verbatim from
// ../internal.ts; the dispatch chain there owns order.
import type { ServerResponse } from "node:http";

import { DATA_DIR, skillAuthoringEnabled } from "../../config.ts";
import { appendDecision } from "../../decision-log.ts";
import { learnSource } from "../../skill-learn.ts";
import { applySkillWriteWithReceipt, listSkills, listStagedSkillWrites, rejectStagedSkillWrite, stageSkillWrite } from "../../skills.ts";
import type { InternalRoutesOptions } from "../internal.ts";
import type { InternalRequestCtx } from "./types.ts";

export type SkillsCtx = InternalRequestCtx & {
  cfg: InternalRoutesOptions["cfg"];
  connectorThread: InternalRoutesOptions["connectorThread"];
  skillProposalPersistence: InternalRoutesOptions["skillProposalPersistence"];
  appendSkillRequestCard: InternalRoutesOptions["appendSkillRequestCard"];
  fullAccessForSource: InternalRoutesOptions["fullAccessForSource"];
  stagedSkillListing: InternalRoutesOptions["stagedSkillListing"];
}

export async function skillsList(ctx: SkillsCtx, res: ServerResponse): Promise<boolean> {
  const {
    cfg, stagedSkillListing, connectorThread, internalCapability, internalSender, json,
  } = ctx;
    if (!skillAuthoringEnabled(cfg)) return json(res, 403, { error: "skill authoring is not enabled in Settings" });
    if (!internalCapability.skillAuthoring) {
      return json(res, 403, { error: "skill authoring is not enabled for this turn" });
    }
    const from = internalSender;
    const fromThreadId = internalCapability.threadId;
    if (!connectorThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    return json(res, 200, {
      skills: listSkills(from.id),
      staged: listStagedSkillWrites(from.id).map(stagedSkillListing),
    });
}

export async function skillsStage(ctx: SkillsCtx, res: ServerResponse): Promise<boolean> {
  const {
    cfg, skillProposalPersistence, appendSkillRequestCard, fullAccessForSource, connectorThread,
    internalCapability, internalSender, json, readInternalBody,
  } = ctx;
    if (!skillAuthoringEnabled(cfg)) return json(res, 403, { error: "skill authoring is not enabled in Settings" });
    if (!internalCapability.skillAuthoring) {
      return json(res, 403, { error: "skill authoring is not enabled for this turn" });
    }
    const body = await readInternalBody();
    const from = internalSender;
    const fromThreadId = internalCapability.threadId;
    if (!connectorThread(from.id, fromThreadId)) {
      return json(res, 403, { error: "source conversation does not belong to sender" });
    }
    const persistence = skillProposalPersistence(from.id, fromThreadId);
    if (!persistence.ok) return json(res, persistence.status, { error: persistence.error });
    const action = body.action === "create" || body.action === "update" ? body.action : "";
    if (!action) return json(res, 400, { error: 'action must be "create" or "update"' });
    const skillMd = typeof body.skill_md === "string" ? body.skill_md : "";
    if (!skillMd.trim()) {
      return json(res, 400, { error: 'skill_manage needs skill_md: the full SKILL.md including YAML frontmatter, for example ---\\nname: file-expense\\ndescription: Files an expense in the company portal.\\n---\\n\\n# File expense\\n' });
    }
    const source = typeof body.source === "string" ? body.source.trim() : "";
    if (!source) return json(res, 400, { error: 'source must be a URL, folder, or "conversation"' });
    const targetName = typeof body.skill_name === "string" ? body.skill_name.trim() : "";
    if (action === "update" && !targetName) {
      return json(res, 400, { error: "skill_name is required when action is update" });
    }
    const staged = stageSkillWrite(from.id, {
      action,
      targetName: targetName || undefined,
      files: [{ path: "SKILL.md", content: skillMd }],
      gist: typeof body.gist === "string" ? body.gist : undefined,
      source: learnSource(source),
    });
    if ("error" in staged) return json(res, 422, { error: staged.error });
    if (fullAccessForSource(from.id, fromThreadId)) {
      const applied = applySkillWriteWithReceipt(from.id, staged, () => {
        const receipt = appendSkillRequestCard({ botId: from.id, threadId: fromThreadId, staged, applied: true });
        appendDecision(DATA_DIR, { threadId: fromThreadId, requestId: receipt.requestId, botId: from.id, botName: from.name,
          tool: "stage_skill", summary: receipt.summary, decision: "auto-approved", source: "full-access" });
      });
      if ("error" in applied) {
        rejectStagedSkillWrite(from.id, staged.id);
        return json(res, 422, { state: "failed", error: applied.error });
      }
      return json(res, 201, { state: "applied", stagedId: staged.id, name: staged.name, action: staged.action,
        gist: staged.gist, warnings: staged.warnings, ...applied, summary: `Skill ${staged.name} ${staged.action === "create" ? "enabled" : "updated"}.` });
    }
    let card: ReturnType<typeof appendSkillRequestCard>;
    try {
      card = appendSkillRequestCard({ botId: from.id, threadId: fromThreadId, staged });
    } catch (error) {
      rejectStagedSkillWrite(from.id, staged.id);
      throw error;
    }
    appendDecision(DATA_DIR, {
      threadId: fromThreadId,
      requestId: card.requestId,
      botId: from.id,
      botName: from.name,
      tool: "stage_skill",
      summary: card.summary,
      decision: "card-shown",
      source: "skill",
    });
    return json(res, 201, {
      state: "pending",
      stagedId: staged.id,
      name: staged.name,
      action: staged.action,
      gist: staged.gist,
      warnings: staged.warnings,
      summary: card.summary,
    });
}

