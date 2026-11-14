import type { EffortLevel } from "./wire.ts";

export function modelEffortLevels(model: string, engine: {
  models?: { options: readonly { id: string; effortLevels?: readonly EffortLevel[] }[] };
  capabilities?: { effortLevels?: readonly EffortLevel[] };
}): readonly EffortLevel[] {
  const offered = engine.capabilities?.effortLevels ?? [];
  const levels = engine.models?.options.find((option) => option.id === model)?.effortLevels;
  return levels === undefined ? offered : offered.filter((level) => levels.includes(level));
}
