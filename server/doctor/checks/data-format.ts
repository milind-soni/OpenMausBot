// A data folder a newer version left in a format this one cannot read. Never fixed: the only safe way is the version
// that wrote it, or the copy from before that update.
import { DATA_FORMAT, DataFormatError, readDataFormat } from "../../data-format.ts";
import type { DoctorCheck } from "../types.ts";

export function dataFormatCheck(reads: number = DATA_FORMAT.reads): DoctorCheck {
  return {
    id: "data-format",
    title: "Data format",
    looksAt: "data-format.json",
    check(ctx) {
      let marker;
      try {
        marker = readDataFormat(ctx.dataDir, reads);
      } catch (error) {
        if (!(error instanceof DataFormatError)) throw error;
        return { status: "problem", blocking: true, summary: "data-format.json cannot be read, so this version cannot tell whether it understands the data.",
          instruction: "Restore data-format.json from the same snapshot as the data, or restore the whole data folder from a backup (./update.sh --rollback)." };
      }
      if (!marker) return { status: "ok", summary: "No marker: the data is in format 1." };
      if (marker.format > reads) {
        return { status: "problem", blocking: true,
          summary: `The data was written by a newer OpenMausBot (${marker.writtenBy}) in format ${marker.format}; this version (${ctx.version}) reads up to format ${reads}.`,
          instruction: `Install OpenMausBot ${marker.writtenBy} or newer, or put back the copy of the data taken before that update (./update.sh --rollback). Nothing was changed.` };
      }
      return { status: "ok", summary: `Format ${marker.format}, which this version reads.` };
    },
  };
}
