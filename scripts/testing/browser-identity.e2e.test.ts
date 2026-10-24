// agent-browser drives the Chrome OMB resolves, through the generated launcher and the identity connection, as the server
// does. Runs when agent-browser resolves (tools directory, OMB_AGENT_BROWSER_PATH or PATH) or OMB_UI_E2E=1 asks for the
// download. The Chrome is OMB_CHROME_PATH, else the one OMB picks on this machine (an installed Google Chrome), else the
// Chrome for Testing agent-browser installs into the tools directory, else an installed Google Chrome that policies manage
// (agent-browser installs nothing where it finds one, as on GitHub's Windows runners).
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { agentBrowserIntegration, browserSessionsDirectory, resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { ChromeLauncher } from "../../server/browser/chrome/launcher.ts";
import { chromeHost, installedGoogleChrome, isHeadlessShell } from "../../server/browser/chrome/resolve.ts";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { browserFixtureEnvironment, openIdentityProbePage, verifyBrowserIdentity } from "../verify-browser-identity.ts";
import { expectedUserAgent } from "./browser-identity-probe.ts";
import { ensureUiBrowser, UI_TOOLS_DIR } from "./control-omb-ui.ts";

const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.log(`skipping browser identity e2e: no agent-browser binary resolves (looked in ${UI_TOOLS_DIR}, OMB_AGENT_BROWSER_PATH and PATH); set OMB_UI_E2E=1 to install the pinned release`);
const out = mkdtempSync(join(tmpdir(), "omb-identity-e2e-"));
let preserveOutput = false;
afterAll(async () => {
  if (preserveOutput) {
    console.error(`browser identity diagnostics retained at ${out}`);
    return;
  }
  await removeTempDir(out);
});

const fixtureEnv = browserFixtureEnvironment(out, process.platform);
const home = fixtureEnv.HOME!;
for (const path of Object.values(fixtureEnv)) if (path && path !== home) mkdirSync(path, { recursive: true, mode: 0o700 });
mkdirSync(home, { recursive: true });
const machineEnv = { ...process.env };

describe("browser identity fixture isolation", () => {
  it("keeps agent-browser state disposable while Chrome may use the macOS keychain", () => {
    const scratch = join("fixture", "run");
    expect(browserFixtureEnvironment(scratch, "win32")).toEqual({
      HOME: join(scratch, "home"), USERPROFILE: join(scratch, "home"),
      APPDATA: join(scratch, "home", "AppData", "Roaming"), LOCALAPPDATA: join(scratch, "home", "AppData", "Local"),
    });
    expect(browserFixtureEnvironment(scratch, "linux")).toEqual({
      HOME: join(scratch, "home"), XDG_CONFIG_HOME: join(scratch, "home", ".config"),
      USERPROFILE: join(scratch, "home"), XDG_CACHE_HOME: join(scratch, "home", ".cache"), XDG_RUNTIME_DIR: join(scratch, "runtime"),
    });
    const macFixtureEnv = browserFixtureEnvironment(scratch, "darwin");
    expect(macFixtureEnv).toEqual({ HOME: join(scratch, "home"), USERPROFILE: join(scratch, "home") });

    const integration = agentBrowserIntegration({
      binaryPath: "agent-browser", session: "fixture", encryptionKey: "a".repeat(64), persistent: false,
      platform: "darwin", env: macFixtureEnv, launcher: { AGENT_BROWSER_EXECUTABLE_PATH: "fixture-launcher" },
    });
    expect(browserSessionsDirectory(macFixtureEnv)).toBe(join(scratch, "home", ".agent-browser", "sessions"));
    expect(integration.env.AGENT_BROWSER_CONFIG).toBe(join(scratch, "home", ".agent-browser", "omb-managed-config.json"));
    expect(integration.env.AGENT_BROWSER_CONFIG).not.toContain("real-home");
  });

  it("keeps Windows Chrome discovery on the host app-data path while fixture app-data stays isolated", () => {
    const scratch = join("fixture", "run");
    const hostLocalAppData = win32.join(scratch, "host-local");
    const hostEnv = {
      LOCALAPPDATA: hostLocalAppData,
      USERPROFILE: win32.join(scratch, "host-user"),
      ProgramFiles: win32.join(scratch, "missing-program-files"),
      "ProgramFiles(x86)": win32.join(scratch, "missing-program-files-x86"),
    };
    const chromePath = win32.join(hostLocalAppData, "Google", "Chrome", "Application", "chrome.exe");
    const host = chromeHost({ dataDir: scratch, env: hostEnv, platform: "win32", arch: "x64" });
    host.exists = (candidate) => candidate === chromePath;
    host.registryValue = () => null;
    host.registryKeyExists = () => false;
    const fixtureEnv = browserFixtureEnvironment(scratch, "win32");
    const plan = new ChromeLauncher({ dataDir: scratch, env: hostEnv, host, platform: "win32", arch: "x64", engine: () => ({ managed: true }), log: () => {} }).plan();

    expect(fixtureEnv.LOCALAPPDATA).not.toBe(hostEnv.LOCALAPPDATA);
    expect(plan.kind).toBe("chrome");
    if (plan.kind === "chrome") expect(plan.chrome).toEqual({ path: chromePath, source: "installed" });
  });

  it("repeats only one first probe navigation rejected with ERR_ABORTED and retains the last tool result", async () => {
    const opened = { content: [{ type: "text", text: "opened" }] };
    const aborted = { isError: true, content: [{ type: "text", text: "Navigation failed: net::ERR_ABORTED" }] };
    const normal = vi.fn().mockResolvedValueOnce(opened);
    await expect(openIdentityProbePage(normal, "http://127.0.0.1:1/probe")).resolves.toEqual({ kind: "opened", attempts: 1, result: opened });
    expect(normal).toHaveBeenCalledTimes(1);

    const recovered = vi.fn().mockResolvedValueOnce(aborted).mockResolvedValueOnce(opened);
    await expect(openIdentityProbePage(recovered, "http://127.0.0.1:1/probe")).resolves.toEqual({ kind: "opened", attempts: 2, result: opened });
    expect(recovered).toHaveBeenCalledTimes(2);

    const persistent = vi.fn().mockResolvedValueOnce(aborted).mockResolvedValueOnce(aborted);
    await expect(openIdentityProbePage(persistent, "http://127.0.0.1:1/probe")).resolves.toEqual({ kind: "failed", attempts: 2, result: aborted, detail: "Navigation failed: net::ERR_ABORTED" });
    expect(persistent).toHaveBeenCalledTimes(2);

    const unrelated = { isError: true, content: [{ type: "text", text: "Navigation failed: net::ERR_CONNECTION_REFUSED" }] };
    const rejected = vi.fn().mockResolvedValueOnce(unrelated);
    await expect(openIdentityProbePage(rejected, "http://127.0.0.1:1/probe")).resolves.toEqual({ kind: "failed", attempts: 1, result: unrelated, detail: "Navigation failed: net::ERR_CONNECTION_REFUSED" });
    expect(rejected).toHaveBeenCalledTimes(1);
  });
});

/** What OMB would run here for its own engine, read without starting anything. */
function chromeOmbPicks(): string | null {
  const plan = new ChromeLauncher({ dataDir: out, env: machineEnv, engine: () => ({ managed: true }), log: () => {} }).plan();
  return plan.kind === "chrome" ? plan.chrome.path : null;
}

describe.skipIf(!enabled)("a bot's browser on a real Chrome", () => {
  it("opens a page 1280x720 inside whose user agent is Chrome's own, byte for byte, with the same complete client hints in the page, a worker, a service worker and a cross-site frame", async () => {
    const picked = process.env.OMB_CHROME_PATH?.trim() || chromeOmbPicks();
    const engine = picked ? resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }) : null;
    const browser = engine ? { binary: engine, chrome: picked } : await ensureUiBrowser(process.env, () => {}, UI_TOOLS_DIR);
    const chrome = picked || browser.chrome || installedGoogleChrome(chromeHost({ dataDir: out, env: machineEnv }));
    if (!chrome || isHeadlessShell(chrome)) throw new Error(`a full Chrome is needed, not ${chrome ?? "nothing"}: set OMB_CHROME_PATH`);
    console.log(`browser identity e2e: agent-browser ${browser.binary}, Chrome ${chrome}`);
    try {
      const { readout } = await verifyBrowserIdentity({ engine: browser.binary, chrome, out, sessionPrefix: "omb-id-e2e", log: (line) => console.error(line) });
      const failed = readout.checks.filter((check) => !check.pass).map((check) => `${check.check}: ${check.detail}`);
      expect(failed).toEqual([]);
      const page = readout.reports.page!;
      const major = String(page.high?.uaFullVersion).split(".")[0]!;
      expect(page.ua).toBe(expectedUserAgent(major));
      expect(page.ua).toContain("(KHTML, like Gecko) Chrome/");
      expect(page.inner).toEqual([1280, 720]);
      for (const place of [readout.reports.worker, readout.reports.serviceworker, readout.reports.frame]) {
        expect(place?.ua).toBe(page.ua);
        expect(place?.high).toEqual(page.high);
      }
      expect(readout.reports.headers.document?.["user-agent"]).toBe(page.ua);
      expect(readout.reports.headers.document?.["sec-ch-ua"]).not.toMatch(/Headless/u);
    } catch (error) {
      preserveOutput = true;
      throw error;
    }
  }, 240_000);
});
