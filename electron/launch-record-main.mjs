// This launch's record, made before anything else in the main process runs so the first mark is our code starting.
import { app, net } from "electron";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

import { watchLaunchWork } from "./launch-probes.mjs";
import { createLaunchRecord } from "./launch-record.mjs";

export const desktopLaunchId = randomUUID();

// Electron: process.getCreationTime() is null when the OS will not say; this module's own start stands in.
const processStart = process.getCreationTime() ?? performance.timeOrigin;

export const launchRecord = createLaunchRecord({
  processStart, launchId: desktopLaunchId, appVersion: app.getVersion(), platform: process.platform, arch: process.arch,
  watch: watchLaunchWork({ childProcess, sync: syncBuiltinESMExports, fetchOwners: [globalThis, net] }),
});
launchRecord.mark("codeStart");
launchRecord.watchWindows(app);
