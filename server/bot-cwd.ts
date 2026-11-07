import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { isOwnThreadFolder } from "../shared/thread-folder.ts";

export type CwdValidation = { ok: true; cwd: string | null } | { ok: false; error: string };

export function validateBotCwd(input: unknown): CwdValidation {
  if (input === null) return { ok: true, cwd: null };
  if (typeof input !== "string") return { ok: false, error: "working folder must be a path" };
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, cwd: null };
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? homedir() + trimmed.slice(1) : trimmed;
  if (!isAbsolute(expanded)) return { ok: false, error: "working folder must be an absolute path" };
  const cwd = resolve(expanded);
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    return { ok: false, error: `that folder doesn't exist: ${cwd}` };
  }
  if (!stat.isDirectory()) return { ok: false, error: `that path is not a folder: ${cwd}` };
  return { ok: true, cwd };
}

/** The working folder a thread moves to on this turn: its bot's, while the thread is still in its own folder. Never for a
 * conversation that keeps a private folder (a Cloud guest's), nor for an engine that works in no folder. */
export function folderToFollow(bot: { id: string; cwd?: string }, threadId: string, threadCwd: string | null | undefined,
  opts: { worksInFolders: boolean; keepsPrivateFolder: boolean }): string | undefined {
  if (!bot.cwd || !opts.worksInFolders || opts.keepsPrivateFolder) return undefined;
  return isOwnThreadFolder(threadCwd, bot.id, threadId) ? bot.cwd : undefined;
}

/** A conversation's folder a teammate may be sent to: one that still exists, outside OpenMausBot's own data (a bot's private workspace).
 * The path as given and where it really leads are both checked against the data root as it really resolves too, and a
 * link is shared as the folder it resolved to at check time, so retargeting it afterwards cannot move a shared task. */
export function sharedProjectFolder(cwd: string | null | undefined, dataDir: string): string | undefined {
  const checked = cwd ? validateBotCwd(cwd) : undefined;
  if (!checked?.ok || !checked.cwd) return undefined;
  let real: string;
  let root: string;
  try {
    real = realpathSync(checked.cwd);
    root = realpathSync(resolve(dataDir));
  } catch {
    return undefined;
  }
  for (const candidate of [checked.cwd, real]) {
    const inside = relative(root, candidate);
    if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) return undefined;
  }
  return lstatSync(checked.cwd).isSymbolicLink() ? real : checked.cwd;
}

/** coordinate_bots' in_my_folder: the sender's project folder for the teammate threads it opens outside a room, or why an explicit true cannot be honoured. Omitted means on whenever there is a folder to share. */
export function inMyFolderCwd(wanted: boolean | undefined, outsideRoom: boolean, senderCwd: string | null | undefined, dataDir: string): { cwd?: string; error?: string } {
  if (wanted === false) return {};
  if (!outsideRoom) return wanted ? { error: "in_my_folder does not apply in a room: the room's folder governs there. Leave it out." } : {};
  const cwd = sharedProjectFolder(senderCwd, dataDir);
  if (cwd) return { cwd };
  return wanted ? { error: "This conversation has no project folder to share (it works in its own private folder), so in_my_folder cannot be used. Leave it out; do not retry it." } : {};
}
