// Electron has no role for the macOS Preferences… item, so it is built explicitly.
import { Menu, app } from "electron";

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
export function buildApplicationMenu({ environments, activeId, onSwitch, onAddFromClipboard, onConnect, onForget, onOpenSettings, onOrganizationSignIn, onAddCloud, sublabels = {}, home = null, openAtLogin = null }) {
  const isMac = process.platform === "darwin";
  const active = environments.find((e) => e.id === activeId) ?? null;
  const others = home ? environments.filter((e) => e.origin !== home.origin && e.kind !== "local") : [];
  const away = Boolean(active && home && active.origin !== home.origin);
  const homeServer = {
    label: "Server",
    submenu: [
      { id: "back-to-my-cloud", label: "Back to My Cloud", enabled: away, click: () => home?.onBack() },
      { type: "separator" },
      ...others.map((e) => ({ label: `${e.name} — ${new URL(e.origin).host}`, type: "radio", checked: e.id === activeId, click: () => onSwitch(e.id) })),
      { type: "separator" },
      { label: "Add Server from Copied Pairing Link…", click: () => onAddFromClipboard() },
      { label: away ? `Forget “${active.name}”` : "Forget Server", enabled: away, click: () => away && onForget(active.id) },
    ],
  };
  const server = home ? homeServer : {
    label: "Server",
    submenu: [
      { label: "This computer", type: "radio", checked: !active, click: () => onSwitch("local") },
      ...environments.map((e) => ({
        label: `${e.name} — ${Object.hasOwn(sublabels, e.id) ? sublabels[e.id] : whereItLives(e)}`,
        type: "radio",
        checked: e.id === activeId,
        click: () => onSwitch(e.id),
      })),
      ...(onAddCloud ? [{ id: "add-cloud", label: "Add a Cloud…", click: () => onAddCloud() }] : []),
      { type: "separator" },
      { id: "organization-sign-in", label: "Sign in with your organization…", click: onOrganizationSignIn },
      { label: "Connect to a server…", click: onConnect },
      { label: "Add Server from Copied Pairing Link…", click: () => onAddFromClipboard() },
      {
        label: active ? `Forget “${active.name}”` : "Forget Server",
        enabled: Boolean(active),
        click: () => active && onForget(active.id),
      },
    ],
  };
  const atLogin = openAtLogin ? [{ id: "open-at-login", label: "Open at Login", type: "checkbox", checked: openAtLogin.checked, click: () => openAtLogin.onToggle(!openAtLogin.checked) }] : [];
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [{ role: "about" }, { label: "Preferences…", accelerator: "CmdOrCtrl+,", click: () => onOpenSettings() }, ...atLogin, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }] : []),
    !isMac && openAtLogin ? { label: "File", submenu: [...atLogin, { type: "separator" }, { role: "quit" }] } : { role: "fileMenu" },
    { role: "editMenu" },
    ...(home && !others.length ? [] : [server]),
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}
