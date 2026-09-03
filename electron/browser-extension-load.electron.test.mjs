// Real Electron, real browser surface, real extension loader.
//
// The unit tests around this feature use session doubles, which prove our own
// logic but would happily keep passing if Electron changed how extensions
// load. This one spawns Electron, installs a fixture extension through the
// same state file the server writes, navigates the surface, and checks the
// content script actually reached the page.
//
// It is also the regression test for the finding that motivated the request
// policy seam: without letting a loaded extension's own origin through
// onBeforeRequest, an extension loads and then cannot fetch a single one of
// its own web-accessible resources.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const electron = require("electron");
const fixture = fileURLToPath(new URL("./fixtures/browser-extension-load.cjs", import.meta.url));

// Same gate the other real-Electron fixture uses: Linux CI needs a display
// or xvfb-run, and Windows has no built-in browser surface at all.
const xvfb = process.platform === "linux" && !process.env.DISPLAY
  ? spawnSync("which", ["xvfb-run"], { encoding: "utf8" }).stdout.trim()
  : "";
const canRun = process.platform !== "win32"
  && (process.platform !== "linux" || Boolean(process.env.DISPLAY) || Boolean(xvfb));
const timeoutMs = 60_000;

const runFixture = () => new Promise((resolve, reject) => {
  const command = xvfb || electron;
  const args = xvfb ? ["-a", electron, "--no-sandbox", fixture] : [fixture];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs - 5_000);
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once("exit", () => {
    clearTimeout(timer);
    resolve({
      timedOut,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    });
  });
});

it.skipIf(!canRun)("loads an installed extension into a bot's browser, but never into Guest", async () => {
  const result = await runFixture();
  expect(result.timedOut, result.stderr).toBe(false);
  const line = result.stdout.split("\n").find((candidate) => candidate.startsWith("FIXTURE_RESULT "));
  expect(line, `no result line.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBeTruthy();
  const out = JSON.parse(line.slice("FIXTURE_RESULT ".length));

  expect(out.fatal, out.fatal).toBeUndefined();

  // The coordinator read the server's state file and loaded the extension
  // into the bot's own persistent session.
  expect(out.partition).toBe("persist:openmausbot-browser-fixture-bot");
  expect(out.loadedInSession).toEqual(["OpenMausBot Surface Fixture"]);
  expect(out.sessionHasExtension).toBe(true);

  // The navigation went through the real loadSafe seam, and the content
  // script was registered in time to run on the page it loaded.
  expect(out.navigated).toBe("https://fixture.invalid/");
  expect(out.contentScriptRan).toBe(true);

  // The request-policy seam: the extension can reach its own resources.
  // Without it this reads "failed:Failed to fetch".
  expect(out.webAccessibleResourceFetch).toBe("ok:loaded");

  // Guest is in-memory, so Electron would throw; the coordinator skips it.
  expect(out.guestPartitionIsPersistent).toBe(false);
  expect(out.guestLoadedCount).toBe(0);
}, timeoutMs);
