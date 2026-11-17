// Team files: one shared folder per Team Cloud (`team-files/` in the data folder, audience `team`) that every teammate
// and every bot can use: payroll records, client lists, templates, brand assets. People reach it through the Team files
// page (server/routes/team-files.ts); bots through the bot box, where it is at /team-files, read-only unless an admin
// marked the bot "Can edit team files" (server/host/team-box-scope.ts). What changed, and who changed it, is kept in
// `team-files-activity.json`: the page's uploads and deletes as they happen, a bot's writes after each turn that could
// write (a cheap size and time comparison of the folder before and after). Nothing here exists off a Team Cloud.
import { closeSync, constants, createReadStream, createWriteStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, type Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, relative, isAbsolute } from "node:path";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { writeFileAtomic } from "../atomic.ts";

export const TEAM_FILES_DIR = "team-files";
/** The team's library of templates, one folder of Team files (server/team-templates.ts): its admins' to change. */
export const TEAM_FILES_TEMPLATES = "templates";
export const TEAM_FILES_ACTIVITY = "team-files-activity.json";
/** Where every bot's box has the folder. */
export const TEAM_FILES_IN_BOX = "/team-files";
export const TEAM_FILES_CAP_BYTES = 5 * 1024 ** 3;
export const TEAM_FILES_UPLOAD_MAX_BYTES = 100 * 1024 ** 2;
/** A folder with more entries than this is not compared around a turn: its changes go unrecorded rather than slow it. */
export const TEAM_FILES_SNAPSHOT_MAX = 20_000;
const ACTIVITY_MAX = 5_000;
const USAGE_TTL_MS = 10_000;
/** Uploads arrive here first, outside the folder a bot can write (and out of backups, which leave tmp/ out). */
const STAGING = join("tmp", "team-files-uploads");

import type { TeamFileAction } from "../../shared/team-files.ts";
export type { TeamFileAction };

/** One change: who (a person, a bot working for a person, or a bot alone), what and when. */
export interface TeamFileChange {
  at: number;
  path: string;
  action: TeamFileAction;
  /** The person who did it, or the one whose turn the bot was working on. */
  person?: string;
  bot?: string;
  /** A rename's old path. */
  from?: string;
}

interface ActivityFile {
  changes: TeamFileChange[];
  /** Who uploaded each file or made each folder through the page: they (and the admins) may delete it. */
  owners: Record<string, string>;
}

export interface TeamFileEntry {
  name: string;
  path: string;
  kind: "file" | "folder";
  size: number;
  modifiedAt: number;
  /** The last change recorded for it, if any. */
  last?: TeamFileChange;
  owner?: string;
}

export interface TeamFilesActor { person: string; admin: boolean }

export class TeamFilesError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const SEGMENT_MAX = 255, PATH_MAX = 1024;
// Control characters and the separators of other systems never name a team file.
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f\\]/;

/** A path in the folder as the routes take it: relative, "/"-separated, no `.` or `..` part, no control characters. "" is
 * the folder itself; null is refused. Leading, trailing and doubled slashes are dropped. */
export function teamFilePath(input: unknown): string | null {
  if (typeof input !== "string" || input.length > PATH_MAX || BAD_CHARS.test(input)) return null;
  const parts = input.split("/").filter((part) => part !== "");
  if (parts.some((part) => part === "." || part === ".." || part.length > SEGMENT_MAX || part.trim() === "")) return null;
  return parts.join("/");
}

/** One name inside a folder (an upload's, a new folder's). */
export function teamFileName(input: unknown): string | null {
  const path = teamFilePath(input);
  return path && !path.includes("/") ? path : null;
}

/** The folder's files by path, as size and modification time: what a turn's before and after are compared by. */
export type TeamFilesSnapshot = Map<string, string>;

export interface TeamFilesChanges { added: string[]; changed: string[]; deleted: string[] }

export function compareSnapshots(before: TeamFilesSnapshot, after: TeamFilesSnapshot): TeamFilesChanges {
  const added: string[] = [], changed: string[] = [], deleted: string[] = [];
  for (const [path, mark] of after) {
    const was = before.get(path);
    if (was === undefined) added.push(path);
    else if (was !== mark) changed.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) deleted.push(path);
  return { added: added.sort(), changed: changed.sort(), deleted: deleted.sort() };
}

