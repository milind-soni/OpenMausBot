import { MENTION_PICKS_MAX, resolveMentions } from "../../shared/room-mentions";

type Picked = { id: string; name: string };

const picksByDraft = new Map<string, Picked[]>();
const pickedNames = new Map<string, string>();

/** The bots a person chose from the @ list while writing one draft. A send carries the ids of those its text still
 * @-tags, so the chosen bot is the one reached even when another bot has the same name. */
export function mentionPicksFor(draftId: string) {
  return {
    pick(choice: { id: string; name: string; bot?: unknown }): void {
      if (!choice.bot) return;
      pickedNames.set(choice.id, choice.name);
      const kept = (picksByDraft.get(draftId) ?? []).filter((one) => one.id !== choice.id);
      picksByDraft.set(draftId, [...kept, { id: choice.id, name: choice.name }]);
    },
    ids(text: string): string[] {
      const picks = picksByDraft.get(draftId) ?? [];
      if (!picks.length) return [];
      return resolveMentions(text, picks, picks.map((one) => one.id)).bots.map((one) => one.id).slice(0, MENTION_PICKS_MAX);
    },
    clear(): void {
      picksByDraft.delete(draftId);
    },
  };
}

/** A send that failed hands its words back to the draft, and its picks with them. */
export function restoreMentionPicks(draftId: string, ids: readonly string[] | undefined): void {
  const picks = mentionPicksFor(draftId);
  for (const id of ids ?? []) {
    const name = pickedNames.get(id);
    if (name !== undefined) picks.pick({ id, name, bot: true });
  }
}
