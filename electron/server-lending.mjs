// Lending this computer to a server connected by hand (Settings → Servers). A server of the person's own (this desktop
// is its admin: computer-sharing.mjs ownServerSession) gets it with one switch, with no maintainer flag: in the add form,
// on its row in Settings, on its card in Devices and in its Screen panel. Any other server only while that flag is on, as
// before. Security: only this app's own page turns it on with no question; a server's own page (its Screen panel) gets
// main's own popup first, which no page can draw or answer and which defaults to Not now. Stopping is one tap anywhere.
import nativeText from "./native-text.cjs";

const OWN_CHECK_MS = 30_000;

/**
 * `sharing()`: the computer-sharing controller, made when first needed. `validate`: computer-sharing.mjs
 * validateSharedFolders. `saved(id)`: the saved server, or throws. `candidate(env)`: a server saved by hand that no Cloud
 * rule lends (not My Cloud, another Cloud of the person's own, a team's Cloud or the server their bots moved to).
 * `flag()`: the maintainer flag, read now. `environments()`: the saved places. `active()`: the place on screen.
 * `openSettings(id)`: Settings → Servers with that server's computer access open. `local(event)`: the sender is this app's
 * own page in the main window. `page(event)`: the saved server whose page sent it, when that page is the main window's
 * active server (never an id the page names). `screen()`: computer control's state (screen-status.mjs). `allowScreen()`:
 * asks the system for what computer control lacks (macOS's Accessibility and Screen Recording).
 */
export function installServerLending({ ipcMain, guard, sharing, dialogs, validate, dialog, window, saved, candidate, flag, environments, active = () => null,
  openSettings = () => {}, now = Date.now, t = nativeText.englishText.t, log = () => {}, local = () => false, page = () => null, screen = async () => null,
  allowScreen = async () => {} }) {
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
    // Edits on the home folder or the system drive are kept only because confirmServerAccess asks about them first.
    const grant = { folders: await validate(input?.folders, { homeEdits: true }), terminal: input?.terminal === true, computer: input?.computer === true };
    if (!(await dialogs.confirmServerAccess(env, grant))) return null;
    saved(id);
    return mine ? sharing().lendOwn(env, grant, { homeEdits: true }) : sharing().save(env, grant, info, { homeEdits: true });
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

  /** What lending this computer to `env` is, for the switch on its row, its card, the add form and its Screen panel: one
   * shape everywhere (src/lib/use-lend-computer.ts). Never a folder or anything else this computer lends. */
  const refusals = new Map();
  const view = async env => {
    if (!candidate(env)) return { name: env.name, lendable: false, why: env.team ? "team" : "cloud" };
    if (!(await own(env))) {
      // Asked of the server at most every 30 s, as `own` is: each open switch reads this every few seconds.
      const kept = refusals.get(env.id);
      const why = kept && kept.origin === env.origin && now() - kept.at < OWN_CHECK_MS ? kept.why
        : await flag() ? "settings" : await sharing().ownRefusal(env).catch(() => "unreachable") ?? "unreachable";
      if (!kept || kept.why !== why || now() - kept.at >= OWN_CHECK_MS) refusals.set(env.id, { at: now(), origin: env.origin, why });
      return { name: env.name, lendable: false, why };
    }
    const { enabled, connected, paused, problem } = sharing().state(env.id);
    const status = enabled === true ? await Promise.resolve().then(screen).catch(() => null) : null;
    return { name: env.name, lendable: true, on: enabled === true, connected: connected === true, paused: paused === true || problem === "paused",
      ...(status && !status.ready && status.reason ? { screen: status.reason } : {}) };
  };
  /** The server a lend:* call is about: the one named on this app's own page, or the server whose page asks (`fromPage`). */
  const target = (event, id) => {
    if (local(event)) return { env: saved(id), fromPage: false };
    const env = page(event);
    if (!env) throw new Error("These controls are only available in the main desktop window");
    return { env, fromPage: true };
  };
  // The switch: on lends the apps on the screen at once from this app's own page; a server's own page could press it
  // itself, so from there main's own popup (which no page can draw or answer) asks first. Off is one tap anywhere.
  ipcMain.handle("lend:state", async (event, id) => view(target(event, id).env));
  // Only a server of the person's own is ever changed here: a Cloud's or a team's page (or any other) changes nothing.
  ipcMain.handle("lend:set", async (event, id, on) => {
    const { env, fromPage } = target(event, id);
    if (!(await own(env))) { if (on === true) throw new Error(t("native.lend.notOwnServer")); return view(env); }
    if (on !== true) { sharing().revoke(env); return view(env); }
    if (fromPage && !(await allows(env))) return view(env);
    await sharing().lendOwn(env, firstGrant);
    return view(env);
  });
  /** Choose what it can use: This computer's Settings with that server's folders and terminal open, once it is lent. On a
   * server's own page it is about that server only, as the switch is. */
  ipcMain.handle("lend:choose", async (event, id) => {
    const { env } = target(event, id);
    if (!(await own(env)) || sharing().state(env.id).enabled !== true) return false;
    openSettings(env.id);
    return true;
  });
  /** macOS's Accessibility and Screen Recording, the one step the system itself asks for. */
  ipcMain.handle("lend:allow-screen", async (event, id) => {
    const { env } = target(event, id);
    if (await own(env) && sharing().state(env.id).enabled === true) await allowScreen();
    return view(env);
  });
  /** The add form's switch: lend to the server about to be paired at `host`, if it turns out to be the person's own. Only
   * from this app's own page; used once, by the next pairing of that host within ten minutes. */
  const wishes = new Map();
  const hostOf = origin => { try { return new URL(origin).hostname.toLowerCase(); } catch { return ""; } };
  ipcMain.handle("lend:wish", async (event, address, on) => {
    if (!local(event)) throw new Error("These controls are only available in the main desktop window");
    const host = hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(String(address ?? "")) ? String(address) : `https://${address ?? ""}`);
    if (!host) return false;
    // One wish at a time: the form's address as typed so far, never each partial host on the way.
    wishes.clear();
    if (on === true) wishes.set(host, now());
    return true;
  });
  const wished = env => {
    const host = hostOf(env.origin), at = wishes.get(host);
    wishes.delete(host);
    return at !== undefined && now() - at < 10 * 60_000;
  };

  const asking = new Set();
  /** Still on that server: the person may have gone elsewhere while the server answered. */
  const showing = (win, env) => {
    if (win.isDestroyed() || active()?.id !== env.id) return false;
    try { return new URL(win.webContents.getURL()).origin === env.origin; } catch { return false; }
  };
  return {
    /** The window finished loading a server: a server of the person's own the add form's switch was on for is lent; any
     * other server asks as before while the maintainer flag is on. */
    async offer(win) {
      const env = active();
      if (!env || asking.has(env.id) || win.isDestroyed() || !candidate(env)) return;
      asking.add(env.id);
      try {
        const info = await sharing().ownOffer(env);
        if (info !== false) {
          // A server of their own is no longer asked in a popup: the add form's switch said what they want (`wished`),
          // and the switch on its row, its card and its Screen panel says and changes it from then on.
          if (info && wished(env) && showing(win, env)) await sharing().lendOwn(env, firstGrant);
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
