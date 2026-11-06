// In-memory desk state, persisted to state.json after every change and reset from seed.json.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { DeskEvent, DeskState } from "./types.ts";

export type IdPrefix = "REQ" | "EM" | "SUB" | "INT" | "PR" | "CAN";

export interface Store {
  state: DeskState;
  now(): number;
  save(): void;
  reset(): void;
  emit(e: Omit<DeskEvent, "at">): void;
  on(fn: (e: DeskEvent) => void): () => void;
  nextId(prefix: IdPrefix): string;
  log(actor: string, text: string, ids?: { reqId?: string; candidateId?: string }): void;
}

export function createStore(opts: { statePath: string; seedPath: string; now?: () => number }): Store {
  const now = opts.now ?? Date.now;
  const listeners = new Set<(e: DeskEvent) => void>();
  const readSeed = (): DeskState => JSON.parse(readFileSync(opts.seedPath, "utf8"));

  const store: Store = {
    state: existsSync(opts.statePath) ? JSON.parse(readFileSync(opts.statePath, "utf8")) : readSeed(),
    now,
    save() {
      const tmp = `${opts.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(store.state));
      renameSync(tmp, opts.statePath);
    },
    reset() {
      store.state = readSeed();
      store.save();
      store.emit({ name: "reset" });
    },
    emit(e) {
      const event: DeskEvent = { ...e, at: now() };
      for (const fn of listeners) fn(event);
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    nextId(prefix) {
      const n = (store.state.counters[prefix] ?? 0) + 1;
      store.state.counters[prefix] = n;
      return prefix === "REQ" ? `REQ-${n}` : `${prefix}-${String(n).padStart(4, "0")}`;
    },
    log(actor, text, ids = {}) {
      store.state.activity.push({ at: now(), actor, text, ...ids });
    },
  };
  return store;
}
