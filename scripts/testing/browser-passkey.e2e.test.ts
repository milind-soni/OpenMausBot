// A passkey step in a bot's browser on today's engine (agent-browser), started as the server starts it: through the
// generated launcher and the identity connection, headless. The step's request must end at once, as a dismissed passkey
// sheet does, so the page's own "Try another way" works. Runs where browser-identity.e2e.test.ts runs.
import { mkdtempSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { FixtureServer } from "../../server/browser/cdp/testing/fixtures.ts";
import { ChromeLauncher } from "../../server/browser/chrome/launcher.ts";
import { chromeHost, installedGoogleChrome, isHeadlessShell } from "../../server/browser/chrome/resolve.ts";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { openOwnPageAsBot, withBotBrowser, type BotCall } from "../verify-browser-identity.ts";
import { ensureUiBrowser, UI_TOOLS_DIR } from "./control-omb-ui.ts";

const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.log("skipping browser passkey e2e: no agent-browser binary resolves; set OMB_UI_E2E=1 to install the pinned release");
const out = mkdtempSync(join(tmpdir(), "omb-passkey-e2e-"));
const home = userInfo().homedir;
const machineEnv = { ...process.env, HOME: home, USERPROFILE: home };
let preserveOutput = false;

/** The step's request, and what the page shows once it ends. WebAuthn needs a registrable RP ID: localhost, not 127.0.0.1. */
const PASSKEY_STEP = `<!doctype html><meta charset="utf-8"><title>Sign in - Google Accounts</title><h1>Verifying it’s you</h1>
<p>Complete sign-in using your passkey</p><a id="other" href="/v3/signin/challenge/selection">Try another way</a><p id="state">Waiting…</p>
<script>
  const state = document.getElementById("state");
  navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: "localhost", userVerification: "required", timeout: 300000 } })
    .then(() => { state.textContent = "Signed in"; }, (error) => { state.textContent = "Something went wrong: " + error.name; });
</script>`;

afterAll(async () => {
  if (preserveOutput) console.error(`browser passkey diagnostics retained at ${out}`);
  else await removeTempDir(out);
});

function text(result: unknown): string {
  const answer = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | null;
  if (!answer || answer.isError) throw new Error(`the tool call failed: ${JSON.stringify(result).slice(0, 300)}`);
  return (answer.content ?? []).map((part) => part.text ?? "").join("\n");
}

async function pageSays(call: BotCall, expression: string, wanted: (value: string) => boolean, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = text(await call("agent_browser_eval", { script: expression }));
    if (wanted(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(!enabled)("a passkey step in a bot's headless browser on agent-browser", () => {
  let fx: FixtureServer;
  beforeAll(async () => {
    fx = await FixtureServer.start();
    fx.page("/v3/signin/challenge/pk/presend", PASSKEY_STEP);
    fx.page("/v3/signin/challenge/selection", `<!doctype html><title>Sign in - Google Accounts</title><h1>Choose how you want to sign in</h1>`);
  });
  afterAll(async () => { await fx?.close(); });

  it("ends the passkey request at once, so Try another way opens the other ways", async () => {
    const picked = process.env.OMB_CHROME_PATH?.trim() || (() => {
      const plan = new ChromeLauncher({ dataDir: out, env: machineEnv, engine: () => ({ managed: true }), log: () => {} }).plan();
      return plan.kind === "chrome" ? plan.chrome.path : null;
    })();
    const engine = picked ? resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }) : null;
    const browser = engine ? { binary: engine, chrome: picked } : await ensureUiBrowser(process.env, () => {}, UI_TOOLS_DIR);
    const chrome = picked || browser.chrome || installedGoogleChrome(chromeHost({ dataDir: out, env: machineEnv }));
    if (!chrome || isHeadlessShell(chrome)) throw new Error(`a full Chrome is needed, not ${chrome ?? "nothing"}: set OMB_CHROME_PATH`);
    try {
      const log = (line: string) => console.error(line);
      await withBotBrowser({ engine: browser.binary, chrome, out, sessionPrefix: "omb-pk-e2e", log }, async (call) => {
        expect(await openOwnPageAsBot(call, fx.crossSiteUrl("/v3/signin/challenge/pk/presend"), log)).toBeNull();
        expect(await pageSays(call, "document.getElementById('state').textContent", (state) => !state.includes("Waiting"))).toContain("Something went wrong: NotAllowedError");
        await call("agent_browser_click", { selector: "#other" });
        expect(await pageSays(call, "location.pathname", (path) => path.includes("selection"))).toContain("/v3/signin/challenge/selection");
      });
    } catch (error) {
      preserveOutput = true;
      throw error;
    }
  }, 240_000);
});
