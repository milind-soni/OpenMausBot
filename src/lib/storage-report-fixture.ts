// A storage report as a Cloud home's server sends it, for tests and the Storage preview.
import type { StorageReportWire } from "./storage-report";

export const GB = 1024 ** 3;

/** A report as the server sends it: 60 GB volume, 30 GB used, measured an hour ago. */
export function storageReport(over: Partial<StorageReportWire> = {}): StorageReportWire {
  return {
    at: 1_800_000_000_000, ageS: 3_600, running: false, failed: false,
    volume: { totalBytes: 60 * GB, freeBytes: 30 * GB, usedBytes: 30 * GB }, walkedBytes: 29 * GB, unwalkedBytes: 1 * GB,
    categories: [
      { name: "bot_files", class: "work", bytes: 12 * GB, files: 1_000 },
      { name: "conversations", class: "precious", bytes: 6 * GB, files: 10 },
      { name: "packages", class: "rebuildable", bytes: 8 * GB, files: 90_000 },
      { name: "other", class: "work", bytes: 2 * GB, files: 40 },
      { name: "attachments", class: "work", bytes: 1 * GB, files: 300 },
    ],
    bots: [{ id: "chief", bytes: 7 * GB, files: 600 }, { id: "research", bytes: 3 * GB, files: 300 }],
    botsRest: { bytes: 2 * GB, files: 100, count: 2 }, botsGone: { bytes: 1.5 * GB, files: 60, count: 1 },
    ...over,
  };
}
