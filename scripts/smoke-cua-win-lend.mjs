// Windows lend smoke: computer control starts as the installed app starts it, then a Cloud takes its first look at
// this PC through the lend path, both in Electron's main process. Run after `pnpm build:cua:win`. It reads the
// screen's size and the list of apps and sends no input.
//
// Electron reports app.isPackaged from its executable's name (anything but electron.exe), and process.resourcesPath
// is the resources folder beside the executable, so a renamed copy of Electron with the staged files placed where
// electron-builder.yml puts them runs electron/cua.mjs's packaged branch unchanged.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.error("smoke-cua-win-lend is Windows-only");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const builder = readFileSync(join(root, "electron-builder.yml"), "utf8");
const winSection = /^win:\n([\s\S]*?)^\S/m.exec(builder)?.[1] ?? "";
const resources = [...winSection.matchAll(/- from: (dist-native\/cua-win32-x64\/\S+)\s+to: (\S+)/g)].map(([, from, to]) => ({ from, to }));
if (resources.length < 3) throw new Error("electron-builder.yml no longer names the Windows CUA resources this smoke places");
for (const { from } of resources) {
  if (!existsSync(join(root, from))) throw new Error(`${from} is missing: run pnpm build:cua:win first`);
}

const work = mkdtempSync(join(tmpdir(), "omb-cua-lend-"));
const installed = join(work, "OpenMausBot");
cpSync(dirname(createRequire(import.meta.url)("electron")), installed, { recursive: true });
renameSync(join(installed, "electron.exe"), join(installed, "OpenMausBot.exe"));
for (const { from, to } of resources) cpSync(join(root, from), join(installed, "resources", to), { recursive: true });

const report = join(work, "report.json");
const env = { ...process.env, OMB_SMOKE_USER_DATA: join(work, "user-data"), OMB_SMOKE_REPORT: report, CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" };
delete env.CUA_DRIVER_PATH;
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(join(installed, "OpenMausBot.exe"), [join(root, "scripts", "smoke-cua-win-lend.electron.cjs")], {
  env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
});
const watchdog = setTimeout(() => {
  console.error("smoke:cua-win-lend timed out");
  spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}, 150_000);
const code = await new Promise((resolve) => {
  child.once("error", (error) => { console.error(error); resolve(1); });
  child.once("exit", (exitCode) => resolve(exitCode ?? 1));
});
clearTimeout(watchdog);
if (existsSync(report)) console.log(`report: ${readFileSync(report, "utf8")}`);
else console.error("the Electron side wrote no report");
process.exit(existsSync(report) ? code : 1);
