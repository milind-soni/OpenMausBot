// bots.json and groups.json (registry-store.ts). The Store takes one it cannot read for an empty list, and the next save
// writes over it. Fixed only from a whole copy the server itself wrote: the temp file of a save that was interrupted
// after it was written and before it was renamed, which is newer than anything else. Otherwise a copy of the damaged
// file goes into the backup before the server starts, so a later save cannot take the last of it.
import { chmodSync, renameSync } from "node:fs";
import { join } from "node:path";

import { leftoverTemps, registryState, type LeftoverTemp } from "../files.ts";
import type { DoctorCheck } from "../types.ts";

export const REGISTRY_FILES = ["bots.json", "groups.json"] as const;

type Damage = { file: string; path: string; copy: LeftoverTemp | null };

export function registryCheck(): DoctorCheck {
  return {
    id: "registry",
    title: "Bots and rooms",
    looksAt: REGISTRY_FILES.join(", "),
    check(ctx) {
      const damaged: Damage[] = [];
      for (const file of REGISTRY_FILES) {
        const path = join(ctx.dataDir, file);
        if (registryState(path) !== "unreadable") continue;
        const copies = leftoverTemps(ctx).filter((temp) => temp.of === file && registryState(temp.path) === "ok").sort((a, b) => b.mtimeMs - a.mtimeMs);
        damaged.push({ file, path, copy: copies[0] ?? null });
      }
      if (!damaged.length) return { status: "ok", summary: "Both read as lists (or are not there yet)." };
      const lost = damaged.filter((damage) => !damage.copy);
      return {
        status: "problem",
        fixable: lost.length === 0,
        keepCopy: lost.length > 0,
        summary: damaged.map((damage) => `${damage.file} cannot be read${damage.copy ? ", and a whole copy from an interrupted save is there" : ""}.`).join(" "),
        ...(lost.length ? { instruction: `Stop the server and put back ${lost.map((damage) => damage.file).join(" and ")} from the copy taken before the last update (./update.sh --rollback) or from a workspace backup. Until then the server shows no ${lost.some((damage) => damage.file === "bots.json") ? "bots" : "rooms"}.` } : {}),
        detail: damaged,
      };
    },
    fix(_ctx, finding, backup) {
      const done: string[] = [];
      for (const damage of finding.detail as Damage[]) {
        if (!damage.copy) {
          // Not a repair: the damaged file stays, and its bytes are kept where a later save cannot reach them.
          backup.copy("registry", damage.path, "kept: could not be read, and no whole copy was found");
          done.push(`kept a copy of the unreadable ${damage.file}`);
          continue;
        }
        backup.move("registry", damage.path, "moved aside: could not be read");
        backup.copy("registry", damage.copy.path, "the copy put in its place");
        renameSync(damage.copy.path, damage.path);
        if (process.platform !== "win32") chmodSync(damage.path, 0o600);
        done.push(`put back ${damage.file} from the save process ${damage.copy.pid} did not finish`);
      }
      return `${done.join("; ")}.`;
    },
  };
}
