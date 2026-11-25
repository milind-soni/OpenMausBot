// What this computer lends My Cloud now, as the move step says it (shared/move-changes.ts MoveLending): paused or not,
// whether a bot's working folder is inside a folder already lent, and whether My Cloud may run commands here. Pure: main
// reads lending's state for My Cloud (computer-sharing.mjs cloudState) and hands it in.

/** A folder's path as its file system compares it: "/" between parts, no trailing one, one case on Windows and macOS. */
function folderKey(value, platform) {
  const slashed = String(value).replaceAll("\\", "/").replace(/\/+$/u, "");
  return platform === "win32" || platform === "darwin" ? slashed.toLowerCase() : slashed;
}

/** `child` is `parent` or inside it, on `platform`. */
export function insideFolder(child, parent, platform = process.platform) {
  const inner = folderKey(child, platform), outer = folderKey(parent, platform);
  return Boolean(inner && outer) && (inner === outer || inner.startsWith(`${outer}/`));
}

/**
 * @param {{ state?: { enabled?: boolean, folders?: Array<{ path: string, write?: boolean }>, terminal?: boolean, problem?: string } | null,
 *   paused?: boolean, folders?: string[], home?: string | null, platform?: string }} input `state`: lending to My Cloud as cloudState
 *   answers it; null when nothing is lent. `folders`: every working folder of the choice. `home`: the person's home folder, which
 *   every Cloud of their own is lent with editing by itself unless lending is paused (computer-sharing.mjs automaticGrant).
 * @returns {{ paused: boolean, folderLent: boolean, terminal: boolean }} `folderLent`: every one of `folders` is reachable with
 *   editing already, so the move adds nothing by lending them; one lent read-only is not, since the move would add editing.
 */
export function moveLending({ state = null, paused = false, folders = [], home = null, platform = process.platform }) {
  const stopped = paused === true || state?.problem === "paused";
  const lent = state?.enabled === true && !stopped;
  const named = (Array.isArray(folders) ? folders : []).filter((folder) => typeof folder === "string" && folder !== "");
  const editable = lent ? (state.folders ?? []).filter((entry) => typeof entry?.path === "string" && entry.write === true).map((entry) => entry.path) : [];
  if (!stopped && typeof home === "string" && home !== "") editable.push(home);
  return {
    paused: stopped,
    folderLent: named.length > 0 && named.every((folder) => editable.some((root) => insideFolder(folder, root, platform))),
    terminal: lent && state.terminal === true,
  };
}

/** The folder as the person reads it: "~/code/app" under their home folder on macOS and Linux; anything else as it is. */
export function shownFolder(folder, home, platform = process.platform) {
  if (typeof folder !== "string" || !folder || platform === "win32" || !home) return folder;
  return insideFolder(folder, home, platform) ? `~${folder.slice(home.replace(/\/+$/u, "").length)}` : folder;
}
