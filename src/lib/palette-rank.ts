export function rankByName<T extends { name: string }>(items: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const prefix: T[] = [];
  const substring: T[] = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(item);
    else if (name.includes(q)) substring.push(item);
  }
  return [...prefix, ...substring];
}
