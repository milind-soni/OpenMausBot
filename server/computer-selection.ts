/** Which computer select_computer picks for a request, kept free of index.ts
 * so the rule stays unit-testable. */
import type { Surface } from "./surface.ts";

/** One computer select_computer can offer (selectableComputers). */
export interface ComputerOption {
  surface: Surface;
  available: boolean;
  ready: boolean;
  canStart: boolean;
  canCreate: boolean;
}

/** The option a request picks, and whether it is the computer this turn
 * already has. `current` is the turn's mounted place. `startsOnFirstCall`
 * says that place's computer is the one this turn's first computer call
 * creates or wakes (the bot's own cloud computer): it is this turn's before
 * it is up, so asking for it, or for Auto, keeps it instead of restarting
 * the request somewhere else. */
export function pickComputer<T extends ComputerOption>(
  options: readonly T[],
  requested: Surface | "auto",
  current: string | undefined,
  startsOnFirstCall: boolean,
): { option: T | undefined; current: boolean } {
  const isCurrent = (option: T) => option.surface === current && (option.ready || (startsOnFirstCall && option.available));
  const option = requested === "auto"
    ? options.find(isCurrent)
      ?? options.find((candidate) => candidate.ready && candidate.surface === "vm")
      ?? options.find((candidate) => candidate.ready)
      ?? options.find((candidate) => candidate.canStart)
      ?? options.find((candidate) => candidate.canCreate && candidate.surface === "vm")
      ?? options.find((candidate) => candidate.canCreate)
    : options.find((candidate) => candidate.surface === requested);
  return { option, current: option !== undefined && isCurrent(option) };
}
