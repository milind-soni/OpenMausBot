// The parts of a bot's page the person pointed at, waiting in the composer for their next message.
import { useSyncExternalStore } from "react";
import { POINT_LIMITS, type PointedElement } from "../../shared/app-frame/point";
import { randomUuid } from "./random-uuid";

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

/** The same part picked twice stays one chip, in its place and with its note. Past the limit a new part is refused
 * (false), so earlier picks are never dropped. */
export function addPointedChip(threadId: string, chip: Omit<PointedChip, "id">): boolean {
  const list = chips[threadId] ?? EMPTY;
  const same = list.findIndex((each) => each.appId === chip.appId && each.selector === chip.selector);
  if (same >= 0) {
    const { note: _note, ...picked } = chip;
    set({ ...chips, [threadId]: list.map((each, index) => (index === same ? { ...each, ...picked } : each)) });
    return true;
  }
  if (list.length >= POINT_LIMITS.perMessage) return false;
  set({ ...chips, [threadId]: [...list, { ...chip, id: randomUuid() }] });
  return true;
}

/** The person's note on one chip; an empty note removes it. */
export function setPointedNote(threadId: string, id: string, note: string): void {
  const list = chips[threadId];
  if (!list?.some((chip) => chip.id === id)) return;
  const clipped = Array.from(note).slice(0, POINT_LIMITS.note).join("");
  set({ ...chips, [threadId]: list.map((chip) => {
    if (chip.id !== id) return chip;
    const { note: _old, ...rest } = chip;
    return clipped.trim() ? { ...rest, note: clipped } : rest;
  }) });
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
    pointed: list.map(({ id: _id, title: _title, note, ...element }) => (note?.trim() ? { ...element, note: note.trim() } : element)),
    restore: () => set({ ...chips, [threadId]: [...list, ...(chips[threadId] ?? EMPTY)].slice(0, POINT_LIMITS.perMessage) }),
  };
}

export function forgetPointedChips(): void {
  set({});
}
