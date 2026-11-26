// A saved app's server side (app.json, server/, migrations/ beside it) is never a page's file: not served to the frame,
// not in a published bundle, not on included hosting, whether the folder, the file or a link to it is what was named.
//
// Security: decided on the real path, so a link inside ui/ to ../server/operations.js is caught too. Case-insensitive,
// as macOS and Windows file systems usually are.
import { statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const PRIVATE_FOLDERS = new Set(["server", "migrations"]);
export const APP_MANIFEST_FILE = "app.json";

const isAppRoot = (folder: string) => statSync(join(folder, APP_MANIFEST_FILE), { throwIfNoEntry: false })?.isFile() === true;

/** Whether `path` (real, absolute) is an app's server side: its app.json, or inside its server/ or migrations/. Looks at
 * every folder above `path` up to and including `root`. */
export function isAppServerSide(path: string, root: string): boolean {
  let folder = dirname(path);
  for (;;) {
    const inside = relative(folder, path).split(sep);
    if (isAppRoot(folder)) {
      const first = inside[0]?.toLowerCase() ?? "";
      if ((inside.length === 1 && first === APP_MANIFEST_FILE) || (PRIVATE_FOLDERS.has(first) && inside.length >= 1)) return true;
    }
    if (folder === root || relative(root, folder).startsWith("..")) return false;
    const parent = dirname(folder);
    if (parent === folder) return false;
    folder = parent;
  }
}
