// Security: a bot reaches the person's files here only inside their own folders: their home and the places Windows,
// macOS or the desktop name as their Desktop, Documents, Downloads (which OneDrive or iCloud may keep elsewhere). Never
// the system, another account, anything hidden at any depth (.git, .env, .ssh), Library or AppData, PowerShell's
// folders, the app's own data, nor anything through a link. A write never makes or changes something that runs: no
// script or program file type, no file with an execute bit, nothing in an app bundle or in a folder on PATH.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export type HostFilePlatform = "darwin" | "linux" | "win32";

export interface HostPlace {
  name: string;
  /** Real path, every link resolved. */
  path: string;
  /** The spelling it was found under, which a bot may use too (macOS /tmp is /private/tmp). */
  given: string;
}

export interface HostFolders {
  platform: HostFilePlatform;
  /** Home first. */
  places: HostPlace[];
  denied: string[];
  /** The folders on PATH, real paths. */
  programs: string[];
}

/** The bridge's reading of `withHostFiles`; null leaves the file tools off. */
export function hostFilesSetting(value: string | undefined, platform: string | undefined): { platform: HostFilePlatform; appData: string[] } | null {
  if (!value || (platform !== "darwin" && platform !== "linux" && platform !== "win32")) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const appData = (parsed as { appData?: unknown })?.appData;
    if (!Array.isArray(appData) || !appData.every((entry) => typeof entry === "string")) return null;
    return { platform, appData };
  } catch {
    return null;
  }
}

export class HostFileRefusal extends Error {}

export const OUTSIDE =
  "That path is outside the person's own folders on this computer. Files can be read and saved only in their home folder and its subfolders, Desktop, Documents and Downloads included: call list_files with no path to see where those are.";
const SETTINGS = "That is a folder of settings, keys or app data, which bots cannot open. Use a folder such as Documents or Desktop.";
const RUNS = "Bots cannot save a file that runs as a program or script there. Save it as text (.txt, .md) or a document instead.";
const LINKED = "That path goes through a link or shortcut to another place, which is not followed. Use the real folder's path: list_files with no path shows it.";

const pathFor = (platform: HostFilePlatform) => (platform === "win32" ? path.win32 : path.posix);
/** Windows and macOS compare paths without case; macOS also without Unicode form. */
const fold = (platform: HostFilePlatform, value: string) => (platform === "linux" ? value : value.normalize("NFC").toLowerCase());

function trimmed(platform: HostFilePlatform, value: string): string {
  const { sep, parse } = pathFor(platform);
  return value.length > parse(value).root.length && value.endsWith(sep) ? value.slice(0, -1) : value;
}

export function sameOrInside(platform: HostFilePlatform, child: string, parent: string): boolean {
  const { sep } = pathFor(platform);
  const c = fold(platform, trimmed(platform, child));
  const p = fold(platform, trimmed(platform, parent));
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\..*)?$/i;

