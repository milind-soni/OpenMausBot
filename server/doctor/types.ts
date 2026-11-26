// The doctor's parts: a check looks at one thing in a server's data folder and says ok or what is wrong; a check whose
// problem has a repair that cannot lose data also has `fix`, which the runner calls only after the data is this
// process's (it holds the folder's lease) and after the backup has taken a copy of what the repair changes.
import type { DoctorBackup } from "./backup.ts";

export interface DoctorContext {
  dataDir: string;
  /** The version running the checks. */
  version: string;
  /** "start": the server's own run as it starts, holding the lease; "command": `openmausbot doctor --data`. */
  mode: "start" | "command";
  now(): number;
  /** When this process started (ms): a temp file with its pid from before then is a predecessor's. */
  startedAt: number;
  /** Whether a process with this pid runs on this machine (EPERM counts as running). */
  pidAlive(pid: number): boolean;
  /** Set in the looks the runner takes again, right before and after a fix: what the first look found. A check whose
   * look reads a lot (messages.db) does that read only in the first look, and takes its verdict from here. */
  earlier?: Finding;
}

export type Finding = {
  status: "ok" | "problem";
  /** One plain sentence: what was found. Never a secret, never a file's contents. */
  summary: string;
  /** `fix` can repair this, or the part of it that is safe to, without losing anything. */
  fixable?: boolean;
  /** Not repairable, but `fix` still runs to keep a copy of what is damaged where nothing will overwrite it. */
  keepCopy?: boolean;
  /** A problem that makes starting unsafe; no fix of any check runs while one is found. */
  blocking?: boolean;
  /** What a person does about a problem the doctor does not fix. */
  instruction?: string;
  /** What `fix` needs, from the same look. */
  detail?: unknown;
};

export interface DoctorCheck {
  id: string;
  title: string;
  /** What it reads, in a few words. */
  looksAt: string;
  check(ctx: DoctorContext): Finding;
  /** Repairs the problem `finding` describes; copies what it changes into `backup` first. Returns what it did. */
  fix?(ctx: DoctorContext, finding: Finding, backup: DoctorBackup): string;
}

export type CheckResult = {
  id: string;
  title: string;
  looksAt: string;
  status: "ok" | "problem" | "fixed" | "failed";
  summary: string;
  fixable: boolean;
  blocking: boolean;
  instruction?: string;
  /** What the fix did, when it ran. */
  fixed?: string;
  /** The fix repaired something (a copy kept of what it could not repair is not a repair). */
  repaired?: boolean;
};

export type DoctorReport = {
  dataDir: string;
  version: string;
  at: string;
  /** Whether fixes were asked for, and whether they could run. */
  fix: { asked: boolean; ran: boolean; why?: string };
  checks: CheckResult[];
  /** The folder this run copied things into before changing them, when it changed anything. */
  backup: string | null;
  counts: { checked: number; problems: number; fixed: number; blocking: number };
};
