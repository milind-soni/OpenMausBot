// What the cache sweeper may remove: a fixed list of whole folders in cache roots the server made, and old Node compile
// caches in the app's own cache folder. Invariants, each with a test (sweeper.test.ts, units.linux.test.ts):
//   - every path comes from the arguments (no HOME or environment read here);
//   - a tools root is used only when it is a real folder (not a link) holding the server's own CACHEDIR.TAG
//     (bot-box/tool-caches.ts ensureToolCacheRoot), so a `cache` folder a person made is never looked into;
//   - only the names on TOOL_UNITS are ever measured or removed there, each as one whole folder; nothing else in a root is
//     counted, listed or touched, and no browser folder is on the list (a Playwright MCP profile holds sign-ins);
//   - every walk and removal goes through open folders (tree.ts), so nothing outside the opened root is ever reached.
import { basename, join, resolve } from "node:path";

import { under } from "../bot-box/plan.ts";
import { CACHE_TAG, CACHE_TAG_FILE, toolCacheRoot } from "../bot-box/tool-caches.ts";
import { close, measureChild, names, openFolder, openPath, readPlainFile, removeChild, removeLeftovers, type Folder, type Pacer, type Tally } from "./tree.ts";

export type CacheGroup = "tools" | "app";

/** The app's own cache folder in the data folder, which the bot box hides. */
export const APP_CACHE_DIR = "cache";

/** The tools' units: whole folders, by fixed name. Each is a folder bot-box/tool-caches.ts routes a tool's cache to; a
 * tool keeps its own index and cross-references inside it (npm's content store, uv's archive links), so it goes whole or
 * not at all. Not here, ever: a browser's folder, and any name not on this list. */
export const TOOL_UNITS: readonly string[] = ["npm", "pip", "uv", "huggingface/hub", "huggingface/xet", "bun"];

/** The app's: Node's compile cache, one folder per Node version and build (cloud-home-start.ts NODE_COMPILE_CACHE). The
 * box hides the data folder, so no bot writes here. */
const APP_COMPILE_DIR = "node-compile";

export interface Root {
  group: CacheGroup;
  /** As expected (`<HOME>/cache`, `<data folder>/cache`): a name for logs and counters. */
  path: string;
}

export interface RootInput {
  home: string;
  dataDir: string;
  /** A Team Cloud's audience engine homes (engine-homes/layout.ts audienceHomes). */
  audienceHomes: readonly string[];
  /** The tools' cache folders are in use: the switch (bot-box/tool-caches.ts toolCachesOn) and the bot box is on. */
  tools: boolean;
}

/** The roots to look at: each box HOME's `cache` when the tools' folders are on, and the data folder's own `cache`. */
export function expectedRoots(input: RootInput): Root[] {
  const tools = input.tools ? [...new Set([input.home, ...input.audienceHomes].map((home) => toolCacheRoot(home)))].map((path) => ({ group: "tools" as const, path })) : [];
  return [...tools, { group: "app", path: join(resolve(input.dataDir), APP_CACHE_DIR) }];
}

/** Opens a root, or says why it is left alone. `forbidden`: HOME and the data folder, which a root may never hold. */
export async function openRoot(root: Root, forbidden: readonly string[]): Promise<{ folder: Folder } | { refused: string } | null> {
  if (forbidden.some((place) => under(resolve(place), root.path))) return { refused: "it holds HOME or the data folder" };
  const folder = await openFolder(root.path);
  if (!folder) return null;
  if (root.group === "tools" && await readPlainFile(folder, CACHE_TAG_FILE) !== CACHE_TAG) {
    await close(folder);
    return { refused: "not made by the server (no CACHEDIR.TAG of ours)" };
  }
  return { folder };
}

export interface Unit {
  group: CacheGroup;
  root: string;
  /** Under the root, with `/` between parts. */
  name: string;
}

const split = (name: string) => name.split("/");

/** The units of an open root. `keep`: compile cache folders that are never units (the running server's own). */
export async function listUnits(root: Root, folder: Folder, keep: readonly string[] = []): Promise<Unit[]> {
  if (root.group === "tools") return TOOL_UNITS.map((name) => ({ group: "tools", root: root.path, name }));
  const compile = await openPath(folder, [APP_COMPILE_DIR]);
  if (!compile) return [];
  try {
    // By name: the running server's folder is node-compile/<its version>, whichever way the data folder's path is spelled.
    const kept = new Set(keep.map((path) => basename(resolve(path))));
    return (await names(compile)).filter((name) => !name.startsWith(".") && !kept.has(name))
      .map((name) => ({ group: "app" as const, root: root.path, name: `${APP_COMPILE_DIR}/${name}` }));
  } finally {
    await close(compile);
  }
}

/** The open parent of a unit and its own name, or null when the way there is missing, a link or another filesystem. */
async function parentOf(folder: Folder, unit: Unit): Promise<{ parent: Folder; name: string } | null> {
  const parts = split(unit.name);
  const parent = parts.length === 1 ? folder : await openPath(folder, parts.slice(0, -1));
  return parent ? { parent, name: parts.at(-1)! } : null;
}

/** A unit's size and last write; null when it is not there (or is a link, or on another filesystem). */
export async function measureUnit(folder: Folder, unit: Unit, pacer: Pacer): Promise<Tally | null> {
  const found = await parentOf(folder, unit);
  if (!found) return null;
  try { return await measureChild(found.parent, found.name, pacer); } finally { if (found.parent !== folder) await close(found.parent); }
}

/** Finishes what an earlier removal left (tree.ts TRASH_PREFIX) in the folders that hold a root's units. The caller
 * decides whether it may, as for removeUnit. */
export async function finishLeftovers(root: Root, folder: Folder, pacer: Pacer): Promise<number> {
  let done = 0;
  for (const parts of root.group === "tools" ? [[], ["huggingface"]] : [[APP_COMPILE_DIR]]) {
    const parent = parts.length ? await openPath(folder, parts) : folder;
    if (!parent) continue;
    try { done += await removeLeftovers(parent, pacer); } finally { if (parent !== folder) await close(parent); }
  }
  return done;
}

/** Deletes a unit inside its open root and never outside it (tree.ts). The caller decides whether it may. */
export async function removeUnit(folder: Folder, unit: Unit, pacer: Pacer): Promise<Tally | null> {
  const found = await parentOf(folder, unit);
  if (!found) return null;
  try { return await removeChild(found.parent, found.name, pacer); } finally { if (found.parent !== folder) await close(found.parent); }
}
