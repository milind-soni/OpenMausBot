// Temp files of saves that never finished (atomic.ts: a crash between the write and the rename). The file they were
// for is whole as it was before that save; the temp files are moved into the backup, never deleted. Only the data
// folder's own top level is looked at: bots' work folders hold the person's files. A temp file the registry check would
// put in place of a damaged bots.json or groups.json stays where it is, so its repair can run again.
import { leftoverTemps } from "../files.ts";
import { registryCopies } from "./registry.ts";
import type { DoctorCheck } from "../types.ts";

export function tempFilesCheck(): DoctorCheck {
  return {
    id: "temp-files",
    title: "Unfinished saves",
    looksAt: "<file>.<pid>.<id>.tmp in the data folder",
    check(ctx) {
      const keep = registryCopies(ctx);
      const temps = leftoverTemps(ctx).filter((temp) => !keep.has(temp.path));
      if (!temps.length) return { status: "ok", summary: "None." };
      const files = [...new Set(temps.map((temp) => temp.of))];
      return { status: "problem", fixable: true, detail: temps.map((temp) => temp.path),
        summary: `${temps.length} temp file${temps.length === 1 ? "" : "s"} left by save${temps.length === 1 ? "" : "s"} that did not finish (${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}).` };
    },
    fix(_ctx, finding, backup) {
      const paths = finding.detail as string[];
      for (const path of paths) backup.move("temp-files", path);
      return `Moved ${paths.length} into the backup.`;
    },
  };
}
