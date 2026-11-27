// While this computer is lent, the app starts with the person's session, out of sight, so My Cloud's bots can use it
// again after a restart without anyone opening it. Lending only ever removes a login item it added, and only such a
// launch starts hidden: one the person set up themselves, here or in the system's settings, opens the window.
import fs from "node:fs";
import path from "node:path";

export const HIDDEN_ARG = "--omb-hidden";
const MARK = "X-OpenMausBot-Lending=true";
/** Windows keeps one Run entry per name, so the person's own entry has a name apart from lending's (the app's). */
const CHOSEN_NAME = "OpenMausBot at login";

/** Desktop Entry Exec quoting: the path in double quotes, with ", `, $ and \ escaped. */
const quoted = (value) => `"${value.replace(/["`$\\]/g, (match) => `\\${match}`)}"`;

export function autostartEntry(exec, { lending = true } = {}) {
  return ["[Desktop Entry]", "Type=Application", "Name=OpenMausBot", `Exec=${quoted(exec)}${lending ? ` ${HIDDEN_ARG}` : ""}`, "NoDisplay=true",
    "X-GNOME-Autostart-enabled=true", ...(lending ? [MARK] : []), ""].join("\n");
}

/**
 * `file`: where this app records that it added the login item (macOS, where a login item carries no arguments), and
 * that the person turned Open at login off (Windows, where lending then adds no entry of its own).
 * `follow(on)` keeps the login item in step with lending; `startedHidden()` says this launch came from it.
 * `chosen()` and `choose(on)`: the person's own login item, which opens the window and which lending never removes; on
 * Windows, whether Windows starts the app at sign-in at all, as its Startup apps list shows.
 * The always-on home (always-on-home.mjs) has its own calls: `hold(on)` keeps the item while lending stops, `homeAdd()`
 * adds the person's kind of item, and `homeRelease()` takes away only that one, or gives it to lending.
 */
