import type { Routine } from "@/lib/routines";
import { api, type Action, type Bot, type Group } from "@/state/store";

export interface AddedTemplate {
  bots: Bot[];
  groups?: Group[];
  routines?: Routine[];
  connections?: unknown[];
  presets?: unknown[];
  /** The first visible bot, now selected. */
  first?: Bot;
}

/** Adds a previewed template alongside everything already here, and selects its first bot. The server keeps the rules:
 * new records only, skills off, routines paused. */
export async function addTemplate(manifest: unknown, dispatch: (action: Action) => void): Promise<AddedTemplate> {
  // SAFETY: this endpoint is owned by the app and returns the imported records.
  const response = (await api("/api/teams/import?mode=add", { method: "POST", body: JSON.stringify(manifest) })) as AddedTemplate;
  for (const bot of response.bots) dispatch({ type: "botAdded", bot });
  for (const group of response.groups ?? []) dispatch({ type: "groupPatched", group });
  for (const routine of response.routines ?? []) dispatch({ type: "routinePatched", routine });
  const first = response.bots.find((bot) => !bot.hidden);
  if (first) dispatch({ type: "select", id: first.id });
  return { ...response, ...(first ? { first } : {}) };
}
