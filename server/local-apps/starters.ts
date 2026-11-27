import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LOCAL_APP_ID } from "../../shared/local-apps.ts";
import type { AppDocs } from "../app-docs.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { LocalAppRecord, LocalAppsStore } from "./store.ts";

/** A sample app every computer and Cloud starts with. Its id never changes: removing it is remembered by that id. */
export interface StarterApp {
  id: string;
  name: string;
  /** The page, a file in the starters folder. */
  file: string;
}

export const STARTER_APPS: readonly StarterApp[] = [
  { id: "la_starter_ledger__", name: "Ledger · household & studio accounts", file: "ledger.html" },
  { id: "la_starter_cohorts_", name: "Cohorts · Q3 activation review", file: "cohorts.html" },
  { id: "la_starter_fleet___", name: "Corridor · Fleet control", file: "fleet.html" },
  { id: "la_starter_bigtable", name: "Rowfall · orders", file: "bigtable.html" },
];

export interface StarterSource {
  apps: readonly StarterApp[];
  html(app: StarterApp): string | null;
}

/** Beside this module in a checkout; under local-apps/starters/ beside the bundled server, where the server build copies
 * them. */
export function bundledStarterApps(apps: readonly StarterApp[] = STARTER_APPS): StarterSource {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = [join(here, "starters"), join(here, "local-apps", "starters")].find((candidate) => existsSync(candidate));
  return {
    apps,
    html: (app) => {
      if (!dir) return null;
      try { return readFileSync(join(dir, app.file), "utf8"); } catch { return null; }
    },
  };
}

export const removedStartersFile = (dataDir: string) => join(dataDir, "local-apps-removed.json");

/** The starter apps the person removed; null when the file is there but can't be read, so nothing is added back. */
export function readRemovedStarters(dataDir: string): Set<string> | null {
  let text: string;
  try {
    text = readFileSync(removedStartersFile(dataDir), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? new Set() : null;
  }
  try {
    const parsed = JSON.parse(text) as { version?: unknown; ids?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.ids)) return null;
    return new Set(parsed.ids.filter((id): id is string => typeof id === "string" && LOCAL_APP_ID.test(id)));
  } catch {
    return null;
  }
}

/** Throws when it can't be remembered, the removals file unreadable included (writing over it would forget earlier
 * removals): a removal that isn't remembered would come back at the next start. */
export function rememberRemovedStarter(dataDir: string, id: string): void {
  const removed = readRemovedStarters(dataDir);
  if (!removed) throw new Error("The removed starter apps can't be read, so this one can't be removed for good.");
  if (removed.has(id)) return;
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(removedStartersFile(dataDir), JSON.stringify({ version: 1, ids: [...removed, id] }), { mode: 0o600 });
}

/**
 * Adds each starter app the store lacks and the person never removed, after their own apps; a starter still kept whose
 * page changed in this release gets the new page as its newest version. Nothing at all when either file can't be read:
 * the person's saved apps are never written over, and a removed starter never comes back.
 */
export function seedStarterApps(args: { store: LocalAppsStore; docs: AppDocs; dataDir: string; source: StarterSource; now: number }): void {
  const { store, docs, source, now } = args;
  if (!store.readable) return;
  const removed = readRemovedStarters(args.dataDir);
  if (!removed) return;
  const added: LocalAppRecord[] = [];
  for (const app of source.apps) {
    if (removed.has(app.id) || !LOCAL_APP_ID.test(app.id)) continue;
    const html = source.html(app);
    if (html === null) continue;
    const put = docs.put({ source: "html", html });
    if (!put.ok) continue;
    const kept = store.get(app.id);
    if (!kept) {
      added.push({ id: app.id, name: app.name, botId: "", threadId: "", messageId: app.id, sample: true, versions: [{ rev: 0, doc: put.doc, at: now }],
        createdAt: now, updatedAt: now, manifest: { name: app.name } });
      continue;
    }
    const newest = kept.versions.at(-1)!;
    if (newest.doc !== put.doc) store.update(app.id, (record) => ({ ...record, versions: [...record.versions, { rev: newest.rev + 1, doc: put.doc, at: now }] }), now);
  }
  store.append(added);
}
