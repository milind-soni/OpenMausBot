// bots.json and groups.json (registry-store.ts). The Store takes one it cannot read for an empty list, and the next save
// writes over it. Fixed only from a whole copy the server itself wrote after the damaged file: the temp file of a save
// that was interrupted after it was written and before it was renamed. Otherwise a copy of the damaged
// file goes into the backup before the server starts, so a later save cannot take the last of it. A file this user
// cannot read at all is not taken for damaged: it is reported as not checked, and left alone.
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";

import { renameWithRetry } from "../../atomic.ts";
import { leftoverTemps, registryState, type LeftoverTemp } from "../files.ts";
import type { DoctorCheck, DoctorContext } from "../types.ts";

export const REGISTRY_FILES = ["bots.json", "groups.json"] as const;

type Damage = { file: string; path: string; copy: LeftoverTemp | null };
type Unchecked = { file: string; reason: string; copy: LeftoverTemp | null };

/** The newest whole save of `file` begun after `path` was last written: an older one would bring back a list from before. */
function newestCopy(ctx: DoctorContext, file: string, path: string): LeftoverTemp | null {
  let since = Infinity;
  try { since = statSync(path).mtimeMs; } catch {}
  const copies = leftoverTemps(ctx).filter((temp) => temp.of === file && temp.mtimeMs >= since && registryState(temp.path).state === "ok").sort((a, b) => b.mtimeMs - a.mtimeMs);
  return copies[0] ?? null;
}

function look(ctx: DoctorContext): { damaged: Damage[]; unchecked: Unchecked[] } {
  const damaged: Damage[] = [], unchecked: Unchecked[] = [];
  for (const file of REGISTRY_FILES) {
    const path = join(ctx.dataDir, file);
    const state = registryState(path);
    if (state.state === "unreadable") unchecked.push({ file, reason: state.reason, copy: newestCopy(ctx, file, path) });
    if (state.state === "damaged") damaged.push({ file, path, copy: newestCopy(ctx, file, path) });
  }
  return { damaged, unchecked };
}

/** The temp files the registry would put in place of a damaged file, or of one it could not read: while one is still
 * chosen (its fix has not run, or failed, or the file cannot be checked yet), the temp-file check leaves it where it is. */
export function registryCopies(ctx: DoctorContext): Set<string> {
  const { damaged, unchecked } = look(ctx);
  return new Set([...damaged, ...unchecked].flatMap((item) => item.copy ? [item.copy.path] : []));
}

export function registryCheck(options: { rename?: (from: string, to: string) => void } = {}): DoctorCheck {
  return {
    id: "registry",
    title: "Bots and rooms",
    looksAt: REGISTRY_FILES.join(", "),
    check(ctx) {
      const { damaged, unchecked } = look(ctx);
      if (!damaged.length && !unchecked.length) return { status: "ok", summary: "Both read as lists (or are not there yet)." };
      const lost = damaged.filter((damage) => !damage.copy);
      const instructions = [
        ...(lost.length ? [`Stop the server and put back ${lost.map((damage) => damage.file).join(" and ")} from the copy taken before the last update (./update.sh --rollback) or from a workspace backup. Until then the server shows no ${lost.some((damage) => damage.file === "bots.json") ? "bots" : "rooms"}.`] : []),
        ...(unchecked.length ? [`Give the server's user ${unchecked.map((item) => item.file).join(" and ")} back as a file it can read, then run openmausbot doctor --data again.`] : []),
      ];
      return {
        status: "problem",
        fixable: lost.length < damaged.length,
        keepCopy: lost.length > 0,
        summary: [
          ...damaged.map((damage) => `${damage.file} is damaged (it does not read as a whole list)${damage.copy ? ", and a whole copy from an interrupted save is there" : ""}.`),
          ...unchecked.map((item) => `Could not check ${item.file}: ${item.reason}.`),
        ].join(" "),
        ...(instructions.length ? { instruction: instructions.join(" ") } : {}),
        detail: damaged,
      };
    },
    fix(_ctx, finding, backup) {
      const done: string[] = [];
      for (const damage of finding.detail as Damage[]) {
        if (!damage.copy) {
          // Not a repair: the damaged file stays, and its bytes are kept where a later save cannot reach them.
          backup.copy("registry", damage.path, "kept: damaged, and no whole copy was found");
          done.push(`kept a copy of the damaged ${damage.file}`);
          continue;
        }
        // Both copied first, and then one rename puts the whole copy in place: at every step the live path holds a file,
        // and a step that fails leaves both where they were.
        backup.copy("registry", damage.path, "copied: damaged, then replaced");
        backup.copy("registry", damage.copy.path, "the copy put in its place");
        if (process.platform !== "win32") {
          try { chmodSync(damage.copy.path, 0o600); } catch {}
        }
        renameWithRetry(damage.copy.path, damage.path, options.rename);
        done.push(`put back ${damage.file} from the save process ${damage.copy.pid} did not finish`);
      }
      return `${done.join("; ")}.`;
    },
  };
}
