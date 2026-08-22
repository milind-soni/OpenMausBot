// Custom picker: search the live inject list, and pin models the host
// already has in memory so the user can pick them without scrolling.

interface SearchableModel {
  id: string;
  label: string;
  canonicalId?: string;
  provider?: string;
  host?: string;
  reason?: string;
  costClass?: string;
  capabilities?: string[];
}

export function filterCustomModels<T extends SearchableModel>(
  options: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter((option) => {
    return [
      option.label,
      option.id,
      option.canonicalId,
      option.provider,
      option.host,
      option.reason,
      option.costClass,
      ...(option.capabilities ?? []),
    ].filter(Boolean).join(" ").toLowerCase().includes(needle);
  });
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

/** Keep the active and default choices visible, then fill the compact list
 * from catalog order. Catalog order is provider-owned and already reflects
 * its preferred/current models. */
export function suggestedModels<T extends { id: string }>(
  options: readonly T[],
  defaultId: string,
  currentId: string | undefined,
  limit = 5,
): T[] {
  const picked: T[] = [];
  const seen = new Set<string>();
  const add = (option: T | undefined) => {
    if (!option || seen.has(option.id) || picked.length >= limit) return;
    seen.add(option.id);
    picked.push(option);
  };
  add(currentId ? options.find((option) => option.id === currentId) : undefined);
  add(options.find((option) => option.id === defaultId));
  for (const option of options) add(option);
  return picked;
}
