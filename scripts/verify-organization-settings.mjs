// Real renderer + production preload/client against an offline synthetic Admin.
// No provider calls, real browser consent, OS keychain or user workspace data.
// Run: node scripts/verify-organization-settings.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const flag = "--omb-organization-fixture";

if (process.versions.electron && process.argv.includes(flag)) {
  const { app, BrowserWindow, ipcMain, session } = await import("electron");
  const { createManagedDesktopClient, createManagedDesktopRelay } = await import("../electron/managed-desktop.mjs");
  const { createOrganizationEntry } = await import("../electron/organization-entry.mjs");
  const { buildApplicationMenu } = await import("../electron/menu.mjs");
  const { parseEnvironments, serializeEnvironments, activeEnvironment } = createRequire(import.meta.url)("../electron/environments.cjs");
  const [url, output, runtimeUrl] = process.argv.slice(process.argv.indexOf(flag) + 1);
  app.setPath("userData", join(output, "user-data"));
  app.setPath("sessionData", join(output, "user-data"));
  app.commandLine.appendSwitch("disable-background-networking");
  const localOrigin = new URL(url).origin;
  const localOriginGuard = createRequire(import.meta.url)("../electron/local-origin.cjs");
  localOriginGuard.setLocalOrigin(localOrigin);
  const organization = { id: "11111111-1111-4111-8111-111111111111", name: "Fixture Studio" };
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=";
  let branding = { logo: image, icons: [{ id: "33333333-3333-4333-8333-333333333333", name: "Studio helper", image }] };
  const device = { id: "22222222-2222-4222-8222-222222222222", organizationId: organization.id, email: "employee@example.test", expiresAt: Date.now() + 60_000, revokedAt: null };
  const token = `omd_${randomBytes(32).toString("base64url")}`;
  const modelToken = `omg_${randomBytes(32).toString("base64url")}`;
  let approved = false, revoked = false, begins = 0, revokes = 0, grantsApplied = 0, clearsApplied = 0;
  let origin, win, entry, saved = null;
  const browserRequests = [];
  const admin = createHttpServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end('<html><body><h1>Old hosted workspace</h1><p>These chats belong to the server.</p></body></html>');
    }
    if (req.url === "/api/public/config") return reply(200, { desktopContractVersion: 1, capabilities: { desktopEnrollment: true } });
    if (req.url === "/api/desktop/enrollment" && req.method === "POST") {
      approved = false; revoked = false; begins++;
      return reply(201, { deviceCode: "A".repeat(43), userCode: "ABCDE-FGHJK", verificationUriComplete: `${origin}/enroll?code=ABCDE-FGHJK`, expiresIn: 600, interval: 5 });
    }
    if (req.url === "/api/desktop/enrollment/token" && req.method === "POST") return approved
      ? reply(200, { accessToken: token, expiresAt: device.expiresAt, device })
      : reply(400, { error: "authorization_pending" });
    if (req.url === "/api/desktop/session" && req.headers.authorization === `Bearer ${token}`) {
      if (req.method === "DELETE") { revoked = true; revokes++; return reply(200, { revoked: true }); }
      if (revoked) return reply(401, { error: "invalid_token" });
      return reply(200, { desktopContractVersion: 1, organization, branding, device, modelAccessToken: modelToken, cloudBackups: false,
        providers: [{ id: "anthropic", configured: true, models: ["claude-fixture"] }, { id: "openrouter", configured: true, models: ["fixture/writer", "fixture/reader"] }] });
    }
    reply(404, { error: "not_found" });
  });
  await new Promise(resolve => admin.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${admin.address().port}`;
  const relay = createManagedDesktopRelay();
  // This acknowledges private IPC but deliberately does not simulate native
  // driver execution. Native driver/registry behavior has separate tests.
  const fakeProcess = { postMessage(message) {
    if (message.connection) {
      assert.equal(message.connection.token, modelToken, "native provider gets model-only capability");
      grantsApplied++;
    } else clearsApplied++;
    queueMicrotask(() => relay.receive(fakeProcess, { type: "openmausbot:managed-desktop-result", requestId: message.requestId, ok: true }));
  } };
  const client = createManagedDesktopClient({
    store: { read: async () => saved, write: async value => { saved = structuredClone(value); } },
    platform: process.platform, deviceName: "Isolated desktop fixture",
    openBrowser: async target => { browserRequests.push(target); },
    applyConnection: value => relay.send(fakeProcess, value),
    onState: value => { if (win && !win.isDestroyed()) win.webContents.send("organization:state-changed", value); },
  });
  for (const [channel, method] of [["state", "state"], ["begin", "begin"], ["cancel", "cancelEnrollment"], ["refresh", "refresh"], ["disconnect", "disconnect"]]) {
    ipcMain.handle(`organization:${channel}`, (event, input) => {
      assert.equal(new URL(event.senderFrame.url).origin, localOrigin);
      return client[method](input);
    });
  }
  let settingsOpened = 0;
  ipcMain.handle("organization:settings-opened", event => {
    assert.equal(new URL(event.senderFrame.url).origin, localOrigin);
    settingsOpened++;
    return entry?.settingsOpened() ?? false;
  });
  ipcMain.handle("update:get-state", () => ({ status: "idle" }));
  ipcMain.handle("companion:state", () => ({ running: false, enabled: false, devices: [], bind: null, publicUrl: null }));
  ipcMain.handle("perm:status", () => ({}));
  ipcMain.handle("window:state", () => ({ maximized: false, fullscreen: false }));
  ipcMain.handle("desktop:capabilities", event => createRequire(import.meta.url)("../electron/capabilities.cjs").desktopCapabilities({
    platform: process.platform,
    remote: !localOriginGuard.isLocalSender(event),
  }));
  ipcMain.handle("workspaces:state", () => createRequire(import.meta.url)("../electron/environments.cjs").workspaceSummary({ activeId: "local", environments: [] }));
  ipcMain.handle("environments:state", () => ({ activeId: "local", environments: [] }));
  ipcMain.handle("desktop-remote:state", () => ({ active: false }));

  app.whenReady().then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
      const target = new URL(request.url);
      callback({ cancel: target.host !== new URL(url).host && target.origin !== runtimeUrl && target.origin !== origin });
    });
    const open = async (local, path = url) => {
      const window = new BrowserWindow({ show: false, width: 820, height: 760, webPreferences: {
        preload: join(root, "electron/preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false,
        additionalArguments: [`--omb-local-origin=${local ? localOrigin : "https://remote-fixture.invalid"}`, "--omb-company-desktop=1"],
      } });
      await window.loadURL(path); return window;
    };
    await client.start();
    win = await open(true);
    const evaluate = code => win.webContents.executeJavaScript(code);
    const button = label => `[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
    const until = async (check, description) => {
      for (let attempt = 0; attempt < 350; attempt++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      writeFileSync(join(output, "failure.png"), (await win.webContents.capturePage()).toPNG());
      throw new Error(`Timed out: ${description}`);
    };
    const click = async label => {
      await until(() => evaluate(`Boolean(${button(label)}) && !${button(label)}.disabled`), label);
      await evaluate(`${button(label)}.click()`);
    };
    const fillAddress = async () => evaluate(`(() => { const el = document.querySelector('input[type=url]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(origin)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const openAdvanced = async () => evaluate(`document.querySelector('details summary').click()`);
    await until(() => evaluate(`Boolean(${button("Sign in with your organisation")})`), "optional sign-in form");
    assert.equal(begins, 0); assert.equal(browserRequests.length, 0);
    assert.equal(await evaluate("document.body.textContent.includes('personal and local models')"), true);
    await openAdvanced(); await fillAddress(); await click("Sign in to custom Admin");
    await until(() => browserRequests.length === 1, "browser sign-in request");
    assert.deepEqual(browserRequests, [`${origin}/enroll?code=ABCDE-FGHJK`]);
    assert.equal(await evaluate("[...document.querySelectorAll('details')].some(el => el.textContent.includes('ABCDE-FGHJK') && el.open)"), false, "security code stays collapsed by default");
    assert.equal(await evaluate("document.body.textContent.includes('connect automatically')"), true);
    await click("Cancel sign-in");
    await until(() => evaluate(`Boolean(${button("Sign in with your organisation")})`), "cancel restored form");
    assert.equal(saved, null);
    await openAdvanced(); await fillAddress(); await click("Sign in to custom Admin");
    await until(() => browserRequests.length === 2, "second browser request"); approved = true;
    await until(() => evaluate("document.body.textContent.includes('Fixture Studio')"), "approved company connected");
    assert.equal(await evaluate("document.body.textContent.includes('Approved models: 2')"), true);
    assert.equal(await evaluate("JSON.stringify(window.ogb.organization).includes('token')"), false);
    assert.equal(await evaluate("window.ogb.organization.state().then(s => /om[dg]_/.test(JSON.stringify(s)))"), false);
    assert.equal(await evaluate("typeof window.ogb.organization.connection"), "undefined");
    assert.equal(await evaluate("window.ogb.getCapabilities().then(value => value.dictation.available)"), process.platform === "darwin", "organisation sign-in does not turn the local renderer into a remote workspace");
    assert.ok(grantsApplied > 0);
    await until(() => evaluate("document.querySelector('img[alt=\"Organization logo\"]')?.naturalWidth > 0"), "organization logo decoded");
    await win.loadURL(`${url}?branding=1`);
    await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"Use Studio helper icon\"]'))"), "organization icon library");
    await evaluate("document.querySelector('[aria-label=\"Use Studio helper icon\"]').click()");
    await until(() => evaluate("Boolean(window.fixtureBot?.avatarUrl?.startsWith('/api/'))"), "icon saved as local avatar attachment");
    const avatar = await evaluate("window.fixtureBot.avatarUrl");
    assert.equal(await evaluate("fetch(window.fixtureBot.avatarUrl).then(r => r.ok)"), true, "local avatar pixels are retrievable");
    writeFileSync(join(output, "organization-branding.png"), (await win.webContents.capturePage()).toPNG());
    branding = { logo: null, icons: [] };
    await click("Refresh");
    await until(() => evaluate("!document.querySelector('[aria-label=\"Use Studio helper icon\"]') && !document.querySelector('img[alt=\"Organization logo\"]')"), "admin removal propagated");
    assert.equal(await evaluate("window.fixtureBot.avatarUrl"), avatar, "removing a shared icon preserves the chosen local avatar");
    await win.loadURL(url);
    await until(() => evaluate("document.body.textContent.includes('Fixture Studio')"), "settings restored");
    writeFileSync(join(output, "organization-connected.png"), (await win.webContents.capturePage()).toPNG());
    win.setSize(390, 780);
    await until(() => evaluate("innerWidth === 390"), "narrow viewport");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    await click("Disconnect…");
    assert.equal(revokes, 0); assert.ok(saved);
    await click("Keep connection");
    assert.ok(saved);
    await click("Disconnect…");
    writeFileSync(join(output, "organization-disconnect-narrow.png"), (await win.webContents.capturePage()).toPNG());
    await click("Disconnect from organization");
    await until(() => evaluate(`Boolean(${button("Sign in with your organisation")})`), "confirmed disconnect");
    assert.equal(saved, null); assert.equal(revokes, 1); assert.ok(clearsApplied > 0);
    await openAdvanced(); await fillAddress(); await click("Sign in to custom Admin");
    await until(() => browserRequests.length === 3, "third browser request"); approved = true;
    await until(() => evaluate("document.body.textContent.includes('Fixture Studio')"), "reconnected company");
    revoked = true; await click("Refresh");
    await until(() => evaluate("document.body.textContent.includes('Disconnect below, then sign in again')"), "revoked access shown");
    assert.equal(await evaluate(`Boolean(${button("Sign in with your organisation")})`), false);
    await click("Disconnect…"); await click("Disconnect from organization");
    await until(() => client.state().status === "signed-out", "revoked grant cleared");

    const remote = await open(false);
    assert.equal(await remote.webContents.executeJavaScript("typeof window.ogb.organization"), "undefined");
    assert.equal(await remote.webContents.executeJavaScript("typeof require"), "undefined");
    remote.destroy();

    // Actual unchanged app startup: no organization auth wall, even before
    // local onboarding. Only explicit Settings navigation opens the panel.
    const beginsBeforeApp = begins;
    win.setSize(1180, 850);
    await win.loadURL(`${url}?app=1`);
    await until(() => evaluate("document.body.textContent.includes('Welcome to OpenMausBot')"), "normal optional welcome flow");
    assert.equal(await evaluate(`Boolean(${button("Sign in with your organisation")})`), false);
    assert.equal(begins, beginsBeforeApp);
    win.webContents.send("app:open-settings");
    await until(() => evaluate("Boolean(document.querySelector('option[value=organization]'))"), "optional Settings section");
    await click("Organisation");
    await until(() => evaluate(`Boolean(${button("Sign in with your organisation")})`), "Organisation in real app Settings");
    assert.equal(await evaluate("document.querySelectorAll('[role=dialog]').length"), 1, "welcome yields only to explicit connection Settings");
    await evaluate("new Promise(resolve => setTimeout(resolve, 180))"); // Capture settled navigation colors.
    writeFileSync(join(output, "organization-in-app.png"), (await win.webContents.capturePage()).toPNG());

    // Reproduce the upgrade trap: an old hosted selection survives a fresh
    // renderer. Use the actual native transition and menu with recorded
    // confirmation; navigation, preload classification and disk state are real.
    const environmentsFile = join(output, "user-data", "environments.json");
    const hostedState = { activeId: "old-host", environments: [{ id: "old-host", name: "Retained cloud workspace", origin }] };
    writeFileSync(environmentsFile, serializeEnvironments(hostedState));
    const readEnvironments = () => parseEnvironments(readFileSync(environmentsFile, "utf8"));
    let confirmLocal = false;
    let restartIntent = false;
    const confirmations = [];
    entry = createOrganizationEntry({
      readState: () => ({ environments: readEnvironments(), remoteAccess: null, restartIntent }),
      confirm: async options => { confirmations.push(options); return confirmLocal; },
      saveEnvironments: next => writeFileSync(environmentsFile, serializeEnvironments(next)),
      disconnectAndRemember: () => { throw new Error("Legacy hosted entry must not clear companion credentials"); },
      clearRestartIntent: () => { restartIntent = false; },
      openLocalSettings: () => win.loadURL(`${url}?app=1&desktop-settings=organization`),
      relaunch: () => { throw new Error("Legacy hosted entry needs no restart"); },
    });
    await win.loadURL(activeEnvironment(readEnvironments()).origin);
    await until(() => evaluate("document.body.textContent.includes('Old hosted workspace')"), "saved old server restored");
    assert.equal(await evaluate("typeof window.ogb.organization"), "undefined", "old cloud renderer has no organisation authority");
    const beforeCancel = readFileSync(environmentsFile, "utf8");
    await entry.request();
    assert.equal(readFileSync(environmentsFile, "utf8"), beforeCancel, "cancel preserves the exact saved selection");
    assert.equal(new URL(win.webContents.getURL()).origin, origin);
    confirmLocal = true;
    const acknowledgmentsBeforeReturn = settingsOpened;
    let menuRequest;
    const menu = buildApplicationMenu({ ...readEnvironments(), onOrganizationSignIn: () => { menuRequest = entry.request(); },
      onSwitch: () => {}, onAddFromClipboard: () => {}, onConnect: () => {}, onForget: () => {}, onOpenSettings: () => {} });
    menu.getMenuItemById("organization-sign-in").click();
    await menuRequest;
    await until(() => evaluate(`Boolean(${button("Sign in with your organisation")})`), "native organisation action opens local Settings before onboarding");
    await until(() => settingsOpened > acknowledgmentsBeforeReturn, "mounted local Organisation settings acknowledged");
    assert.equal(new URL(win.webContents.getURL()).origin, localOrigin);
    assert.equal(readEnvironments().activeId, "local");
    assert.deepEqual(readEnvironments().environments, hostedState.environments, "hosted entry retained; no chat migration or deletion");
    assert.equal(begins, beginsBeforeApp, "opening local Settings does not enroll automatically");
    assert.equal(confirmations.length, 2);
    writeFileSync(join(output, "organization-returned-local.png"), (await win.webContents.capturePage()).toPNG());
    // A new renderer after relaunch uses the persisted local choice rather
    // than loading the old server again. No sign-in wall for personal use.
    const previousWindow = win;
    win = await open(true, activeEnvironment(readEnvironments())?.origin ?? `${url}?app=1`);
    previousWindow.destroy();
    await until(() => evaluate("document.body.textContent.includes('Welcome to OpenMausBot')"), "local choice survives recreated renderer");
    assert.equal(await evaluate("typeof window.ogb.organization"), "object");
    assert.equal(new URL(win.webContents.getURL()).origin, localOrigin);
    // Simulate the already-confirmed companion disconnect's one-bit restart
    // intent; only the actual local panel's acknowledgement consumes it.
    restartIntent = true;
    writeFileSync(environmentsFile, serializeEnvironments(hostedState));
    await entry.restore();
    await until(() => !restartIntent, "confirmed restart intent consumed after local panel mounts");
    assert.equal(readEnvironments().activeId, "local");
    assert.equal(await evaluate(`Boolean(${button("Sign in with your organisation")})`), true);
    const receipt = { passed: true, renderer: "OrganizationSettings + actual app shell", preload: "electron/preload.cjs", client: "electron/managed-desktop.mjs",
      checks: ["organization logo and icon grid", "chosen icon becomes a durable local attachment", "admin removal clears branding without deleting chosen avatar", "one-button default organization sign-in", "custom Admin kept under Advanced", "browser handoff and automatic connection", "security code collapsed and cancel works", "approved company and model counts", "model-only capability sent to private process", "no token or private connection method in renderer", "organisation sign-in preserves local desktop capabilities", "390px no overflow", "cancel/confirm disconnect", "revocation requires reconnect", "remote bridge absent", "normal app startup unchanged", "explicit Organisation Settings before local onboarding", "saved old hosted renderer restored without local authority", "cancel keeps hosted selection", "native menu returns to local Organisation Settings", "hosted entry remains saved", "persisted local selection survives recreated renderer"],
      limitation: "Synthetic loopback Admin, confirmation, credential store and utility-process acknowledgement. Renderer recreation and a synthetic restart intent, not an installed update or OS relaunch; no real Admin consent, OS keychain, native driver execution, private runtime synchronization, backups or public DNS/TLS." };
    writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify(receipt));
    client.close(); admin.close(); win.destroy(); app.exit(0);
  }).catch(error => { console.error(error.message); client.close(); admin.close(); app.exit(1); });
} else {
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const { default: tailwindcss } = await import("@tailwindcss/vite");
  const { launchVerificationServer } = await import("./control-omb.ts");
  const fixture = await launchVerificationServer();
  const output = mkdtempSync(join(tmpdir(), "omb-organization-ui-"));
  for (const name of ["home", "user-data"]) mkdirSync(join(output, name));
  const ui = await createServer({ configFile: false, root, resolve: { alias: { "@": join(root, "src") } },
    define: { __APP_VERSION__: JSON.stringify("fixture") },
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.info.url } } },
    plugins: [react(), tailwindcss(), {
      name: "organization-fixture",
      resolveId(id) { if (id === "virtual:organization-fixture") return `\0${id}`; },
      load(id) { if (id === "\0virtual:organization-fixture") return `import React from 'react'; import { createRoot } from 'react-dom/client'; import { OrganizationSettings } from '/src/components/OrganizationSettings.tsx'; import { setLocale } from '/src/lib/i18n.ts'; import { StoreProvider } from '/src/state/store.tsx'; import { BotProfileAvatarCard } from '/src/components/BotProfileAvatarCard.tsx'; import { OrganizationIdentity } from '/src/components/OrganizationIdentity.tsx'; import '/src/styles.css'; setLocale('en'); localStorage.setItem('omb-analytics-opt-out','1'); const root = createRoot(document.getElementById('root')); if(location.search.includes('app=1')) { document.body.classList.remove('p-4'); import('/src/App.tsx').then(({default: App}) => root.render(React.createElement(App))); } else if(location.search.includes('branding=1')) { function Fixture() { const [bot, setBot] = React.useState({ id:'fixture-avatar', name:'Studio bot', color:'green', mascotBody:'cursor', avatarCrop:'mascot', messages:[] }); window.fixtureBot = bot; return React.createElement(StoreProvider, null, React.createElement('main', {className:'mx-auto flex max-w-xl flex-col gap-4'}, React.createElement(OrganizationIdentity), React.createElement(OrganizationSettings), React.createElement(BotProfileAvatarCard, {bot, activeState:'idle', mascotMotion:null, onPatch: patch => setBot(b => ({...b,...patch}))}))); } root.render(React.createElement(Fixture)); } else root.render(React.createElement('main',{className:'mx-auto flex max-w-xl flex-col gap-4'},React.createElement(OrganizationSettings)));`; },
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/__organization.html") return next();
        void server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Isolated Organisation Settings</title></head><body class="bg-app p-4"><div id="root"></div><script type="module" src="/@id/virtual:organization-fixture"></script></body></html>')
          .then(html => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
      }); },
    }] });
  try {
    await ui.listen();
    const url = `${ui.resolvedUrls.local[0]}__organization.html`;
    console.log(JSON.stringify({ previewUrl: url, evidence: output, serverEvidence: fixture.info.logPath }));
    const child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(import.meta.url), flag, url, output, fixture.info.url], {
      env: { PATH: process.env.PATH, HOME: join(output, "home"), XDG_CONFIG_HOME: join(output, "home"), TMPDIR: output, TEMP: output, TMP: output, DISPLAY: process.env.DISPLAY, SystemRoot: process.env.SystemRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { appendFileSync(join(output, "electron.log"), data); process.stdout.write(data); });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    const timer = setTimeout(stop, 60_000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); })
      .finally(() => { clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); });
    assert.equal(code, 0, `Organisation smoke failed; inspect ${join(output, "electron.log")}`);
    assert.equal(JSON.parse(readFileSync(join(output, "receipt.json"), "utf8")).passed, true, "Electron must finish every workflow assertion");
  } finally {
    await ui.close(); await fixture.close();
    for (const name of ["home", "user-data"]) rmSync(join(output, name), { recursive: true, force: true });
  }
}
