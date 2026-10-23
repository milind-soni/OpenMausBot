// "Let my bots use this Mac" (this PC, this computer): main's IPC for it. This computer's Settings may choose folders,
// the screen and the internet connection; My Cloud's own page in this app (verified as the person's Cloud) gets the same
// one switch, Apps and screen, and what is lent, so nobody has to leave My Cloud to change it. Turned on with nothing
// chosen, it lends the internet connection and the usual folders, read only.

import { randomUUID } from "node:crypto";
import path from "node:path";

/** The usual folders, read only (Electron app.getPath names): what most people mean by "use my computer", and nothing
 * that can change a file. */
export const DEFAULT_FOLDERS = Object.freeze(["desktop", "documents", "downloads"]);
/** Each usual folder's usual name in the home folder: where to look when the system names the home folder itself. */
const USUAL_NAMES = Object.freeze({ desktop: "Desktop", documents: "Documents", downloads: "Downloads" });

const GONE = new Set(["ENOENT", "ENOTDIR"]);

/** A refusal the person can act on, which trying again never fixes: main throws it as `lending-refused:<code>` and the
 * page says it in plain words, without Try again. */
export const LENDING_REFUSED = "lending-refused:";
const FOLDER_REFUSALS = Object.freeze({ HOME_OR_ROOT: "home-or-root", NOT_FOLDER: "not-folder", TOO_MANY: "too-many" });
const refused = (code) => Object.assign(new Error(`${LENDING_REFUSED}${code}`), { code: `lending-${code}` });
/** The same handler, with a folder check's own refusal passed on as one the page can say plainly. */
const plainly = (handler) => async (...args) => {
  try { return await handler(...args); } catch (error) {
    const code = FOLDER_REFUSALS[error?.code];
    throw code ? refused(code) : error;
  }
};

/** Where the system keeps each usual folder, and the folder of that name in the home folder. On Linux without
 * user-dirs.dirs (no xdg-user-dirs), Electron names the home folder itself for Documents and Downloads. */
export function usualFolderPaths(getPath, home) {
  return DEFAULT_FOLDERS.map((name) => ({ path: getPath(name), named: path.join(home, USUAL_NAMES[name]) }));
}

/** The folders that still exist and pass the checks a folder chosen by hand passes. One moved or deleted since is left
 * out, instead of failing the whole switch; any other refusal (the whole home folder, a file) still fails it. */
export async function existingFolders(folders, validate) {
  const found = await Promise.all(folders.map((folder) => validate([folder]).then((list) => list[0] ?? null, (error) => {
    if (GONE.has(error?.code)) return null;
    throw error;
  })));
  return found.filter(Boolean);
}

/** Each usual folder that exists, read only. One the system places at the home folder or a whole disk is looked for by
 * its usual name in the home folder instead (~/Documents); one that still can't be lent is left out, never failing the
 * switch. Folders a person picks by hand are checked as before. */
export async function usualFolders(entries, validate) {
  const check = async (folder) => {
    try { return (await validate([{ id: randomUUID(), path: folder, write: false }]))[0] ?? null; } catch (error) { return { refused: error?.code ?? "unknown" }; }
  };
  const found = [];
  for (const entry of entries) {
    const { path: where, named } = typeof entry === "string" ? { path: entry, named: null } : entry;
    let folder = await check(where);
    if (folder?.refused === "HOME_OR_ROOT" && named && named !== where) folder = await check(named);
    if (folder && !folder.refused && !found.some((known) => known.path === folder.path)) found.push(folder);
  }
  return found;
}

/** My Cloud's page learns whether it is on, how it is going, and what is lent by folder name, never a path. */
export function pageLending(snapshot) {
  const state = snapshot?.state;
  const on = state?.enabled === true;
  return {
    available: snapshot?.available === true,
    on,
    status: on ? state.busy ? "busy" : state.connected ? "lent" : state.problem ?? "starting" : state?.problem ?? null,
    folders: on ? (state.folders ?? []).map((folder) => ({ name: String(folder.name ?? ""), write: folder.write === true })) : [],
    screen: on && state.screen === true,
    screenAvailable: snapshot?.screenAvailable === true,
    internet: on && state.internet === true,
    ...(on && state.link ? { link: state.link } : {}),
  };
}

