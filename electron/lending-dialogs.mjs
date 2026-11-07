// Security: sharing this computer with a server lets its bots read its folders, run commands or act in its apps as the
// person. These are main's own dialogs, which no page (this computer's or a server's) can draw or answer, and each one
// defaults to Cancel.
import { randomUUID } from "node:crypto";
import { deviceWord } from "./lending-indicator.mjs";
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
export function createLendingDialogs({ dialog, window, validate, isHome = async () => false, device = deviceWord(), platform = process.platform, t = nativeText.englishText.t }) {
  let askingTerminal = false;
  const liveWindow = () => { const shown = window(); return shown && !shown.isDestroyed() ? shown : null; };
  // Electron 43 runs a message box without a window synchronously on macOS.
  const canAskMcp = () => platform !== "darwin" || liveWindow() !== null;
  return {
    /** Turning the terminal on runs `lend` only once the person confirms, one question at a time; turning it off never asks.
     * True once `lend` ran. */
    async lendTerminal(on, lend) {
      if (on) {
        if (askingTerminal) return false;
        askingTerminal = true;
        try {
          const { response } = await dialog.showMessageBox({
            type: "warning", buttons: [t("native.lend.terminalAllow"), t("native.common.cancel")], defaultId: 1, cancelId: 1,
            message: t("native.lend.terminalTitle"),
            detail: t("native.lend.terminalDetail"),
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
        const { response } = await dialog.showMessageBox(window(), { type: "warning", message: t("native.lend.home.title"),
          detail: t("native.lend.home.detail"),
          buttons: [t("native.lend.home.button"), t("native.common.cancel")], defaultId: 1, cancelId: 1 });
        if (response !== 0) return null;
        folder.home = true;
      }
      return (await validate([folder]))[0];
    },
    canAskMcp,
    /** One MCP server this computer's person is asked to let My Cloud use; Don't allow is the default, and anything but Allow is no. */
    async allowMcpServer({ name, target }) {
      const where = device === "computer" ? t("native.lendTray.computer") : device;
      const detail = target.kind === "url" ? t("native.lend.mcp.port", { port: target.port, device: where })
        : [t("native.lend.mcp.command", { command: target.command }), ...target.env?.length ? [t("native.lend.mcp.settings", { names: target.env.join(", ") })] : []].join("\n\n");
      const options = { type: "warning", message: t("native.lend.mcp.title", { name, device: where }), detail,
        buttons: [t("native.lend.mcp.allow"), t("native.lend.mcp.deny")], defaultId: 1, cancelId: 1 };
      if (!canAskMcp()) throw new Error("No window to ask in.");
      const parent = liveWindow();
      if (parent && !parent.isVisible()) parent.show();
      const { response } = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
      return response === 0;
    },
    async confirmServerAccess(env, grant) {
      const { response } = await dialog.showMessageBox(window(), { type: "warning", message: t("native.lend.allow.title", { name: env.name }), detail: serverAccessDetail(env, grant, t),
        buttons: [t("native.lend.allow.button"), t("native.common.cancel")], defaultId: 1, cancelId: 1 });
      return response === 0;
    },
  };
}
