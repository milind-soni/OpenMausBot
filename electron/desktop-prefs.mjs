// What this desktop keeps whatever page its window shows, whichever port its own page is served on: the notices it
// has shown, its usage-analytics switch, the app's language and its answer to the product-updates email question.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { localDay } from "./cloud-trial-notice.mjs";
import nativeText from "./native-text.cjs";
import { ONBOARDING_CLOUD_HINT, onboardingHints } from "./onboarding-record.mjs";
import { createUpdatesConsent, parseUpdatesConsent, registerUpdatesConsent } from "./updates-consent.mjs";

export { DESKTOP_PORTS } from "./desktop-ports.mjs";
/** The only notices a page may record, so no page can write anything else into the file. */
export const DESKTOP_NOTICES = Object.freeze(["cloud-pro-update-2026-10"]);
const CLOUD_PRO = DESKTOP_NOTICES[0];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A locale code such as "de" or "pt-br", or "" for following the system. */
const LANGUAGE = /^(?:[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2})?$/i;
const isLanguage = value => typeof value === "string" && value.length <= 24 && LANGUAGE.test(value);
const INSTALL_ID = /^[A-Za-z0-9_-]{22,64}$/;

/** Security: a write that fails (a full disk, a kill mid-write) leaves the last whole record, analytics opt-out included.
 * A file another tool saved with a byte-order mark (Notepad on Windows) still reads. */
export function jsonFile(file, files = fs) {
  return {
    read: () => JSON.parse(files.readFileSync(file, "utf8").replace(/^\uFEFF/, "")),
    write: value => {
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        files.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
        files.renameSync(temporary, file);
      } catch (error) {
        try { files.rmSync(temporary, { force: true }); } catch {}
        throw error;
      }
    },
  };
}

function parse(raw) {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const seen = Array.isArray(record.seen) ? DESKTOP_NOTICES.filter(id => record.seen.includes(id)) : [];
  const shown = Object.fromEntries(DESKTOP_NOTICES.flatMap(id => {
    const day = record.shown && typeof record.shown === "object" ? record.shown[id] : undefined;
    return typeof day === "string" && DAY.test(day) ? [[id, day]] : [];
  }));
  const updatesConsent = parseUpdatesConsent(record.updatesConsent);
  return { seen, shown, ...(typeof record.analytics === "boolean" ? { analytics: record.analytics } : {}),
    ...(isLanguage(record.language) ? { language: record.language } : {}),
    ...(typeof record.installId === "string" && INSTALL_ID.test(record.installId) ? { installId: record.installId } : {}),
    ...(updatesConsent ? { updatesConsent } : {}) };
}

/** Main's own words in the language this desktop's record keeps, with that record as `prefs`. Electron knows the
 * system's language only once the app is ready. */
export function createDesktopText(app, prefs = createDesktopPrefs(jsonFile(path.join(app.getPath("userData"), "desktop-prefs.json")))) {
  return Object.assign(nativeText.createNativeText({ saved: prefs.language(), system: () => (app.isReady() ? app.getLocale() : "") }), { prefs });
}

/** A record that cannot be written is still kept for this launch. */
export function createDesktopPrefs({ read, write, now = Date.now }) {
  let record = null;
  const current = () => {
    if (record) return record;
    let raw = null;
    try { raw = read(); } catch {}
    return (record = parse(raw));
  };
  const save = next => { record = next; try { write(next); } catch {} };
  return {
    seen: () => [...current().seen],
    markSeen(id) {
      const saved = current();
      if (DESKTOP_NOTICES.includes(id) && !saved.seen.includes(id)) save({ ...saved, seen: [...saved.seen, id] });
    },
    /** True the first time a notice not yet seen counts as shown on a calendar day. */
    shown(id) {
      const saved = current(), day = localDay(now());
      if (!DESKTOP_NOTICES.includes(id) || saved.seen.includes(id) || saved.shown[id] === day) return false;
      save({ ...saved, shown: { ...saved.shown, [id]: day } });
      return true;
    },
    /** null until a choice is saved. */
    analytics: () => current().analytics ?? null,
    setAnalytics(enabled) { save({ ...current(), analytics: enabled === true }); },
    /** null until a language is picked; "" is a pick too: follow the system. */
    language: () => current().language ?? null,
    setLanguage(language) {
      if (!isLanguage(language)) return false;
      if (current().language !== language) save({ ...current(), language });
      return true;
    },
    /** Random, made on first use: the only name the Admin's no-account consent endpoint counts this computer by. */
    installId() {
      const saved = current();
      if (saved.installId) return saved.installId;
      const installId = randomBytes(24).toString("base64url");
      save({ ...saved, installId });
      return installId;
    },
    updatesConsent: () => current().updatesConsent ?? null,
    setUpdatesConsent(value) {
      const updatesConsent = parseUpdatesConsent(value);
      if (!updatesConsent) return false;
      save({ ...current(), updatesConsent });
      return true;
    },
  };
}

