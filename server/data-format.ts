// The data folder's format marker, and the rule that makes an update safe to roll back: what version N writes, version
// N-1 can still read (CONTRIBUTING.md, "Changing how data is stored"). A server that finds data in a format it cannot
// read refuses to start before it touches a file.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

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

/** The marker in the folder; null when there is none, "unreadable" when there is one whose format cannot be told. */
function markerIn(dataDir: string): DataFormatMarker | null | "unreadable" {
  const file = join(dataDir, DATA_FORMAT_FILE);
  if (!existsSync(file)) return null;
  try {
    // A byte-order mark is what some editors put in front of JSON; the format behind it is still readable.
    const marker = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Partial<DataFormatMarker> | null;
    if (marker && typeof marker.format === "number" && Number.isInteger(marker.format) && marker.format >= 1) {
      return { format: marker.format, writtenBy: typeof marker.writtenBy === "string" ? marker.writtenBy : "unknown", writtenAt: typeof marker.writtenAt === "string" ? marker.writtenAt : "" };
    }
  } catch {
  }
  return "unreadable";
}

/**
 * Null when the folder has no marker. A marker that cannot be read (empty or NUL-filled after a power loss, not
 * readable by this user) is format 1 while no version writes anything newer (`writes` 1): there is then no newer format
 * it could have recorded, and refusing would stop a healthy install. Once a version writes format 2 its format is
 * unknown, and this throws.
 */
export function readDataFormat(dataDir: string, writes: number = DATA_FORMAT.writes): DataFormatMarker | null {
  const marker = markerIn(dataDir);
  if (marker !== "unreadable") return marker;
  const file = join(dataDir, DATA_FORMAT_FILE);
  if (writes <= 1) {
    console.warn(`[data-format] ${file} cannot be read; taking the data as format 1, the only format any version has written.`);
    return null;
  }
  throw new DataFormatError(`OpenMausBot startup failed: ${file} cannot be read, so this version cannot tell whether it understands the data in ${dataDir}. Nothing was changed. Restore that file from a backup, or the whole folder from the copy taken before the last update.`);
}

/** Throws, having changed nothing, when a newer version left the data in a format `reads` does not cover. */
export function checkDataFormat(dataDir: string, version: string, reads: number = DATA_FORMAT.reads, writes: number = DATA_FORMAT.writes): void {
  const marker = readDataFormat(dataDir, writes);
  if (marker && marker.format > reads) throw newerData(dataDir, version, marker);
}

function newerData(dataDir: string, version: string, marker: DataFormatMarker): DataFormatError {
  return new DataFormatError(
    `OpenMausBot startup failed: the data in ${dataDir} was written by a newer OpenMausBot (${marker.writtenBy}), in a format this version (${version}) cannot read. Nothing was changed. `
    + `Install OpenMausBot ${marker.writtenBy} or newer, or put back the copy of the data taken before that update.`,
  );
}

/**
 * Records that this version has run on the folder. Never lowers a marker: an older version that could read the data
 * leaves it. Throws only DataFormatError, for data it cannot read; a marker it cannot write (a read-only folder, a file
 * Windows holds open past the retries) is said in the log and the start goes on, since the data itself is fine.
 */
export function stampDataFormat(
  dataDir: string,
  version: string,
  format: { writes: number; reads: number } = DATA_FORMAT,
  write: (path: string, text: string) => void = writeFileAtomic,
): void {
  const marker = readDataFormat(dataDir, format.writes);
  if (marker && marker.format > format.reads) throw newerData(dataDir, version, marker);
  if (marker && marker.format >= format.writes) return;
  const file = join(dataDir, DATA_FORMAT_FILE);
  const next: DataFormatMarker = { format: format.writes, writtenBy: version, writtenAt: new Date().toISOString() };
  try {
    write(file, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    console.warn(`[data-format] could not write ${file} (${error instanceof Error ? error.message : String(error)}); starting without it.`);
  }
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
