// A move to My Cloud before v0.1.110 rebased a path field only when it was cased like the old computer's data folder,
// and never rewrote that folder in instructions, room notes, routine prompts or memory. A Cloud home has one data
// folder, so the one other default data folder those files name was the old computer's: on the first start after the
// update this rewrites it as a move does now, keeping the earlier copy of each file it changes.
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { INSTRUCTION_FILE, restorePaths } from "./workspace-backup-paths.ts";

const DEFINITIONS = ["bots.json", "groups.json", "config.json", "routines.json", "calendar-calls.json"];
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_FILE_BYTES = 16 * 1024 ** 2;
// The folder a desktop keeps its data in by default, <home>\.openmausbot or <home>/.openmausbot, where a path ends.
const END = String.raw`(?=[.,;:!?)\]}]*(?:[\s"'\x60<>|]|$)|[\\/])`;
const WINDOWS_DATA_FOLDER = new RegExp(String.raw`(?<![\w\\/])[A-Za-z]:(?:[\\/][^\\/:*?"<>|\r\n]+?)*?[\\/]\.openmausbot${END}`, "gi");
const POSIX_DATA_FOLDER = new RegExp(String.raw`(?<![\w.:\\/-])\/(?:[^/\s"'\x60<>|]+\/)*?\.openmausbot${END}`, "g");

type Paths = ReturnType<typeof restorePaths>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (record(value)) for (const item of Object.values(value)) strings(item, out);
  return out;
}
function readText(dataDir: string, path: string): string | null {
  try {
    const stat = lstatSync(join(dataDir, path));
    return stat.isFile() && stat.size <= MAX_FILE_BYTES ? readFileSync(join(dataDir, path), "utf8") : null;
  } catch { return null; }
}
function instructionFiles(dataDir: string): string[] {
  const list = (path: string): Dirent[] => {
    try { return readdirSync(join(dataDir, path), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1); } catch { return []; }
  };
  const files: string[] = [];
  const memory = (path: string): void => {
    for (const entry of list(path)) {
      if (entry.isDirectory()) memory(`${path}/${entry.name}`);
      else files.push(`${path}/${entry.name}`);
    }
  };
  for (const bot of list("bots")) if (bot.isDirectory()) files.push(`bots/${bot.name}/SOUL.md`);
  for (const workspace of list("workspaces")) {
    if (!workspace.isDirectory()) continue;
    files.push(`workspaces/${workspace.name}/MEMORY.md`);
    memory(`workspaces/${workspace.name}/memory`);
  }
  return files.filter((path) => INSTRUCTION_FILE.test(path));
}
function dataFolders(text: string, dataDir: string, found: Map<string, string>): void {
  const own = dataDir.replaceAll("\\", "/").toLowerCase();
  for (const [folder] of text.matchAll(WINDOWS_DATA_FOLDER)) {
    const key = folder.replaceAll("\\", "/").toLowerCase();
    if (key !== own) found.set(key, folder);
  }
  for (const [folder] of text.matchAll(POSIX_DATA_FOLDER)) if (folder !== dataDir) found.set(folder, folder);
}
// Where a move rewrites paths (prepareRestore in workspace-backup.ts), leaving each routine on or off as it is now.
function rewrite(name: string, value: unknown, paths: Paths): void {
  if (name === "bots.json") {
    if (Array.isArray(value)) for (const bot of value) if (record(bot)) {
      paths.definitions(bot, String(bot.id));
      if (typeof bot.soul === "string") bot.soul = paths.text(bot.soul);
    }
    return;
  }
  paths.definitions(value);
  if (name === "groups.json" && Array.isArray(value)) {
    for (const group of value) if (record(group) && typeof group.bulletin === "string") group.bulletin = paths.text(group.bulletin);
  }
  if (name === "routines.json" && record(value) && Array.isArray(value.routines)) {
    for (const routine of value.routines) if (record(routine) && typeof routine.prompt === "string") routine.prompt = paths.text(routine.prompt);
  }
}

function repair(dataDir: string, id: string): string[] {
  const documents = new Map<string, unknown>();
  for (const name of DEFINITIONS) {
    const text = readText(dataDir, name);
    if (text !== null) try { documents.set(name, JSON.parse(text)); } catch {}
  }
  const files = new Map<string, string>();
  for (const path of instructionFiles(dataDir)) {
    const text = readText(dataDir, path);
    if (text !== null) files.set(path, text);
  }
  const found = new Map<string, string>();
  for (const value of documents.values()) for (const text of strings(value)) dataFolders(text, dataDir, found);
  for (const text of files.values()) dataFolders(text, dataDir, found);
  if (found.size !== 1) {
    if (found.size) console.warn(`[moved-paths] files name ${found.size} other data folders; every path was left as it is`);
    return [];
  }
  const paths = restorePaths([...found.values()][0]!, dataDir);
  const edits: Array<[string, string]> = [];
  for (const [name, value] of documents) {
    const before = JSON.stringify(value);
    rewrite(name, value, paths);
    const after = JSON.stringify(value);
    if (after !== before) edits.push([name, after]);
  }
  for (const [path, text] of files) {
    const after = paths.text(text);
    if (after !== text) edits.push([path, after]);
  }
  const kept = join(dataDir, ".backups", `path-repair-${id}`);
  for (const [path, text] of edits) {
    const live = join(dataDir, path);
    const copy = join(kept, path);
    mkdirSync(dirname(copy), { recursive: true, mode: 0o700 });
    // A repair cut short runs again; the first copy is the one from before it.
    if (!existsSync(copy)) copyFileSync(live, copy, constants.COPYFILE_EXCL);
    writeFileAtomic(live, text, { mode: lstatSync(live).mode & 0o777 });
  }
  if (edits.length) console.log(`[moved-paths] rewrote the old computer's data folder in ${edits.length} files; the earlier copies are in .backups/path-repair-${id}`);
  return edits.map(([path]) => path);
}

/** Call on a Cloud home before anything reads app state. Once per move: the files it changed, relative to the data
 * folder, or null when there was no move to repair. Never throws, so a failure cannot keep the server from starting. */
export function repairMovedWorkspacePaths(dataDir: string): string[] | null {
  const receiptPath = join(dataDir, ".backups", "last-restore.json");
  let receipt: Record<string, unknown>;
  try {
    if (!lstatSync(receiptPath).isFile()) return null;
    const value: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (!record(value) || value.restored !== true || typeof value.id !== "string" || !ID.test(value.id) || value.pathsRewritten === true) return null;
    receipt = value;
  } catch { return null; }
  try {
    const changed = repair(resolve(dataDir), String(receipt.id));
    writeFileAtomic(receiptPath, JSON.stringify({ ...receipt, pathsRewritten: true }), { mode: 0o600 });
    return changed;
  } catch (error) {
    console.error(`[moved-paths] the repair stopped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
