// A computer whose bots moved to a Cloud nobody here can reach (nobody is signed in, or the account signed in has no way to
// that Cloud) isn't a dead end: its window opens a clean workspace, in a folder of its own beside this computer's data folder,
// and says the bots are safe in their Cloud. Signing in as the account they moved with goes to that Cloud as ever.
//
// The folder swap is the one named local environments use (environment-switch.mjs): one server at a time, on the same port.
// So this computer's frozen copy isn't running while the clean workspace is: nothing in it can run, its freeze isn't touched,
// and no page of it can show. It sits beside the data folder, not in it: a move carries that folder and forgetting the frozen
// copy empties it, and neither ever reaches this one. Nothing made here is merged anywhere.
//
// A person signed in to the Cloud their bots moved to can open a workspace of this computer's own from the rail too: a
// profile, one folder per profile under one folder beside the data folder, named by its stable id. It is fresh, the same
// swap opens it, and this computer stays lent to their Cloud while it runs, since that account is the one lending answers to.
//
// Security: the move's code knows one server, this computer's own copy. A top-up, a send or a lift pointed at the clean
// workspace would upload it over the person's Cloud or report a freeze lifted that wasn't, so while the clean workspace runs
// `realCopy` answers only what the copy's own files can say, and refuses the rest; `holding` brings the copy back first for
// the two things that must reach it (lifting the freeze, forgetting the copy).
import nodeFs from "node:fs";
import path from "node:path";

import { WELCOME_VERSION } from "./onboarding-record.mjs";
import nativeText from "./native-text.cjs";

/** This first conversation stays quiet: no corner notices until a reply, no spotlights (src/lib/onboarding.ts MET_CHIEF_HINT). */
const QUIET_HINT = "met-chief-v1";
/** The popup that offers to bring bots here (src/lib/notices.ts GROK_MOVE_NOTICE) would read badly beside a line saying they're safe in the Cloud. */
const NO_MOVE_POPUP = "grok-move-2026-11";
const CLEAN = "clean-workspace";

export const cleanWorkspaceDir = (dataDir) => `${dataDir}-clean`;
export const profilesDir = (dataDir) => `${dataDir}-profiles`;
/** The profile the rail calls This Mac (or This PC). */
export const DEFAULT_PROFILE = "default";
/** A profile id: its folder's name, and nothing that could reach outside the profiles' folder. */
export const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const profileDir = (dataDir, id) => path.join(profilesDir(dataDir), id);

/** A clean workspace's first config: never the new-user setup, which would read as the person's bots being gone. Connecting
 * an AI isn't part of this: the page's line offers it while none works (HomeLine). */
export function cleanWorkspaceConfig(language = null, now = new Date()) {
  return { ...(typeof language === "string" && language ? { language } : {}), onboarding: { completedAt: now.toISOString(), version: WELCOME_VERSION, hintsSeen: [QUIET_HINT, NO_MOVE_POPUP] } };
}

/**
 * @param {{
 *   dataDir(): string,
 *   running(): string | null,
 *   swap(dir: string): Promise<{ ok: boolean }>,
 *   allowed?(): boolean,
 *   changed?(): void,
 *   log?(line: string): void,
 *   fs?: typeof nodeFs,
 * }} deps `dataDir`: this computer's own data folder, the frozen copy's. `running`: the folder its server runs on now.
 * `swap`: starts the server on that folder instead, and moves the window to its page. `changed`: the clean workspace started or
 * ended, so whatever depends on it (lending) looks again.
 */
