// Which engine sign-ins in the server's HOME a bot box keeps. A box that has the server's HOME (a My Cloud; on a Team Cloud
// a turn's box has its audience's engine home instead) keeps only the sign-in of the engine account its process runs:
// every other engine's and every other account's sign-in file there is masked, and so are the folders only the server
// reads. Security: a spawn that names no engine keeps none.
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
 * sign-in file on the server's own disk. Real paths, so a link into HOME is masked where it points; returned under HOME
 * as the box has it. */
export function signInMasks(input: { home: string; dataDir: string; env: Record<string, string | undefined>; engine?: string | null }, fs: SignInFiles = files): SignInMasks {
  const home = fs.realpath(input.home) ?? resolve(input.home), dataDir = fs.realpath(input.dataDir) ?? resolve(input.dataDir);
  const spawnHome = input.env.HOME && isAbsolute(input.env.HOME) ? input.env.HOME : input.home;
  const lexical = (path: string) => under(resolve(path), resolve(input.home)) ? join(home, relative(resolve(input.home), resolve(path))) : resolve(path);
  const inHome = (path: string) => under(path, home) && !under(path, dataDir);
  const defaults = ENGINE_FOLDERS.flatMap((folder) => folder.shared.map((name) => join(home, folder.home, name)));
  const ownFiles = new Set<string>(), aliases = new Set<string>();
  for (const folder of ENGINE_FOLDERS) {
    if (!input.engine || !folder.drivers.includes(input.engine)) continue;
    const named = folder.env ? input.env[folder.env] : undefined;
    const base = named && isAbsolute(named) ? named : join(spawnHome, folder.home);
    for (const name of folder.shared) {
      const path = join(base, name), real = fs.realpath(path), fallback = join(home, folder.home, name);
      // Security: the folders are a bot's to write, so a link is followed only to this same file in HOME (MausBot's own
      // engine folder linking the person's login) or through a linked folder, never to another engine's sign-in.
      const throughFolder = real !== null && real === join(fs.realpath(dirname(path)) ?? dirname(path), basename(path)) && inHome(real) && !defaults.includes(real);
      if (real && (real === lexical(path) || real === fallback || throughFolder)) { ownFiles.add(real); aliases.add(lexical(path)); }
      // The driver's own sign-in check also takes the HOME default where the folder is a shared XDG one.
      if (folder.env?.startsWith("XDG_") && fs.realpath(fallback) === fallback) ownFiles.add(fallback);
    }
  }
  const own = [...ownFiles].filter((path) => inHome(path) && fs.isFile(path));
  const masked: string[] = [];
  for (const alias of defaults) {
    const real = fs.realpath(alias);
    if (!real || !inHome(real) || !fs.isFile(real)) continue;
    aliases.add(alias);
    if (!ownFiles.has(real) && !masked.includes(real)) masked.push(real);
  }
  const hidden = SERVER_ONLY_HOME_FOLDERS.map((name) => fs.realpath(join(home, name))).filter((path): path is string => path !== null && inHome(path) && fs.isDirectory(path));
  // Security: every folder between HOME and a sign-in, and between HOME and each name it is reached by, is a mount point
  // too, so a bot cannot rename one away and leave the file at a path the next box does not mask.
  const folders = new Set<string>();
  for (const file of [...own, ...masked, ...[...aliases].filter(inHome)]) {
    for (let folder = dirname(file); folder !== home && under(folder, home); folder = dirname(folder)) if (fs.isDirectory(folder)) folders.add(folder);
  }
  const inBox = (path: string) => join(resolve(input.home), relative(home, path));
  return {
    folders: [...folders].sort((a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b)).map(inBox),
    own: own.map(inBox), masked: masked.map(inBox), hidden: hidden.map(inBox),
  };
}
