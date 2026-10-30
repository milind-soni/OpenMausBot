import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

const BLURBS: readonly [RegExp, LocaleKey][] = [
  [/opus/, "model.blurb.smartest"],
  [/sonnet/, "model.blurb.balanced"],
  [/haiku/, "model.blurb.fastest"],
  [/\b(mini|nano|flash|lite)\b|-(mini|nano|flash|lite)\b/, "model.blurb.light"],
];

export function modelBlurb(option: { id: string; label: string }): string | undefined {
  const name = `${option.id} ${option.label}`.toLowerCase();
  const match = BLURBS.find(([pattern]) => pattern.test(name));
  return match ? t(match[1]) : undefined;
}

export function displayModelLabel(label: string, provider: string, custom = false): string {
  if (custom || !provider || /\d/.test(label) || label.toLowerCase().startsWith(provider.toLowerCase())) return label;
  return `${provider} ${label}`;
}

export function shortModelLabel(label: string, family: string): string {
  const prefix = `${family} `;
  if (!family || label.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return label;
  const rest = label.slice(prefix.length).trimStart();
  return /^\p{L}{2}/u.test(rest) ? rest : label;
}