function badName(platform: HostFilePlatform, part: string): boolean {
  if (part === "." || part === ".." || [...part].some((char) => char.charCodeAt(0) < 0x20)) return true;
  return platform === "win32" && (WINDOWS_DEVICE.test(part) || /[<>:"|?*]/.test(part) || /[. ]$/.test(part));
}

/** The place a requested path is in and its names below it, or why it is refused. Pure: nothing on disk is read. */
export function placeOf(folders: HostFolders, raw: unknown): { place: HostPlace; parts: string[] } {
  const { platform } = folders;
  const p = pathFor(platform);
  if (typeof raw !== "string" || !raw || raw.length > 4096 || raw.includes("\0")) throw new HostFileRefusal("Give the file's full path.");
  const home = folders.places[0];
  if (!home) throw new HostFileRefusal(OUTSIDE);
  let text = raw;
  if (text === "~" || text.startsWith("~/") || (platform === "win32" && text.startsWith("~\\"))) text = home.given + text.slice(1);
  if (platform === "win32") {
    // Drive-letter paths only: never \\server\share, \\?\ or \\.\ device paths, nor C:relative or a file:stream.
    if (!/^[A-Za-z]:[\\/]/.test(text)) throw new HostFileRefusal("Give a full path that starts with a drive letter, like C:\\Users\\name\\Documents\\notes.txt.");
    if (text.slice(2).includes(":")) throw new HostFileRefusal("A path cannot contain ':' after its drive letter.");
  } else if (!text.startsWith("/")) {
    throw new HostFileRefusal("Give a full path that starts with /, like " + p.join(home.given, "Documents", "notes.txt") + ".");
  }
  const normal = trimmed(platform, p.normalize(text)).normalize("NFC");
  let best: { place: HostPlace; base: string } | undefined;
  for (const place of folders.places) {
    for (const base of [place.path, place.given]) {
      if (sameOrInside(platform, normal, base) && (!best || base.length > best.base.length)) best = { place, base: trimmed(platform, base).normalize("NFC") };
    }
  }
  if (!best) throw new HostFileRefusal(OUTSIDE);
  const parts = normal.slice(best.base.length).split(p.sep).filter(Boolean);
  if (parts.some((part) => badName(platform, part))) throw new HostFileRefusal("That path has a name a file cannot have here.");
  return { place: best.place, parts };
}

/** Folders the shell and PowerShell run code from, at any depth. */
const RUNS_FROM = new Set(["powershell", "windowspowershell"]);
/** Opened by the system as a program, script or shortcut when double-clicked or listed. */
const RUNNABLE_TYPES: Record<HostFilePlatform, readonly string[]> = {
  win32: [".bat", ".cmd", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta", ".exe", ".scr", ".com", ".pif", ".msi", ".dll", ".ps1",
    ".psm1", ".lnk", ".url", ".scf", ".library-ms", ".searchconnector-ms"],
  darwin: [".command", ".terminal", ".app", ".tool", ".workflow"],
  linux: [".desktop"],
};

/** The innermost place holding a real path, and the names below it. */
function within(folders: HostFolders, target: string): { place: HostPlace; parts: string[] } | null {
  const { platform } = folders;
  const holding = folders.places.filter((place) => sameOrInside(platform, target, place.path));
  const place = holding.sort((a, b) => b.path.length - a.path.length)[0];
  return place ? { place, parts: target.slice(trimmed(platform, place.path).length).split(pathFor(platform).sep).filter(Boolean) } : null;
}

/** Why a real path is off limits to read or write, or null. Pure. */
export function refusalFor(folders: HostFolders, target: string): string | null {
  const { platform } = folders;
  const found = within(folders, target);
  if (!found) return OUTSIDE;
  if (folders.denied.some((denied) => sameOrInside(platform, target, denied))) return SETTINGS;
  const names = found.parts.map((part) => part.normalize("NFC").toLowerCase());
  if (names.some((name) => name.startsWith(".") || RUNS_FROM.has(name))) return SETTINGS;
  const top = found.place === folders.places[0] ? names[0] : undefined;
  if (top === "library" || top === "appdata" || (platform === "linux" && top === "snap")) return SETTINGS;
  return null;
}

/** Why a file may not be saved at this real path, beyond `refusalFor`, or null. Pure. */
export function writeRefusal(folders: HostFolders, target: string, kind: "file" | "folder" = "file"): string | null {
  const { platform } = folders;
  const p = pathFor(platform);
  const names = trimmed(platform, target).split(p.sep).filter(Boolean).map((part) => part.normalize("NFC").toLowerCase());
  if (platform === "darwin" && names.some((name) => name.endsWith(".app"))) return RUNS;
  if (kind === "folder") return null;
  const name = names.at(-1) ?? "";
  if (RUNNABLE_TYPES[platform].some((type) => name.endsWith(type)) || (platform === "win32" && name === "desktop.ini")) return RUNS;
  const folder = fold(platform, p.dirname(trimmed(platform, target)));
  if (folders.programs.some((program) => fold(platform, trimmed(platform, program)) === folder)) return RUNS;
  return null;
}

/** The real path of a requested one, refusing any link on the way, and whether it exists yet. Names past the first missing
 * one are new and so cannot be links. */
export async function resolveHostPath(folders: HostFolders, raw: unknown): Promise<{ target: string; exists: boolean }> {
  const { platform } = folders;
  const p = pathFor(platform);
  const { place, parts } = placeOf(folders, raw);
  let current = place.path;
  let walked = 0;
  for (const part of parts) {
    const next = p.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(next);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") break;
      if (code === "ENOTDIR") throw new HostFileRefusal(`${current} is a file, not a folder.`);
      throw error;
    }
    // Windows junctions and symlinks both read as links here.
    if (stat.isSymbolicLink()) throw new HostFileRefusal(LINKED);
    if (!stat.isDirectory() && walked < parts.length - 1) throw new HostFileRefusal(`${next} is a file, not a folder.`);
    current = next;
    walked += 1;
  }
  const real = await fs.realpath(current);
  if (!sameOrInside(platform, real, place.path)) throw new HostFileRefusal(LINKED);
  const target = p.join(real, ...parts.slice(walked));
  const refused = refusalFor(folders, target);
  if (refused) throw new HostFileRefusal(refused);
  return { target, exists: walked === parts.length };
}

export type RunCommand = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const runCommand: RunCommand = (file, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 256 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

/** Windows' own answer for where each folder is, which OneDrive's backup moves (C:\Users\name\OneDrive\Documentos), as UTF-8 JSON. */
const WINDOWS_FOLDERS_SCRIPT = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "$f = [ordered]@{}",
  "foreach ($n in 'Desktop','MyDocuments','MyPictures','MyMusic','MyVideos') { $f[$n] = [Environment]::GetFolderPath($n) }",
  "$d = (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' -ErrorAction SilentlyContinue).'{374DE290-123F-4565-9164-39C4925E467B}'",
  "if ($d) { $f['Downloads'] = [Environment]::ExpandEnvironmentVariables($d) }",
  "$f | ConvertTo-Json -Compress",
].join("\n");
const WINDOWS_NAMES: Record<string, string> = {
  Desktop: "Desktop", MyDocuments: "Documents", Downloads: "Downloads", MyPictures: "Pictures", MyMusic: "Music", MyVideos: "Videos",
};
/** Cold PowerShell under an antivirus scan can take seconds on a slow PC. */
const WINDOWS_FOLDERS_MS = 15_000;

export function windowsFoldersFrom(output: string): Array<{ name: string; path: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim().replace(/^\uFEFF/, ""));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return Object.entries(parsed as Record<string, unknown>).flatMap(([key, value]) => {
    const name = WINDOWS_NAMES[key];
    return name && typeof value === "string" && /^[A-Za-z]:\\/.test(value) ? [{ name, path: value }] : [];
  });
}

