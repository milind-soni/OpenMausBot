// Which parts of Claude's usage reply are one model's own limit rather than the account's.

const CLAUDE_MODEL_FAMILIES = ["opus", "sonnet", "haiku"];
/** How a model names itself in the usage reply ("Fable", "Opus 4.5"); anything else is not shown. */
const MODEL_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .-]{0,39}$/u;

export interface ClaudeScopedWeekly { name: string; usedPercent: number; resetsAt: unknown }

export function claudeExtraLabel(key: string): string {
  const suffix = key.startsWith("seven_day_")
    ? key.slice("seven_day_".length)
    : key.replace(/^five_hour_/, "");
  return titleWords(suffix);
}

function titleWords(suffix: string): string {
  const words = suffix.split("_").filter((part) => part.length > 0);
  if (words.length === 0) return "Window";
  return words.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}

export function claudeModelWindow(key: string): { name: string; window: string } | null {
  const weekly = key.startsWith("seven_day_");
  const fiveHour = key.startsWith("five_hour_");
  if (!weekly && !fiveHour) return null;
  const suffix = key.slice(weekly ? "seven_day_".length : "five_hour_".length);
  const lower = suffix.toLowerCase();
  const family = CLAUDE_MODEL_FAMILIES.find((name) => lower === name || lower.startsWith(`${name}_`));
  if (!family) return null;
  return { name: titleWords(suffix), window: weekly ? "Weekly" : "5-hour" };
}

const record = (value: unknown): Record<string, unknown> | null =>
  !value || typeof value !== "object" || Array.isArray(value) ? null : value as Record<string, unknown>;

const modelFamily = (name: string): string => name.split(" ")[0].toLowerCase();

/** A model's own weekly limit, such as Fable's, listed in `limits` as `weekly_scoped` with the model's name and a `percent`.
 * A model whose weekly limit already came from a `seven_day_<family>` key (its name is in `keyed`) is left out. */
export function claudeScopedWeekly(limits: unknown, keyed: readonly string[]): ClaudeScopedWeekly[] {
  if (!Array.isArray(limits)) return [];
  const families = new Set(keyed.map(modelFamily));
  const found: ClaudeScopedWeekly[] = [];
  for (const value of limits) {
    const entry = record(value);
    const shown = record(record(entry?.scope)?.model)?.display_name;
    const name = typeof shown === "string" ? shown.trim() : "";
    const percent = entry?.percent;
    if (entry?.kind !== "weekly_scoped" || !MODEL_NAME.test(name) || typeof percent !== "number" || !Number.isFinite(percent)) continue;
    if (families.has(modelFamily(name)) || found.some((limit) => limit.name.toLowerCase() === name.toLowerCase())) continue;
    found.push({ name, usedPercent: percent, resetsAt: entry.resets_at ?? entry.resetsAt });
  }
  return found;
}
