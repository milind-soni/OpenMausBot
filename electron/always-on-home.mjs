// "Use this computer as an always-on home" (Settings → Phone & devices): one switch for a spare computer, such as a Mac
// mini, that runs the person's bots all day. It turns on what the app already has (Open at login, the updater's quiet
// install, the server supervisor's recovery) and adds one thing of its own: the computer stays awake while it is on
// power. Turning it off undoes only what turning it on changed: a login item the person had set up stays.
import fs from "node:fs";
import path from "node:path";

export const ALWAYS_ON_FILE = "always-on-home.json";
/** Electron's powerSaveBlocker type that keeps the system from idle sleep and lets the display turn off. */
export const ALWAYS_ON_BLOCKER = "prevent-app-suspension";
export const ALWAYS_ON_LOOK_MS = 60_000;
const UPDATES = new Set(["by-itself", "restart", "package", "none"]);

/** The saved switch: `{ v: 1, on, addedLogin }`; anything else reads as off. `addedLogin`: turning it on added the login item. */
export function parseAlwaysOn(value) {
  if (!value || typeof value !== "object" || value.v !== 1) return { v: 1, on: false, addedLogin: false };
  return { v: 1, on: value.on === true, addedLogin: value.on === true && value.addedLogin === true };
}

/**
 * `loginItem`: open-at-login.mjs's item (`available`, `chosen`, `choose`). `blocker`: Electron's powerSaveBlocker.
 * `isOnBattery()`: powerMonitor's word. `updates()`: how an update arrives with nobody at the computer (updater.mjs
 * `unattendedUpdates`). `platform`: process.platform.
 */
export function createAlwaysOnHome({ file, loginItem, blocker, isOnBattery, updates = () => "none", platform = process.platform, log = () => {}, lookMs = ALWAYS_ON_LOOK_MS }) {
  let saved = read();
  let blockerId = null;
  let timer = null;

  function read() {
    try { return parseAlwaysOn(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { return parseAlwaysOn(null); }
  }
  function write(next) {
    saved = next;
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(next));
      fs.renameSync(temporary, file);
    } catch {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
  const battery = () => { try { return isOnBattery() === true; } catch { return false; } };
  const loginOn = () => { try { return loginItem.chosen() === true; } catch { return false; } };

  function look() {
    const hold = saved.on && !battery();
    if (hold && blockerId === null) {
      blockerId = blocker.start(ALWAYS_ON_BLOCKER);
      log("always-on home: holding this computer awake while it is on power");
    } else if (!hold && blockerId !== null) {
      if (blocker.isStarted(blockerId)) blocker.stop(blockerId);
      blockerId = null;
      log(`always-on home: released the awake hold (${saved.on ? "on battery" : "off"})`);
    }
  }

  function state() {
    const kind = updates();
    return {
      available: loginItem.available() === true,
      on: saved.on,
      platform,
      openAtLogin: loginOn(),
      awake: !saved.on ? "off" : battery() ? "battery" : "holding",
      updates: UPDATES.has(kind) ? kind : "none",
    };
  }

  return {
    state,
    look,
    on: () => saved.on,
    set(on) {
      const want = on === true;
      if (want === saved.on) { look(); return state(); }
      let addedLogin = false;
      try {
        if (want && !loginOn()) { loginItem.choose(true); addedLogin = true; }
        else if (!want && saved.addedLogin && loginOn()) loginItem.choose(false);
      } catch (error) {
        log(`always-on home: login item: ${error?.message ?? error}`);
      }
      write({ v: 1, on: want, addedLogin });
      look();
      return state();
    },
    /** `powerMonitor`: plugging in or unplugging changes the hold at once, not at the next look. */
    start(powerMonitor = null) {
      look();
      if (timer) return;
      for (const event of ["on-ac", "on-battery"]) { try { powerMonitor?.on(event, look); } catch {} }
      timer = setInterval(look, lookMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (blockerId !== null && blocker.isStarted(blockerId)) blocker.stop(blockerId);
      blockerId = null;
    },
    holding: () => blockerId !== null,
  };
}

/** The switch and Settings' channels for it, on this computer's own page (`guard`). `changed()` redraws what shows Open
 * at login elsewhere (the app menu). Nothing is held until `start()`, once the app is ready. */
export function installAlwaysOnHome({ ipcMain, guard, changed = () => {}, ...options }) {
  const home = createAlwaysOnHome(options);
  ipcMain.handle("always-on-home:state", guard("always-on-home:state", () => home.state()));
  ipcMain.handle("always-on-home:set", guard("always-on-home:set", (_event, on) => { const next = home.set(on === true); changed(); return next; }));
  return home;
}
