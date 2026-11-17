// Runs the checks, and with `fix` the repairs that cannot lose data. Every check is looked at first; repairs run only
// when nothing blocks (a data format this version cannot read), and only in a process that holds the data folder's lease:
// the server as it starts, or `openmausbot doctor --data --fix`, which takes the lease for its run and changes nothing
// while a server uses the folder, and only as the folder's owner. Each repair looks again right before it runs, and once
// more after; those looks skip what is slow to read (SQLite's check of messages.db) and take it from the first look.
import { statSync } from "node:fs";

import { acquireDataDirLease, type DataDirLeaseHolder } from "../data-dir-lease.ts";
import { DoctorBackup } from "./backup.ts";
import { dataFormatCheck } from "./checks/data-format.ts";
import { engineRunsCheck } from "./checks/engine-runs.ts";
import { foldersCheck } from "./checks/folders.ts";
import { leaseCheck } from "./checks/lease.ts";
import { messagesDbCheck } from "./checks/messages-db.ts";
import { registryCheck } from "./checks/registry.ts";
import { secretModesCheck } from "./checks/secret-modes.ts";
import { settingsFileCheck } from "./checks/settings-file.ts";
import { tempFilesCheck } from "./checks/temp-files.ts";
import { pidAlive } from "./files.ts";
import type { CheckResult, DoctorCheck, DoctorContext, DoctorReport, Finding } from "./types.ts";

/** In this order: the registry looks at temp files before they are moved aside, since one may be its only whole copy. */
export function defaultChecks(): DoctorCheck[] {
  return [dataFormatCheck(), leaseCheck(), foldersCheck(), registryCheck(), tempFilesCheck(), engineRunsCheck(), messagesDbCheck(), secretModesCheck(), settingsFileCheck()];
}

