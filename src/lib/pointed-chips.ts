// The parts of a bot's page the person pointed at, waiting in the composer for their next message.
import { useSyncExternalStore } from "react";
import { POINT_LIMITS, type PointedElement } from "../../shared/app-frame/point";

export interface PointedChip extends PointedElement {
  id: string;
  /** The page's title when it was picked. */
  title: string;
}

let chips: Readonly<Record<string, readonly PointedChip[]>> = {};
const listeners = new Set<() => void>();

function set(next: Readonly<Record<string, readonly PointedChip[]>>) {
  chips = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: readonly PointedChip[] = [];

export function usePointedChips(threadId: string): readonly PointedChip[] {
  return useSyncExternalStore(subscribe, () => chips[threadId] ?? EMPTY, () => EMPTY);
}

/** The same part picked twice stays one chip; past the limit the oldest goes. */
export function addPointedChip(threadId: string, chip: Omit<PointedChip, "id">): void {
  const kept = (chips[threadId] ?? EMPTY).filter((each) => !(each.appId === chip.appId && each.selector === chip.selector));
  set({ ...chips, [threadId]: [...kept, { ...chip, id: crypto.randomUUID() }].slice(-POINT_LIMITS.perMessage) });
}

export function removePointedChip(threadId: string, id: string): void {
  const list = chips[threadId];
  if (!list?.some((chip) => chip.id === id)) return;
  set({ ...chips, [threadId]: list.filter((chip) => chip.id !== id) });
}

/** The chips a send carries, taken out of the composer; `restore` puts them back when the send fails. */
export function takePointedChips(threadId: string): { pointed: PointedElement[]; restore(): void } | null {
  const list = chips[threadId];
  if (!list?.length) return null;
  const { [threadId]: _taken, ...rest } = chips;
  set(rest);
  return {
    pointed: list.map(({ id: _id, title: _title, ...element }) => element),
    restore: () => set({ ...chips, [threadId]: [...list, ...(chips[threadId] ?? EMPTY)].slice(-POINT_LIMITS.perMessage) }),
  };
}

export function forgetPointedChips(): void {
  set({});
}
