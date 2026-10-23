     import { hasAppAutoReview, hasNativeAutoReview, supportsApprovalMode } from "../../shared/approval-mode.ts";
import type { Level, LevelSource, OriginKind } from "./types.ts";

export interface LevelInput {
  own: Level;
  chief?: Level;
  origin: OriginKind;
  chiefLineage: boolean;
  driverKind?: string;
}

 const TRAVELS: readonly Level[] = ["ask", "edits", "auto", "full"];
const rank = (level: Level): number => TRAVELS.indexOf(level);

/** Whether the engine runs a level as that level, not as something weaker
 * dressed up: Full only where the provider (or the harness, for the chat
 * family) answers residual prompts; Auto only where a native or app-owned reviewer
 * decides what is safe; Edits only where an auto-accept-edits mode exists.
 * Every engine asks. */
function engineRuns(level: Level, driverKind: string | undefined): boolean {
  if (level === "full") return supportsApprovalMode(driverKind, "full");
  if (level === "auto") return hasNativeAutoReview(driverKind) || hasAppAutoReview(driverKind);
  if (level === "edits") return supportsApprovalMode(driverKind, "edits");
  return level === "ask";
}

 function engineCap(inherited: Level, driverKind: string | undefined): Level {
  for (let i = rank(inherited); i > 0; i--) {
    if (engineRuns(TRAVELS[i]!, driverKind)) return TRAVELS[i]!;
  }
  return "ask";
}

export function assignmentLevel(input: LevelInput): { level: Level; source: LevelSource } {
  const { own, chief, origin, chiefLineage, driverKind } = input;
  const inherited = chiefLineage && (origin === "person" || origin === "routine") ? chief : undefined;
  if (own === "custom" || inherited === undefined || rank(inherited) <= rank(own)) return { level: own, source: "own" };
  const capped = engineCap(inherited, driverKind);
  if (rank(capped) <= rank(own)) return { level: own, source: "engine_cap" };
  return { level: capped, source: capped === inherited ? "chief" : "engine_cap" };
}