/** Which Cloud lending is for, from the verified Cloud sign-in alone (the renderer names no server, account or origin):
 * `cloud()` is the sign-in's state, and `environment()` the saved server that is My Cloud, kept through a brief
 * disconnect of the same account. */
export function createLendingTarget({ account, environments }) {
  let lastHome = null;
  const cloud = () => {
    const current = account();
    if (!current) return null;
    const state = current.state();
    const accountId = state.account?.id ?? null;
    const origin = state.status === "connected" ? (state.machine?.origin ?? null) : null;
    if (origin && accountId) lastHome = { accountId, origin };
    else if (!accountId || lastHome?.accountId !== accountId) lastHome = null;
    return { status: state.status === "signed-out" && state.message === "restoring" ? "restoring" : state.status, accountId, origin };
  };
  return {
    cloud,
    environment() {
      const snapshot = cloud();
      const origin = snapshot?.origin ?? (lastHome?.accountId === snapshot?.accountId ? lastHome?.origin : null);
      return origin ? environments().find((entry) => entry.origin === origin) ?? null : null;
    },
  };
}

/** Each folder that exists and passes the folder checks, with editing; any that cannot be lent is left out. */
async function editableFolders(paths, validate) {
  const found = [];
  for (const where of paths) {
    if (typeof where !== "string" || !path.isAbsolute(where)) continue;
    try {
      const [folder] = await validate([{ id: randomUUID(), path: where, write: true }]);
      if (folder) found.push(folder);
    } catch {}
  }
  return found;
}

/** The default grant, on top of what was lent before: the usual folders read only, each project folder with editing,
 * the internet connection, and apps and screen when they were lent before or computer control already works here for
 * this computer's own bots (`screenReady`: macOS granted Accessibility and Screen Recording). */
export function defaultGrant({ kept, usual, projects, screenAvailable, screenReady }) {
  const byPath = new Map();
  for (const folder of [...(kept?.folders ?? []), ...usual, ...projects]) {
    const known = byPath.get(folder.path);
    byPath.set(folder.path, known ? { ...known, write: known.write || folder.write } : folder);
  }
  return { folders: [...byPath.values()].slice(0, 20), screen: screenAvailable === true && (kept?.screen === true || screenReady === true), internet: true };
}

/**
 * @param {{
 *   ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void },
 *   localOnly: (channel: string, handler: (...args: any[]) => unknown) => (...args: any[]) => unknown,
 *   cloudPage: (channel: string, handler: (...args: any[]) => unknown) => (...args: any[]) => unknown,
 *   snapshot: () => Promise<{ available: boolean, screenAvailable?: boolean, screenReady?: boolean, state?: Record<string, any>, activity?: unknown[] }>,
 *   environment: () => unknown,
 *   save: (env: unknown, choice: { folders: unknown, screen: boolean, internet?: boolean, terminal?: boolean }) => Promise<unknown>,
 *   stop: () => void,
 *   chooseFolder: () => Promise<{ id: string, path: string, name: string, write: boolean } | null>,
 *   defaults: () => Promise<Array<{ id: string, path: string, name: string, write: boolean }>>,
 *   validate: (folders: unknown[]) => Promise<Array<{ id: string, path: string, name: string, write: boolean }>>,
 *   confirmScreen: () => Promise<boolean>,
 * }} deps `cloudPage` lets only My Cloud's verified page through; turning lending or Apps and screen on from it still
 * takes a real click (the preload bridge's rule). Security: Apps and screen lets bots act as the person, and a page
 * served by the Cloud must never grant that alone, so main also asks in a dialog of its own (`confirmScreen`).
 * `screenReady` in a snapshot: computer control works here for this computer's own bots, read from its running state,
 * never by asking macOS.
 */
