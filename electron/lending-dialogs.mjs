// Security: sharing this computer with a server lets its bots read its folders, run commands or act in its apps as the
// person. These are main's own dialogs, which no page (this computer's or a server's) can draw or answer, and each one
// defaults to Cancel.
import { randomUUID } from "node:crypto";
import { desktopText as text } from "./i18n.mjs";

export function serverAccessDetail(env, { folders, terminal, computer }) {
  return [
    text("desktop.sharing.server", { origin: env.origin }),
    ...folders.map(folder => text("desktop.sharing.folder", { mode: text(folder.write ? "desktop.sharing.readWrite" : "desktop.sharing.readOnly"), path: folder.path, home: folder.home ? text("desktop.sharing.homeSuffix") : "" })),
    text(terminal === true ? "desktop.sharing.terminalOn" : "desktop.sharing.terminalOff"),
    text(computer === true ? "desktop.sharing.computerOn" : "desktop.sharing.computerOff"),
    text("desktop.sharing.disclosure"),
  ].join("\n\n");
}

/**
 * @param {{
 *   dialog: { showOpenDialog: Function, showMessageBox: Function },
 *   window: () => ({ isDestroyed(): boolean } | null),
 *   validate: (folders: Array<{ id: string, path: string, write: boolean, home?: boolean }>) => Promise<Array<{ id: string, path: string, name: string, write: boolean, home?: boolean }>>,
 *   isHome?: (path: string) => Promise<boolean>,
 * }} deps
 */
export function createLendingDialogs({ dialog, window, validate, isHome = async () => false }) {
  let askingTerminal = false;
  return {
    /** Turning the terminal on runs `lend` only once the person confirms, one question at a time; turning it off never asks.
     * True once `lend` ran. */
    async lendTerminal(on, lend) {
      if (on) {
        if (askingTerminal) return false;
        askingTerminal = true;
        try {
          const { response } = await dialog.showMessageBox({
            type: "warning", buttons: [text("desktop.sharing.allowTerminal"), text("desktop.common.cancel")], defaultId: 1, cancelId: 1,
            message: text("desktop.sharing.terminalTitle"),
            detail: text("desktop.sharing.terminalDetail"),
          });
          if (response !== 0) return false;
        } finally { askingTerminal = false; }
      }
      await lend();
      return true;
    },
    /** The folder or drive the person picks, read only and checked as every lent folder is; null when they cancel. The
     * home folder is lent only when it is picked here and confirmed here: the folders above it and the system disk never are. */
    async chooseFolder(title) {
      const picked = await dialog.showOpenDialog(window(), { title, properties: ["openDirectory"] });
      if (picked.canceled || !picked.filePaths[0]) return null;
      const folder = { id: randomUUID(), path: picked.filePaths[0], write: false };
      if (await isHome(folder.path)) {
        // What stays private is `personalSecretPaths` and this app's own data (computer-sharing.mjs `protectedRoots`),
        // refused inside any lent folder, the home folder included.
        const { response } = await dialog.showMessageBox(window(), { type: "warning", message: text("desktop.sharing.homeTitle"),
          detail: text("desktop.sharing.homeDetail"),
          buttons: [text("desktop.sharing.allowHome"), text("desktop.common.cancel")], defaultId: 1, cancelId: 1 });
        if (response !== 0) return null;
        folder.home = true;
      }
      return (await validate([folder]))[0];
    },
    async confirmServerAccess(env, grant) {
      const { response } = await dialog.showMessageBox(window(), { type: "warning", message: text("desktop.sharing.allowComputer", { name: env.name }), detail: serverAccessDetail(env, grant), buttons: [text("desktop.common.allow"), text("desktop.common.cancel")], defaultId: 1, cancelId: 1 });
      return response === 0;
    },
  };
}
