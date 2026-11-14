// agent-browser drives the Chrome OMB resolves, through the generated launcher and the identity connection, as the server
// does. Runs when agent-browser resolves (tools directory, OMB_AGENT_BROWSER_PATH or PATH) or OMB_UI_E2E=1 asks for the
// download. The Chrome is OMB_CHROME_PATH, else the one OMB picks on this machine (an installed Google Chrome), else the
// Chrome for Testing agent-browser installs into the tools directory, else an installed Google Chrome that policies manage
// (agent-browser installs nothing where it finds one, as on GitHub's Windows runners).
import { mkdtempSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { connectCdp } from "../../server/browser-sites.ts";
import { ChromeLauncher } from "../../server/browser/chrome/launcher.ts";
import { chromeHost, installedGoogleChrome, isHeadlessShell } from "../../server/browser/chrome/resolve.ts";
import { IdentitySidecars, startIdentitySidecar } from "../../server/browser/chrome/sidecar.ts";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { verifyBrowserIdentity } from "../verify-browser-identity.ts";
import { expectedUserAgent } from "./browser-identity-probe.ts";
import { ensureUiBrowser, UI_TOOLS_DIR } from "./control-omb-ui.ts";

const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.log(`skipping browser identity e2e: no agent-browser binary resolves (looked in ${UI_TOOLS_DIR}, OMB_AGENT_BROWSER_PATH and PATH); set OMB_UI_E2E=1 to install the pinned release`);
const out = mkdtempSync(join(tmpdir(), "omb-identity-e2e-"));
afterAll(async () => { await removeTempDir(out); });

const home = userInfo().homedir;
const machineEnv = { ...process.env, HOME: home, USERPROFILE: home };

/** What OMB would run here for its own engine, read without starting anything. */
function chromeOmbPicks(): string | null {
  const plan = new ChromeLauncher({ dataDir: out, env: machineEnv, engine: () => ({ managed: true }), log: () => {} }).plan();
  return plan.kind === "chrome" ? plan.chrome.path : null;
}

/** The agent-browser and the full Chrome this machine would use. */
async function realBrowser(): Promise<{ engine: string; chrome: string }> {
  const picked = process.env.OMB_CHROME_PATH?.trim() || chromeOmbPicks();
  const engine = picked ? resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }) : null;
  const browser = engine ? { binary: engine, chrome: picked } : await ensureUiBrowser(process.env, () => {}, UI_TOOLS_DIR);
  const chrome = picked || browser.chrome || installedGoogleChrome(chromeHost({ dataDir: out, env: machineEnv }));
  if (!chrome || isHeadlessShell(chrome)) throw new Error(`a full Chrome is needed, not ${chrome ?? "nothing"}: set OMB_CHROME_PATH`);
  console.log(`browser identity e2e: agent-browser ${browser.binary}, Chrome ${chrome}`);
  return { engine: browser.binary, chrome };
}

/** The real connection, with a page's or a frame's override answered late, as on a busy machine. */
const slowOverride = (lateMs: number): typeof connectCdp => async (url, timeoutMs, listeners = {}) => {
  const types = new Map<string, string>();
  const cdp = await connectCdp(url, timeoutMs, { ...listeners, event(message) {
    if (message.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = (message.params ?? {}) as { sessionId?: string; targetInfo?: { type?: string } };
      if (sessionId) types.set(sessionId, targetInfo?.type ?? "");
    }
    listeners.event?.(message);
  } });
  return {
    send: async (method, params, sessionId) => {
      if (method === "Emulation.setUserAgentOverride" && sessionId && ["page", "iframe"].includes(types.get(sessionId) ?? "")) await new Promise((resolve) => setTimeout(resolve, lateMs));
      return cdp.send(method, params, sessionId);
    },
    close: () => cdp.close(),
  };
};

describe.skipIf(!enabled)("a bot's browser on a real Chrome", () => {
  it("opens a page 1280x720 inside whose user agent is Chrome's own, byte for byte, with the same complete client hints in the page, a worker, a service worker and a cross-site frame", async () => {
    const { engine, chrome } = await realBrowser();
    const { readout } = await verifyBrowserIdentity({ engine, chrome, out, sessionPrefix: "omb-id-e2e" });
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
  }, 240_000);

  it("gives the first page the same complete client hints when the identity is slow to land", async () => {
    const { engine, chrome } = await realBrowser();
    const sidecars = new IdentitySidecars({ start: (url, identity, _connect, options) => startIdentitySidecar(url, identity, slowOverride(600), options) });
    const { readout } = await verifyBrowserIdentity({ engine, chrome, out, sessionPrefix: "omb-id-slow", sidecars });
    expect(readout.checks.filter((check) => !check.pass).map((check) => `${check.check}: ${check.detail}`)).toEqual([]);
  }, 240_000);
});
