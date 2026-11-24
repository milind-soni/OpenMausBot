// Which saved config fields can change what an engine's status read reports. Saving any other field makes every
// engine probe its CLI again on the next read, so the fields listed here are the ones known not to: what the app
// shows, and text and names that go into prompts and labels. A field missing from the list, such as one added later,
// counts as one that can.

const WHOLE = "whole";

const NO_ENGINE_EFFECT: Readonly<Record<string, typeof WHOLE | ReadonlySet<string>>> = {
  language: WHOLE,
  computerName: WHOLE,
  everyBotRules: WHOLE,
  onboarding: new Set(["completedAt", "version", "reelSeen", "hintsSeen", "firstTurnAt"]),
  profile: new Set(["name", "email", "aboutMe", "avatarUrl"]),
  features: new Set(["showToolCalls"]),
};

/** False only when every field the patch sets is known to leave every engine's status as it was. */
export function patchMayChangeEngineStatus(patch: Readonly<Record<string, unknown>>): boolean {
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const known = Object.hasOwn(NO_ENGINE_EFFECT, field) ? NO_ENGINE_EFFECT[field] : undefined;
    if (known === undefined) return true;
    if (known === WHOLE) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
    for (const [inner, innerValue] of Object.entries(value)) {
      if (innerValue !== undefined && !known.has(inner)) return true;
    }
  }
  return false;
}
