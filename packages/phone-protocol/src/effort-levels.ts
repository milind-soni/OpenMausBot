import type { EffortLevel } from "./wire.ts";

export interface EffortOfferingInstance {
  models?: { options?: readonly { id: string; effortLevels?: readonly EffortLevel[] }[] };
  capabilities?: { effortLevels?: readonly EffortLevel[] };
  adapter?: { capabilities?: { effortLevels?: readonly EffortLevel[] } };
}

/** Effort levels offered for `model` on `instance`, preferring model-specific levels over instance defaults. */
export function offeredEffortLevels(
  instance: EffortOfferingInstance | null | undefined,
  model: string | undefined,
): readonly EffortLevel[] {
  const option = model ? instance?.models?.options?.find((candidate) => candidate.id === model) : undefined;
  return option?.effortLevels ?? instance?.capabilities?.effortLevels ?? instance?.adapter?.capabilities?.effortLevels ?? [];
}
