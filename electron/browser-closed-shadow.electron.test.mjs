import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const electron = require("electron");
const fixture = fileURLToPath(new URL("./fixtures/browser-closed-shadow.cjs", import.meta.url));
const xvfb = process.platform === "linux" && !process.env.DISPLAY
  ? spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout.trim()
  : "";
const canRun = process.platform !== "linux" || Boolean(process.env.DISPLAY) || Boolean(xvfb);

it.runIf(canRun)("protects closed-shadow values and revalidates real Electron ref actions", async () => {
  const command = xvfb || electron;
  const args = xvfb
    ? ["-a", electron, "--no-sandbox", fixture]
    : ["--no-sandbox", fixture];
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
  expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
  expect(result.stdout).toContain("closed-shadow-screenshot-refused");
  expect(result.stdout).toContain("transformed-secret-taint");
  expect(result.stdout).toContain("protected-focused-keys-refused");
  expect(result.stdout).toContain("late-overlay-click-refused");
  expect(result.stdout).toContain("relabelled-ref-refused");
}, 30_000);
