// Prove the secure collaboration entry point is bundled, starts without
// node_modules, exposes health with DingTalk disabled, and honors SIGTERM.
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = mkdtempSync(join(tmpdir(), "omb-collaboration-smoke-"));
const home = mkdtempSync(join(tmpdir(), "omb-collaboration-home-"));
const healthData = join(home, "health-data");
const serviceData = join(home, "service-data");
let serviceChild = null;

const minimalEnvironment = (dataDirectory) => ({
  ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  HOME: home,
  USERPROFILE: home,
  OMB_DATA_DIR: dataDirectory,
  OMB_DINGTALK_ENABLED: "0",
});

const cleanup = () => {
  if (serviceChild?.exitCode === null) serviceChild.kill("SIGKILL");
  for (const directory of [staging, home]) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Scratch cleanup must not hide the actual packaging assertion.
    }
  }
};

try {
  await execFileAsync(process.execPath, [join(root, "scripts", "bundle-server.mjs")], {
    cwd: root,
    timeout: 120_000,
  });

  cpSync(process.env.OMB_SMOKE_DIST ?? join(root, "dist-server"), join(staging, "server"), { recursive: true });
  // Node resolves import.meta.url through macOS' /var -> /private/var alias.
  // Use the canonical path so the entry point's direct-execution guard holds.
  const entry = realpathSync(join(staging, "server", "collaboration-headless.js"));

  const health = await execFileAsync(process.execPath, [entry, "--health", "--data-dir", healthData], {
    cwd: staging,
    env: minimalEnvironment(healthData),
    timeout: 20_000,
  });
  const healthLines = health.stdout.trim().split(/\r?\n/).filter(Boolean);
  const report = JSON.parse(healthLines.at(-1) ?? "null");
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("packaged --health did not emit a JSON object");
  }
  if (typeof report.ready !== "boolean" || (typeof report.status !== "string" && typeof report.state !== "string")) {
    throw new Error("packaged --health omitted readiness or lifecycle state");
  }
  const serialized = JSON.stringify(report);
  if (/clientSecret|clientId|accessToken|refreshToken|backupKey/i.test(serialized)) {
    throw new Error("packaged health exposed a secret-bearing field");
  }

  const child = execFile(process.execPath, [entry, "--data-dir", serviceData], {
    cwd: staging,
    env: minimalEnvironment(serviceData),
    timeout: 30_000,
  });
  serviceChild = child;
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));

  const startedDeadline = Date.now() + 15_000;
  while (Date.now() < startedDeadline && child.exitCode === null && !output.includes("\n")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (child.exitCode !== null || !output.includes("\n")) {
    throw new Error(`disabled-Stream service did not stay running: ${output.trim() || "no output"}`);
  }
  const startupReport = JSON.parse(output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "null");
  if (!startupReport || typeof startupReport !== "object") {
    throw new Error("disabled-Stream service did not emit startup health JSON");
  }

  await new Promise((resolve) => setTimeout(resolve, 250));
  if (child.exitCode !== null) throw new Error(`disabled-Stream service exited early with ${child.exitCode}`);
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("packaged service did not exit within 15 seconds of SIGTERM"));
    }, 15_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.kill("SIGTERM");
  });
  if (exit.code !== 0) throw new Error(`packaged service SIGTERM exit was not clean: ${JSON.stringify(exit)}`);

  console.log("packaged collaboration health is JSON and secret-free ✓");
  console.log("packaged disabled-Stream service stayed live and exited cleanly on SIGTERM ✓");
} finally {
  cleanup();
}
