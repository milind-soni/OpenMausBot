// Where synced files live on a Cloud home, and the one way a request's path becomes a file: inside its folder, never
// through a link.
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { validWirePath } from "../electron/cloud-sync-rules.mjs";

export class SyncPathError extends Error {}

export function syncRoot(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.OMB_SYNC_ROOT || join(dirname(dataDir), "Synced");
}

/** Copies of lent folders: in the data folder, which no bot's box shows, under sync/, which backups and moves leave out. */
export function lentRoot(dataDir: string): string {
  return join(dataDir, "sync", "lent");
}

/** The absolute path of `wirePath` inside `folder`. Refuses a malformed path, and any existing part that is a link. */
export function insideFolder(folder: string, wirePath: unknown): string {
  if (!validWirePath(wirePath)) throw new SyncPathError("invalid path");
  let current = folder;
  for (const part of wirePath.split("/")) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new SyncPathError("the path goes through a link");
  }
  return join(folder, ...wirePath.split("/"));
}
