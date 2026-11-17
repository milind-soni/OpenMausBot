// <data>/doctor-backups/<time>/: every fix puts what it is about to change here first, at the same path it has in the
// data folder, and writes a line in manifest.json. Made on the first fix of a run, so a run that changes nothing leaves
// no folder. Owner-only: it holds copies of the registries.
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export const DOCTOR_BACKUPS_DIR = "doctor-backups";
/** The newest runs' copies kept; an older run's go when a new run copies something. */
export const DOCTOR_BACKUPS_KEPT = 10;
/** A run that kept a copy of bots.json or groups.json is kept this long whatever else: it may be the only one left. */
export const DOCTOR_BACKUPS_REGISTRY_DAYS = 30;
/** The older runs together stay under this; the oldest go first. A run kept for its registry copy stays even past it
 * (those copies are small; a large run is a messages.db copy, which is not held). */
export const DOCTOR_BACKUPS_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export type BackupLimits = { kept?: number; registryDays?: number; maxBytes?: number };

export type BackupEntry = { check: string; action: string; path: string; savedAs?: string; mode?: string };

export class DoctorBackup {
  private folder: string | null = null;
  private readonly entries: BackupEntry[] = [];

  private readonly dataDir: string;
  private readonly now: () => number;
  private readonly limits: BackupLimits;

  constructor(dataDir: string, now: () => number, limits: BackupLimits = {}) {
    this.dataDir = dataDir;
    this.now = now;
    this.limits = limits;
  }

  /** The run's folder, once anything was put in it. */
  get path(): string | null {
    return this.folder;
  }

  private open(): string {
    if (this.folder) return this.folder;
    const root = join(this.dataDir, DOCTOR_BACKUPS_DIR);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    tighten(root, 0o700);
    // No colons: the folder name is valid on Windows too.
    const base = new Date(this.now()).toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-");
    let name = base;
    for (let n = 2; existsSync(join(root, name)); n += 1) name = `${base}-${n}`;
    const folder = join(root, name);
    mkdirSync(folder, { mode: 0o700 });
    this.folder = folder;
    try { this.prune(root, name); } catch {}
    return folder;
  }

  /** Beyond the newest runs, and while the older runs together are over the size cap, the oldest go; never one that
   * kept a registry copy in the last 30 days. */
  private prune(root: string, current: string): void {
    const kept = this.limits.kept ?? DOCTOR_BACKUPS_KEPT, maxBytes = this.limits.maxBytes ?? DOCTOR_BACKUPS_MAX_BYTES;
    const holdSince = this.now() - (this.limits.registryDays ?? DOCTOR_BACKUPS_REGISTRY_DAYS) * 86_400_000;
    // The names sort by time.
    const runs = readdirSync(root).filter((entry) => entry !== current && /^\d{4}-\d{2}-\d{2}T/.test(entry)).sort();
    const held = (run: string) => (runTime(run) ?? Infinity) >= holdSince && holdsRegistry(join(root, run));
    const sizes = new Map(runs.map((run) => [run, bytesIn(join(root, run))]));
    let total = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
    runs.forEach((run, at) => {
      const beyond = runs.length - at > kept - 1;
      if ((!beyond && total <= maxBytes) || held(run)) return;
      try {
        rmSync(join(root, run), { recursive: true, force: true });
        total -= sizes.get(run)!;
      } catch {}
    });
  }

  private target(path: string): string {
    const inData = relative(this.dataDir, path);
    const safe = !inData || inData.startsWith("..") || inData.includes(`..${sep}`) ? path.split(/[\\/]/).filter(Boolean).join("_") : inData;
    const to = join(this.open(), safe);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    return to;
  }

  /** A copy of `path` (a file or a folder); the original stays. Returns where the copy is. */
  copy(check: string, path: string, action = "copied before the fix"): string {
    const to = this.target(path);
    if (statSync(path).isDirectory()) cpSync(path, to, { recursive: true, errorOnExist: true, force: false });
    else {
      copyFileSync(path, to);
      tighten(to, 0o600);
    }
    this.record({ check, action, path, savedAs: to });
    return to;
  }

  /** Moves `path` into the backup (one rename, the data folder and its backups being one filesystem). */
  move(check: string, path: string, action = "moved out of the data folder"): string {
    const to = this.target(path);
    renameSync(path, to);
    this.record({ check, action, path, savedAs: to });
    return to;
  }

  /** A change with nothing to copy (a mode, a folder made): written down only. */
  note(check: string, action: string, path: string, mode?: number): void {
    this.open();
    this.record({ check, action, path, ...(mode !== undefined ? { mode: `0${(mode & 0o777).toString(8)}` } : {}) });
  }

  private record(entry: BackupEntry): void {
    this.entries.push(entry);
    const manifest = join(this.open(), "manifest.json");
    writeFileSync(manifest, `${JSON.stringify({ entries: this.entries }, null, 2)}\n`, { mode: 0o600 });
  }
}

/** When a run's folder was made, from its name (`2026-11-17T09-30-00Z`, maybe with `-2`). */
function runTime(run: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(run);
  if (!match) return null;
  const at = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
  return Number.isNaN(at) ? null : at;
}

/** The run kept a copy of bots.json or groups.json; one whose manifest cannot be read is taken to have. */
function holdsRegistry(folder: string): boolean {
  try {
    const { entries } = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as { entries?: BackupEntry[] };
    return !Array.isArray(entries) || entries.some((entry) => entry.check === "registry");
  } catch {
    return true;
  }
}

function bytesIn(path: string): number {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) return stat.size;
    return readdirSync(path).reduce((sum, name) => sum + bytesIn(join(path, name)), 0);
  } catch {
    return 0;
  }
}

function tighten(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try { chmodSync(path, mode); } catch {}
}
