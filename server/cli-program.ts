// The program file an engine's CLI runs, found the way its spawn finds it, without starting anything; and which CLIs have
// a status check that could not finish, so a check again is a real one. One place for both, for every reader of a
// program file: the engine status hold (harness/probe-hold.ts) and any cache of probe answers keyed by that file.
import { statSync } from "node:fs";

import { augmentedPath, findCliCandidates, splitCliString } from "./env-path.ts";

/** The file a CLI string runs: its first word, as given when it is a path, else the first match on `path` (the PATH engines
 * are started with: the app's own, with the engines' folders registered on it); null when that is not a file. */
export function cliProgramFile(cli: string, path: string = augmentedPath()): string | null {
  const program = splitCliString(cli)[0];
  if (!program) return null;
  for (const candidate of findCliCandidates(program, path)) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

const unsettled = new Set<string>();

/** A status check of this CLI could not finish (`true`), or one answered (`false`). */
export function noteProbeUnsettled(cli: string, open: boolean): void {
  if (open) unsettled.add(cli); else unsettled.delete(cli);
}

/** Whether this CLI's last status check could not finish: a check again must run the program, never answer from a kept
 * copy of an earlier answer. */
export const probeUnsettled = (cli: string): boolean => unsettled.has(cli);

/** Whether any CLI's last status check could not finish. A probe may name its program otherwise than the check does (on
 * Windows, by the path of the copy it found), so a kept answer waits until every open check has answered. */
export const anyProbeUnsettled = (): boolean => unsettled.size > 0;
