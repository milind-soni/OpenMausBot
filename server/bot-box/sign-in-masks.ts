// Which engine sign-ins in the server's HOME a bot box keeps. A box that has the server's HOME (a My Cloud; on a Team Cloud
// a turn's box has its audience's engine home instead) keeps only the sign-in of the engine account its process runs:
// every other engine's and every other account's sign-in file there is masked, and so are the folders only the server
// reads. Security: a spawn that names no engine keeps none.
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ENGINE_FOLDERS } from "../engine-homes/layout.ts";
import { under, type SignInMasks } from "./plan.ts";

/** Folders in the server's HOME only the server reads: the edge's TLS certificate and ACME account. */
export const SERVER_ONLY_HOME_FOLDERS = [".omb-edge"] as const;

export interface SignInFiles {
  realpath(path: string): string | null;
  isFile(path: string): boolean;
  isDirectory(path: string): boolean;
}

const files: SignInFiles = {
  realpath: (path) => { try { return realpathSync(path); } catch { return null; } },
  isFile: (path) => { try { return statSync(path).isFile(); } catch { return false; } },
  isDirectory: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } },
};

/** Only paths that exist now: bubblewrap makes a missing mount target, which in a read-write HOME would leave an empty
 * sign-in file on the server's own disk. Real paths, so a link into HOME is masked where it points. */
export function signInMasks(input: { home: string; dataDir: string; env: Record<string, string | undefined>; engine?: string | null }, fs: SignInFiles = files): SignInMasks {
  const home = fs.realpath(input.home) ?? resolve(input.home), dataDir = fs.realpath(input.dataDir) ?? resolve(input.dataDir);
  const spawnHome = input.env.HOME && isAbsolute(input.env.HOME) ? input.env.HOME : input.home;
  const lexical = (path: string) => under(resolve(path), resolve(input.home)) ? join(home, relative(resolve(input.home), resolve(path))) : resolve(path);
  const ownFiles = new Set<string>();
  for (const folder of ENGINE_FOLDERS) {
    if (!input.engine || !folder.drivers.includes(input.engine)) continue;
    const named = folder.env ? input.env[folder.env] : undefined;
    const base = named && isAbsolute(named) ? named : join(spawnHome, folder.home);
    for (const name of folder.shared) {
      const path = join(base, name), real = fs.realpath(path);
      // Security: the folders are a bot's to write, so a link is followed only to this same file in HOME (MausBot's own
      // engine folder linking the person's login), never to another engine's file planted there.
      const fallback = join(home, folder.home, name);
      if (real && (real === lexical(path) || real === fallback)) ownFiles.add(real);
      // The driver's own sign-in check also takes the HOME default where the folder is a shared XDG one.
      if (folder.env?.startsWith("XDG_") && fs.realpath(fallback) === fallback) ownFiles.add(fallback);
    }
  }
  const inHome = (path: string) => under(path, home) && !under(path, dataDir);
  const own = [...ownFiles].filter((path) => inHome(path) && fs.isFile(path));
  const masked: string[] = [];
  for (const folder of ENGINE_FOLDERS) {
    for (const name of folder.shared) {
      const real = fs.realpath(join(home, folder.home, name));
      if (!real || ownFiles.has(real) || !inHome(real) || !fs.isFile(real) || masked.includes(real)) continue;
      masked.push(real);
    }
  }
  const hidden = SERVER_ONLY_HOME_FOLDERS.map((name) => fs.realpath(join(home, name))).filter((path): path is string => path !== null && inHome(path) && fs.isDirectory(path));
  // Security: every folder between HOME and a sign-in is a mount point too, so a bot cannot rename it away and leave the
  // file at a path the next box does not mask.
  const folders = new Set<string>();
  for (const file of [...own, ...masked]) {
    for (let folder = dirname(file); folder !== home && under(folder, home); folder = dirname(folder)) folders.add(folder);
  }
  return { folders: [...folders].sort((a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b)), own, masked, hidden };
}
