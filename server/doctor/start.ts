// The doctor as a server starts: on the first start of a version (the version that last started is kept in
// doctor-state.json), after the folder's lease is this server's and before anything loads the registries or the
// messages. It applies the safe fixes, logs a line for each finding, and keeps a short summary for /api/health. It
// never stops the server: the one thing that would make starting damage data, a newer data format, has already
// stopped it (data-format.ts), and anything that throws here is logged and passed over.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { reportLines, runDoctor, type RunDoctorOptions } from "./run.ts";
import type { DoctorReport } from "./types.ts";

export const DOCTOR_STATE_FILE = "doctor-state.json";

/** For the health report: counts and check names, never a path or a file's contents. */
export type DoctorSummary = {
  /** When the doctor last ran on this folder, and for which version. */
  at: string;
  version: string;
  checked: number;
  fixed: string[];
  problems: string[];
  /** Whether it ran as this server started (false: it ran at an earlier start of this version). */
  thisStart: boolean;
};

type DoctorState = { version: string; summary: Omit<DoctorSummary, "thisStart"> };

let current: DoctorSummary | null = null;

export function doctorSummary(): DoctorSummary | null {
  return current;
}

function readState(dataDir: string): DoctorState | null {
  try {
    const state = JSON.parse(readFileSync(join(dataDir, DOCTOR_STATE_FILE), "utf8")) as Partial<DoctorState>;
    return typeof state?.version === "string" && state.summary && typeof state.summary === "object" ? state as DoctorState : null;
  } catch {
    return null;
  }
}

export function summaryOf(report: DoctorReport): Omit<DoctorSummary, "thisStart"> {
  return {
    at: report.at,
    version: report.version,
    checked: report.counts.checked,
    fixed: report.checks.filter((result) => result.repaired).map((result) => result.id),
    problems: report.checks.filter((result) => result.status === "problem" || result.status === "failed").map((result) => result.id),
  };
}

export function doctorAtStart(dataDir: string, version: string, options: Partial<RunDoctorOptions> & { log?: (line: string) => void } = {}): DoctorSummary | null {
  const log = options.log ?? ((line: string) => console.log(line));
  try {
    const state = readState(dataDir);
    if (state && state.version === version) {
      current = { ...state.summary, thisStart: false };
      return current;
    }
    const report = runDoctor({ ...options, dataDir, version, mode: "start", fix: true });
    const lines = reportLines(report);
    for (const line of lines) log(`[doctor] ${line}`);
    log(`[doctor] ${state ? `first start of ${version} (last: ${state.version})` : `first start of ${version}`}: ${report.counts.checked} checks, ${report.counts.fixed} fixed, ${report.counts.problems} need a person${report.backup ? `; what was changed was copied to ${report.backup} first` : ""}.`);
    const summary = summaryOf(report);
    current = { ...summary, thisStart: true };
    try {
      writeFileAtomic(join(dataDir, DOCTOR_STATE_FILE), `${JSON.stringify({ version, summary } satisfies DoctorState, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      log(`[doctor] could not record this version in ${DOCTOR_STATE_FILE} (${error instanceof Error ? error.message : String(error)}); it runs again at the next start.`);
    }
    return current;
  } catch (error) {
    log(`[doctor] did not run: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
