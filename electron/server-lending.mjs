// Lending this computer to a server connected by hand (Settings → Servers). A server of the person's own (this desktop
// is its admin: computer-sharing.mjs ownServerSession) gets it once the person allows it, in one popup right after
// pairing (once for a pairing made before this) or from Settings' switch, with no maintainer flag; any other server only
// while that flag is on, as before. Security: every grant is confirmed in main's own dialog, which no page can draw or
// answer, and each one defaults to Not now; stopping never needs a flag.
import nativeText from "./native-text.cjs";

const OWN_CHECK_MS = 30_000;

/**
 * `sharing()`: the computer-sharing controller, made when first needed. `validate`: computer-sharing.mjs
 * validateSharedFolders. `saved(id)`: the saved server, or throws. `candidate(env)`: a server saved by hand that no Cloud
 * rule lends (not My Cloud, another Cloud of the person's own, a team's Cloud or the server their bots moved to).
 * `flag()`: the maintainer flag, read now. `environments()`: the saved places. `active()`: the place on screen.
 * `openSettings(id)`: Settings → Servers with that server's computer access open.
 */
export function installServerLending({ ipcMain, guard, sharing, dialogs, validate, dialog, window, saved, candidate, flag, environments, active = () => null,
  openSettings = () => {}, now = Date.now, t = nativeText.englishText.t, log = () => {} }) {
  const checked = new Map();
  /** A server of the person's own: one lent to before as theirs, else asked of the server, at most every 30 s. */
  const own = async env => {
    if (!candidate(env)) return false;
    if (sharing().state(env.id).own === true) return true;
    const hit = checked.get(env.id);
    if (hit && hit.origin === env.origin && now() - hit.at < OWN_CHECK_MS) return hit.own;
    const answer = Boolean(await sharing().ownServer(env));
    checked.set(env.id, { at: now(), origin: env.origin, own: answer });
    return answer;
  };
  const requireOwnOrFlag = async env => {
    if (await own(env)) return true;
    if (await flag()) return false;
    throw new Error("Computer sharing is turned off on this server.");
  };
  /** The one question, the same after pairing and from Settings' switch. */
  const allows = async (env, parent = window()) => {
    const options = { type: "question", message: t("native.lend.own.title", { name: env.name }), detail: t("native.lend.own.detail"),
      buttons: [t("native.lend.own.allow"), t("native.dialog.share.notNow")], defaultId: 1, cancelId: 1 };
    return (await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))).response === 0;
  };
  /** Allow lends the apps on the screen now; folders and the terminal are chosen in Settings. */
  const firstGrant = { folders: [], terminal: false, computer: true };

  ipcMain.handle("sharing:state", guard("sharing:state", async (_event, id) => {
    const env = saved(id);
    const mine = await requireOwnOrFlag(env);
    return { ...sharing().state(env.id), ...(mine ? { own: true } : {}) };
  }));
  // Picking a folder lends nothing by itself: a save does, and is checked there.
  ipcMain.handle("sharing:folder", guard("sharing:folder", () => dialogs.chooseFolder(t("native.picker.shareFolder"))));
  ipcMain.handle("sharing:revoke", guard("sharing:revoke", (_event, id) => sharing().revoke(saved(id))));
  // What that server's bots did here: the local log, never a server's claim.
  ipcMain.handle("sharing:activity", guard("sharing:activity", async (_event, id) => {
    const env = saved(id);
    await requireOwnOrFlag(env);
    return sharing().activity(env.id, 50);
  }));
  ipcMain.handle("sharing:save", guard("sharing:save", async (_event, id, input) => {
    const env = saved(id);
    const mine = await requireOwnOrFlag(env);
    const info = mine ? null : await sharing().identity(env);
    const grant = { folders: await validate(input?.folders), terminal: input?.terminal === true, computer: input?.computer === true };
    if (!(await dialogs.confirmServerAccess(env, grant))) return null;
    saved(id);
    return mine ? sharing().lendOwn(env, grant) : sharing().save(env, grant, info);
  }));
  /** Settings → Servers: each server of the person's own, and how lending to it is. */
  ipcMain.handle("sharing:servers", guard("sharing:servers", async () => {
    const places = environments().filter(env => env.kind !== "local" && env.origin && candidate(env));
    const mine = await Promise.all(places.map(env => own(env).catch(() => false)));
    return places.filter((_env, index) => mine[index]).map(env => {
      const { enabled, connected, paused } = sharing().state(env.id);
      return { id: env.id, enabled: enabled === true, connected: connected === true, paused: paused === true };
    });
  }));
  /** Settings' switch turned on: the same popup, then what Allow lends. */
  ipcMain.handle("sharing:allow", guard("sharing:allow", async (_event, id) => {
    const env = saved(id);
    if (!(await own(env))) throw new Error(t("native.lend.notOwnServer"));
    if (!(await allows(env))) return null;
    return sharing().lendOwn(env, firstGrant);
  }));
  ipcMain.handle("sharing:pause", guard("sharing:pause", () => { sharing().pause(); }));
  ipcMain.handle("sharing:resume", guard("sharing:resume", async () => { await sharing().resume(); }));

  const asking = new Set();
  /** Still on that server: the person may have gone elsewhere while the server answered. */
  const showing = (win, env) => {
    if (win.isDestroyed() || active()?.id !== env.id) return false;
    try { return new URL(win.webContents.getURL()).origin === env.origin; } catch { return false; }
  };
  return {
    /** The window finished loading a server: a server of the person's own asks once per pairing; any other asks as before
     * while the maintainer flag is on. */
    async offer(win) {
      const env = active();
      if (!env || asking.has(env.id) || win.isDestroyed() || !candidate(env)) return;
      asking.add(env.id);
      try {
        const info = await sharing().ownOffer(env);
        if (info !== false) {
          if (!info || !showing(win, env)) return;
          if (await allows(env, win)) await sharing().lendOwn(env, firstGrant);
          else sharing().declineOwn(env, info);
          return;
        }
        if (!(await flag()) || win.isDestroyed()) return;
        const seen = await sharing().observe(env);
        if (!seen || !showing(win, env)) return;
        const choice = await dialog.showMessageBox(win, {
          type: "question", message: t("native.dialog.share.title", { name: env.name }), detail: t("native.dialog.share.detail"),
          buttons: [t("native.dialog.share.choose"), t("native.dialog.share.notNow")], defaultId: 1, cancelId: 1,
        });
        sharing().decline(env, seen);
        if (choice.response === 0) openSettings(env.id);
      } catch (error) { log(`computer sharing offer: ${error?.message ?? error}`); }
      finally { asking.delete(env.id); }
    },
  };
}
