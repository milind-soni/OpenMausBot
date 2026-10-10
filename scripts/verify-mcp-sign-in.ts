// Real MCP panel + server + fake OAuth provider, only in a disposable workspace.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { ensureUiBrowser } from "./testing/control-omb-ui.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";
import { startFakeOAuth } from "../server/testing/fake-oauth-server.ts";
import { startFakeHttpMcp } from "../server/testing/fake-http-mcp-server.ts";

const fixture = await launchVerificationServer();
let oauth: Awaited<ReturnType<typeof startFakeOAuth>> | undefined;
let mcp: Awaited<ReturnType<typeof startFakeHttpMcp>> | undefined;
let ui: MountedPreview | undefined;
let closeBrowser: (() => Promise<unknown>) | undefined;
let releaseToken!: () => void;
const tokenPending = new Promise<void>((resolve) => { releaseToken = resolve; });
try {
  oauth = await startFakeOAuth({ beforeToken: () => tokenPending });
  mcp = await startFakeHttpMcp({ acceptBearer: oauth.isValid, wwwAuthenticate: oauth.challenge });
  const api = fixtureApi(fixture.info.url);
  await runControlOmb(["doctor", "--url", fixture.info.url]);
  await api("POST", "/api/mcp/servers", { name: "documents", url: mcp.url });
  await api("POST", "/api/mcp/servers/documents/test");
  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  let authorizationUrl = "";
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/mcp-sign-in-preview.tsx", route: "/__mcp-sign-in.html", title: "MCP sign-in fixture",
    extraRoutes: [{
      path: "/api/mcp/servers/documents/sign-in", method: "POST",
      handler: async (req, res) => {
        const response = await fetch(`${fixture.info.url}/api/mcp/servers/documents/sign-in`, {
          method: "POST", headers: { cookie: req.headers.cookie ?? "", "x-forwarded-for": "192.0.2.10" },
        });
        const body = await response.json();
        if (response.ok) {
          authorizationUrl = body.auth.authorizationUrl;
          // The in-process provider uses HTTP; the renderer only opens HTTPS.
          // Stand in for its public login page, without weakening that check.
          body.auth.authorizationUrl = "https://oauth.example.test/authorize";
        }
        res.writeHead(response.status, { "content-type": "application/json" }).end(JSON.stringify(body));
      },
    }],
  });
  const { binary, chrome } = await ensureUiBrowser(process.env);
  const temp = join(fixture.info.dataDir, "browser-tmp");
  mkdirSync(temp, { recursive: true });
  const env = {
    HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, PATH: process.env.PATH,
    TMPDIR: temp, TEMP: temp, TMP: temp, AGENT_BROWSER_SESSION: `mcp-oauth-${process.pid}`,
    AGENT_BROWSER_HEADLESS: "1", AGENT_BROWSER_NO_WEBMCP: "1",
    ...(chrome ? { AGENT_BROWSER_EXECUTABLE_PATH: chrome } : {}),
  };
  const command = async (...args: string[]) => {
    const { stdout } = await promisify(execFile)(binary, [...args, "--json"], { env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const result = JSON.parse(stdout);
    assert.equal(result.success, true, JSON.stringify(result.error));
    return result.data;
  };
  closeBrowser = () => command("close");
  const clickButton = async (name: string) => {
    await command("wait", "--fn", `[...document.querySelectorAll('button')].some(b => b.textContent.trim() === ${JSON.stringify(name)} && !b.disabled)`);
    await command("find", "role", "button", "click", "--name", name, "--exact");
  };
  const evaluate = async (js: string) => (await command("eval", js)).result;
  await command("open", ui.previewUrl);
  assert.equal(await evaluate(`(async () => (await fetch('/api/auth/pair', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:${JSON.stringify(pairing.code)},cookie:true,label:'MCP sign-in fixture'})})).status)()`), 200);
  await command("reload");
  await command("wait", "--fn", "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Sign in')");
  // Simulate a blocked popup; the explicit reopen and paste UI must still work.
  await evaluate("window.open = () => null");
  const evidence = resolve(process.env.OMB_UI_EVIDENCE_DIR ?? ".omb-scratch/mcp-oauth-evidence");
  mkdirSync(evidence, { recursive: true });
  await command("screenshot", join(evidence, "before.png"), "--full");
  await clickButton("Sign in");
  // A remote browser with no https address to return to: the paste box is shown up front.
  await command("wait", "--fn", "document.body.textContent.includes('After you approve, your browser shows a page that can') && document.getElementById('mcp-callback-documents') !== null");
  await command("screenshot", join(evidence, "waiting.png"), "--full");
  await command("fill", "#mcp-callback-documents", "http://127.0.0.1:1/wrong?code=wrong&state=wrong");
  await clickButton("Complete sign-in");
  await command("wait", "--fn", "document.querySelector('[role=alert]') !== null");
  assert.equal(oauth.counts.token, 0);
  const approved = await fetch(authorizationUrl, { redirect: "manual" });
  const callbackUrl = approved.headers.get("location")!;
  await command("fill", "#mcp-callback-documents", callbackUrl);
  await clickButton("Complete sign-in");
  await command("wait", "--fn", "document.querySelector('button[aria-busy=true] .animate-spin') !== null");
  assert.equal(await evaluate("document.querySelector('button[aria-busy=true]').disabled"), true);
  assert.equal(await evaluate("document.getElementById('mcp-callback-documents').value"), callbackUrl);
  await command("screenshot", join(evidence, "authenticating.png"), "--full");
  // Cancel while the completion request is held, then retry before that old
  // request settles. The new form must not inherit the old busy state.
  await clickButton("Cancel");
  await clickButton("Sign in");
  await command("wait", "--fn", "document.body.textContent.includes('After you approve, your browser shows a page that can') && document.getElementById('mcp-callback-documents') !== null");
  const retried = await fetch(authorizationUrl, { redirect: "manual" });
  await command("fill", "#mcp-callback-documents", retried.headers.get("location")!);
  await clickButton("Complete sign-in");
  await command("wait", "--fn", "document.querySelector('button[aria-busy=true] .animate-spin') !== null");
  releaseToken();
  await command("wait", "--fn", "document.body.textContent.includes('Signed in') && !document.getElementById('mcp-callback-documents')");
  assert.equal(oauth.counts.token, 2);
  await clickButton("Test");
  await command("wait", "--fn", "document.body.textContent.includes('read_notes')");
  await command("screenshot", join(evidence, "signed-in.png"), "--full");
  // Revoke the initiating browser while another attempt waits.
  await clickButton("Sign out");
  await clickButton("Test");
  await command("wait", "--fn", "[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Sign in')");
  await clickButton("Sign in");
  await command("wait", "--fn", "document.body.textContent.includes('After you approve, your browser shows a page that can') && document.getElementById('mcp-callback-documents') !== null");
  const pending = await fetch(authorizationUrl, { redirect: "manual" });
  assert.equal(await evaluate("fetch('/api/auth/logout', {method:'POST',headers:{'content-type':'application/json'}}).then(r=>r.status)"), 200);
  await assert.rejects(fetch(pending.headers.get("location")!));
  console.log(JSON.stringify({ ok: true, evidence, tested: ["remote admin start", "blocked popup", "invalid URL retry", "pending spinner and preserved input", "cancel and retry during pending completion", "paste completion", "MCP tools", "logout cancellation"] }));
} finally {
  releaseToken();
  await closeBrowser?.().catch(() => {});
  await ui?.close();
  await fixture.close();
  await mcp?.close();
  await oauth?.close();
}
