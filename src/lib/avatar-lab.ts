import {
  MAUS_COLOR_NAMES,
  PICKABLE_STATES,
  type MausColor,
  type MausState,
} from "./mascot";
import {
  MASCOT_BODY_IDS,
  type MascotBodyId,
} from "../../shared/mascot-bodies";

/**
 * Hexagon remains a valid stored value for backward compatibility, but it is
 * intentionally absent from the picker. Moon was never part of the official
 * generated catalog.
 */
export const AVATAR_LAB_BODY_IDS = MASCOT_BODY_IDS.filter(
  (id): id is Exclude<MascotBodyId, "hexagon"> => id !== "hexagon",
);

export interface AvatarLabDraft {
  bodyId: MascotBodyId;
  color: MausColor;
  expression: MausState;
}

/** Randomizes only choices that the dialog visibly offers. */
export function randomizeAvatarLabDraft(
  draft: AvatarLabDraft,
  random: () => number = Math.random,
): AvatarLabDraft {
  const pickDifferent = <T,>(items: readonly T[], current: T) => {
    const alternatives = items.filter((item) => item !== current);
    return alternatives[Math.min(alternatives.length - 1, Math.floor(random() * alternatives.length))] ?? current;
  };
  return {
    bodyId: pickDifferent(AVATAR_LAB_BODY_IDS, draft.bodyId),
    color: pickDifferent(MAUS_COLOR_NAMES, draft.color),
    expression: pickDifferent(PICKABLE_STATES, draft.expression),
  };
}
