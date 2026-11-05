import { HALLOWEEN_BODIES } from "../../shared/halloween-bodies";
import { MASCOT_BODIES } from "../../shared/mascot-bodies";
import type { BotBodyId } from "../../shared/bot-body";
import type { MausColor } from "../../shared/wire";
import { t } from "@/lib/i18n";
import { en, type LocaleKey } from "@/locales";

const BODIES = [...Object.values(MASCOT_BODIES), ...Object.values(HALLOWEEN_BODIES)];

const named = (key: string, fallback: string): string => Object.hasOwn(en, key) ? t(key as LocaleKey) : fallback;

export const bodyName = (id: BotBodyId): string =>
  named(`mascot.body.${id}`, BODIES.find((body) => body.id === id)?.name ?? id);
export const colorName = (color: MausColor): string => named(`mascot.color.${color}`, color);
export const expressionName = (state: string): string => named(`mascot.expression.${state}`, state);

export function silhouetteName(name: string): string {
  const body = BODIES.find((candidate) => candidate.name === name);
  return body ? bodyName(body.id) : name;
}

export const mascotLabel = (silhouette: string): string => t("mascot.label", { name: silhouetteName(silhouette) });
