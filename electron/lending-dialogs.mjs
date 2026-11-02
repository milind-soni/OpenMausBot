// Security: sharing this computer with a server lets its bots read its folders, run commands or act in its apps as the
// person. These are main's own dialogs, which no page (this computer's or a server's) can draw or answer, and each one
// defaults to Cancel.
import { randomUUID } from "node:crypto";

export function serverAccessDetail(env, { folders, terminal, computer }) {
  return [
    `Server: ${env.origin}`,
    ...folders.map(folder => `${folder.write ? "Read and write" : "Read only"}: ${folder.path}${folder.home ? " (your whole home folder)" : ""}`),
    terminal === true ? "Terminal: UNRESTRICTED commands as your user. Can access files outside the folders above, including credentials." : "Terminal: off",
    computer === true ? "Computer control: can view your screen and operate logged-in apps. Can access information outside the folders above." : "Computer control: off",
    "Shared content is sent to this server and may reach its model provider. Bots on this server can use these permissions until you revoke them. Closing the desktop stops access.",
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
            type: "warning", buttons: ["Let them run commands", "Cancel"], defaultId: 1, cancelId: 1,
            message: "Let your Clouds run commands on this computer?",
            detail: "Bots on your own Clouds could run any command on this computer as you, including reading and changing any file you can. You can turn this off from the OpenMausBot icon's menu.",
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
        const { response } = await dialog.showMessageBox(window(), { type: "warning", message: "Share your whole home folder?",
          detail: "Everything in your home folder becomes readable by the bots you allow. The places that hold keys, passwords and browser data, like .ssh and your browsers' profiles, always stay private.",
          buttons: ["Share home folder", "Cancel"], defaultId: 1, cancelId: 1 });
        if (response !== 0) return null;
        folder.home = true;
      }
      return (await validate([folder]))[0];
    },
    async confirmServerAccess(env, grant) {
      const { response } = await dialog.showMessageBox(window(), { type: "warning", message: `Allow computer access for ${env.name}?`, detail: serverAccessDetail(env, grant), buttons: ["Allow access", "Cancel"], defaultId: 1, cancelId: 1 });
      return response === 0;
    },
  };
}
