// One place per conversation: where a bot's hands land, as the person sees
// it. The server decides what a turn mounts (server/surface.ts); this is the
// renderer's reading of the same facts, for the composer chip, the panel
// tabs and the place icon on a tool chip.
import { toolSurfaceKind } from "../../shared/tool-surface";
import type { Bot, Task } from "@/state/store";
import type { LocaleKey } from "@/locales";

export type Place = "cloud" | "vm" | "local" | "browser";
export const PLACES: readonly Place[] = ["cloud", "vm", "local", "browser"];
/** What the chip shows: a place, the bot's Auto, or Off. */
export type EffectivePlace = Place | "auto" | "off";

/** The conversation's pin wins over the bot's Works on, except Off, exactly
 * as the server resolves it. */
export function effectivePlace(bot: Pick<Bot, "computer">, task?: Pick<Task, "surface"> | null): EffectivePlace {
  if (bot.computer === "off") return "off";
  return task?.surface ?? bot.computer ?? "auto";
}

export function isComputerPlace(place: EffectivePlace): place is "cloud" | "vm" | "local" {
  return place === "cloud" || place === "vm" || place === "local";
}

export function placeLabelKey(place: EffectivePlace): LocaleKey {
  return `place.${place}` as LocaleKey;
}

/** The place a tool chip should carry: the browser for browser tools, the
 * conversation's computer for computer tools, nothing for everything else.
 * A computer tool on an unpinned Auto conversation has no known place yet. */
export function toolPlace(toolName: string, effective: EffectivePlace): Place | null {
  const kind = toolSurfaceKind(toolName);
  if (kind === "browser") return "browser";
  if (kind === "computer") return isComputerPlace(effective) ? effective : null;
  return null;
}
