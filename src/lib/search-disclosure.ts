import { useEffect, useState, type SetStateAction } from "react";

/** The open state each sidebar row was left in outside a search. Kept here
 * rather than in the row, because a row that does not match a search leaves
 * the list and would come back closed. Per window, for this session. */
const chosen = new Map<string, boolean>();

/** Tests start each case with no remembered rows. */
export function forgetSearchDisclosuresForTests(): void {
  chosen.clear();
}

/** A sidebar row's thread list open state while a search may be active
 * (MOCA-293). A search used to open every row it listed and leave them all
 * open after it was cleared, so one search exploded the sidebar for good.
 * Now a search opens only the rows that have a matching thread to show,
 * and clearing it puts every row back the way it was. A row the person
 * opens or closes during a search keeps that until the query changes. */
export function useSearchDisclosure(
  key: string,
  query: string,
  matches: boolean,
  initial = false,
): [boolean, (next: SetStateAction<boolean>) => void] {
  const [own, setOwn] = useState(() => chosen.get(key) ?? initial);
  const [during, setDuring] = useState<boolean | null>(null);
  useEffect(() => setDuring(null), [query]);
  const searching = Boolean(query.trim());
  const open = searching ? (during ?? matches) : own;
  const set = (next: SetStateAction<boolean>) => {
    const value = typeof next === "function" ? next(open) : next;
    if (searching) {
      setDuring(value);
      return;
    }
    chosen.set(key, value);
    setOwn(value);
  };
  return [open, set];
}

/** Whether a search has a thread (or folder) of this row to show, which is
 * what earns opening the row; a name or role match alone just lists it. */
export function searchMatchesThreads(
  query: string,
  tasks: ReadonlyArray<{ title: string; routineRunId?: string }> | undefined,
  folders: ReadonlyArray<{ name: string }> | undefined = [],
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return Boolean(tasks?.some((task) => !task.routineRunId && task.title.toLowerCase().includes(q)))
    || folders.some((folder) => folder.name.toLowerCase().includes(q));
}
