// <data>/doctor-backups/<time>/: every fix puts what it is about to change here first, at the same path it has in the
// data folder, and writes a line in manifest.json. Made on the first fix of a run, so a run that changes nothing leaves
// no folder. Owner-only: it holds copies of the registries.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export const DOCTOR_BACKUPS_DIR = "doctor-backups";

export type BackupEntry = { check: string; action: string; path: string; savedAs?: string; mode?: string };

export class DoctorBackup {
  private folder: string | null = null;
  private readonly entries: BackupEntry[] = [];

  private readonly dataDir: string;
  private readonly now: () => number;

  constructor(dataDir: string, now: () => number) {
    this.dataDir = dataDir;
    this.now = now;
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
    return folder;
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

function tighten(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try { chmodSync(path, mode); } catch {}
}
