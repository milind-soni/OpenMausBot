// Runs the hand-off in a real Electron process (terminal-launch.test.mjs fakes the runner); a recording script on PATH is the terminal.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const electron = require("electron");
const fixture = fileURLToPath(new URL("./fixtures/updater-handoff.cjs", import.meta.url));

const xvfb =
  process.platform === "linux" && !process.env.DISPLAY
    ? spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout.trim()
    : "";
// The clipboard is an X11 selection on Linux, so this needs a display.
const canRun = process.platform === "linux" && (Boolean(process.env.DISPLAY) || Boolean(xvfb));

function runFixture() {
  const [command, args] = xvfb
    ? [xvfb, ["-a", electron, "--no-sandbox", fixture]]
    : [electron, ["--no-sandbox", fixture]];
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

it.runIf(canRun)(
  "copies the install command and launches a terminal for real",
  async () => {
    const result = await runFixture();
    const diagnostics = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

    expect(result.code, diagnostics).toBe(0);
    expect(result.stdout, diagnostics).toContain("fixture-complete");

    expect(result.stdout, diagnostics).toContain("clipboard-holds-the-install-command");
    expect(result.stdout, diagnostics).toContain("hand-off-returned-the-command");

    expect(result.stdout, diagnostics).toContain("terminal-really-launched");
    expect(result.stdout, diagnostics).toContain("hand-off-reported-the-terminal");

    expect(result.stdout, diagnostics).toContain("no-terminal-is-reported-honestly");
    expect(result.stdout, diagnostics).toContain("clipboard-written-even-without-a-terminal");

    expect(result.stdout, diagnostics).toContain("missing-download-is-reported");
    expect(result.stdout, diagnostics).toContain("vanished-download-is-reported");
  },
  90_000,
);
