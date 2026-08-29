import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { win32 as pathWin32 } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const electron = require("electron");
const fixture = fileURLToPath(new URL("./fixtures/browser-closed-shadow.cjs", import.meta.url));
const xvfb = process.platform === "linux" && !process.env.DISPLAY
  ? spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout.trim()
  : "";
const canRun = process.platform !== "linux" || Boolean(process.env.DISPLAY) || Boolean(xvfb);

function windowsSandboxAclCommand(executable) {
  return {
    command: "icacls",
    args: [
      pathWin32.dirname(executable),
      "/grant",
      "*S-1-15-2-2:(OI)(CI)(RX)",
      "/T",
      "/C",
      "/Q",
    ],
  };
}

// Electron's npm archive is extracted into the runner workspace after install.
// Restore the read/execute ACE that Chromium's restricted Windows children
// require; zip archives cannot carry this filesystem ACL between machines.
function prepareWindowsElectronSandbox(executable) {
  if (process.platform !== "win32") return;
  const { command, args } = windowsSandboxAclCommand(executable);
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    throw new Error(`Could not grant the Electron test binary's Windows sandbox ACL: ${detail}`);
  }
}

it("constructs the Windows Electron sandbox ACL grant without a shell", () => {
  expect(windowsSandboxAclCommand("D:\\a\\OpenMausBot\\node_modules\\electron\\dist\\electron.exe")).toEqual({
    command: "icacls",
    args: [
      "D:\\a\\OpenMausBot\\node_modules\\electron\\dist",
      "/grant",
      "*S-1-15-2-2:(OI)(CI)(RX)",
      "/T",
      "/C",
      "/Q",
    ],
  });
});

it.runIf(canRun)("protects closed-shadow values and revalidates real Electron ref actions", async () => {
  prepareWindowsElectronSandbox(electron);
  const command = xvfb || electron;
  const args = xvfb
    ? ["-a", electron, "--no-sandbox", fixture]
    : [fixture];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
  const diagnostics = [
    `Electron exit code: ${result.code}; signal: ${result.signal ?? "none"}`,
    `stdout:\n${result.stdout || "<empty>"}`,
    `stderr:\n${result.stderr || "<empty>"}`,
  ].join("\n");
  expect(result, diagnostics).toMatchObject({ code: 0, signal: null });
  expect(result.stdout).toContain("closed-shadow-screenshot-refused");
  expect(result.stdout).toContain("transformed-secret-taint");
  expect(result.stdout).toContain("protected-focused-keys-refused");
  expect(result.stdout).toContain("late-overlay-click-refused");
  expect(result.stdout).toContain("relabelled-ref-refused");
}, 30_000);
