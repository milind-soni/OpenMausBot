// An engine CLI's `--version` and `--help` answers, kept between starts of the desktop app: they cannot change while the
// program file is the same, and each start used to run them again (a process each, hundreds of ms for a Node CLI, more on
// Windows). Only under the desktop app (its own folder, OMB_USER_DATA, never the data folder); any other server runs every
// probe as before. Only successful answers are kept, never a sign-in check (`auth status`), whose answer changes.
//
// The key is the program file itself: its real path, size, modification and change times and inode, plus the app's
// version, the platform and the arguments. An update writes a new file (npm and Homebrew both do, and a reinstall gets a
// new change time even when the package keeps the 1985 modification time npm gives every file), so it is asked again. Not
// kept: a program that is a shell script or a version manager's shim (asdf, mise, volta and the like), whose file stays
// the same while the version it runs changes.
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ExecFileOptions } from "node:child_process";

import { writeFileAtomic } from "./atomic.ts";
import { findCliCandidates, resolveCliSpawn, splitCliString } from "./env-path.ts";
import { execCli } from "./procs.ts";

export const PROBE_CACHE_FILE = "engine-probes.json";
const KEPT = 64;
const OUTPUT_MAX = 64 * 1024;
const CACHED_ARGS = new Set(["--version", "--help"]);
const SHIM_PROGRAMS = new Set(["mise", "rtx", "asdf", "volta", "volta-shim", "proto", "fnm", "nodenv", "pyenv", "rbenv", "goenv", "aqua", "nvm", "pkgx", "devbox"]);
const SHELL_INTERPRETERS = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh)\b/;

type Entry = { stdout: string; stderr: string };
type ExecCli = typeof execCli;

/** The file the desktop app keeps the answers in; null on any other server. */
export function probeCacheFile(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.OMB_DESKTOP_PARENT === "1" && env.OMB_USER_DATA && isAbsolute(env.OMB_USER_DATA) ? join(env.OMB_USER_DATA, PROBE_CACHE_FILE) : null;
}

/** The file a probe of `cli` actually runs (a Windows .cmd shim's script, not the shim), or null when it is not one whose
 * answer may be kept. */
export function probedProgram(cli: string, path: string, platform: NodeJS.Platform = process.platform): string | null {
  if (splitCliString(cli).length !== 1) return null;
  const found = findCliCandidates(cli, path)[0];
  if (!found) return null;
  let file = found;
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(found)) {
    const resolved = resolveCliSpawn(found, []);
    const script = resolved.args[0];
    if (resolved.command === found || !script || !isAbsolute(script)) return null;
    file = script;
  }
  let real: string;
  try { real = realpathSync(file); } catch { return null; }
  const name = basename(real).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, "");
  if (SHIM_PROGRAMS.has(name) || real.toLowerCase().split(/[\\/]/).includes("shims")) return null;
  if (/\.(?:ps1|sh)$/i.test(real) || shellScript(real)) return null;
  return real;
}

function shellScript(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(128);
    const read = readSync(fd, head, 0, head.length, 0);
    return SHELL_INTERPRETERS.test(head.subarray(0, read).toString("utf8").split("\n")[0] ?? "");
  } catch {
    return true;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

/** The key one answer is kept under, or null when the program cannot be read. */
export function probeKey(program: string, args: readonly string[], appVersion: string, platform: NodeJS.Platform = process.platform): string | null {
  let stat;
  try { stat = statSync(program, { bigint: true }); } catch { return null; }
  if (!stat.isFile()) return null;
  return createHash("sha256").update(JSON.stringify([appVersion, platform, program, String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), String(stat.ino), String(stat.dev), args])).digest("hex").slice(0, 40);
}

function readEntries(file: string): Map<string, Entry> {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; entries?: unknown };
    if (raw?.v !== 1 || !Array.isArray(raw.entries)) return new Map();
    const entries = new Map<string, Entry>();
    for (const item of raw.entries.slice(-KEPT)) {
      if (!Array.isArray(item) || typeof item[0] !== "string" || !item[1] || typeof item[1].stdout !== "string" || typeof item[1].stderr !== "string") continue;
      entries.set(item[0], { stdout: item[1].stdout, stderr: item[1].stderr });
    }
    return entries;
  } catch {
    return new Map();
  }
}

/**
 * execCli for a probe whose answer is fixed by the program file: answered from the desktop app's kept copy when the file
 * is unchanged, else run, and kept when it succeeds with some output. The callback gets exactly what a run would give.
 */
export function createCliProbeCache(options: { file: string | null; appVersion: string; run?: ExecCli; platform?: NodeJS.Platform }) {
  const run = options.run ?? execCli;
  const platform = options.platform ?? process.platform;
  let entries: Map<string, Entry> | null = null;
  const loaded = () => (entries ??= options.file ? readEntries(options.file) : new Map());
  const save = () => {
    if (!options.file) return;
    try {
      mkdirSync(dirname(options.file), { recursive: true });
      writeFileAtomic(options.file, JSON.stringify({ v: 1, entries: [...loaded()].slice(-KEPT) }), { durable: false });
    } catch {}
  };
  const exec: ExecCli = (cli, args, opts, cb) => {
    const program = options.file && args.length === 1 && CACHED_ARGS.has(args[0]!) ? probedProgram(cli, String((opts.env ?? process.env).PATH ?? ""), platform) : null;
    const key = program ? probeKey(program, args, options.appVersion, platform) : null;
    const kept = key ? loaded().get(key) : undefined;
    if (kept) {
      queueMicrotask(() => cb(null, kept.stdout, kept.stderr));
      return;
    }
    run(cli, args, opts, (err, stdout, stderr) => {
      if (key && !err && typeof stdout === "string" && `${stdout}${stderr ?? ""}`.trim() && stdout.length <= OUTPUT_MAX && (stderr ?? "").length <= OUTPUT_MAX && probeKey(program!, args, options.appVersion, platform) === key) {
        const map = loaded();
        map.delete(key);
        map.set(key, { stdout, stderr: stderr ?? "" });
        while (map.size > KEPT) map.delete(map.keys().next().value!);
        save();
      }
      cb(err, stdout, stderr);
    });
  };
  return { exec, forget() { entries = new Map(); save(); } };
}

let shared: ReturnType<typeof createCliProbeCache> | null = null;

/** execCli for `--version` and `--help` probes: the desktop app's kept answer when the program is unchanged. */
export const execCliProbe: ExecCli = (cli, args, opts: ExecFileOptions, cb) => {
  shared ??= createCliProbeCache({ file: probeCacheFile(), appVersion: process.env.OMB_APP_VERSION ?? "dev" });
  shared.exec(cli, args, opts, cb);
};