export function createCleanWorkspace({ dataDir, running, swap, allowed = () => true, changed = () => {}, log = () => {}, fs = nodeFs, t = nativeText.englishText.t }) {
  const folder = () => cleanWorkspaceDir(dataDir());
  const stranded = () => running() === folder();
  const profile = () => {
    const dir = running();
    return typeof dir === "string" && path.dirname(dir) === profilesDir(dataDir()) && PROFILE_ID.test(path.basename(dir)) ? path.basename(dir) : null;
  };
  const active = () => stranded() || profile() !== null;
  let held = 0, swapping = false;
  /** This computer's own copy is the server that answers now: not the clean workspace, and not on its way between them. */
  const ownCopy = () => !active() && !swapping;
  let queue = Promise.resolve();
  /** One swap at a time: a second would stop the server the first just started. */
  const inTurn = (work) => {
    const turn = queue.then(work, work);
    queue = turn.catch(() => {});
    return turn;
  };
  const readOwn = (name) => { try { return fs.readFileSync(path.join(dataDir(), name), "utf8"); } catch { return null; } };

  function seed(dir) {
    fs.mkdirSync(dir, { recursive: true });
    let language = null;
    try { language = JSON.parse(readOwn("config.json") ?? "{}")?.language ?? null; } catch {}
    try { fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cleanWorkspaceConfig(language)), { mode: 0o600, flag: "wx" }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  }
  async function swapTo(dir) {
    swapping = true;
    const done = await swap(dir).catch((error) => ({ ok: false, error })).finally(() => { swapping = false; });
    if (done?.ok !== true) { log(`clean workspace: could not start on ${dir} (${done?.error?.message ?? done?.error ?? "no answer"})`); return false; }
    changed();
    return true;
  }
  /** The frozen copy's server again; true once it is the one running. */
  const leave = () => inTurn(() => (active() ? swapTo(dataDir()) : true));
  /** This computer's freeze marker, as the frozen copy's own server would say it. */
  function marker() {
    const text = readOwn("moved.json");
    if (text === null) return { frozen: false };
    let saved = null;
    try { saved = JSON.parse(text); } catch {}
    return { frozen: true, ...(typeof saved?.cloud === "string" ? { cloud: saved.cloud } : {}), ...(typeof saved?.place === "string" ? { place: saved.place } : {}) };
  }

  return {
    /** The clean workspace or a profile runs, not this computer's own copy. */
    active,
    /** The clean workspace for nobody here who can reach the bots runs: nothing is lent from it. */
    stranded,
    /** The id of the profile that runs, or null. */
    profile,
    ownCopy,
    marker,
    /** Opens the clean workspace; true once it runs. False when it can't, and the window says why as before. A named local
     * environment the person chose is no frozen copy, so it stays, and so does a profile. */
    enter: () => inTurn(async () => {
      if (active()) return true;
      if (!allowed() || held > 0) return false;
      if (running() !== dataDir()) return true;
      try { seed(folder()); } catch (error) { log(`clean workspace: could not set it up (${error?.message ?? error})`); return false; }
      return swapTo(folder());
    }),
    /** Opens profile `id`, set up fresh the first time; true once it runs. */
    open: (id = DEFAULT_PROFILE) => inTurn(async () => {
      if (!PROFILE_ID.test(id)) return false;
      if (profile() === id) return true;
      if (!allowed() || held > 0) return false;
      const dir = profileDir(dataDir(), id);
      try { seed(dir); } catch (error) { log(`profile ${id}: could not set it up (${error?.message ?? error})`); return false; }
      return swapTo(dir);
    }),
    leave,
    /** Runs `work` on this computer's own copy, its server back first, and nothing opens the clean workspace meanwhile. */
    async holding(work) {
      held++;
      try {
        if (!(await leave())) throw new Error(t("native.home.ownCopyNotReady"));
        return await work();
      } finally { held--; }
    },
    /** `request` (this computer's server) as the move may use it: while the clean workspace runs, what the frozen copy's own
     * files say, and everything else refused. */
    realCopy(request) {
      return async (route, init) => {
        if (ownCopy()) return request(route, init);
        if ((init?.method ?? "GET").toUpperCase() === "GET") {
          if (route === "/api/move/freeze") return Response.json(marker());
          if (route === "/.well-known/openmausbot/environment") {
            const id = readOwn("environment-id")?.trim();
            return Response.json(id ? { environmentId: id } : {});
          }
        }
        throw Object.assign(new Error(t("native.home.ownCopyNotRunning")), { code: CLEAN });
      };
    },
  };
}
