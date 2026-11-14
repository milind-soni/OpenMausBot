export function filterCustomModels<T extends { id: string; label: string; provider?: string }>(
  options: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      option.id.toLowerCase().includes(needle) ||
      (option.provider?.toLowerCase().includes(needle) ?? false),
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