const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

export interface TeamFilesOptions {
  dataDir: string;
  now?: () => number;
  cap?: number;
  uploadMax?: number;
}

export function createTeamFiles(options: TeamFilesOptions) {
  const root = join(options.dataDir, TEAM_FILES_DIR);
  const activityPath = join(options.dataDir, TEAM_FILES_ACTIVITY);
  const now = options.now ?? Date.now;
  const cap = options.cap ?? TEAM_FILES_CAP_BYTES;
  const uploadMax = options.uploadMax ?? TEAM_FILES_UPLOAD_MAX_BYTES;
  let usage: { bytes: number; at: number } | null = null;
  let activity: ActivityFile | null = null;

  const ensure = (): string => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return root;
  };

  /** The full path of `rel`, refusing a link anywhere on the way (a bot with edit could plant one) and a non-folder parent. */
  const resolve = (rel: string, want: "file" | "folder" | "any" | "absent" | "maybe"): { full: string; stat: Stats | null } => {
    ensure();
    const parts = rel ? rel.split("/") : [];
    let full = root;
    let stat: Stats | null = lstatSync(root);
    for (let i = 0; i < parts.length; i++) {
      if (!stat?.isDirectory()) throw new TeamFilesError(404, "not_found", "That folder doesn't exist.");
      full = join(full, parts[i]!);
      try { stat = lstatSync(full); } catch { stat = null; }
      if (stat?.isSymbolicLink()) throw new TeamFilesError(400, "link", "Team files never follow links.");
      if (!stat && i < parts.length - 1) throw new TeamFilesError(404, "not_found", "That folder doesn't exist.");
    }
    if (want === "absent" && stat) throw new TeamFilesError(409, "exists", "Something with that name is already there.");
    if ((want === "file" || want === "folder" || want === "any") && !stat) throw new TeamFilesError(404, "not_found", "That file doesn't exist any more.");
    if (want === "file" && !stat!.isFile()) throw new TeamFilesError(400, "not_file", "That is a folder, not a file.");
    if (want === "folder" && !stat!.isDirectory()) throw new TeamFilesError(400, "not_folder", "That is a file, not a folder.");
    return { full, stat };
  };

  /** The real place of `full` (and of its folder) is inside the folder: nothing on the way was swapped for a link. */
  const within = (full: string): boolean => {
    try {
      const rel = relative(realpathSync(root), realpathSync(full));
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    } catch {
      return false;
    }
  };
  const settledParent = (full: string) => {
    if (!within(dirname(full))) throw new TeamFilesError(400, "link", "Team files never follow links.");
  };

  /** Turns that could write the folder, by key, with the folder as it was when each started. */
  const open = new Map<string, { before: TeamFilesSnapshot; by: { bot: string; person?: string } }>();
  /** A change someone else made (the page, another turn) is never claimed by a turn still open. */
  const settle = (paths: readonly string[]) => {
    if (!open.size || !paths.length) return;
    for (const path of paths) {
      let mark: string | null = null;
      try { const stat = lstatSync(join(root, path)); if (stat.isFile()) mark = `${stat.size}:${Math.round(stat.mtimeMs)}`; } catch {}
      for (const turn of open.values()) {
        for (const known of turn.before.keys()) if (known !== path && inside(known, path) && mark === null) turn.before.delete(known);
        if (mark === null) turn.before.delete(path); else turn.before.set(path, mark);
      }
    }
  };

  /** Every regular file under the folder, by path; null when there are more than `max` (too large to compare cheaply). */
  const walk = (max = Number.POSITIVE_INFINITY, countAll = true): { files: Map<string, Stats>; bytes: number } | null => {
    ensure();
    const files = new Map<string, Stats>();
    let bytes = 0, seen = 0;
    const stack: string[] = [""];
    while (stack.length) {
      const rel = stack.pop()!;
      let names: string[];
      try { names = readdirSync(rel ? join(root, rel) : root); } catch { continue; }
      for (const name of names) {
        if (++seen > max) return null;
        const path = rel ? `${rel}/${name}` : name;
        if (!countAll && path === TEAM_FILES_TEMPLATES) continue;
        let stat: Stats;
        try { stat = lstatSync(join(root, path)); } catch { continue; }
        if (stat.isDirectory()) stack.push(path);
        else if (stat.isFile()) { files.set(path, stat); bytes += stat.size; }
      }
    }
    return { files, bytes };
  };

  /** The folder's files as they are now, or null when it is too large to compare. */
  const snapshot = (): TeamFilesSnapshot | null => {
    // The template library is no turn's to change (read-only in every box) and keeps its own record of who added what.
    const walked = walk(TEAM_FILES_SNAPSHOT_MAX, false);
    if (!walked) return null;
    return new Map([...walked.files].map(([path, stat]) => [path, `${stat.size}:${Math.round(stat.mtimeMs)}`]));
  };

  const used = (): number => {
    if (usage && now() - usage.at < USAGE_TTL_MS) return usage.bytes;
    usage = { bytes: walk()?.bytes ?? 0, at: now() };
    return usage.bytes;
  };
  const changedSize = () => { usage = null; };

  const readActivity = (): ActivityFile => {
    if (activity) return activity;
    try {
      const parsed = JSON.parse(readFileSync(activityPath, "utf8")) as Partial<ActivityFile>;
      activity = { changes: Array.isArray(parsed.changes) ? parsed.changes.filter((change) => change && typeof change.path === "string") : [], owners: parsed.owners && typeof parsed.owners === "object" ? parsed.owners : {} };
    } catch {
      activity = { changes: [], owners: {} };
    }
    return activity;
  };
  const saveActivity = () => {
    const file = readActivity();
    if (file.changes.length > ACTIVITY_MAX) file.changes.splice(0, file.changes.length - ACTIVITY_MAX);
    writeFileAtomic(activityPath, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  };
  const record = (changes: TeamFileChange[]) => {
    if (!changes.length) return;
    readActivity().changes.push(...changes);
    saveActivity();
  };
  /** The last recorded change of each path: a file's own, a folder's latest of anything in it. */
  const lastChanges = (): Map<string, TeamFileChange> => {
    const last = new Map<string, TeamFileChange>();
    for (const change of readActivity().changes) last.set(change.path, change);
    return last;
  };

  /** The template library is the admins': members see it, only an admin changes anything in it. */
  const librarys = (rel: string) => inside(rel, TEAM_FILES_TEMPLATES);
  const mayAdd = (folder: string, actor: TeamFilesActor) => {
    if (!actor.admin && librarys(folder)) throw new TeamFilesError(403, "forbidden", "The team's templates are the admins' to change.");
  };
  const mayRemove = (rel: string, actor: TeamFilesActor): boolean => {
    if (actor.admin) return true;
    if (librarys(rel)) return false;
    const owners = readActivity().owners;
    return owners[rel] === actor.person;
  };

  return {
    root: () => root,
    ensure,
    cap,
    uploadMax,
    used,
    /** Full: a bot's box has the folder read-only, and the page refuses uploads, until someone removes files. */
    full: () => used() >= cap,

    list(rel: string, actor: TeamFilesActor): { entries: TeamFileEntry[] } {
      const { full } = resolve(rel, "folder");
      const last = lastChanges();
      const owners = readActivity().owners;
      const entries: TeamFileEntry[] = [];
      for (const name of readdirSync(full)) {
        const path = rel ? `${rel}/${name}` : name;
        let stat: Stats;
        try { stat = lstatSync(join(full, name)); } catch { continue; }
        if (!stat.isFile() && !stat.isDirectory()) continue;
        const kind = stat.isDirectory() ? "folder" as const : "file" as const;
        let latest = last.get(path);
        if (kind === "folder") for (const [changed, change] of last) if (changed.startsWith(`${path}/`) && (!latest || change.at > latest.at)) latest = change;
        entries.push({ name, path, kind, size: kind === "file" ? stat.size : 0, modifiedAt: Math.round(stat.mtimeMs), ...(latest ? { last: latest } : {}), ...(owners[path] ? { owner: owners[path] } : {}) });
      }
      void actor;
      entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));
      return { entries };
    },

    mayRemove,

    /** A file to read, by path, opened without following a link and checked to be the one inside the folder. The caller
     * streams it (`stream`) and so closes the descriptor. */
    open(rel: string): { fd: number; size: number; name: string } {
      const { full } = resolve(rel, "file");
      const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || !within(full)) throw new TeamFilesError(400, "link", "Team files never follow links.");
        return { fd, size: stat.size, name: rel.split("/").at(-1)! };
      } catch (error) {
        closeSync(fd);
        throw error;
      }
    },

    stream(fd: number): Readable { return createReadStream("", { fd }); },

    /** One file into `folder` from a request body; replaces a file of the same name only for its uploader or an admin. */
    async upload(folder: string, name: string, body: Readable, declared: number | null, actor: TeamFilesActor): Promise<TeamFileEntry> {
      resolve(folder, "folder");
      const path = folder ? `${folder}/${name}` : name;
      mayAdd(path, actor);
      const target = resolve(path, "maybe");
      if (target.stat?.isDirectory()) throw new TeamFilesError(409, "exists", "A folder with that name is already there.");
      if (target.stat && !mayRemove(path, actor)) throw new TeamFilesError(409, "exists", "A file with that name is already there, and it isn't yours to replace.");
      if (declared !== null && declared > uploadMax) throw new TeamFilesError(413, "too_large", `A file may be at most ${Math.round(uploadMax / 1024 ** 2)} MB.`);
      const room = cap - used() + (target.stat?.size ?? 0);
      if (room <= 0 || (declared !== null && declared > room)) throw new TeamFilesError(507, "full", `Team files are full (${Math.round(cap / 1024 ** 3)} GB). Remove files to make room.`);
      const staging = join(options.dataDir, STAGING);
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      const temp = join(staging, `${randomBytes(8).toString("hex")}.part`);
      let taken = 0;
      const limit = Math.min(uploadMax, room);
      const capped = new Transform({ transform(chunk: Buffer, _encoding, done) { taken += chunk.length; done(taken > limit ? new TeamFilesError(taken > uploadMax ? 413 : 507, "too_large", "") : null, chunk); } });
      try {
        await pipeline(body, capped, createWriteStream(temp, { mode: 0o600 }));
      } catch (error) {
        rmSync(temp, { force: true });
        if (taken > uploadMax) throw new TeamFilesError(413, "too_large", `A file may be at most ${Math.round(uploadMax / 1024 ** 2)} MB.`);
        if (taken > limit) throw new TeamFilesError(507, "full", `Team files are full (${Math.round(cap / 1024 ** 3)} GB). Remove files to make room.`);
        throw error instanceof TeamFilesError ? error : new TeamFilesError(400, "incomplete", "The file did not arrive whole.");
      }
      // Checked again just before it lands: the folder may have changed while the file arrived.
      const again = resolve(path, "maybe");
      if (again.stat?.isDirectory()) { rmSync(temp, { force: true }); throw new TeamFilesError(409, "exists", "A folder with that name is already there."); }
      try { settledParent(again.full); } catch (error) { rmSync(temp, { force: true }); throw error; }
      renameSync(temp, again.full);
      changedSize();
      const file = readActivity();
      file.owners[path] = actor.person;
      record([{ at: now(), path, action: "uploaded", person: actor.person }]);
      settle([path]);
      const stat = statSync(again.full);
      return { name, path, kind: "file", size: stat.size, modifiedAt: Math.round(stat.mtimeMs), owner: actor.person, last: file.changes.at(-1)! };
    },

    folder(rel: string, actor: TeamFilesActor): void {
      if (!rel) throw new TeamFilesError(400, "bad_path", "Name the new folder.");
      mayAdd(rel, actor);
      const { full } = resolve(rel, "absent");
      settledParent(full);
      mkdirSync(full, { mode: 0o700 });
      readActivity().owners[rel] = actor.person;
      record([{ at: now(), path: rel, action: "folder", person: actor.person }]);
    },

    rename(from: string, to: string, actor: TeamFilesActor): void {
      if (!from || !to) throw new TeamFilesError(400, "bad_path", "Name the file and its new name.");
      if (inside(to, from)) throw new TeamFilesError(400, "bad_path", "A folder can't go inside itself.");
      const source = resolve(from, "any");
      if (!mayRemove(from, actor)) throw new TeamFilesError(403, "forbidden", "Only an admin, or whoever uploaded it, can rename this.");
      mayAdd(to, actor);
      if (dirname(to) !== "." && dirname(to) !== "") resolve(dirname(to), "folder");
      const target = resolve(to, "absent");
      settledParent(source.full);
      settledParent(target.full);
      const moved = source.stat!.isDirectory() ? [...(walk()?.files.keys() ?? [])].filter((path) => inside(path, from)) : [from];
      renameSync(source.full, target.full);
      settle([...moved, ...moved.map((path) => `${to}${path.slice(from.length)}`)]);
      const owners = readActivity().owners;
      for (const path of Object.keys(owners)) {
        if (inside(path, from)) { owners[`${to}${path.slice(from.length)}`] = owners[path]!; delete owners[path]; }
      }
      record([{ at: now(), path: to, from, action: "renamed", person: actor.person }]);
    },

    remove(rel: string, actor: TeamFilesActor): void {
      if (!rel) throw new TeamFilesError(400, "bad_path", "Name what to delete.");
      const { full, stat } = resolve(rel, "any");
      if (!mayRemove(rel, actor)) throw new TeamFilesError(403, "forbidden", "Only an admin, or whoever uploaded it, can delete this.");
      const owners = readActivity().owners;
      if (stat!.isDirectory() && !actor.admin) {
        // A member's own folder goes only when everything in it is theirs too.
        const others = [...(walk()?.files.keys() ?? [])].filter((path) => inside(path, rel) && owners[path] !== actor.person);
        if (others.length) throw new TeamFilesError(403, "forbidden", "That folder has other people's files in it: only an admin can delete it.");
      }
      settledParent(full);
      const gone = stat!.isDirectory() ? [...(walk()?.files.keys() ?? [])].filter((path) => inside(path, rel)) : [rel];
      rmSync(full, { recursive: true, force: true });
      settle(gone);
      changedSize();
      for (const path of Object.keys(owners)) if (inside(path, rel)) delete owners[path];
      record([{ at: now(), path: rel, action: "deleted", person: actor.person }]);
    },

    snapshot,

    /** A turn that could write starts: the folder as it is now, to compare with when it ends. False when the folder is
     * too large to compare. */
    beginTurn(key: string, by: { bot: string; person?: string }): boolean {
      const before = snapshot();
      if (before) open.set(key, { before, by }); else open.delete(key);
      return before !== null;
    },

    /** The turn ended: what it changed, recorded as the bot's for the person it worked for. */
    endTurn(key: string): TeamFilesChanges | null {
      const turn = open.get(key);
      open.delete(key);
      if (!turn) return null;
      const { before, by } = turn;
      const after = snapshot();
      if (!after) return null;
      const changes = compareSnapshots(before, after);
      const at = now();
      const who = { bot: by.bot, ...(by.person ? { person: by.person } : {}) };
      const rows: TeamFileChange[] = [
        ...changes.added.map((path) => ({ at, path, action: "added" as const, ...who })),
        ...changes.changed.map((path) => ({ at, path, action: "changed" as const, ...who })),
        ...changes.deleted.map((path) => ({ at, path, action: "deleted" as const, ...who })),
      ];
      if (rows.length) {
        const owners = readActivity().owners;
        for (const path of changes.deleted) delete owners[path];
        changedSize();
        record(rows);
        settle(rows.map((row) => row.path));
      }
      return changes;
    },

    activity(): readonly TeamFileChange[] { return readActivity().changes; },
    /** For tests and a restore: forget what was read, so the file on disk is read again. */
    reload(): void { activity = null; usage = null; },
    exists: () => existsSync(root),
    /** Turns still open, for tests. */
    openTurns: () => open.size,
  };
}

export type TeamFiles = ReturnType<typeof createTeamFiles>;
