import type { Surface } from "./surface.ts";

export interface ComputerOption {
  surface: Surface;
  available: boolean;
  ready: boolean;
  canStart: boolean;
  canCreate: boolean;
}

/** The place a person chose for this conversation: their own pin in it, else the bot's Works on. A pin a turn made on
 * its own is not a choice, and Auto or Off chooses no place. */
export function chosenPlace(task: { surface?: Surface; surfaceSource?: "user" | "auto" } | undefined, worksOn: string | undefined): Surface | undefined {
  if (task?.surface && task.surfaceSource !== "auto") return task.surface;
  return worksOn === "cloud" || worksOn === "vm" || worksOn === "local" || worksOn === "browser" ? worksOn : undefined;
}

/** `startsOnFirstCall`: the turn's first computer call creates or wakes it, so it is this turn's before it is up, and
 * asking for it (or for Auto) keeps it rather than restarting the request elsewhere.
 * `chosen`: the place the person chose. Auto keeps it whenever it can be had, up or not, so a bot never moves their work
 * to another computer on its own; only a request naming another place moves it. Otherwise a private desktop that is set
 * up (up, stopped, or recreatable on this device) comes before waking or creating a cloud computer. */
export function pickComputer<T extends ComputerOption>(
  options: readonly T[],
  requested: Surface | "auto",
  current: string | undefined,
  startsOnFirstCall: boolean,
  chosen?: Surface,
): { option: T | undefined; current: boolean } {
  const isCurrent = (option: T) => option.surface === current && (option.ready || (startsOnFirstCall && option.available));
  const kept = chosen === undefined ? undefined : options.find((candidate) => candidate.surface === chosen && candidate.available);
  const option = requested !== "auto" ? options.find((candidate) => candidate.surface === requested)
    : kept ?? options.find(isCurrent)
      ?? options.find((candidate) => candidate.ready && candidate.surface === "vm")
      ?? options.find((candidate) => candidate.ready)
      ?? options.find((candidate) => candidate.available && candidate.surface === "vm")
      ?? options.find((candidate) => candidate.canStart)
      ?? options.find((candidate) => candidate.canCreate);
  return { option, current: option !== undefined && isCurrent(option) };
}
