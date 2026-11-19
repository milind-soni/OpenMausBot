// This launch's record, made before anything else in the main process runs so the first mark is our code starting.
import { app, net } from "electron";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

import { watchLaunchWork } from "./launch-probes.mjs";
import { createLaunchRecord } from "./launch-record.mjs";

// Electron: process.getCreationTime() is null when the OS will not say; this module's own start stands in.
const processStart = process.getCreationTime() ?? performance.timeOrigin;

export const launchRecord = createLaunchRecord({
  processStart, appVersion: app.getVersion(), platform: process.platform, arch: process.arch,
  watch: watchLaunchWork({ childProcess, sync: syncBuiltinESMExports, fetchOwners: [globalThis, net] }),
});
// A launch whose record is not written by then (no server came up) stops being counted.
setTimeout(() => launchRecord.giveUp(), 120_000).unref();
launchRecord.mark("codeStart");
launchRecord.watchWindows(app);
