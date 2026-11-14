// Builds the island window outside main.mjs, so the entry file stays a readable size.
import { createDynamicIsland } from "./island-main.mjs";

let island = null;

/** The island window while it is up, so the app's window lists can leave it out. */
export function islandWindow() {
  return island?.window ?? null;
}

/** Builds the island only for a launch that asked for it (--dynamic-island). */
export function startIsland(deps) {
  if (!process.argv.includes("--dynamic-island")) return null;
  island = createDynamicIsland(deps);
  return island;
}

export function disposeIsland() {
  island?.dispose();
  island = null;
}
