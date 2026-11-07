import { cloudHomeOffersPlace } from "../../shared/cloud-home";
import { toolSurfaceKind } from "../../shared/tool-surface";
import type { Bot, Task } from "@/state/store";
import type { LocaleKey } from "@/locales";

export type Place = "cloud" | "vm" | "local" | "browser";
export const PLACES: readonly Place[] = ["cloud", "vm", "local", "browser"];
export type EffectivePlace = Place | "auto" | "off";

export function placeOffered(place: Place, config: { cloudHome?: boolean } | null | undefined): boolean {
  return !config?.cloudHome || cloudHomeOffersPlace(place);
}

export function effectivePlace(bot: Pick<Bot, "computer">, task?: Pick<Task, "surface"> | null): EffectivePlace {
  if (bot.computer === "off") return "off";
  return task?.surface ?? bot.computer ?? "auto";
}

/** The place the person pinned this conversation to; a place Auto picked and recorded for it is not their pin. */
export function personPin(task?: Pick<Task, "surface" | "surfaceAuto"> | null): Place | undefined {
  return task?.surfaceAuto ? undefined : task?.surface;
}

export function isComputerPlace(place: EffectivePlace): place is "cloud" | "vm" | "local" {
  return place === "cloud" || place === "vm" || place === "local";
}

export function placeLabelKey(place: EffectivePlace): LocaleKey {
  return `place.${place}` as LocaleKey;
}

export function toolPlace(toolName: string, effective: EffectivePlace): Place | null {
  const kind = toolSurfaceKind(toolName);
  if (kind === "browser") return "browser";
  if (kind === "computer") return isComputerPlace(effective) ? effective : null;
  return null;
}

/** Whether a running tool call is using the bot's screen (its browser or computer) right now, so the chat can offer
 * to watch it. Only the live calls matter, and they sit at the end of the transcript. */
export function screenToolLive(messages: readonly { id: string; tool?: { name: string } | null }[], liveTools: ReadonlySet<string>, effective: EffectivePlace): boolean {
  let left = liveTools.size;
  for (let index = messages.length - 1; index >= 0 && left > 0; index--) {
    const message = messages[index];
    if (!liveTools.has(message.id)) continue;
    left--;
    if (message.tool && toolPlace(message.tool.name, effective)) return true;
  }
  return false;
}