export function installCloudLending({ ipcMain, localOnly, cloudPage, snapshot, environment, save, stop, chooseFolder, defaults, validate, confirmScreen }) {
  const env = () => {
    const current = environment();
    if (!current) throw new Error("Open My Cloud first.");
    return current;
  };
  /** What was chosen (an off switch keeps its choice), without folders that are gone since; else the internet connection
   * and the usual folders. The internet connection alone is a choice too. */
  const choice = async (input) => {
    const folders = Array.isArray(input?.folders) && input.folders.length ? await existingFolders(input.folders, validate) : [];
    // The terminal is chosen only here, from this computer's own Settings (`lending:save` is local-only); it is never
    // carried over from a saved grant, filled in by default, or set from My Cloud's page.
    const terminal = input?.terminal === true;
    if (folders.length || input?.screen === true || input?.internet === true || terminal) return { folders, screen: input?.screen === true, internet: input?.internet === true, ...(terminal ? { terminal: true } : {}) };
    return { folders: await defaults(), screen: false, internet: true };
  };
  ipcMain.handle("lending:state", localOnly("lending:state", () => snapshot()));
  ipcMain.handle("lending:folder", localOnly("lending:folder", plainly(async () => { env(); return chooseFolder(); })));
  ipcMain.handle("lending:save", localOnly("lending:save", plainly(async (_event, input) => {
    await save(env(), await choice(input));
    return snapshot();
  })));
  ipcMain.handle("lending:stop", localOnly("lending:stop", async () => { stop(); return snapshot(); }));

  ipcMain.handle("cloud-lending:state", cloudPage("cloud-lending:state", async () => pageLending(await snapshot())));
  ipcMain.handle("cloud-lending:set", cloudPage("cloud-lending:set", plainly(async (_event, on) => {
    if (on !== true) { stop(); return pageLending(await snapshot()); }
    const current = await snapshot();
    if (current.state?.enabled) return pageLending(current);
    const kept = current.state ?? {};
    await save(env(), await choice({ folders: kept.folders, screen: kept.screen === true && current.screenAvailable === true, internet: kept.internet === true }));
    return pageLending(await snapshot());
  })));
  ipcMain.handle("cloud-lending:screen", cloudPage("cloud-lending:screen", plainly(async (_event, on) => {
    const current = await snapshot();
    const kept = current.state;
    if (!kept?.enabled || (kept.screen === true) === (on === true)) return pageLending(current);
    if (on === true && (!current.screenAvailable || !(await confirmScreen()))) return pageLending(current);
    await save(env(), await choice({ folders: kept.folders, screen: on === true, internet: kept.internet === true }));
    return pageLending(await snapshot());
  })));
  const ownOff = (state) => !state?.enabled && state?.stopped?.reason === "you";
  return {
    /** What is lent, as My Cloud's page sees it, whether computer control works here, and whether the person turned
     * lending off themselves. */
    async state() {
      const current = await snapshot();
      return { ...pageLending(current), screenReady: current.screenReady === true, ownOff: ownOff(current.state) };
    },
    /** At the move to My Cloud, and when the person chooses Use my Mac (`asked`): lends the default grant (defaultGrant)
     * on top of what is lent. Without `asked` the person's own Off is never undone: lending they turned off stays off.
     * Answers the page's view, or null when it stayed off. */
    async lendByDefault({ projects = [], asked = false } = {}) {
      const current = await snapshot();
      const kept = current.state;
      if (!current.available || (!asked && ownOff(kept))) return null;
      const lentBefore = kept?.folders?.length ? await existingFolders(kept.folders, validate) : [];
      const grant = defaultGrant({ kept: { folders: lentBefore, screen: kept?.screen === true }, usual: await defaults(), projects: await editableFolders(projects, validate),
        screenAvailable: current.screenAvailable, screenReady: current.screenReady });
      await save(env(), grant);
      return pageLending(await snapshot());
    },
    /** Apps and screen on top of what is lent, once computer control works here; null while lending is off or computer
     * control does not work yet. */
    async lendScreen() {
      const current = await snapshot();
      const kept = current.state;
      if (!current.available || !kept?.enabled || current.screenAvailable !== true) return null;
      if (kept.screen === true) return pageLending(current);
      await save(env(), await choice({ folders: kept.folders, screen: true, internet: kept.internet === true }));
      return pageLending(await snapshot());
    },
  };
}
