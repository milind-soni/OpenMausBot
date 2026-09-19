// Skill authoring: listing imported and staged skills, and staging
// SKILL.md writes for the user's review.
import type { Json, ToolContext, ToolHandler, ToolOutcome } from "./context.ts";

export const handlers = {
  async skills_list(_args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const query = new URLSearchParams({ fromBotId: ctx.botId, fromThreadId: ctx.threadId });
    const r = await ctx.api(`/api/internal/skills?${query.toString()}`);
    const skills = Array.isArray(r.skills) ? r.skills : [];
    const staged = Array.isArray(r.staged) ? r.staged : [];
    if (!skills.length && !staged.length) {
      return { text: "This bot has no imported skills and nothing staged. Use skill_manage action=\"create\" for a user-requested skill, then follow its applied or pending result." };
    }
    const live = skills.length
      ? skills.map((skill) => {
        const row = skill as Json;
        // Disabled imports have not been reviewed yet. Never return their
        // description to the authoring model: a hostile description is still
        // prompt content. Names and lifecycle status are sufficient for
        // duplicate detection.
        const editable = row.editable === true;
        const status = row.enabled ? "enabled" : "disabled";
        return `- ${row.name} (${status}, ${editable ? "learned/editable" : "imported"})`;
      }).join("\n")
      : "(none)";
    const pending = staged.length
      ? staged.map((entry) => {
        const row = entry as Json;
        // A pending proposal is also unreviewed. Keep its gist and source out
        // of provider-visible tool output until the person approves it.
        return `- ${row.action} ${row.name}`;
      }).join("\n")
      : "(none)";
    return { text: `Imported skills:\n${live}\n\nStaged (waiting for the user to confirm):\n${pending}` };
  },
  async skill_manage(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    if (args.action !== "create" && args.action !== "update") {
      return { text: 'skill_manage action must be "create" or "update".', isError: true };
    }
    const skillMd = typeof args.skill_md === "string" ? args.skill_md : "";
    if (!skillMd.trim()) {
      return { text: 'skill_manage needs skill_md: the full SKILL.md including YAML frontmatter.', isError: true };
    }
    const source = typeof args.source === "string" ? args.source.trim() : "";
    if (!source) {
      return { text: 'skill_manage needs source: the URL, folder, or "conversation" used to author the skill.', isError: true };
    }
    const skillName = typeof args.skill_name === "string" ? args.skill_name.trim() : "";
    if (args.action === "update" && !skillName) {
      return { text: "skill_manage needs skill_name for an update. Copy the exact name from skills_list.", isError: true };
    }
    const r = await ctx.api("/api/internal/skills/stage", {
      method: "POST",
      body: JSON.stringify({
        fromBotId: ctx.botId,
        fromThreadId: ctx.threadId,
        action: args.action,
        skill_name: skillName || undefined,
        skill_md: skillMd,
        gist: typeof args.gist === "string" ? args.gist : undefined,
        source,
      }),
    });
    const nameLabel = typeof r.name === "string" ? r.name : "the skill";
    const warningText = Array.isArray(r.warnings) && r.warnings.length ? `\n\nScan warnings:\n- ${r.warnings.join("\n- ")}` : "";
    const completed = ctx.completedProposalResult(r, args.action === "update" ? `the update to skill “${nameLabel}”` : `the new skill “${nameLabel}”`);
    if (completed) return { ...completed, text: completed.text + warningText };
    const status = args.action === "update"
      ? "The current version remains unchanged until the user reviews and applies the update."
      : "The skill is staged and inactive until the user reviews and enables it.";
    const proposal = args.action === "update" ? `updating skill “${nameLabel}”` : `new skill “${nameLabel}”`;
    return {
      text: `A confirmation card is now visible to the user for ${proposal}.${warningText}\n\n${status} End this turn and wait for the decision.`,
    };
  },
} satisfies Record<string, ToolHandler>;