export function createOpenAtLogin({ app, file, platform = process.platform, env = process.env, home, argv = process.argv, execPath = process.execPath }) {
  const autostart = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "autostart", "openmausbot.desktop");
  const saved = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")) ?? {}; } catch { return {}; } };
  const store = (fields) => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ...saved(), ...fields })); } catch {} };
  const added = () => saved().added === true;
  const remember = (value) => store({ added: value });
  /** Electron 43.7 on Windows: `openAtLogin` compares the Run entry's arguments with the `args` asked about (none by
   * default), so lending's `--omb-hidden` entry reads as off; `launchItems` lists the entries that start this executable,
   * each with its name, arguments and whether Task Manager has it enabled. */
  const windowsStartsApp = () => (app.getLoginItemSettings().launchItems ?? []).filter(item => item.enabled !== false);
  const ours = () => { try { return fs.readFileSync(autostart, "utf8").includes(MARK); } catch { return false; } };
  let holding = false;
  let whenChosen = () => {};
  function choose(on) {
    if (!app.isPackaged) return;
    if (platform === "linux") {
      if (on) {
        fs.mkdirSync(path.dirname(autostart), { recursive: true });
        fs.writeFileSync(autostart, autostartEntry(env.APPIMAGE || execPath, { lending: false }));
      } else if (!ours()) fs.rmSync(autostart, { force: true });
      return;
    }
    if (platform === "win32") {
      if (on) app.setLoginItemSettings({ openAtLogin: true, args: [], name: CHOSEN_NAME });
      else for (const item of windowsStartsApp()) app.setLoginItemSettings({ openAtLogin: false, args: item.args ?? [], name: item.name });
      store({ declined: !on });
      return;
    }
    app.setLoginItemSettings({ openAtLogin: on });
    remember(false);
  }
  const login = {
    follow(on) {
      if (!app.isPackaged || (!on && holding)) return;
      try {
        if (platform === "linux") {
          if (on && !fs.existsSync(autostart)) {
            fs.mkdirSync(path.dirname(autostart), { recursive: true });
            fs.writeFileSync(autostart, autostartEntry(env.APPIMAGE || execPath));
          } else if (!on && ours()) fs.rmSync(autostart, { force: true });
          return;
        }
        if (platform === "win32") {
          const settings = { args: [HIDDEN_ARG] };
          if (on && saved().declined === true) return;
          if (app.getLoginItemSettings(settings).openAtLogin !== on) app.setLoginItemSettings({ openAtLogin: on, ...settings });
          return;
        }
        const set = app.getLoginItemSettings().openAtLogin === true;
        if (on && !set) { app.setLoginItemSettings({ openAtLogin: true }); remember(true); }
        else if (!on && set && added()) { app.setLoginItemSettings({ openAtLogin: false }); remember(false); }
        else if (!set && added()) remember(false);
      } catch {}
    },
    available: () => app.isPackaged,
    chosen() {
      try {
        if (platform === "linux") return fs.existsSync(autostart) && !ours();
        if (platform === "win32") return windowsStartsApp().length > 0;
        return app.getLoginItemSettings().openAtLogin === true && !added();
      } catch { return false; }
    },
    /** The person's own choice, from Settings or the app menu. */
    choose(on) {
      choose(on);
      whenChosen();
    },
    /** Called after each `choose`: the person has taken the item over from the always-on home. */
    whenChosen(listener) { whenChosen = listener; },
    /** While the always-on home is on, lending stopping leaves the item, whoever added it. */
    hold(on) { holding = on === true; },
    /** Anything starts the app at login: the person's item, lending's or the home's. */
    starts() {
      try {
        if (platform === "linux") return fs.existsSync(autostart);
        if (platform === "win32") return windowsStartsApp().length > 0;
        return app.getLoginItemSettings().openAtLogin === true;
      } catch { return false; }
    },
    /** The home adds the person's kind of item; it returns what Windows had saved about the person turning it off (null
     * elsewhere), for `homeRelease` to put back. */
    homeAdd() {
      const declined = platform === "win32" ? saved().declined === true : null;
      choose(true);
      return declined;
    },
    /** Takes away only the item `homeAdd` added (on Windows its own entry, and the saved word put back), or, while
     * `lending`, gives it to lending, which then removes it once it stops. */
    homeRelease({ declined = null, lending = false } = {}) {
      if (!app.isPackaged) return;
      if (platform === "linux") {
        if (!fs.existsSync(autostart) || ours()) return;
        if (lending) fs.writeFileSync(autostart, autostartEntry(env.APPIMAGE || execPath));
        else fs.rmSync(autostart, { force: true });
        return;
      }
      if (platform === "win32") {
        app.setLoginItemSettings({ openAtLogin: false, args: [], name: CHOSEN_NAME });
        if (typeof declined === "boolean") store({ declined });
        if (lending) login.follow(true);
        return;
      }
      if (app.getLoginItemSettings().openAtLogin !== true || added()) return;
      if (lending) remember(true);
      else app.setLoginItemSettings({ openAtLogin: false });
    },
    startedHidden() {
      if (platform === "darwin") {
        try { return app.getLoginItemSettings().wasOpenedAtLogin === true && added(); } catch { return false; }
      }
      return argv.includes(HIDDEN_ARG);
    },
  };
  return login;
}

/** Settings' switch, on this computer's own page or My Cloud's page once it is home (`guard`); `changed` redraws the
 * app menu's item. */
export function installOpenAtLogin({ ipcMain, guard, loginItem, changed }) {
  const state = () => ({ available: loginItem.available(), on: loginItem.chosen() });
  ipcMain.handle("open-at-login:state", guard("open-at-login:state", state));
  ipcMain.handle("open-at-login:set", guard("open-at-login:set", (_event, on) => { loginItem.choose(on === true); changed(); return state(); }));
}
