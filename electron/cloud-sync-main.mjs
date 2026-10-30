// Wires Files into the desktop app: the service with Electron's pieces, and its channels for this computer's own window
// only. A folder reaches `share` only as a token for one the person picked (or the app suggested and checked) here.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createCloudFilesService } from "./cloud-sync.mjs";
import { createDownloadMarker } from "./cloud-sync-mark.mjs";
import { cloudPlanDisk } from "./cloud-home.mjs";
import { lendingForFiles } from "./lent-folders.mjs";

const TOKEN_MS = 30 * 60_000;

/** `stateDir`: Files' own folder under userData; the staging Admin keeps its own (cloud-account.mjs cloudTarget).
 * `lending`: main's pieces for lending to My Cloud ({ environment, sharing, validate }): each lent folder gets a copy,
 * and a folder added here is lent, read only (lent-folders.mjs). */
export function installCloudFiles({ app, ipcMain, dialog, shell, powerMonitor, fetch, localWorkspaceOnly, send, cloudOrigin, cloudAccount, localDataDir, power, lending: lendingParts = null, now = Date.now, stateDir = "cloud-sync" }) {
  const lending = lendingParts ? lendingForFiles(lendingParts) : null;
  const dir = path.join(app.getPath("userData"), stateDir);
  const service = createCloudFilesService({
    settingsFile: path.join(dir, "settings.json"), stateFile: path.join(dir, "state.db"),
    documentsDir: app.getPath("documents"), homeDir: app.getPath("home"), localDataDir, cloudOrigin, fetch, ...(power ? { power } : {}),
    trashItem: (file) => shell.trashItem(file), markDownloaded: createDownloadMarker(),
    onChange: (state) => send("files:state-changed", state),
    lending, planDisk: () => { try { return cloudPlanDisk(cloudAccount().state()); } catch { return null; } },
  });
  const tokens = new Map();
  const issue = (checked) => {
    for (const [token, entry] of tokens) if (entry.at + TOKEN_MS < now()) tokens.delete(token);
    const token = randomUUID();
    if (!checked.refusal) tokens.set(token, { pcPath: checked.pcPath, at: now() });
    return { token, ...checked };
  };
  const pick = async () => {
    const picked = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return picked.canceled || !picked.filePaths[0] ? null : picked.filePaths[0];
  };
  const handle = (channel, work) => ipcMain.handle(channel, localWorkspaceOnly(channel, work));
  handle("files:state", () => service.state());
  handle("files:pick", async () => {
    const picked = await pick();
    return picked ? issue(await service.check(picked)) : null;
  });
  handle("files:check", async (_event, paths) => {
    if (!Array.isArray(paths) || paths.length > 20 || !paths.every((value) => typeof value === "string" && value.length <= 4096)) throw new Error("Invalid folders.");
    return Promise.all(paths.map(async (value) => issue(await service.check(value))));
  });
  handle("files:share", async (_event, token) => {
    const entry = typeof token === "string" ? tokens.get(token) : null;
    if (!entry) throw new Error("Choose the folder again.");
    tokens.delete(token);
    // Lent, read only, so it works live while this computer is on and from its copy while it is away; Files on its own
    // only when lending to My Cloud can't take it.
    const lent = await lending?.lend(entry.pcPath).catch(() => null);
    return lent ? service.adopt(lent) : service.share(entry.pcPath);
  });
  const folderId = (value) => {
    if (typeof value !== "string" || !/^[\w-]{1,200}$/.test(value)) throw new Error("Invalid folder.");
    return value;
  };
  handle("files:stop", async (_event, id) => {
    const lentId = service.lentOf(folderId(id));
    if (lentId) await lending?.unlend(lentId);
    return service.stopSharing(folderId(id));
  });
  handle("files:deletes", (_event, id, remove) => service.answerDeletes(folderId(id), remove === true));
  handle("files:locate", async (_event, id) => {
    const picked = await pick();
    return picked ? service.relocate(folderId(id), picked) : service.state();
  });
  handle("files:outputs", (_event, enabled) => service.setOutputs(enabled === true));
  handle("files:open", async (_event, target) => {
    const folder = service.localFolder(target?.outputs === true ? { outputs: true } : { folderId: folderId(target?.folderId) });
    if (folder) await shell.openPath(folder);
  });
  handle("files:more-space", async () => { await cloudAccount().openDashboard(); });
  powerMonitor.on("resume", () => service.wake());
  // Lending changed (a folder lent, unlent or given editing): Files follows within seconds.
  let lentSeen = null, follow = null;
  const lentNow = () => { try { return JSON.stringify(lending?.now() ?? null); } catch { return null; } };
  const start = () => {
    service.start();
    lentSeen = lentNow();
    follow ??= setInterval(() => { const next = lentNow(); if (next !== lentSeen) { lentSeen = next; service.wake(); } }, 15_000);
    follow.unref?.();
  };
  return { start, running: () => service.running(), close: () => { clearInterval(follow); service.close(); } };
}