function linuxFoldersFrom(text: string, home: string): Array<{ name: string; path: string }> {
  const names: Record<string, string> = { DESKTOP: "Desktop", DOCUMENTS: "Documents", DOWNLOAD: "Downloads", PICTURES: "Pictures", MUSIC: "Music", VIDEOS: "Videos" };
  const found: Array<{ name: string; path: string }> = [];
  for (const line of text.split("\n")) {
    const match = /^XDG_([A-Z]+)_DIR="(\$HOME\/[^"$`\\]*|\/[^"$`\\]*)"\s*$/.exec(line.trim());
    const name = match && names[match[1]!];
    if (name) found.push({ name, path: match[2]!.startsWith("$HOME/") ? path.posix.join(home, match[2]!.slice(6)) : match[2]! });
  }
  return found;
}

/** Where the person's named folders are, as found; not yet checked. */
export async function knownFolders(platform: HostFilePlatform, home: string, env: NodeJS.ProcessEnv, run: RunCommand = runCommand): Promise<Array<{ name: string; path: string }>> {
  const p = pathFor(platform);
  const under = (...names: string[]) => names.map((name) => ({ name, path: p.join(home, name) }));
  if (platform === "darwin") {
    return [...under("Desktop", "Documents", "Downloads", "Pictures", "Music", "Movies"),
      { name: "iCloud Drive", path: p.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs") },
      { name: "Cloud storage", path: p.join(home, "Library", "CloudStorage") }];
  }
  if (platform === "linux") {
    const configHome = env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : p.join(home, ".config");
    const listed = await fs.readFile(p.join(configHome, "user-dirs.dirs"), "utf8").then((text) => linuxFoldersFrom(text, home), () => []);
    return [...listed, ...under("Desktop", "Documents", "Downloads")];
  }
  const systemRoot = env.SystemRoot && /^[A-Za-z]:\\/.test(env.SystemRoot) ? env.SystemRoot : "C:\\Windows";
  const powershell = p.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const asked = await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_FOLDERS_SCRIPT, "utf16le").toString("base64")], WINDOWS_FOLDERS_MS)
    .then(windowsFoldersFrom, () => []);
  const oneDrive = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"].flatMap((key) => {
    const value = env[key];
    return value && /^[A-Za-z]:\\/.test(value) ? [{ name: "OneDrive", path: value }] : [];
  });
  return [...asked, ...oneDrive, ...under("Desktop", "Documents", "Downloads")];
}

