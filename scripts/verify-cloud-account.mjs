// Actual renderer/preload and production client; synthetic loopback Cloud only.
// No user home, OS keychain, real browser sign-in, payment, or installed app.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)), flag = "--omb-cloud-account-fixture";
if (process.versions.electron && process.argv.includes(flag)) {
  const { app, BrowserWindow, ipcMain, session } = await import("electron");
  const { createServer } = await import("node:http");
  const { createCloudAccountClient } = await import("../electron/cloud-account.mjs");
  const local = createRequire(import.meta.url)("../electron/local-origin.cjs");
  const [preview, output] = process.argv.slice(process.argv.indexOf(flag) + 1), previewOrigin = new URL(preview).origin;
  app.setPath("userData", join(output, "user-data")); app.setPath("sessionData", join(output, "user-data"));
  app.commandLine.appendSwitch("disable-background-networking"); local.setLocalOrigin(previewOrigin);
  let win, origin, saved = null, approved = false, revoked = false, offline = false, begins = 0, revokes = 0;
  let entitlement = { plan: "free", status: "inactive", expiresAt: null, version: 0 };
  const token = `omc_${"T".repeat(43)}`, browsers = [];
  const identity = () => ({ cloudContractVersion: 1, expiresAt: Date.now() + 86400_000, device: { id: "fixture-device" }, account: { id: "fixture-account", email: "person@example.test" } });
  const cloud = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume fixture body */ }
    const reply = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<h1>Untrusted remote fixture</h1>"); }
    if (req.url === "/api/cloud/desktop/authorize") { begins++; approved = false; revoked = false; return reply(201, { cloudContractVersion: 1,
      deviceCode: "A".repeat(43), userCode: "ABCDE-FGHJK", verificationUriComplete: `${origin}/cloud/desktop?code=ABCDE-FGHJK`, expiresIn: 600, interval: 5 }); }
    if (req.url === "/api/cloud/desktop/token") return approved ? reply(200, { ...identity(), accessToken: token }) : reply(400, { error: "authorization_pending" });
    if (req.url === "/api/cloud/desktop/session" && req.headers.authorization === `Bearer ${token}`) {
      if (req.method === "DELETE") { revoked = true; revokes++; return reply(200, { revoked: true }); }
      return offline ? reply(503, { error: "unavailable" }) : revoked ? reply(401, { error: "invalid_token" }) : reply(200, { ...identity(), entitlement });
    }
    reply(404, { error: "not_found" });
  });
  await new Promise(resolve => cloud.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${cloud.address().port}`;
  const client = createCloudAccountClient({ origin, fixture: true, platform: process.platform, deviceName: "Disposable desktop", appVersion: "fixture",
    store: { read: async () => saved, write: async value => { saved = structuredClone(value); } }, openBrowser: async url => { browsers.push(url); },
    onState: state => { if (win && !win.isDestroyed() && win.webContents.mainFrame.url.startsWith(`${previewOrigin}/`)) win.webContents.send("cloud-account:state-changed", state); },
  });
  for (const method of ["state", "begin", "reopen", "cancel", "refresh", "signOut", "openDashboard"]) ipcMain.handle(`cloud-account:${method}`, local.localOnly(`cloud-account:${method}`, event => {
    assert.equal(event.sender, win.webContents); assert.equal(event.senderFrame, win.webContents.mainFrame); return client[method]();
  }));
  // Electron waits for the ESM entry to finish before emitting ready; never
  // top-level-await whenReady() here.
  void app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const url = new URL(details.url); done({ cancel: ![previewOrigin, origin].includes(url.origin) && !["data:", "devtools:", "ws:"].includes(url.protocol) });
  });
  try {
    await client.start(); assert.equal(begins, 0); assert.deepEqual(browsers, []);
    win = new BrowserWindow({ width: 740, height: 780, show: false, webPreferences: { preload: join(root, "electron/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true,
      additionalArguments: [`--omb-local-origin=${previewOrigin}`, "--omb-company-desktop=1"] } });
    const evaluate = source => win.webContents.executeJavaScript(source, true);
    const wait = async text => { for (let count = 0; count < 240; count++) { if (await evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`)) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Missing fixture UI: ${text}`); };
    const click = async text => { for (let count = 0; count < 80; count++) {
      if (await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}); if(!b || b.disabled)return false; b.click(); return true; })()`)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    } throw new Error(`Button unavailable: ${text}`); };
    await win.loadURL(preview); await wait("Sign in to OMB Cloud"); assert.equal(begins, 0);
    assert.equal(await evaluate("typeof window.ogb.cloudAccount.connection"), "undefined");
    await click("Sign in to OMB Cloud"); await wait("Security details"); assert.equal(browsers[0], `${origin}/cloud/desktop?code=ABCDE-FGHJK`);
    await click("Cancel sign-in"); await wait("Sign in to OMB Cloud"); assert.equal(saved, null);
    await click("Sign in to OMB Cloud"); await wait("Security details"); approved = true;
    await wait("Free account"); assert.equal(saved.token, token);
    assert.ok(!(await evaluate("(async () => JSON.stringify(await window.ogb.cloudAccount.state()))()")).includes(token));
    await click("Choose a Cloud plan in your browser"); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(browsers.at(-1), `${origin}/cloud`);
    await wait("Free account"); assert.equal(await evaluate("document.body.innerText.includes('Pro active')"), false);
    entitlement = { plan: "pro", status: "active", expiresAt: Date.now() + 3600_000, version: 1 };
    await click("Refresh"); await wait("Pro active");
    writeFileSync(join(output, "cloud-connected.png"), (await win.webContents.capturePage()).toPNG());
    offline = true; await click("Refresh"); await wait("Cloud status cannot currently be verified");
    assert.equal(await evaluate("document.body.innerText.includes('Pro active')"), false);
    offline = false; await click("Refresh"); await wait("Pro active");
    win.setSize(390, 760); await click("Sign out of OMB Cloud"); await wait("does not cancel your subscription");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    writeFileSync(join(output, "cloud-signout-narrow.png"), (await win.webContents.capturePage()).toPNG());
    await click("Keep signed in"); assert.equal(revokes, 0);
    revoked = true; await click("Refresh"); await wait("Cloud access expired or was revoked");
    assert.equal(await evaluate("document.body.innerText.includes('Pro active')"), false);
    await click("Sign out of OMB Cloud"); await wait("does not cancel your subscription"); await click("Sign out of OMB Cloud");
    await wait("Sign in to OMB Cloud");
    for (let count = 0; count < 80 && revokes !== 1; count++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(saved, null); assert.equal(revokes, 1);
    await win.loadURL(`${origin}/`); assert.equal(await evaluate("typeof window.ogb?.cloudAccount"), "undefined"); assert.equal(await evaluate("typeof require"), "undefined");
    const receipt = { passed: true, flow: "Optional personal Cloud sign-in, cancellation, free state, checkout cannot activate, verified Pro, unavailable, revocation, confirmed sign-out, narrow layout, remote boundary",
      limitation: "Synthetic Cloud/approval, captured external browser requests and in-memory credential storage. No real OTP, payment, OS keychain, installed update or production service." };
    writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`); console.log(JSON.stringify(receipt));
    client.close(); cloud.closeAllConnections(); cloud.close(); win.destroy(); app.exit(0);
  } catch (error) { console.error(error); client.close(); cloud.closeAllConnections(); cloud.close(); app.exit(1); }
  });
} else {
  const { createServer } = await import("vite"), { default: react } = await import("@vitejs/plugin-react"), { default: tailwindcss } = await import("@tailwindcss/vite");
  const output = mkdtempSync(join(tmpdir(), "omb-cloud-account-ui-"));
  for (const name of ["home", "user-data"]) mkdirSync(join(output, name));
  const ui = await createServer({ configFile: false, root, resolve: { alias: { "@": join(root, "src") } }, define: { __APP_VERSION__: JSON.stringify("fixture") },
    server: { host: "127.0.0.1", port: 0 }, plugins: [react(), tailwindcss(), {
      name: "cloud-account-fixture", resolveId(id) { if (id === "virtual:cloud-account-fixture") return `\0${id}`; },
      load(id) { if (id === "\0virtual:cloud-account-fixture") return `import React from 'react'; import { createRoot } from 'react-dom/client'; import { CloudAccountSettings } from '/src/components/CloudAccountSettings.tsx'; import { setLocale } from '/src/lib/i18n.ts'; import '/src/styles.css'; setLocale('en'); createRoot(document.getElementById('root')).render(React.createElement('main',{className:'mx-auto flex max-w-xl flex-col gap-4'},React.createElement(CloudAccountSettings)));`; },
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url !== "/__cloud.html") return next();
        void server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Isolated OMB Cloud</title></head><body class="bg-app p-4"><div id="root"></div><script type="module" src="/@id/virtual:cloud-account-fixture"></script></body></html>')
          .then(html => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
      }); },
    }] });
  try {
    await ui.listen(); const url = `${ui.resolvedUrls.local[0]}__cloud.html`; console.log(JSON.stringify({ previewUrl: url, evidence: output }));
    const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(import.meta.url), flag, url, output], {
      env: { PATH: process.env.PATH, HOME: join(output, "home"), XDG_CONFIG_HOME: join(output, "home"), TMPDIR: output, TEMP: output, TMP: output, DISPLAY: process.env.DISPLAY, SystemRoot: process.env.SystemRoot }, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { appendFileSync(join(output, "electron.log"), data); process.stdout.write(data); });
    const stop = () => child.kill("SIGTERM"); process.once("SIGINT", stop); process.once("SIGTERM", stop);
    const timer = setTimeout(stop, 60_000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); })
      .finally(() => { clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); });
    assert.equal(code, 0, `Cloud smoke failed; inspect ${join(output, "electron.log")}`);
    assert.equal(JSON.parse(readFileSync(join(output, "receipt.json"), "utf8")).passed, true);
  } finally { await ui.close(); for (const name of ["home", "user-data"]) rmSync(join(output, name), { recursive: true, force: true }); }
}
