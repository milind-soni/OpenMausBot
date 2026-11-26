// Shared test setup: a fresh store over a temp copy of the real seed.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSeed } from "../seed/generate.ts";
import { createStore, type Store } from "../src/store.ts";

const SEED_JSON = JSON.stringify(buildSeed());

export function seedFiles(): { seedPath: string; statePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "desk-"));
  const seedPath = join(dir, "seed.json");
  writeFileSync(seedPath, SEED_JSON);
  return { seedPath, statePath: join(dir, "state.json") };
}

export function makeStore(now: () => number = () => 1_000_000): Store {
  return createStore({ ...seedFiles(), now });
}

export function clock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

export function candidateId(store: Store, name: string): string {
  const c = store.state.candidates.find((x) => x.name === name);
  if (!c) throw new Error(`no candidate ${name}`);
  return c.id;
}
