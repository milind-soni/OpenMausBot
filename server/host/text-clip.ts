/** Cut to `max` UTF-16 units, the widget validator's own count, never inside a surrogate pair. Newlines stay. */
export function clip(text: string, max: number): string {
  const value = text.trim();
  if (value.length <= max) return value;
  let cut = Math.max(0, max - 1);
  if (cut > 0 && /[\ud800-\udbff]/.test(value[cut - 1]!)) cut -= 1;
  return `${value.slice(0, cut).trimEnd()}…`;
}

/** `clip` after every run of whitespace, newlines included, becomes one space. */
export const oneLine = (value: string, max: number): string => clip(value.replace(/\s+/g, " "), max);
