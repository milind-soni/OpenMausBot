// Actual Apps modal/card in Chromium, with fake authorize responses only.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./testing/control-omb-ui.ts";
import { mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
let preview: MountedPreview | undefined;
let closeBrowser: (() => Promise<unknown>) | undefined;
let authorizationServer: ReturnType<typeof createServer> | undefined;
let authorizationBase = "";
const visitedAuthorizationPages: string[] = [];
let release!: () => void;
let hold: Promise<void> = Promise.resolve();
let failure = false;
let attempts = 0;
const requestBodies: Array<{ alias?: string }> = [];
const services: Record<string, { connected: boolean; pending: boolean; status: string; accounts: Array<{ id: string; alias: string; status: string }> }> = {};
const evidence = resolve(process.env.OMB_UI_EVIDENCE_DIR ?? ".omb-scratch/connected-apps-evidence");
mkdirSync(evidence, { recursive: true });
const pauseAuthorize = (fail = false) => {
  failure = fail;
  hold = new Promise<void>((done) => { release = done; });
};
try {
  await runControlOmb(["doctor", "--url", fixture.info.url]);
  // All native popups use this dedicated test hostname mapped to loopback.
  // Its ephemeral certificate and ignored trust live only in this fixture.
  const key = join(fixture.info.dataDir, "oauth-fixture.key");
  const certificate = join(fixture.info.dataDir, "oauth-fixture.crt");
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate, "-subj", "/CN=auth.example.test", "-days", "1"]);
  authorizationServer = createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (req, res) => {
    visitedAuthorizationPages.push(req.url!);
    res.setHeader("content-type", "text/html"); res.end("<!doctype html><title>Fixture authorization</title><p>syntheticAuthorization</p>");
  });
  await new Promise<void>((done) => authorizationServer!.listen(0, "127.0.0.1", done));
  const address = authorizationServer.address();
  assert.ok(address && typeof address === "object");
  authorizationBase = `https://auth.example.test:${address.port}`;
  preview = await mountPreview(fixture, {
    entry: "/scripts/testing/connected-apps-preview.tsx", route: "/__connected-apps.html", title: "Connected Apps OAuth fixture",
    extraRoutes: [
      { path: "/api/connectors/catalog", handler: (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ configured: true, mode: "self-hosted", source: "api", cards: ["gmail", "slack"].map((slug) => ({ slug, label: slug === "gmail" ? "Gmail" : "Slack", blurb: "Synthetic account", logo: null, domain: null })) }));
      } },
      { path: /^\/api\/connectors(?:\/connected)?$/, handler: (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ services }));
      } },
      { path: /^\/api\/(?:connectors\/(?:gmail|slack)|bots\/fixture-bot\/connector-cards\/connector-\d+)\/authorize$/, method: "POST", handler: async (req, res) => {
        const attempt = ++attempts;
        const failed = failure;
        let text = "";
        for await (const part of req) text += String(part);
        const body: { alias?: string } = text ? JSON.parse(text) : {};
        requestBodies.push(body);
        const slug = req.url?.startsWith("/api/connectors/") ? req.url.split("/")[3]! : null;
        if (!failed && slug) services[slug] = {
          connected: false, pending: true, status: "INITIALIZING",
          accounts: [...(services[slug]?.accounts ?? []), { id: `ca-${attempt}`, alias: body.alias ?? `omb-retry-${attempt}`, status: "INITIALIZING" }],
        };
        await hold;
        res.writeHead(failed ? 503 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify(failed ? { error: "Synthetic authorization outage" } : { url: `${authorizationBase}/authorize?attempt=${attempt}` }));
      } },
      { path: /^\/api\/bots\/fixture-bot\/connector-cards\/connector-\d+\/status$/, handler: (_req, res) => {
        res.setHeader("content-type", "application/json"); res.end('{"connected":false}');
      } },
    ],
  });
  const browser = await ensureUiBrowser();
  mkdirSync(join(fixture.info.dataDir, "tmp"), { recursive: true });
  const env = { ...sessionEnv({ home: fixture.info.dataDir, session: `ca${process.pid}`, chrome: browser.chrome }), AGENT_BROWSER_SOCKET_DIR: join(fixture.info.dataDir, "ab"), AGENT_BROWSER_ARGS: "--host-resolver-rules=MAP auth.example.test 127.0.0.1", AGENT_BROWSER_IGNORE_HTTPS_ERRORS: "1" };
  const command = (...args: string[]) => agentBrowser(browser.binary, env, args);
  closeBrowser = () => command("close");
  const evaluate = async (js: string) => (await command("eval", js)).result;
  const wait = async (js: string) => {
    try { return await command("wait", "--fn", js); }
    catch (error) {
      const state = { waitingFor: js, tabs: await command("tab", "list"), snapshot: await command("snapshot") };
      writeFileSync(join(evidence, "failure.json"), JSON.stringify(state, null, 2));
      await command("screenshot", join(evidence, "failure.png"), "--full");
      throw new Error(`Renderer did not reach ${js}; see ${join(evidence, "failure.json")}`, { cause: error });
    }
  };
  const click = async (name: string) => {
    await wait(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(name)}&&!b.disabled)`);
    await command("find", "role", "button", "click", "--name", name, "--exact");
  };
  await command("open", preview.previewUrl);
  await evaluate(`window.__nativeOpen=window.open.bind(window);window.__oauthTrace=[];window.__oauthPages=[];window.__oauthResponses=0;window.__blockOAuth=false;
    window.open=(url,target)=>{window.__oauthTrace.push({event:'open',url,active:navigator.userActivation.isActive});const page=window.__blockOAuth?null:window.__nativeOpen(url,target);if(page)window.__oauthPages.push(page);return page;};
    const originalFetch=window.fetch.bind(window);window.fetch=(input,init)=>{const auth=String(input).includes('/authorize');if(auth)window.__oauthTrace.push({event:'fetch'});return originalFetch(input,init).then(response=>{if(auth)window.__oauthResponses++;return response;});};`);
  const assertReserved = async () => {
    // Native popups become the browser's active tab; inspect the app tab.
    await command("tab", "t1");
    const trace = await evaluate("window.__oauthTrace.slice(-2)");
    assert.deepEqual(trace, [{ event: "open", url: "", active: true }, { event: "fetch" }]);
    assert.equal(await evaluate("window.__oauthPages.at(-1).location.href"), "about:blank");
    assert.equal(await evaluate("window.__oauthPages.at(-1).opener===null"), true);
  };
  const checkLink = async (selector: string, attempt: number) => {
    await wait(`document.querySelector(${JSON.stringify(selector)})!==null`);
    assert.deepEqual(await evaluate(`(()=>{const a=document.querySelector(${JSON.stringify(selector)});return {href:a.href,target:a.target,rel:a.rel,visible:a.getClientRects().length>0};})()`), {
      href: `${authorizationBase}/authorize?attempt=${attempt}`, target: "_blank", rel: "noopener noreferrer", visible: true,
    });
  };
  const checkAuthorizationTab = async (attempt: number) => {
    const url = `${authorizationBase}/authorize?attempt=${attempt}`;
    const tabs = (await command("tab", "list")).tabs as Array<{ tabId: string; url: string }>;
    const page = tabs.findLast((tab) => tab.url === url) ?? tabs.findLast((tab) => tab.url === "about:blank");
    assert.ok(page, "the browser must create an authorization tab");
    await command("tab", page.tabId);
    await wait(`location.href===${JSON.stringify(url)}&&document.body.textContent.includes('syntheticAuthorization')`);
    assert.ok(visitedAuthorizationPages.includes(`/authorize?attempt=${attempt}`));
    assert.equal(await evaluate("window.opener===null"), true);
    await command("tab", "t1");
  };

  // Settings reserves synchronously even though the returned URL is delayed.
  await click("Settings Apps");
  await wait("document.querySelector('[data-app-tile=gmail] button[type=button]:not([aria-label]):not(:disabled)')!==null");
  await command("click", "[data-app-tile=gmail] button[type=button]:not([aria-label])");
  await command("fill", "[data-app-tile=gmail] form input", "fixture-work");
  pauseAuthorize(); await command("click", "[data-app-tile=gmail] form button[type=submit]");
  await assertReserved(); assert.equal(attempts, 1); release();
  await checkLink("[data-app-tile=gmail] a[target=_blank]", 1);
  await checkAuthorizationTab(1);
  await command("screenshot", join(evidence, "settings-authorizing.png"), "--full");
  // The same real modal remains usable when a later popup is blocked.
  await evaluate("window.__blockOAuth=true");
  await command("click", "[data-app-tile=gmail] button[type=button]:not([aria-label])");
  await wait("document.querySelector('[role=alert]').textContent.includes('blocked')");
  assert.equal(attempts, 1, "Settings Continue must reuse its issued flow");
  await checkLink("[data-app-tile=gmail] a[target=_blank]", 1);
  const beforeSettingsLink = ((await command("tab", "list")).tabs as unknown[]).length;
  await command("click", "[data-app-tile=gmail] a[target=_blank]");
  assert.equal(((await command("tab", "list")).tabs as unknown[]).length, beforeSettingsLink + 1);
  await checkAuthorizationTab(1);
  await command("screenshot", join(evidence, "settings-popup-blocked.png"), "--full");
  // Closing Settings while another toolkit request is pending cancels its tab.
  await evaluate("window.__blockOAuth=false");
  await command("click", "[data-app-tile=slack] button[type=button]:not([aria-label])");
  await command("fill", "[data-app-tile=slack] form input", "fixture-slack");
  pauseAuthorize(); await command("click", "[data-app-tile=slack] form button[type=submit]");
  await assertReserved(); assert.equal(attempts, 2);
  await command("find", "role", "button", "click", "--name", "Close plugins", "--exact");
  release();
  await wait("window.__oauthResponses===2&&window.__oauthPages.at(-1).closed");
  assert.equal(await evaluate("document.querySelector('[data-tour=apps-panel]')===null"), true);
  // Reopening loses the memory-only URL, not the unfinished upstream account.
  await click("Settings Apps");
  await command("find", "role", "button", "click", "--name", "Refresh connection status", "--exact");
  await wait("document.querySelector('[data-app-tile=gmail]').textContent.includes('fixture-work')");
  await wait("document.querySelector('[data-app-tile=gmail] button[type=button]:not([aria-label])')?.textContent.trim()==='Check status'");
  pauseAuthorize(); await command("click", "[data-app-tile=gmail] button[type=button]:not([aria-label])");
  await assertReserved(); assert.equal(attempts, 3); assert.equal(requestBodies[2]!.alias, undefined); release();
  await checkLink("[data-app-tile=gmail] a[target=_blank]", 3); await checkAuthorizationTab(3);
  // A stale anchor must authorize again without replaying its old alias.
  await evaluate("window.__realNow=Date.now;Date.now=()=>window.__realNow()+600001");
  pauseAuthorize(); await command("click", "[data-app-tile=gmail] a[target=_blank]");
  await assertReserved(); assert.equal(attempts, 4); assert.equal(requestBodies[3]!.alias, undefined); release();
  await checkLink("[data-app-tile=gmail] a[target=_blank]", 4); await checkAuthorizationTab(4);
  await command("find", "role", "button", "click", "--name", "Close plugins", "--exact");
  await evaluate("Date.now=window.__realNow");

  // Deliberately blocked window.open leaves a native, safe authorization link.
  await evaluate("window.__blockOAuth=true");
  pauseAuthorize(); await click("Connect securely");
  assert.equal(attempts, 5); release();
  await checkLink("[data-tour=connector] a[target=_blank]", 5);
  await wait("document.body.textContent.includes('blocked')");
  await command("screenshot", join(evidence, "card-popup-blocked.png"), "--full");
  await click("Card authorizing"); await click("Open again");
  assert.equal(attempts, 5, "Open again must reuse the issued flow");
  const beforeCardLink = ((await command("tab", "list")).tabs as unknown[]).length;
  await command("click", "[data-tour=connector] a[target=_blank]");
  assert.equal(((await command("tab", "list")).tabs as unknown[]).length, beforeCardLink + 1);
  await checkAuthorizationTab(5);

  // A failed request closes only its reserved blank; the real retry can launch.
  await click("Replace card target"); await evaluate("window.__blockOAuth=false");
  pauseAuthorize(true); await click("Connect securely"); await assertReserved(); release();
  await wait("document.body.textContent.includes('Synthetic authorization outage')");
  assert.equal(await evaluate("window.__oauthPages.at(-1).closed"), true);
  await click("Card failed");
  pauseAuthorize(); await click("Try again"); await assertReserved(); release();
  await click("Card authorizing");
  await checkLink("[data-tour=connector] a[target=_blank]", 7);

  // Replacement/unmount cannot late-open the old account after its response.
  await click("Replace card target"); pauseAuthorize(); await click("Connect securely"); await assertReserved();
  await click("Replace card target"); release();
  await wait("window.__oauthResponses===8&&window.__oauthPages.at(-1).closed");
  assert.equal(await evaluate("document.querySelector('[data-tour=connector] a[target=_blank]')===null"), true);
  pauseAuthorize(); await click("Connect securely"); await assertReserved();
  await click("Remove card"); release();
  await wait("window.__oauthResponses===9&&window.__oauthPages.at(-1).closed");
  assert.equal(await evaluate("document.querySelector('[data-tour=connector]')===null"), true);
  const errors = await command("errors");
  assert.deepEqual(errors.errors, []);
  const result = { ok: true, fixtureUrl: fixture.info.url, logPath: fixture.info.logPath, attempts, evidence, tested: ["Settings synchronous reservation", "Settings blocked-popup fallback and Continue", "Settings close cancels late opening", "Settings pending inventory after reopen", "expired anchor renewal without stale alias", "card blocked-popup fallback", "native safe link navigation", "Open again reuses flow", "failure closes blank and Try again", "replacement and unmount cancel late opening"], limitation: "Synthetic authorize responses in Chromium; no live provider, Safari or Brave acceptance." };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  release?.();
  await closeBrowser?.().catch(() => {});
  await preview?.close();
  await new Promise<void>((done) => authorizationServer ? authorizationServer.close(() => done()) : done());
  await fixture.close();
}
