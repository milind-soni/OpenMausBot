// Where things are in the app, as a bot tells the person: only places from Settings' own index (shared/settings-places.ts),
// so a bot never sends someone to a menu that does not exist.
import { SETTINGS_HOW_TO_OPEN, SETTINGS_PLACES, type SettingsPlace, type SettingsPlaceId } from "../../shared/settings-places.ts";

const PLACES: readonly SettingsPlace[] = SETTINGS_PLACES;
const byId = new Map(PLACES.map((place) => [place.id, place]));

function described(place: SettingsPlace): string {
  const notes = [
    ...(place.advanced ? [place.simplePath ? `in Simple mode it is at ${place.simplePath}` : "shown in Advanced mode only; app_settings set appearance.advanced true turns it on"] : []),
    ...(place.only ? [`only in ${place.only}`] : []),
  ];
  return notes.length ? `${place.path} (${notes.join("; ")})` : place.path;
}

/** The place's path, with when only Advanced mode or one kind of place shows it. */
export const placePath = (id: SettingsPlaceId): string => described(byId.get(id)!);

/** The places whose words, path or id match `query`, best first. */
export function findPlaces(query: string, limit = 6): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}&'-]+/u).filter((word) => word.length > 1);
  if (!words.length) return [];
  const phrase = words.join(" ");
  return PLACES.map((place) => {
    const path = place.path.toLowerCase();
    const whole = place.words.includes(phrase) || path.endsWith(phrase) ? 10 : 0;
    const score = words.reduce((sum, word) => sum + (place.words.includes(word) ? 3 : path.includes(word) || place.words.some((one) => one.includes(word)) ? 1 : 0), whole);
    return { place, score };
  }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((hit) => described(hit.place));
}

/** Every place, one per line, after how Settings opens: for directions no setting covers. */
export function placesList(): string {
  return [SETTINGS_HOW_TO_OPEN, ...PLACES.map(described)].join("\n");
}
