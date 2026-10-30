export const TYPEAHEAD_RESET_MS = 500;

export type Typeahead = { text: string; at: number };

export function typeaheadText(previous: Typeahead | null, key: string, at: number): Typeahead {
  return { text: previous && at - previous.at < TYPEAHEAD_RESET_MS ? previous.text + key : key, at };
}

export function typeaheadMatch(labels: readonly string[], focused: number, text: string): number | null {
  const typed = text.toLowerCase();
  const sameLetter = [...typed].every((letter) => letter === typed[0]);
  const prefix = sameLetter ? typed.slice(0, 1) : typed;
  const from = sameLetter ? focused + 1 : Math.max(focused, 0);
  for (let step = 0; step < labels.length; step++) {
    const index = (from + step) % labels.length;
    if (labels[index]!.trim().toLowerCase().startsWith(prefix)) return index;
  }
  return null;
}

export function isTypeaheadKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey;
}