/**
 * `cloudAccount()`: the MausBot Cloud sign-in client, for the product-updates question (updates-consent.mjs), which is
 * asked where Cloud offers are (`cloudOffered`); without it nothing is asked and null is returned.
 * `page(event)`: "local" for this computer's page, "cloud" for My Cloud's own page as main verifies it, "server" for
 * another saved server open in this desktop's window, null for anything else. `cloudOffered()`: this desktop sells
 * MausBot Cloud, asked once its Cloud sign-in is restored. `localConfig()`: This computer's own workspace's config.json.
 * `languageChanged(language, sender)`: tells this desktop's other pages the language picked on one of them;
 * `onLanguage(language)`: tells main, which draws its menus, tray and dialogs in it. `prefs`: the record main reads too.
 */
export function registerDesktopPrefs({ ipcMain, read, write, prefs: given = null, page, cloudOffered, cloudAccount, localConfig = () => null, languageChanged = () => {}, onLanguage = () => {}, now = Date.now }) {
  let prefs = given;
  const store = () => prefs ??= createDesktopPrefs({ read, write, now });
  const from = (channel, pages, handler) => (event, ...args) => {
    const asking = page(event);
    if (!pages.includes(asking)) throw new Error(`${channel} is only available in this app's window`);
    return handler(asking, ...args);
  };
  // This computer's workspace record counts on every page, before This computer's page has loaded: an earlier close, or the welcome's Cloud beat.
  const state = async () => {
    const cloud = await cloudOffered();
    let hints = [];
    try { hints = onboardingHints(localConfig()); } catch {}
    const seen = store().seen(), closed = hints.includes(CLOUD_PRO) || hints.includes(ONBOARDING_CLOUD_HINT);
    return { seen: closed && !seen.includes(CLOUD_PRO) ? [...seen, CLOUD_PRO] : seen, cloud };
  };
  const ANY = ["local", "cloud", "server"];
  ipcMain.handle("desktop-notices:state", from("desktop-notices:state", ANY, state));
  ipcMain.handle("desktop-notices:seen", from("desktop-notices:seen", ANY, (_, id) => store().markSeen(id)));
  ipcMain.handle("desktop-notices:shown", from("desktop-notices:shown", ANY, (_, id) => store().shown(id)));
  // Security: a server's page learns only that this desktop turned analytics off, never that it is on.
  ipcMain.on("desktop-analytics:read", event => {
    try {
      const asking = page(event), saved = store().analytics();
      event.returnValue = asking === "local" ? saved : asking && saved === false ? false : null;
    } catch { event.returnValue = null; }
  });
  ipcMain.handle("desktop-analytics:set", from("desktop-analytics:set", ["local"], (_, enabled) => { store().setAnalytics(enabled === true); }));
  ipcMain.on("desktop-language:read", event => {
    try { event.returnValue = page(event) ? store().language() : null; } catch { event.returnValue = null; }
  });
  const setLanguage = from("desktop-language:set", ANY, (_, language) => {
    const before = store().language();
    return store().setLanguage(language) && before !== language;
  });
  ipcMain.handle("desktop-language:set", (event, language) => {
    if (setLanguage(event, language)) {
      try { languageChanged(language, event.sender); } catch {}
      try { onLanguage(language); } catch {}
    }
    return store().language() === language;
  });
  if (!cloudAccount) return null;
  const consent = createUpdatesConsent({ prefs: { installId: () => store().installId(), updatesConsent: () => store().updatesConsent(), setUpdatesConsent: value => store().setUpdatesConsent(value) },
    account: cloudAccount, available: cloudOffered, now });
  registerUpdatesConsent({ ipcMain, page, consent });
  void cloudOffered().then(offered => offered && consent.sync()).catch(() => {});
  return consent;
}
