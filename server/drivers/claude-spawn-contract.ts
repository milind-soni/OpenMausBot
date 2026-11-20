const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Which fields of a spawn-contract key changed between two turns, for the close line when a
 * warm process is replaced. Names only, never values: a server's config carries credentials,
 * and the two hashes already hide their inputs. */
export function spawnContractDiff(previous: string, next: string): string[] {
  let oldKey: unknown;
  let newKey: unknown;
  try {
    oldKey = JSON.parse(previous);
    newKey = JSON.parse(next);
  } catch {
    return [];
  }
  if (!isObject(oldKey) || !isObject(newKey)) return [];
  const changed: string[] = [];
  for (const field of new Set([...Object.keys(oldKey), ...Object.keys(newKey)])) {
    const oldValue = oldKey[field];
    const newValue = newKey[field];
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    if (field === "mcpServers" && isObject(oldValue) && isObject(newValue)) {
      for (const name of Object.keys(oldValue)) {
        if (!Object.hasOwn(newValue, name)) changed.push(`mcpServers:-${name}`);
        else if (JSON.stringify(oldValue[name]) !== JSON.stringify(newValue[name])) changed.push(`mcpServers:~${name}`);
      }
      for (const name of Object.keys(newValue)) {
        if (!Object.hasOwn(oldValue, name)) changed.push(`mcpServers:+${name}`);
      }
    } else {
      changed.push(field);
    }
  }
  return changed;
}
