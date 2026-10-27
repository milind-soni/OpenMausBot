// No bulk route on purpose: each bot goes through its own panel's request, so every per-bot server check still applies.
import { t } from "@/lib/i18n";
import { threadApprovalModes, type Bot, type InstanceInfo } from "@/state/store";
import type { BotUpdatePatch } from "@/state/bot-patch-queue";
import { approvalModeFor, supportsApprovalMode, type ApprovalMode } from "../../shared/approval-mode";
import type { EffortLevel, ModelSelection } from "../../shared/wire";

/** Custom is per bot: it can only be granted through the desktop's confirmation for that one bot. */
export const TEAM_APPROVAL_MODES = ["ask", "edits", "auto", "full"] as const satisfies readonly ApprovalMode[];
export type TeamApprovalMode = (typeof TEAM_APPROVAL_MODES)[number];

export type TeamChange =
  | { kind: "approval"; mode: TeamApprovalMode }
  | { kind: "model"; model?: string; effort?: EffortLevel | null };

export type TeamPlanRow =
  | { bot: Bot; status: "apply"; patch: BotUpdatePatch }
  | { bot: Bot; status: "unchanged" }
  | { bot: Bot; status: "skip"; reason: string };

export type TeamResultRow =
  | { bot: Bot; status: "applied" }
  | { bot: Bot; status: "unchanged" }
  | { bot: Bot; status: "skipped"; reason: string };

export function teamBots(bots: readonly Bot[], team: string): Bot[] {
  const name = team.trim();
  return bots.filter((bot) => !bot.hidden && (bot.section?.trim() || "") === name);
}

const engineOf = (bot: Bot, instances: readonly InstanceInfo[]) =>
  instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);

export function teamModeOffered(driverKind: string | undefined, mode: TeamApprovalMode): boolean {
  return supportsApprovalMode(driverKind, mode) && !(driverKind === "antigravityAgent" && mode === "auto");
}

export function teamModelChoices(bots: readonly Bot[], instances: readonly InstanceInfo[]): Array<{ id: string; label: string; engines: string[] }> {
  const choices = new Map<string, { id: string; label: string; engines: string[] }>();
  const seen = new Set<string>();
  for (const bot of bots) {
    const engine = engineOf(bot, instances);
    if (!engine || seen.has(engine.instanceId)) continue;
    seen.add(engine.instanceId);
    const ids = [engine.models.default, ...engine.models.options.map((option) => option.id)].filter((id) => id.trim());
    for (const id of new Set(ids)) {
      const label = engine.models.options.find((option) => option.id === id)?.label ?? id;
      const entry = choices.get(id) ?? { id, label, engines: [] };
      if (!entry.engines.includes(engine.displayName)) entry.engines.push(engine.displayName);
      choices.set(id, entry);
    }
  }
  return [...choices.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function teamEffortChoices(bots: readonly Bot[], instances: readonly InstanceInfo[], order: readonly EffortLevel[]): EffortLevel[] {
  const offered = new Set<EffortLevel>();
  for (const bot of bots) {
    const engine = engineOf(bot, instances);
    if (engine?.capabilities?.modelVariants) continue;
    for (const level of engine?.capabilities?.effortLevels ?? []) offered.add(level);
  }
  return order.filter((level) => offered.has(level));
}

export function planTeamChange(bots: readonly Bot[], instances: readonly InstanceInfo[], change: TeamChange): TeamPlanRow[] {
  return bots.map((bot): TeamPlanRow => {
    const engine = engineOf(bot, instances);
    const engineName = engine?.displayName ?? bot.modelSelection.instanceId;
    if (change.kind === "approval") {
      if ([approvalModeFor(bot), ...threadApprovalModes(bot)].every((mode) => mode === change.mode)) return { bot, status: "unchanged" };
      if (!teamModeOffered(engine?.driverKind, change.mode)) {
        return { bot, status: "skip", reason: t("teamSettings.skip.modeUnsupported", { engine: engineName }) };
      }
      return { bot, status: "apply", patch: { approvalMode: change.mode, applyToAllThreads: true } };
    }
    const current = bot.modelSelection;
    if (!engine) return { bot, status: "skip", reason: t("teamSettings.skip.engineMissing") };
    const model = change.model ?? current.model;
    const offered = model === engine.models.default || engine.models.options.some((option) => option.id === model);
    if (!offered) return { bot, status: "skip", reason: t("teamSettings.skip.modelUnsupported", { engine: engineName, model }) };
    const next: ModelSelection = { instanceId: current.instanceId, model };
    if (current.variant && model === current.model) next.variant = current.variant;
    if (change.effort === undefined) {
      if (current.effort) next.effort = current.effort;
    } else if (change.effort !== null) {
      if (engine.capabilities?.modelVariants) {
        return { bot, status: "skip", reason: t("teamSettings.skip.variantsOnly", { engine: engineName }) };
      }
      if (!(engine.capabilities?.effortLevels ?? []).includes(change.effort)) {
        return { bot, status: "skip", reason: t("teamSettings.skip.effortUnsupported", { engine: engineName }) };
      }
      next.effort = change.effort;
      delete next.variant;
    }
    if (next.model === current.model && next.effort === current.effort && next.variant === current.variant) {
      return { bot, status: "unchanged" };
    }
    if (bot.busy) return { bot, status: "skip", reason: t("teamSettings.skip.busy") };
    return { bot, status: "apply", patch: { modelSelection: next, keepThreadModels: true } };
  });
}

export function planNeedsLocalAutoConsent(plan: readonly TeamPlanRow[]): boolean {
  return plan.some((row) => row.status === "apply" && row.patch.approvalMode === "auto" && row.bot.computer === "local");
}

/** One bot at a time, never in parallel: a refusal on one must not race the next. */
export async function applyTeamPlan(
  plan: readonly TeamPlanRow[],
  persist: (bot: Bot, patch: BotUpdatePatch) => Promise<unknown>,
  options: { acknowledgeLocalAuto?: boolean; onProgress?: (done: number) => void } = {},
): Promise<TeamResultRow[]> {
  const results: TeamResultRow[] = [];
  for (const row of plan) {
    if (row.status === "unchanged") results.push({ bot: row.bot, status: "unchanged" });
    else if (row.status === "skip") results.push({ bot: row.bot, status: "skipped", reason: row.reason });
    else {
      const patch = options.acknowledgeLocalAuto && row.patch.approvalMode === "auto" && row.bot.computer === "local"
        ? { ...row.patch, acknowledgeLocalAuto: true } : row.patch;
      try {
        await persist(row.bot, patch);
        results.push({ bot: row.bot, status: "applied" });
      } catch (cause) {
        results.push({ bot: row.bot, status: "skipped", reason: cause instanceof Error ? cause.message : String(cause) });
      }
    }
    options.onProgress?.(results.length);
  }
  return results;
}

export function teamResultCounts(results: readonly TeamResultRow[]): { applied: number; unchanged: number; skipped: number } {
  return {
    applied: results.filter((row) => row.status === "applied").length,
    unchanged: results.filter((row) => row.status === "unchanged").length,
    skipped: results.filter((row) => row.status === "skipped").length,
  };
}
