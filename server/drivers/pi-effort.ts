// pi's effort menu and the shared union's mapping onto it: pi rejects an unsupported level and the
// turn keeps the engine default; it has no "ultra" thinking level and tops out at "max".
import { EFFORT_LEVELS, type EffortLevel } from "../../shared/wire.ts";

export const PI_EFFORT_LEVELS: readonly EffortLevel[] = ["none", "low", "medium", "high", "xhigh", "max"];

export function piThinkingLevel(effort: EffortLevel): (typeof EFFORT_LEVELS)[number] | "off" {
  return effort === "none" ? "off" : effort;
}
