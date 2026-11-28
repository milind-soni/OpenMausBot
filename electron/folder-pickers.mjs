import { fromAppWindow } from "./browser-pane-main.mjs";
import localOrigin from "./local-origin.cjs";
import { readChosenSkillFolder } from "./skill-folder-import.mjs";

const { isLocalSender, localOnly } = localOrigin;

export function installFolderPickers({ ipcMain, dialog, windowFor, mainWindow, remote, t }) {
  ipcMain.handle("desktop:pick-folder", localOnly("desktop:pick-folder", async (event, current) => {
    const win = windowFor(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win, {
      title: t("native.picker.workingFolder"),
      properties: ["openDirectory", "createDirectory"],
      ...(typeof current === "string" && current ? { defaultPath: current } : {}),
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }));

  ipcMain.handle("desktop:pick-skill-folder", localOnly("desktop:pick-skill-folder", async (event) => {
    const win = mainWindow();
    fromAppWindow(event, win);
    if (remote()) return null;
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
    const chosen = result.filePaths[0];
    if (result.canceled || !chosen || !isLocalSender(event)) return null;
    const folder = await readChosenSkillFolder(chosen).catch(() => ({ error: "Could not read the skill folder." }));
    return isLocalSender(event) ? folder : null;
  }));
}
