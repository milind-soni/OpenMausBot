import type { EffortLevel } from "./wire.ts";

/** The levels a model takes: its own list when its catalog names one, else every level its engine takes. */
export function modelEffortLevels(
  engineLevels: readonly EffortLevel[] | undefined,
  catalog: { options: ReadonlyArray<{ id: string; effortLevels?: readonly EffortLevel[] }> } | undefined,
  model: string,
): readonly EffortLevel[] | undefined {
  return catalog?.options.find((option) => option.id === model)?.effortLevels ?? engineLevels;
}
