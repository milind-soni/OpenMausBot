// The data folder's format marker, and the rule that makes an update safe to roll back: what version N writes, version
// N-1 can still read (CONTRIBUTING.md, "Changing how data is stored"). A server that finds data in a format it cannot
// read refuses to start before it touches a file.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `writes`: the format this version leaves the data folder in. `reads`: the newest format it can read, which may be
 * one ahead. A change the previous release cannot read takes two releases: raise `reads` (and ship the code that reads
 * the new format) in one, raise `writes` in the next. server/data-format.test.ts fails on any other step.
 */
export const DATA_FORMAT = { writes: 1, reads: 1 } as const;

export const DATA_FORMAT_FILE = "data-format.json";

export interface DataFormatMarker {
  /** The newest format a server has left this folder in. A folder without the file is format 1. */
  format: number;
  /** The version that wrote it. */
  writtenBy: string;
  writtenAt: string;
}

/** `message` is whole sentences for the server's owner, and the only line the server prints before it exits. */
export class DataFormatError extends Error {
  override name = "DataFormatError";
}

/** Null when the folder has no marker. Throws when the marker cannot be read: its format is then unknown. */
export function readDataFormat(dataDir: string): DataFormatMarker | null {
  const file = join(dataDir, DATA_FORMAT_FILE);
  if (!existsSync(file)) return null;
  try {
    const marker = JSON.parse(readFileSync(file, "utf8")) as Partial<DataFormatMarker>;
    if (typeof marker.format === "number" && Number.isInteger(marker.format) && marker.format >= 1) {
      return { format: marker.format, writtenBy: typeof marker.writtenBy === "string" ? marker.writtenBy : "unknown", writtenAt: typeof marker.writtenAt === "string" ? marker.writtenAt : "" };
    }
  } catch {
  }
  throw new DataFormatError(`OpenMausBot startup failed: ${file} cannot be read, so this version cannot tell whether it understands the data in ${dataDir}. Nothing was changed. Restore that file from a backup, or the whole folder from the copy taken before the last update.`);
}

/** Throws, having changed nothing, when a newer version left the data in a format `reads` does not cover. */
export function checkDataFormat(dataDir: string, version: string, reads: number = DATA_FORMAT.reads): void {
  const marker = readDataFormat(dataDir);
  if (!marker || marker.format <= reads) return;
  throw new DataFormatError(
    `OpenMausBot startup failed: the data in ${dataDir} was written by a newer OpenMausBot (${marker.writtenBy}), in a format this version (${version}) cannot read. Nothing was changed. `
    + `Install OpenMausBot ${marker.writtenBy} or newer, or put back the copy of the data taken before that update.`,
  );
}

/** Records that this version has run on the folder. Never lowers a marker: an older version that could read the data leaves it. */
export function stampDataFormat(dataDir: string, version: string, format: { writes: number; reads: number } = DATA_FORMAT): void {
  checkDataFormat(dataDir, version, format.reads);
  const marker = readDataFormat(dataDir);
  if (marker && marker.format >= format.writes) return;
  const file = join(dataDir, DATA_FORMAT_FILE);
  const next: DataFormatMarker = { format: format.writes, writtenBy: version, writtenAt: new Date().toISOString() };
  writeFileSync(`${file}.${process.pid}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${file}.${process.pid}.tmp`, file);
}

export interface ReleasedDataFormat {
  version: string;
  writes: number;
  reads: number;
}

/**
 * Why `current` may not follow `released` (the last release's formats), or null. The last release must be able to read
 * what this one writes, and no number goes down or skips.
 */
export function dataFormatStepProblem(current: { writes: number; reads: number }, released: ReleasedDataFormat): string | null {
  if (current.reads < current.writes) return `reads (${current.reads}) is below writes (${current.writes}): a version reads what it writes`;
  if (current.writes < released.writes || current.reads < released.reads) return `the data format went down from release ${released.version} (writes ${released.writes}, reads ${released.reads})`;
  if (current.writes > released.reads) {
    return `writes is ${current.writes}, and release ${released.version} reads only up to ${released.reads}: rolling back to it would leave data it cannot read. `
      + `Raise reads to ${current.writes} now, with the code that reads the new format, and raise writes in the release after that one`;
  }
  if (current.reads > released.reads + 1) return `reads went from ${released.reads} to ${current.reads}: one format at a time`;
  return null;
}

/**
 * At start: `check` before anything in the folder is created, migrated or locked, `stamp` once the folder is this
 * server's (after a pending restore, which may bring another marker). Unreadable data ends the process with the one
 * plain line, last in the log, where an updater looks for why the new version did not start.
 */
export function dataFormatAtStart(step: "check" | "stamp", dataDir: string, version: string): void {
  try {
    if (step === "check") checkDataFormat(dataDir, version);
    else stampDataFormat(dataDir, version);
  } catch (error) {
    if (!(error instanceof DataFormatError)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
