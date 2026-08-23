import type { EffortLevel } from "../../server/contracts.ts";

export interface ModelEffortOption {
  id: string;
  effortLevels?: readonly EffortLevel[];
}

export function effortLevelsForModel(
  options: readonly ModelEffortOption[],
  model: string,
  driverLevels: readonly EffortLevel[] | undefined,
): readonly EffortLevel[] | undefined {
  return options.find((option) => option.id === model)?.effortLevels ?? driverLevels;
}

export function clearUnsupportedEffort<T extends { model: string; effort?: EffortLevel }>(
  selection: T,
  options: readonly ModelEffortOption[],
  driverLevels: readonly EffortLevel[] | undefined,
): T {
  const levels = effortLevelsForModel(options, selection.model, driverLevels);
  return selection.effort && !levels?.includes(selection.effort) ? { ...selection, effort: undefined } : selection;
}
