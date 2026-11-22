import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { isInside, resolveThroughLinks } from "./sentinel/paths.ts";

const LINKED_FOLDERS = ["", "brain", "crew"];

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function names(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/** Security: Edu 6.0.0 takes `<folder>/.edu` as its store, following links, and writes through a linked `.edu` or a link
 * inside it into another store. A folder's store qualifies only when it is its own: the folder is not the global brain or
 * inside it, `.edu` is no link, and nothing in `.edu`, `.edu/brain` or `.edu/crew` is a link out of the folder. */
export function eduStoreRefusal(folder: string, globalHome: string): string | null {
  const real = resolveThroughLinks(folder);
  const global = resolveThroughLinks(globalHome);
  const store = join(real, ".edu");
  if (isInside(real, global) || resolveThroughLinks(store) === global) return "This folder is the global Edu brain or inside it; use a folder of its own";
  if (isSymlink(store)) return "This folder's .edu is a link to another place; use a real .edu folder";
  for (const sub of LINKED_FOLDERS) {
    for (const name of names(join(store, sub))) {
      const path = join(store, sub, name);
      if (isSymlink(path) && !isInside(resolveThroughLinks(path), real)) return `This folder's ${[".edu", sub, name].filter(Boolean).join("/")} is a link to another place; use a real folder`;
    }
  }
  return null;
}

/** Security: the real path of `path` when it lies inside the Edu store `store` (itself no link), else null; every file
 * Edu Bot reads from a store goes through here. */
export function storeFile(store: string, path: string): string | null {
  if (isSymlink(store)) return null;
  const real = resolveThroughLinks(path);
  return isInside(real, resolveThroughLinks(store)) ? real : null;
}
