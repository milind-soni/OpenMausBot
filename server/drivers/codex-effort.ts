// The Codex effort menu: the CLI's own per-model `supportedReasoningEfforts` wins when it announces
// them; the union becomes the menu. Fallback covers codex-cli ≥0.171.0, which accepts "ultra" on many models.
import { EFFORT_LEVELS, type EffortLevel } from "../../shared/wire.ts";
import { codexTierOf } from "./codex-tier.ts";

export function codexEffortTracker(models: () => { options: ReadonlyArray<{ id: string; efforts?: readonly EffortLevel[] }> }) {
  const codexEffortLevels: EffortLevel[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
  const syncEffortCapability = (catalog: { options: ReadonlyArray<{ efforts?: readonly EffortLevel[] }> }) => {
    const union = new Set<EffortLevel>();
    for (const option of catalog.options) for (const level of option.efforts ?? []) union.add(level);
    if (!union.size) return;
    codexEffortLevels.length = 0;
    codexEffortLevels.push(...EFFORT_LEVELS.filter((level) => union.has(level)));
  };
  /** Models that stop below the chosen effort (gpt-6-luna tops out at "max") keep the CLI's own top level. */
  const supportedEffort = (model: string | null | undefined, effort: EffortLevel): EffortLevel => {
    const base = model ? codexTierOf(model)?.model ?? model : model;
    const efforts = base ? models().options.find((option) => option.id === base)?.efforts : undefined;
    return efforts && !efforts.includes(effort) ? efforts[efforts.length - 1]! : effort;
  };
  return { codexEffortLevels, syncEffortCapability, supportedEffort };
}
