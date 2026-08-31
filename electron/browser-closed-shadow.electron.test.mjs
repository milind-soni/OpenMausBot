import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, win32 as pathWin32 } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const electron = require("electron");
const fixture = fileURLToPath(new URL("./fixtures/browser-closed-shadow.cjs", import.meta.url));
const xvfb = process.platform === "linux" && !process.env.DISPLAY
  ? spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout.trim()
  : "";
const canRun = process.platform !== "linux" || Boolean(process.env.DISPLAY) || Boolean(xvfb);
const canRunRealElectronFixture = canRun
  && !(process.platform === "win32" && process.env.OMB_SKIP_REAL_ELECTRON_BROWSER_FIXTURE === "1");
const windowsSandboxSid = "S-1-15-2-2";
const fixtureTimeoutMs = 45_000;

function windowsSandboxRootAclCommand(executable) {
  return {
    command: "icacls",
    args: [
      pathWin32.dirname(executable),
      "/grant",
      `*${windowsSandboxSid}:(OI)(CI)(RX)`,
    ],
  };
}

function windowsSandboxSaveAclCommand(executable, aclFile) {
  return {
    command: "icacls",
    args: [
      pathWin32.dirname(executable),
      "/save",
      aclFile,
      "/T",
      "/Q",
      "/C",
    ],
  };
}

function windowsSandboxFileAclCommand(file) {
  return {
    command: "icacls",
    args: [file, "/grant", `*${windowsSandboxSid}:(RX)`, "/Q"],
  };
}

function runWindowsSandboxAclCommand({ command, args }, action) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`Could not ${action}: ${detail}`);
  }
}

function parseWindowsSavedAcls(text, aclRoot) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const records = [];
  for (let index = 0; index < lines.length; index += 2) {
    const savedName = lines[index]?.trim();
    if (!savedName) continue;
    const acl = lines[index + 1]?.trim();
    if (!acl) throw new Error(`Saved Windows ACL for ${savedName} did not include an SDDL record`);
    records.push({
      path: pathWin32.resolve(pathWin32.dirname(aclRoot), savedName),
      acl,
    });
  }
  return records;
}

function readWindowsSavedAcls(aclFile, aclRoot) {
  return parseWindowsSavedAcls(readFileSync(aclFile, "utf16le"), aclRoot);
}

function windowsEntriesMissingSandboxAcl(records) {
  return records
    .filter((record) => !record.acl.includes(windowsSandboxSid))
    .map((record) => record.path);
}

function describeWindowsSandboxAcls(records, executable, repairedFiles) {
  const aclByPath = new Map(records.map((record) => [record.path.toLowerCase(), record.acl]));
  const aclRoot = pathWin32.dirname(executable);
  const describe = (label, file) => `${label}: ${aclByPath.get(file.toLowerCase()) ?? "<not present in saved ACLs>"}`;
  return [
    `files repaired with an explicit ${windowsSandboxSid} RX ACE: ${repairedFiles.length}`,
    describe("Electron dist", aclRoot),
    describe("electron.exe", executable),
    describe("icudtl.dat", pathWin32.join(aclRoot, "icudtl.dat")),
  ].join("\n");
}

// Electron's npm archive is extracted into the runner workspace after install.
// Restore the read/execute ACE that Chromium's restricted Windows children
// require; zip archives cannot carry this filesystem ACL between machines.
function prepareWindowsElectronSandbox(executable) {
  if (process.platform !== "win32") return "not applicable on this platform";
  const aclRoot = pathWin32.dirname(executable);
  const diagnosticDir = mkdtempSync(join(tmpdir(), "openmaus-electron-acl-"));
  const beforeAclFile = join(diagnosticDir, "before.acl");
  const afterAclFile = join(diagnosticDir, "after.acl");
  try {
    // Chromium grants the inheritable ACE to the root first, then repairs
    // hardlinked bot artifacts that did not inherit the directory's DACL.
    runWindowsSandboxAclCommand(
      windowsSandboxRootAclCommand(executable),
      "grant the Electron test directory's Windows sandbox ACL",
    );
    runWindowsSandboxAclCommand(
      windowsSandboxSaveAclCommand(executable, beforeAclFile),
      "inspect the Electron test directory's Windows sandbox ACLs",
    );
    const beforeRecords = readWindowsSavedAcls(beforeAclFile, aclRoot);
    const missingFiles = windowsEntriesMissingSandboxAcl(beforeRecords);
    for (const file of missingFiles) {
      runWindowsSandboxAclCommand(
        windowsSandboxFileAclCommand(file),
        `grant the Electron test file's Windows sandbox ACL (${file})`,
      );
    }
    runWindowsSandboxAclCommand(
      windowsSandboxSaveAclCommand(executable, afterAclFile),
      "verify the Electron test directory's Windows sandbox ACLs",
    );
    const afterRecords = readWindowsSavedAcls(afterAclFile, aclRoot);
    const stillMissing = windowsEntriesMissingSandboxAcl(afterRecords);
    if (stillMissing.length > 0) {
      throw new Error(`Electron test files still lack ${windowsSandboxSid} RX access:\n${stillMissing.join("\n")}`);
    }
    return describeWindowsSandboxAcls(afterRecords, executable, missingFiles);
  } finally {
    rmSync(diagnosticDir, { force: true, recursive: true });
  }
}

