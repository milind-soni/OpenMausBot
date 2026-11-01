import skins from "./skin-overlay.cjs";
import { createTalkPanel } from "./talk-panel.mjs";
import { createTalkServer } from "./talk-server.mjs";
import { createTalkSession } from "./talk-session.mjs";
import { createCallPresence, createTalkShortcut, TALK_SHORTCUT_UNAVAILABLE } from "./talk-shortcut.mjs";

export { isTalkPanel } from "./talk-panel.mjs";

/**
 * The microphone's IPC for this app's pages (dictation, calls, the talk setting), then the talk shortcut once the app
 * is ready. `speech`: speech.mjs's start/stop/finish/busy. `packaged`: asks go to `localRequest`, this computer's own
 * server; in development to `devUrl`, whose Vite /api proxy reaches `pnpm dev:server`.
 */
export function installTalk({ ipcMain, localOnly, localOrHome, BrowserWindow, appleSpeech, speech, packaged, devUrl, nativeImage, iconPath, openLink, reveal, log, fetch = globalThis.fetch }) {
  const callPresence = createCallPresence();
  let shortcut = null, session = null, panel = null, theme = null;

  ipcMain.handle("speech:start", localOnly("speech:start", (event, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (!appleSpeech) {
      win.webContents.send("speech:end", { code: 2, reason: "unsupported-platform" });
      return;
    }
    speech.start(win, options);
  }));
  ipcMain.handle("speech:stop", localOnly("speech:stop", (event) => {
    if (appleSpeech) speech.stop(BrowserWindow.fromWebContents(event.sender));
  }));
  ipcMain.handle("speech:finish", localOnly("speech:finish", (event) => {
    if (appleSpeech) speech.finish(BrowserWindow.fromWebContents(event.sender));
  }));
  ipcMain.handle("talk-shortcut:state", localOnly("talk-shortcut:state", () => shortcut?.state() ?? TALK_SHORTCUT_UNAVAILABLE));
  ipcMain.handle("talk-shortcut:set", localOnly("talk-shortcut:set", (_event, change) => shortcut?.set({
    enabled: typeof change?.enabled === "boolean" ? change.enabled : undefined,
    key: typeof change?.key === "string" ? change.key : undefined,
  }) ?? TALK_SHORTCUT_UNAVAILABLE));
  ipcMain.handle("call:active", localOrHome("call:active", (event, active) => {
    callPresence.set(event.sender, active === true);
  }));

  // Electron: a throw inside a globalShortcut or webContents event callback reaches no caller.
  const logged = (what, run) => () => {
    try { run(); } catch (error) { log(`talk ${what} failed: ${error?.message ?? error}`); }
  };

  return {
    /** `remote()`: this desktop is a remote client of another computer. `away()`: this computer's bots moved to My Cloud,
     * so its own copy is frozen. `starting()`: this computer's server is on its way up. `dataDir()`: the data folder
     * this process runs. */
    start({ globalShortcut, screen, prefs, remote, away, starting, localRequest, dataDir }) {
      const request = (route, init) => (packaged ? localRequest(route, init) : fetch(new URL(route, devUrl), init));
      try {
        panel = createTalkPanel({ BrowserWindow, screen, nativeImage, iconPath, theme, onOpen: logged("open", () => session.open()), onDismiss: logged("dismiss", () => session.dismiss()) });
        session = createTalkSession({
          speech,
          server: createTalkServer({ request, prefs, starting, serverKey: () => (packaged ? dataDir() : devUrl) ?? "local" }),
          panel,
          voiceInUse: () => speech.busy() || callPresence.active(),
          release: () => shortcut.releaseModifiers(),
          openChat: chat => (chat ? openLink(`openmausbot://thread/${encodeURIComponent(chat.threadId)}?bot=${encodeURIComponent(chat.botId)}`) : reveal()),
        });
        shortcut = createTalkShortcut({ globalShortcut, prefs, available: () => appleSpeech && !remote() && !away(), onPress: logged("press", () => session.press()) });
      } catch (error) {
        session = null;
        log(`talk shortcut unavailable: ${error?.message ?? error}`);
      }
    },
    /** Home changed (My Cloud, or this computer again): the key is let go or taken again to match. */
    homeChanged: logged("home change", () => shortcut?.refresh()),
    /** A page painted the app's skin (its id, resolved from the Theme setting): the box takes its light or dark. */
    skin(id) {
      if (!skins.isKnownSkin(id)) return;
      theme = skins.skinIsLight(id) ? "light" : "dark";
      logged("skin", () => panel?.setTheme(theme))();
    },
    /** Listening, or an ask on its way that has not been answered yet. */
    busy: () => session?.busy() ?? false,
    close() {
      logged("close", () => session?.close())();
      logged("close", () => shortcut?.close())();
    },
  };
}
