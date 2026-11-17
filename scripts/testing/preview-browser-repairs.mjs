// Runs focused browser regressions without using Studio's live profile/data.
import electron from "electron";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const profile = mkdtempSync(join(tmpdir(), "gbs-preview-repairs-"));
const child = spawn(electron, [fileURLToPath(new URL("./preview-browser-repairs-desktop.mjs", import.meta.url))], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, GBS_QA_USER_DATA: profile } });
const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("close", code => { clearTimeout(timer); rmSync(profile, { recursive: true, force: true }); process.exitCode = code ?? 1; });