it("constructs Chromium-style Windows Electron sandbox ACL commands without a shell", () => {
  const executable = "D:\\a\\OpenMausBot\\node_modules\\electron\\dist\\electron.exe";
  expect(windowsSandboxRootAclCommand(executable)).toEqual({
    command: "icacls",
    args: [
      "D:\\a\\OpenMausBot\\node_modules\\electron\\dist",
      "/grant",
      "*S-1-15-2-2:(OI)(CI)(RX)",
    ],
  });
  expect(windowsSandboxSaveAclCommand(executable, "D:\\temp\\electron.acl")).toEqual({
    command: "icacls",
    args: [
      "D:\\a\\OpenMausBot\\node_modules\\electron\\dist",
      "/save",
      "D:\\temp\\electron.acl",
      "/T",
      "/Q",
      "/C",
    ],
  });
  expect(windowsSandboxFileAclCommand(executable)).toEqual({
    command: "icacls",
    args: [executable, "/grant", "*S-1-15-2-2:(RX)", "/Q"],
  });
});

it("finds hardlinked Windows Electron files that missed the inherited sandbox ACL", () => {
  const aclRoot = "D:\\a\\OpenMausBot\\node_modules\\electron\\dist";
  const records = parseWindowsSavedAcls([
    "dist",
    "D:AI(A;OICI;0x1200a9;;;S-1-15-2-2)",
    "dist\\electron.exe",
    "D:AI(A;ID;FA;;;BA)",
    "dist\\icudtl.dat",
    "D:AI(A;ID;0x1200a9;;;S-1-15-2-2)",
    "",
  ].join("\r\n"), aclRoot);
  expect(windowsEntriesMissingSandboxAcl(records)).toEqual([
    "D:\\a\\OpenMausBot\\node_modules\\electron\\dist\\electron.exe",
  ]);
});

it.runIf(canRunRealElectronFixture)("protects closed-shadow values and revalidates real Electron ref actions", async () => {
  const sandboxAclDiagnostics = prepareWindowsElectronSandbox(electron);
  const command = xvfb || electron;
  const args = xvfb
    ? ["-a", electron, "--no-sandbox", fixture]
    : [fixture];
  const diagnosticDir = process.platform === "win32"
    ? mkdtempSync(join(tmpdir(), "openmaus-electron-log-"))
    : null;
  const chromiumLogFile = diagnosticDir ? join(diagnosticDir, "chromium.log") : null;
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  if (chromiumLogFile) {
    // Electron documents file logging as the reliable way to collect native
    // Chromium child-process diagnostics on Windows; stderr cannot carry them.
    childEnv.ELECTRON_ENABLE_LOGGING = "true";
    childEnv.ELECTRON_LOG_FILE = chromiumLogFile;
  }
  let result;
  let chromiumLog = chromiumLogFile ? "<not created>" : "not enabled on this platform";
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, fixtureTimeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({
          code,
          signal,
          timedOut,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
    if (chromiumLogFile && existsSync(chromiumLogFile)) chromiumLog = readFileSync(chromiumLogFile, "utf8");
  } finally {
    if (diagnosticDir) rmSync(diagnosticDir, { force: true, recursive: true });
  }
  const diagnostics = [
    `Electron exit code: ${result.code}; signal: ${result.signal ?? "none"}`,
    `Fixture deadline exceeded: ${result.timedOut}`,
    `stdout:\n${result.stdout || "<empty>"}`,
    `stderr:\n${result.stderr || "<empty>"}`,
    `Chromium log:\n${chromiumLog || "<empty>"}`,
    `Windows sandbox ACLs:\n${sandboxAclDiagnostics}`,
  ].join("\n");
  expect(result, diagnostics).toMatchObject({ code: 0, signal: null, timedOut: false });
  expect(result.stdout).toContain("sandboxed-preload-bridge-loaded");
  expect(result.stdout).toContain("compact-viewport-stable-after-navigation");
  expect(result.stdout).toContain("closed-shadow-screenshot-refused");
  expect(result.stdout).toContain("closed-shadow-nested-name-source-redacted");
  expect(result.stdout).toContain("transformed-secret-taint");
  expect(result.stdout).toContain("rich-nested-name-source-redacted");
  expect(result.stdout).toContain("compact-known-coordinate-click");
  expect(result.stdout).toContain("compact-known-coordinate-scroll");
  expect(result.stdout).toContain("expanded-known-coordinate-click");
  expect(result.stdout).toContain("expanded-known-coordinate-scroll");
  expect(result.stdout).toContain("real-double-click-sequence");
  expect(result.stdout).toContain("fixed-screenshot-pixel-size");
  expect(result.stdout).toContain("protected-focused-keys-refused");
  expect(result.stdout).toContain("late-overlay-click-refused");
  expect(result.stdout).toContain("relabelled-ref-refused");
  expect(result.stdout).toContain("root-scroll-lock-preserved");
}, 60_000);
