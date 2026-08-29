// Custom picker: search the live inject list, and pin models the host
// already has in memory so the user can pick them without scrolling.

export function filterCustomModels<T extends { id: string; label: string }>(
  options: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter(
    (option) => option.label.toLowerCase().includes(needle) || option.id.toLowerCase().includes(needle),
  );
}

export function partitionCustomModels<T extends { id: string; loaded?: boolean }>(
  options: readonly T[],
) {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const option of options) {
    if (option.loaded) pinned.push(option);
    else rest.push(option);
  }
  return { pinned, rest };
}

function modelFamilyKey(id: string): string {
  const normalized = id.trim().toLowerCase();
  const claude = normalized.match(/^claude-(?:(?:\d+(?:\.\d+)?)-)?(fable|sonnet|opus)(?:-|$)/);
  if (claude?.[1]) return `claude:${claude[1]}`;
  if (/^(?:cursor-)?grok(?:-|$)/.test(normalized)) return "grok";
  if (/^gpt-.*codex(?:-|$)/.test(normalized)) return "codex";
  const openAiFamily = normalized.match(/^gpt-\d+(?:\.\d+)?-(sol|terra|luna)(?:-|$)/);
  if (openAiFamily?.[1]) return `gpt:${openAiFamily[1]}`;
  if (/^gpt(?:-|$)/.test(normalized)) return "gpt";
  if (/^gemini(?:-|$)/.test(normalized)) return "gemini";
  if (/^composer(?:-|$)/.test(normalized)) return "composer";
  return normalized.split(/[._:+-]/, 1)[0] || normalized;
}

const SUGGESTED_FAMILY_ORDER = [
  "grok",
  "claude:fable",
  "codex",
  "claude:sonnet",
  "claude:opus",
  "gpt:luna",
  "gpt:sol",
  "gpt:terra",
  "gemini",
  "composer",
  "gpt",
] as const;

/** Keep the active and default choices visible, then show one representative
 * per model family before filling spare slots from provider order. A live
 * Cursor catalog can contain hundreds of effort/fast variants; letting those
 * consume the compact rail makes whole families such as Fable effectively
 * undiscoverable even though the engine offers them. */
export function suggestedModels<T extends { id: string }>(
  options: readonly T[],
  defaultId: string,
  currentId: string | undefined,
  limit = 5,
): T[] {
  const picked: T[] = [];
  const seen = new Set<string>();
  const seenFamilies = new Set<string>();
  const add = (option: T | undefined) => {
    if (!option || seen.has(option.id) || picked.length >= limit) return;
    seen.add(option.id);
    seenFamilies.add(modelFamilyKey(option.id));
    picked.push(option);
  };
  add(currentId ? options.find((option) => option.id === currentId) : undefined);
  add(options.find((option) => option.id === defaultId));
  for (const family of SUGGESTED_FAMILY_ORDER) {
    if (picked.length >= limit) break;
    add(options.find((option) => !seen.has(option.id) && modelFamilyKey(option.id) === family));
  }
  for (const option of options) {
    if (picked.length >= limit) break;
    if (seen.has(option.id) || seenFamilies.has(modelFamilyKey(option.id))) continue;
    add(option);
  }
  for (const option of options) add(option);
  return picked;
}
