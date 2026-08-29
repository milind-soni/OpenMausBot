export interface ContextEntry {
  role: "user" | "assistant" | "system";
  text: string;
  /** Durable instructions/evidence are never discarded by compaction. */
  protected?: boolean;
}

export interface ContextBudgetOptions {
  /** Pressure point. Context below this size is returned verbatim. */
  maxChars: number;
  /** Size to compact down to after maxChars is crossed. Defaults to maxChars. */
  targetChars?: number;
  marker?: string;
  markerRole?: ContextEntry["role"];
}

/**
 * Keeps context bounded while retaining protected entries and the newest
 * ordinary entries. This is a transport-level bound only: durable system
 * instructions and evidence must be marked protected by the caller, and are
 * never summarized or silently dropped.
 */
export function compactContext(entries: readonly ContextEntry[], options: ContextBudgetOptions): ContextEntry[] {
  const maxChars = Number.isFinite(options.maxChars) ? Math.max(1, Math.trunc(options.maxChars)) : 1;
  const totalChars = entries.reduce((sum, entry) => sum + entry.text.length, 0);
  if (totalChars <= maxChars) return [...entries];
  const targetChars = Number.isFinite(options.targetChars)
    ? Math.max(1, Math.min(maxChars, Math.trunc(options.targetChars!)))
    : maxChars;
  const marker = options.marker ?? "[Earlier context omitted by bounded compaction]";
  const markerRole = options.markerRole ?? "system";
  const protectedEntries = entries.filter((entry) => entry.protected === true);
  const ordinary = entries.filter((entry) => entry.protected !== true);
  const protectedChars = protectedEntries.reduce((sum, entry) => sum + entry.text.length, 0);
  // The marker is metadata, like protected instructions: never trade away the
  // newest actual conversation merely to fit its explanatory label.
  const remaining = Math.max(0, targetChars - protectedChars);
  const keptReverse: ContextEntry[] = [];
  let used = 0;
  for (let i = ordinary.length - 1; i >= 0; i -= 1) {
    const entry = ordinary[i]!;
    if (used + entry.text.length > remaining) break;
    keptReverse.push(entry);
    used += entry.text.length;
  }
  const kept = keptReverse.reverse();
  const omitted = kept.length < ordinary.length;
  const keptSet = new Set(kept);
  const firstOmittedIndex = omitted
    ? entries.findIndex((entry) => entry.protected !== true && !keptSet.has(entry))
    : -1;
  const result: ContextEntry[] = [];
  entries.forEach((entry, index) => {
    if (index === firstOmittedIndex) result.push({ role: markerRole, text: marker, protected: true });
    if (entry.protected === true || keptSet.has(entry)) result.push(entry);
  });
  return result;
}
