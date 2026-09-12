// The application menu. Today it exists for one reason: the Server submenu,
// where the user switches between the local server and paired remote ones.
// Everything else is Electron's standard roles so macOS keeps Edit/Window
// and Windows/Linux get the same items under a visible bar.
import { Menu, app } from "electron";

/**
 * @param {object} input
 * @param {{ id: string, name: string, origin: string }[]} input.environments
 * @param {string} input.activeId  "local" or an environment id
 * @param {(id: string) => void} input.onSwitch
 * @param {() => void} input.onAddFromClipboard
 * @param {(id: string) => void} input.onForget
 */
export function buildApplicationMenu({ environments, activeId, onSwitch, onAddFromClipboard, onForget }) {
  const isMac = process.platform === "darwin";
  const active = environments.find((e) => e.id === activeId) ?? null;
  const server = {
    label: "Server",
    submenu: [
      { label: "Local (this computer)", type: "radio", checked: !active, click: () => onSwitch("local") },
      ...environments.map((e) => ({
        label: `${e.name} — ${new URL(e.origin).host}`,
        type: "radio",
        checked: e.id === activeId,
        click: () => onSwitch(e.id),
      })),
      { type: "separator" },
      { label: "Add Server from Copied Pairing Link…", click: () => onAddFromClipboard() },
      {
        label: active ? `Forget “${active.name}”` : "Forget Server",
        enabled: Boolean(active),
        click: () => active && onForget(active.id),
      },
    ],
  };
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [{ role: "about" }, { role: "preferences" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    server,
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}
