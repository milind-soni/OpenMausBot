// Security: lending this computer lets bots read its folders, run commands or act in its apps as the person. These are
// main's own dialogs, which no page (this computer's or a server's) can draw or answer, and each one defaults to Cancel.
import { randomUUID } from "node:crypto";
import nativeText from "./native-text.cjs";

export function serverAccessDetail(env, { folders, terminal, computer }, t = nativeText.englishText.t) {
  return [
    t("native.lend.server", { origin: env.origin }),
    ...folders.map(folder => `${t(folder.write ? "native.lend.readWrite" : "native.lend.readOnly", { path: folder.path })}${folder.home ? ` ${t("native.lend.wholeHome")}` : ""}`),
    t(terminal === true ? "native.lend.terminalOn" : "native.lend.terminalOff"),
    t(computer === true ? "native.lend.computerOn" : "native.lend.computerOff"),
    t("native.lend.footer"),
  ].join("\n\n");
}

/**
 * @param {{
 *   dialog: { showOpenDialog: Function, showMessageBox: Function },
 *   window: () => ({ isDestroyed(): boolean } | null),
 *   validate: (folders: Array<{ id: string, path: string, write: boolean, home?: boolean }>) => Promise<Array<{ id: string, path: string, name: string, write: boolean, home?: boolean }>>,
 *   isHome?: (path: string) => Promise<boolean>,
 *   t?: (key: string, params?: Record<string, string | number>) => string,
 * }} deps
 */
export function createLendingDialogs({ dialog, window, validate, isHome = async () => false, t = nativeText.englishText.t }) {
  return {
    /** The folder or drive the person picks, read only and checked as every lent folder is; null when they cancel. The
     * home folder is lent only when it is picked here and confirmed here: the folders above it and the system disk never are. */
    async chooseFolder(title) {
      const picked = await dialog.showOpenDialog(window(), { title, properties: ["openDirectory"] });
      if (picked.canceled || !picked.filePaths[0]) return null;
      const folder = { id: randomUUID(), path: picked.filePaths[0], write: false };
      if (await isHome(folder.path)) {
        // What stays private is `personalSecretPaths` and this app's own data (computer-sharing.mjs `protectedRoots`),
        // refused inside any lent folder, the home folder included.
        const { response } = await dialog.showMessageBox(window(), { type: "warning", message: t("native.lend.home.title"),
          detail: t("native.lend.home.detail"),
          buttons: [t("native.lend.home.button"), t("native.common.cancel")], defaultId: 1, cancelId: 1 });
        if (response !== 0) return null;
        folder.home = true;
      }
      return (await validate([folder]))[0];
    },
    async confirmServerAccess(env, grant) {
      const { response } = await dialog.showMessageBox(window(), { type: "warning", message: t("native.lend.allow.title", { name: env.name }), detail: serverAccessDetail(env, grant, t),
        buttons: [t("native.lend.allow.button"), t("native.common.cancel")], defaultId: 1, cancelId: 1 });
      return response === 0;
    },
    /** Apps and screen asked for from My Cloud's page: false when there is no window to ask in. */
    async confirmScreen() {
      const parent = window();
      if (!parent || parent.isDestroyed()) return false;
      const { response } = await dialog.showMessageBox(parent, {
        type: "warning", message: t("native.lend.screen.title"),
        detail: t("native.lend.screen.detail"),
        buttons: [t("native.lend.screen.button"), t("native.common.cancel")], defaultId: 1, cancelId: 1,
      });
      return response === 0;
    },
  };
}