/** A named folder may stand beside home (D:\Documents) on Windows, never as a drive, a parent of home or a system folder. */
function acceptablePlace(platform: HostFilePlatform, place: string, home: string, env: NodeJS.ProcessEnv): boolean {
  const p = pathFor(platform);
  if (!p.isAbsolute(place) || trimmed(platform, place) === p.parse(place).root || sameOrInside(platform, home, place)) return false;
  if (sameOrInside(platform, place, home)) return true;
  if (platform !== "win32" || sameOrInside(platform, place, p.dirname(trimmed(platform, home)))) return false;
  const system = [env.SystemRoot, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData, "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"];
  return !system.some((folder) => folder && sameOrInside(platform, place, folder));
}

/** This person's folders, each real and checked, and what inside them stays closed: `appData` is the app's own data. */
export async function hostFolders(options: { platform: HostFilePlatform; home: string; env: NodeJS.ProcessEnv; appData: readonly string[]; run?: RunCommand }): Promise<HostFolders> {
  const { platform, home, env } = options;
  const p = pathFor(platform);
  const realHome = await fs.realpath(home).catch(() => null);
  if (!realHome) return { platform, places: [], denied: [], programs: [] };
  const places: HostPlace[] = [{ name: "Home", path: realHome, given: home }];
  for (const found of await knownFolders(platform, home, env, options.run)) {
    if (!acceptablePlace(platform, found.path, home, env)) continue;
    const real = await fs.realpath(found.path).catch(() => null);
    if (!real || !acceptablePlace(platform, real, realHome, env) || places.some((place) => place.name === found.name || fold(platform, real) === fold(platform, place.path))) continue;
    places.push({ name: found.name, path: real, given: found.path });
  }
  const denied = new Set<string>();
  for (const entry of options.appData) {
    if (!entry || !p.isAbsolute(entry)) continue;
    denied.add(entry);
    const real = await fs.realpath(entry).catch(() => null);
    if (real) denied.add(real);
  }
  const programs = new Set<string>();
  for (const entry of (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":")) {
    if (!entry || !p.isAbsolute(entry)) continue;
    programs.add(entry);
    const real = await fs.realpath(entry).catch(() => null);
    if (real) programs.add(real);
  }
  return { platform, places, denied: [...denied], programs: [...programs] };
}
