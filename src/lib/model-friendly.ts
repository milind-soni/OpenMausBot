// Plain words for the model picker's Simple view. Nothing here changes what
// is sent to a provider: the friendly names map one-to-one onto the real
// effort levels, and a blurb is only a hover hint on a model's row.
import type { EffortLevel } from "../../shared/wire";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

const FRIENDLY_EFFORT: Record<EffortLevel, LocaleKey> = {
  none: "model.effort.off",
  low: "model.effort.quick",
  medium: "model.effort.balanced",
  high: "model.effort.deep",
  xhigh: "model.effort.deeper",
  max: "model.effort.max",
};

export function friendlyEffort(level: EffortLevel): string {
  return t(FRIENDLY_EFFORT[level]);
}

/** At most four steps people can tell apart: quick, balanced, deep and the
 * top level the engine offers (max, else xhigh). An engine without those
 * keeps its own first four. The bot's current level always stays visible,
 * so Simple mode never hides a choice that is already in effect. */
export function simpleEffortLevels(levels: readonly EffortLevel[], current: EffortLevel | undefined): EffortLevel[] {
  const top: EffortLevel = levels.includes("max") ? "max" : "xhigh";
  const preferred: EffortLevel[] = ["low", "medium", "high", top];
  let shown = preferred.filter((level) => levels.includes(level));
  if (shown.length === 0) shown = levels.slice(0, 4);
  if (current && levels.includes(current) && !shown.includes(current)) {
    shown = [...shown, current].sort((a, b) => levels.indexOf(a) - levels.indexOf(b));
  }
  return shown;
}

const BLURBS: readonly [RegExp, LocaleKey][] = [
  [/opus/, "model.blurb.smartest"],
  [/sonnet/, "model.blurb.balanced"],
  [/haiku/, "model.blurb.fastest"],
  [/\b(mini|nano|flash|lite)\b|-(mini|nano|flash|lite)\b/, "model.blurb.light"],
];

/** A one-line hint for well-known model families; undefined when the name
 * alone says nothing we can stand behind. */
export function modelBlurb(option: { id: string; label: string }): string | undefined {
  const name = `${option.id} ${option.label}`.toLowerCase();
  const match = BLURBS.find(([pattern]) => pattern.test(name));
  return match ? t(match[1]) : undefined;
}
