// Electron has no role for the macOS Preferences… item, so it is built explicitly.
import { Menu, app } from "electron";
import nativeText from "./native-text.cjs";

const role = (t, name, key, params) => ({ role: name, label: t(key, params) });

// Electron 43's role labels are English only (lib/browser/api/menu-item-roles.ts), so each role menu is written out
// with Electron's own items and order, and a label on every item.
function roleMenus(t, isMac) {
  const file = { role: "fileMenu", label: t("native.role.file"), submenu: [isMac ? role(t, "close", "native.role.closeWindow") : role(t, "quit", process.platform === "win32" ? "native.role.exit" : "native.role.quit")] };
  const edit = {
    role: "editMenu",
    label: t("native.role.edit"),
    submenu: [
      role(t, "undo", "native.role.undo"),
      role(t, "redo", "native.role.redo"),
      { type: "separator" },
      role(t, "cut", "native.role.cut"),
      role(t, "copy", "native.role.copy"),
      role(t, "paste", "native.role.paste"),
      ...(isMac
        ? [
          role(t, "pasteAndMatchStyle", "native.role.pasteAndMatchStyle"),
          role(t, "delete", "native.role.delete"),
          role(t, "selectAll", "native.role.selectAll"),
          { type: "separator" },
          { label: t("native.role.substitutions"), submenu: [
            role(t, "showSubstitutions", "native.role.showSubstitutions"),
            { type: "separator" },
            role(t, "toggleSmartQuotes", "native.role.smartQuotes"),
            role(t, "toggleSmartDashes", "native.role.smartDashes"),
            role(t, "toggleTextReplacement", "native.role.textReplacement"),
          ] },
          { label: t("native.role.speech"), submenu: [role(t, "startSpeaking", "native.role.startSpeaking"), role(t, "stopSpeaking", "native.role.stopSpeaking")] },
        ]
        : [role(t, "delete", "native.role.delete"), { type: "separator" }, role(t, "selectAll", "native.role.selectAll")]),
    ],
  };
  const view = {
    role: "viewMenu",
    label: t("native.role.view"),
    submenu: [
      role(t, "reload", "native.role.reload"),
      role(t, "forceReload", "native.role.forceReload"),
      role(t, "toggleDevTools", "native.role.toggleDevTools"),
      { type: "separator" },
      role(t, "resetZoom", "native.role.actualSize"),
      role(t, "zoomIn", "native.role.zoomIn"),
      role(t, "zoomOut", "native.role.zoomOut"),
      { type: "separator" },
      role(t, "togglefullscreen", "native.role.toggleFullScreen"),
    ],
  };
  const window = {
    role: "windowMenu",
    label: t("native.role.window"),
    submenu: [
      role(t, "minimize", "native.role.minimize"),
      role(t, "zoom", "native.role.zoom"),
      ...(isMac ? [{ type: "separator" }, role(t, "front", "native.role.front")] : [role(t, "close", "native.role.close")]),
    ],
  };
  return { file, edit, view, window };
}

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
 * @param {(key: string, params?: Record<string, string | number>) => string} [input.t]
 * @param {{ checked: boolean, onToggle: (on: boolean) => void } | null} [input.openAtLogin] Open at Login, in the app
 *   menu on macOS and the File menu elsewhere; absent when this build cannot add a login item.
 */
export function buildApplicationMenu({ environments, activeId, onSwitch, onAddFromClipboard, onConnect, onForget, onOpenSettings, onOrganizationSignIn, onAddCloud, sublabels = {}, home = null, openAtLogin = null, t = nativeText.englishText.t }) {
  const isMac = process.platform === "darwin";
  const active = environments.find((e) => e.id === activeId) ?? null;
  const others = home ? environments.filter((e) => e.origin !== home.origin && e.kind !== "local") : [];
  const away = Boolean(active && home && active.origin !== home.origin);
  const homeServer = {
    label: t("native.menu.server"),
    submenu: [
      { id: "back-to-my-cloud", label: t("native.menu.backToMyCloud"), enabled: away, click: () => home?.onBack() },
      { type: "separator" },
      ...others.map((e) => ({ label: `${e.name} — ${new URL(e.origin).host}`, type: "radio", checked: e.id === activeId, click: () => onSwitch(e.id) })),
      { type: "separator" },
      { label: t("native.menu.addFromLink"), click: () => onAddFromClipboard() },
      { label: away ? t("native.menu.forgetNamed", { name: active.name }) : t("native.menu.forgetServer"), enabled: away, click: () => away && onForget(active.id) },
    ],
  };
  const server = home ? homeServer : {
    label: t("native.menu.server"),
    submenu: [
      { label: t("place.local"), type: "radio", checked: !active, click: () => onSwitch("local") },
      ...environments.map((e) => ({
        label: `${e.name} — ${Object.hasOwn(sublabels, e.id) ? sublabels[e.id] : whereItLives(e)}`,
        type: "radio",
        checked: e.id === activeId,
        click: () => onSwitch(e.id),
      })),
      ...(onAddCloud ? [{ id: "add-cloud", label: t("native.menu.addCloud"), click: () => onAddCloud() }] : []),
      { type: "separator" },
      { id: "organization-sign-in", label: t("native.menu.orgSignIn"), click: onOrganizationSignIn },
      { label: t("native.menu.connect"), click: onConnect },
      { label: t("native.menu.addFromLink"), click: () => onAddFromClipboard() },
      {
        label: active ? t("native.menu.forgetNamed", { name: active.name }) : t("native.menu.forgetServer"),
        enabled: Boolean(active),
        click: () => active && onForget(active.id),
      },
    ],
  };
  const atLogin = openAtLogin ? [{ id: "open-at-login", label: t("native.menu.openAtLogin"), type: "checkbox", checked: openAtLogin.checked, click: () => openAtLogin.onToggle(!openAtLogin.checked) }] : [];
  const roles = roleMenus(t, isMac);
  const appMenu = {
    label: app.name,
    submenu: [
      role(t, "about", "native.role.about", { app: app.name }),
      { label: t("native.menu.settings"), accelerator: "CmdOrCtrl+,", click: () => onOpenSettings() },
      ...atLogin,
      { type: "separator" },
      role(t, "hide", "native.role.hide", { app: app.name }),
      role(t, "hideOthers", "native.role.hideOthers"),
      role(t, "unhide", "native.role.unhide"),
      { type: "separator" },
      role(t, "quit", "native.role.quitApp", { app: app.name }),
    ],
  };
  const template = [
    ...(isMac ? [appMenu] : []),
    !isMac && openAtLogin ? { ...roles.file, submenu: [...atLogin, { type: "separator" }, role(t, "quit", "native.role.quit")] } : roles.file,
    roles.edit,
    ...(home && !others.length ? [] : [server]),
    roles.view,
    roles.window,
  ];
  return Menu.buildFromTemplate(template);
}
