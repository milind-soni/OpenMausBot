// engine-runs/<tag>/ (engine-records.ts): what each server run started, so the next start can stop what a dead one left.
// A run whose server.json cannot be read is never swept, and stays forever; when it also names no process, nothing in
// it can ever be stopped, and it is moved into the backup. One that names processes is left for a person: they may
// still run. Live runs and this server's own are never touched.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ENGINE_RUNS_DIR, engineRunTag } from "../../engine-records.ts";
import type { DoctorCheck } from "../types.ts";

const TAG = /^[0-9a-f]{32}$/;

function readable(file: string): boolean {
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
    return Number.isInteger(record?.pid) && (record.pid as number) > 0;
  } catch {
    return false;
  }
}

export function engineRunsCheck(): DoctorCheck {
  return {
    id: "engine-runs",
    title: "Engine-run records",
    looksAt: `${ENGINE_RUNS_DIR}/`,
    check(ctx) {
      const root = join(ctx.dataDir, ENGINE_RUNS_DIR);
      let names: string[];
      try { names = readdirSync(root); } catch { return { status: "ok", summary: "None." }; }
      const own = engineRunTag();
      const orphaned: string[] = [];
      let unknown = 0;
      for (const name of names) {
        if (!TAG.test(name) || name === own) continue;
        const dir = join(root, name);
        try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
        if (existsSync(join(dir, "clean")) || readable(join(dir, "server.json"))) continue;
        let leaders: string[];
        try { leaders = readdirSync(dir).filter((file) => /^\d+\.json$/.test(file)); } catch { continue; }
        if (leaders.length) unknown += 1;
        else orphaned.push(dir);
      }
      if (!orphaned.length && !unknown) return { status: "ok", summary: `${names.length} run record${names.length === 1 ? "" : "s"}, each with its server.` };
      return {
        status: "problem",
        fixable: orphaned.length > 0,
        summary: [
          orphaned.length ? `${orphaned.length} run record${orphaned.length === 1 ? "" : "s"} without a server and without a process to stop.` : "",
          unknown ? `${unknown} run record${unknown === 1 ? "" : "s"} name processes, but not the server that started them.` : "",
        ].filter(Boolean).join(" "),
        ...(unknown ? { instruction: `Engines those runs started may still be running. Stop any you do not recognise (ps -ef), then delete those folders in ${root}.` } : {}),
        detail: orphaned,
      };
    },
    fix(_ctx, finding, backup) {
      const dirs = finding.detail as string[];
      for (const dir of dirs) backup.move("engine-runs", dir);
      return `Moved ${dirs.length} into the backup.`;
    },
  };
}
