/** Whether two values parsed from JSON hold the same data. The order of an object's keys does not count, and a key
 * holding undefined is the same as no key: JSON would have written neither. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameJson(a[i], b[i])) return false;
    return true;
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  let unmatched = 0;
  for (const key of Object.keys(right)) if (right[key] !== undefined) unmatched++;
  for (const key of Object.keys(left)) {
    if (left[key] === undefined) continue;
    if (right[key] === undefined || !sameJson(left[key], right[key])) return false;
    unmatched--;
  }
  return unmatched === 0;
}