export interface RunDoctorOptions {
  dataDir: string;
  version: string;
  mode: DoctorContext["mode"];
  fix: boolean;
  checks?: DoctorCheck[];
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  startedAt?: number;
  /** "command" mode only: takes the data folder's lease for the repairs. */
  acquireLease?: (dataDir: string) => { release(): unknown };
  /** "command" mode only: this process's effective user id, null where there is none (Windows). */
  euid?: () => number | null;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

function look(check: DoctorCheck, ctx: DoctorContext): Finding & { failed?: boolean } {
  try {
    return check.check(ctx);
  } catch (error) {
    return { status: "problem", failed: true, summary: `The check itself failed: ${errorText(error)}` };
  }
}

function resultOf(check: DoctorCheck, finding: Finding & { failed?: boolean }): CheckResult {
  return {
    id: check.id, title: check.title, looksAt: check.looksAt,
    status: finding.failed ? "failed" : finding.status,
    summary: finding.summary,
    // The lease is repaired by taking it, which the runner does itself before any fix.
    fixable: Boolean(finding.fixable && (check.fix || check.id === "lease")),
    blocking: Boolean(finding.blocking),
    ...(finding.instruction ? { instruction: finding.instruction } : {}),
  };
}

/** The user ids of this process and of the data folder's owner, when they differ (POSIX only). */
function otherOwner(dataDir: string, euid: () => number | null): { euid: number; owner: number } | null {
  if (process.platform === "win32") return null;
  const id = euid();
  if (id === null) return null;
  let owner: number;
  try { owner = statSync(dataDir).uid; } catch { return null; }
  return owner === id ? null : { euid: id, owner };
}

const defaultEuid = () => (typeof process.geteuid === "function" ? process.geteuid() : null);

const wantsFix = (check: DoctorCheck, finding: Finding) => Boolean(check.fix && finding.status === "problem" && (finding.fixable || finding.keepCopy));

export function runDoctor(options: RunDoctorOptions): DoctorReport {
  const now = options.now ?? Date.now;
  const ctx: DoctorContext = { dataDir: options.dataDir, version: options.version, mode: options.mode, now, pidAlive: options.pidAlive ?? pidAlive,
    startedAt: options.startedAt ?? performance.timeOrigin };
  const checks = options.checks ?? defaultChecks();
  const findings = checks.map((check) => look(check, ctx));
  const results = checks.map((check, at) => resultOf(check, findings[at]!));
  const backup = new DoctorBackup(options.dataDir, now);
  const fix: DoctorReport["fix"] = { asked: options.fix, ran: false };

  if (options.fix) {
    let release: (() => void) | null = null;
    const blocked = results.find((result) => result.blocking);
    const leaseAt = checks.findIndex((check) => check.id === "lease");
    const holder = leaseAt >= 0 ? findings[leaseAt]!.detail as DataDirLeaseHolder | undefined : undefined;
    const foldersAt = checks.findIndex((check) => check.id === "folders");
    const noFolder = foldersAt >= 0 && findings[foldersAt]!.status === "problem" && !findings[foldersAt]!.fixable;
    if (blocked) fix.why = `${blocked.title}: ${blocked.summary} Nothing was changed.`;
    else if (noFolder) fix.why = `${results[foldersAt]!.summary} Nothing was changed.`;
    else if (options.mode === "command") {
      // What a fix moves keeps its owner, and what it copies or makes would be this user's: a server running as the
      // folder's owner could then not read or tidy it.
      const other = otherOwner(options.dataDir, options.euid ?? defaultEuid);
      if (other) fix.why = `The data folder belongs to user ${other.owner}, and this runs as user ${other.euid}. Run it as the folder's owner. Nothing was changed.`;
      else if (holder?.state === "alive") fix.why = `A server is using the data folder (process ${holder.pid}). Stop it, then run this again. Nothing was changed.`;
      else if (holder?.state === "other-machine" || holder?.state === "invalid") fix.why = `${results[leaseAt]!.summary} Nothing was changed.`;
      else {
        try {
          if (holder?.state === "dead") backup.copy("lease", holder.path, "the lease a dead process left, before it was retired");
          const lease = (options.acquireLease ?? acquireDataDirLease)(options.dataDir);
          release = () => { lease.release(); };
          if (holder?.state === "dead") Object.assign(results[leaseAt]!, { status: "fixed", fixable: false, repaired: true, fixed: `Retired the lease process ${holder.pid} left.` });
        } catch (error) {
          fix.why = `The data folder's lease could not be taken (${errorText(error)}). Nothing was changed.`;
        }
      }
    }
    if (!fix.why) {
      fix.ran = true;
      try {
        checks.forEach((check, at) => {
          if (check.id === "lease" || !wantsFix(check, findings[at]!)) return;
          const again = { ...ctx, earlier: findings[at]! };
          const fresh = look(check, again);
          if (!wantsFix(check, fresh)) {
            results[at] = resultOf(check, fresh);
            return;
          }
          let did: string;
          try {
            did = check.fix!(ctx, fresh, backup);
          } catch (error) {
            results[at] = { ...resultOf(check, fresh), status: "failed", summary: `${fresh.summary} The fix failed: ${errorText(error)}` };
            return;
          }
          const after = look(check, again);
          // A repair is counted only when the look after it finds the repairable part gone: all fine, or what is left is
          // not repairable (a registry file with no whole copy, beside one that was put back). A fix that changed nothing
          // (a mode on a filesystem without modes) is not one, nor one whose look after it failed.
          const repaired = Boolean(fresh.fixable) && !after.failed && (after.status === "ok" || !after.fixable);
          results[at] = after.status === "ok"
            ? { ...resultOf(check, fresh), status: "fixed", fixable: false, fixed: did, repaired }
            : { ...resultOf(check, after), fixed: did, repaired };
        });
      } finally {
        try { release?.(); } catch {}
      }
    }
  }

  const problems = results.filter((result) => result.status === "problem" || result.status === "failed").length;
  return {
    dataDir: options.dataDir,
    version: options.version,
    at: new Date(now()).toISOString(),
    fix,
    checks: results,
    backup: backup.path,
    counts: {
      checked: results.length,
      problems,
      fixed: results.filter((result) => result.repaired).length,
      blocking: results.filter((result) => result.blocking).length,
    },
  };
}

/** One line per check that is not simply ok, for a log. */
export function reportLines(report: DoctorReport): string[] {
  const lines = report.checks.filter((result) => result.status !== "ok").map((result) => result.status === "fixed"
    ? `${result.id}: ${result.summary} Fixed: ${result.fixed}`
    : `${result.id}: ${result.summary}${result.fixed ? ` (${result.fixed})` : ""}${result.instruction ? ` ${result.instruction}` : ""}`);
  if (report.fix.asked && !report.fix.ran && report.fix.why) lines.push(`no fixes ran: ${report.fix.why}`);
  return lines;
}
