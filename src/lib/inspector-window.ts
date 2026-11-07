import type { RuntimeEvent } from "../../shared/runtime-events";
import type { InspectorEntry, InspectorPage } from "../../shared/inspector";

export const INSPECTOR_WINDOW_LIMIT = 400;
const unpersistedRuntime = new WeakMap<InspectorPage, ReadonlySet<string>>();

/**
 * Retains the latest window per log kind without changing their relative order.
 * Counts belong to InspectorPage.total and are deliberately independent of this
 * display window. The record limit does not bound individual payload sizes.
 */
export function boundInspectorEntries(entries: InspectorEntry[]): InspectorEntry[] {
  const counts = { runtime: 0, native: 0 };
  const kept: InspectorEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (++counts[entry.kind] <= INSPECTOR_WINDOW_LIMIT) kept.push(entry);
  }
  return kept.length === entries.length ? entries : kept.reverse();
}

/**
 * Appends a live batch without mutating the published page and advances its total.
 * Event IDs deduplicate against the retained window and this batch only; an
 * unbounded replay history would defeat the Inspector's retention limit.
 * Empty or fully overlapping batches preserve the original page reference.
 */
export function appendInspectorRuntime(page: InspectorPage | null, events: RuntimeEvent[]): InspectorPage | null {
  if (!events.length) return page;
  const previous = page ?? { entries: [], total: { runtime: 0, native: 0 } };
  const seen = new Set(previous.entries.flatMap((entry) => entry.kind === "runtime" ? [entry.data.eventId] : []));
  const added: Extract<InspectorEntry, { kind: "runtime" }>[] = [];
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    added.push({ kind: "runtime", at: event.createdAt, data: event });
  }
  if (!added.length) return page;
  const entries = boundInspectorEntries([...previous.entries, ...added]);
  const pending = new Set([...(unpersistedRuntime.get(previous) ?? []), ...added.map((entry) => entry.data.eventId)]);
  const next = {
    entries,
    total: { ...previous.total, runtime: previous.total.runtime + added.length },
  };
  unpersistedRuntime.set(next, new Set(entries.flatMap((entry) => entry.kind === "runtime" && pending.has(entry.data.eventId) ? [entry.data.eventId] : [])));
  return next;
}

/**
 * A shared event ID anchors publication order even for equal timestamps; without
 * an overlap, equal-time records remain ambiguous and distinct IDs are retained
 * alongside later records rather than risking the loss of a live event.
 * Events arriving during the request must be buffered separately by the caller
 * and appended afterward, including distinct events with equal timestamps.
 * Native records come from the snapshot, while the runtime total never decreases.
 */
export function mergeInspectorSnapshot(previous: InspectorPage | null, snapshot: InspectorPage): InspectorPage {
  const next = { ...snapshot, entries: boundInspectorEntries(snapshot.entries) };
  if (!previous) return next;
  const runtime = previous.entries.flatMap((entry) => entry.kind === "runtime" ? [entry.data] : []);
  const pending = unpersistedRuntime.get(previous) ?? new Set<string>();
  const snapshotRuntime = next.entries.filter((entry) => entry.kind === "runtime");
  const ids = new Set(snapshotRuntime.map((entry) => entry.data.eventId));
  const overlap = runtime.findLastIndex((event) => ids.has(event.eventId));
  const latest = snapshotRuntime.at(-1)?.at;
  const tail = (overlap >= 0 ? runtime.slice(overlap + 1) : runtime.filter((event) => latest === undefined || event.createdAt >= latest))
    .filter((event) => pending.has(event.eventId));
  const merged = appendInspectorRuntime(next, tail)!;
  const result = { ...merged, total: { ...merged.total, runtime: Math.max(previous.total.runtime, merged.total.runtime) } };
  unpersistedRuntime.set(result, unpersistedRuntime.get(merged) ?? new Set());
  return result;
}
