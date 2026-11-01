// Electron has no role for the macOS Preferences… item, so it is built explicitly.
import { Menu, app } from "electron";
import { desktopText, localizeNativeMenu } from "./i18n.mjs";

/** A local environment has a folder and no address. */
const whereItLives = (environment) => (environment.kind === "local" ? environment.dataDir : new URL(environment.origin).host);

/**
 * @param {object} input
 * @param {({ id: string, name: string, origin: string } | { id: string, name: string, kind: "local", dataDir: string })[]} input.environments
 * @param {string} input.activeId  "local" or an environment id
 * @param {(id: string) => void} input.onSwitch
 * @param {() => void} input.onAddFromClipboard
 * @param {() => void} input.onConnect
 * @param {(id: string) => void} input.onForget
 * @param {() => void} input.onOpenSettings
 * @param {() => void} input.onOrganizationSignIn
 * @param {{ origin: string, onBack: () => void } | null} [input.home] My Cloud once the person's bots moved there: the
 *   menu lists only the other saved servers, with Back to My Cloud, and is absent without any.
 * @param {{ checked: boolean, onToggle: (on: boolean) => void } | null} [input.openAtLogin] Open at Login, in the app
 *   menu on macOS and the File menu elsewhere; absent when this build cannot add a login item.
 */
export function buildApplicationMenu({ environments, activeId, onSwitch, onAddFromClipboard, onConnect, onForget, onOpenSettings, onOrganizationSignIn, onAddCloud, sublabels = {}, home = null, openAtLogin = null, language }) {
  const text = (key, params) => desktopText(key, params, language);
  const isMac = process.platform === "darwin";
  const active = environments.find((e) => e.id === activeId) ?? null;
  const others = home ? environments.filter((e) => e.origin !== home.origin && e.kind !== "local") : [];
  const away = Boolean(active && home && active.origin !== home.origin);
  const homeServer = {
    label: text("desktop.menu.server"),
    submenu: [
      { id: "back-to-my-cloud", label: text("desktop.menu.backToCloud"), enabled: away, click: () => home?.onBack() },
      { type: "separator" },
      ...others.map((e) => ({ label: `${e.name} — ${new URL(e.origin).host}`, type: "radio", checked: e.id === activeId, click: () => onSwitch(e.id) })),
      { type: "separator" },
      { label: text("desktop.menu.addCopiedServer"), click: () => onAddFromClipboard() },
      { label: away ? text("desktop.menu.forgetNamed", { name: active.name }) : text("desktop.menu.forgetServer"), enabled: away, click: () => away && onForget(active.id) },
    ],
  };
  const server = home ? homeServer : {
    label: text("desktop.menu.server"),
    submenu: [
      { label: text("desktop.menu.thisComputer"), type: "radio", checked: !active, click: () => onSwitch("local") },
      ...environments.map((e) => ({
        label: `${e.name} — ${Object.hasOwn(sublabels, e.id) ? sublabels[e.id] : whereItLives(e)}`,
        type: "radio",
        checked: e.id === activeId,
        click: () => onSwitch(e.id),
      })),
      ...(onAddCloud ? [{ id: "add-cloud", label: text("desktop.menu.addCloud"), click: () => onAddCloud() }] : []),
      { type: "separator" },
      { id: "organization-sign-in", label: text("desktop.menu.organizationSignIn"), click: onOrganizationSignIn },
      { label: text("desktop.menu.connectServer"), click: onConnect },
      { label: text("desktop.menu.addCopiedServer"), click: () => onAddFromClipboard() },
      {
        label: active ? text("desktop.menu.forgetNamed", { name: active.name }) : text("desktop.menu.forgetServer"),
        enabled: Boolean(active),
        click: () => active && onForget(active.id),
      },
    ],
  };
  const atLogin = openAtLogin ? [{ id: "open-at-login", label: text("desktop.menu.openAtLogin"), type: "checkbox", checked: openAtLogin.checked, click: () => openAtLogin.onToggle(!openAtLogin.checked) }] : [];
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [{ role: "about" }, { label: text("desktop.menu.preferences"), accelerator: "CmdOrCtrl+,", click: () => onOpenSettings() }, ...atLogin, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }] : []),
    !isMac && openAtLogin ? { label: text("desktop.role.fileMenu"), submenu: [...atLogin, { type: "separator" }, { role: "quit" }] } : { role: "fileMenu" },
    { role: "editMenu" },
    ...(home && !others.length ? [] : [server]),
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  localizeNativeMenu(template, language, app.name);
  return localizeNativeMenu(Menu.buildFromTemplate(template), language, app.name);
}
