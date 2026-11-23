// Real Settings component + production preload, offline IPC responses only.
// Run: node scripts/verify-server-connection.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureFlag = "--omb-server-connection-fixture";

if (process.versions.electron && process.argv.includes(fixtureFlag)) {
  const { app, BrowserWindow, ipcMain, Menu, session } = await import("electron");
  const { parseServerInput } = await import("../electron/server-address.mjs");
  const { withEnvironment, withActive, withoutEnvironment, workspaceSummary, workspaceMenuTemplate } = createRequire(import.meta.url)("../electron/environments.cjs");
  const [url, output, serverUrl] = process.argv.slice(process.argv.indexOf(fixtureFlag) + 1);
  app.setPath("userData", join(output, "user-data"));
  app.setPath("sessionData", join(output, "user-data"));
  app.commandLine.appendSwitch("disable-background-networking");
  for (const channel of ["desktop-analytics:read", "home:page", "home:updating", "update:offered"]) {
    ipcMain.on(channel, event => { event.returnValue = false; });
  }
  ipcMain.on("desktop-language:read", event => { event.returnValue = "en"; });
  const calls = [];
  let pending;
  let saved = { activeId: "local", environments: [{ id: "cloud", name: "My cloud team", origin: "https://bots.fixture.example" }] };
  let menuChoice = "workspace-connect";
  let forgetConfirmed = false;
  let shared = { enabled: false, folders: [], terminal: false, computer: false, connected: false };
  let sharingConfirmed = false;
  const { createServerConnect } = await import("../electron/server-probe.mjs");
  const connectSheet = createServerConnect({
    fetch: async () => Response.json({ environmentId: "fixture-cloud", label: "Research team" }),
    open: (found) => { saved = withEnvironment(saved, { origin: found.origin, name: found.label }, () => "new-cloud"); },
  });
  ipcMain.handle("workspaces:probe", (_event, address, code) => connectSheet.probe(address, code));
  ipcMain.handle("workspaces:add", (_event, choice, address, code) => {
    assert.equal(choice, "link");
    calls.push({ kind: "hosted", address, code });
    return new Promise(resolve => { pending = { resolve: accepted => resolve(accepted ? connectSheet.connect(address, code) : false) }; });
  });
  ipcMain.handle("workspaces:places", () => ({ places: [], add: { cloud: false, link: true, address: true } }));
  const { DESKTOP_NOTICES } = await import("../electron/desktop-prefs.mjs");
  const { TALK_SHORTCUT_UNAVAILABLE } = await import("../electron/talk-shortcut.mjs");
  const shellState = {
    "workspaces:line": null, "workspaces:look": null, "call:active": null,
    "desktop-notices:state": { seen: DESKTOP_NOTICES, cloud: false },
    "desktop-profile:system-name": "Fixture",
    "updates-consent:state": { available: false, due: false },
    "two-places:state": { suggest: null }, "rail:offer": { available: false, hidden: false },
    "window:state": { maximized: false }, "window-frame:state": { on: true, restart: false },
    "open-at-login:state": { available: false, on: false }, "talk-shortcut:state": TALK_SHORTCUT_UNAVAILABLE,
  };
  for (const [channel, value] of Object.entries(shellState)) ipcMain.handle(channel, () => value);
  ipcMain.handle("environments:status", () => []);
  ipcMain.handle("sharing:servers", () => []);
  ipcMain.handle("sharing:activity", () => []);
  ipcMain.handle("sharing:state", () => shared);
  ipcMain.handle("sharing:folder", () => ({ id: "fixture-folder", name: "Invoices", path: "/fixture/Invoices", write: false }));
  ipcMain.handle("sharing:save", (_event, id, grant) => {
    calls.push({ kind: "sharing", id, ...grant, confirmed: sharingConfirmed });
    if (!sharingConfirmed) return null;
    shared = { ...grant, enabled: true, connected: true }; return shared;
  });
  ipcMain.handle("sharing:revoke", () => { shared = { ...shared, enabled: false, connected: false }; return shared; });
  ipcMain.handle("update:get-state", () => ({ status: "idle" }));
  ipcMain.handle("companion:state", () => ({ running: false, enabled: false, devices: [], bind: null, publicUrl: null }));
  ipcMain.handle("desktop:capabilities", () => createRequire(import.meta.url)("../electron/capabilities.cjs").desktopCapabilities({ platform: process.platform }));
  const chooseWorkspace = (id) => { calls.push({ kind: "switch", id }); saved = withActive(saved, id); };
  ipcMain.handle("environments:state", () => ({ ...saved, localOrigin: new URL(url).origin, remote: false }));
  ipcMain.handle("environments:switch", (_event, id) => chooseWorkspace(id));
  ipcMain.handle("environments:forget", (_event, id) => {
    calls.push({ kind: "forget", id, confirmed: forgetConfirmed });
    if (forgetConfirmed) saved = withoutEnvironment(saved, id);
  });
  ipcMain.handle("workspaces:state", () => workspaceSummary(saved));
  ipcMain.handle("workspaces:menu", (event) => {
    const menu = Menu.buildFromTemplate(workspaceMenuTemplate(saved, {
      onSwitch: chooseWorkspace,
      onConnect: () => event.sender.send("workspaces:open-settings"),
      onForget: () => {},
    }));
    // Select the production native MenuItem; no fixture-only renderer dropdown.
    menu.getMenuItemById(menuChoice).click();
  });
  ipcMain.handle("desktop-remote:state", () => ({ active: false }));
  ipcMain.handle("desktop-remote:pair", (_event, endpoint, code) => {
    calls.push({ kind: "companion", endpoint, code });
    throw new Error("Fixture companion pairing rejected");
  });
  ipcMain.handle("environments:add-from-link", (_event, link, name) => {
    const read = parseServerInput(link);
    if (!read.ok) throw new Error("Enter the server's address or its pairing link.");
    const parsed = { origin: read.candidates[0] };
    calls.push({ kind: "server", link, ...(name === undefined ? {} : { name }) });
    return new Promise((resolve, reject) => { pending = { reject, resolve: (confirmed) => {
      if (confirmed) saved = withEnvironment(saved, { origin: parsed.origin, name }, () => "new-cloud");
      resolve(confirmed);
    } }; });
  });

  app.whenReady().then(async () => {
    const blockedRequests = [];
    session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
      const target = new URL(request.url);
      const allowed = target.host === new URL(url).host || target.origin === serverUrl;
      if (!allowed) blockedRequests.push({ type: request.resourceType, url: target.origin + target.pathname });
      callback({ cancel: !allowed });
    });
    const open = async (local) => {
      const win = new BrowserWindow({
        show: false, width: 720, height: 650,
        webPreferences: {
          preload: join(root, "electron/preload.cjs"), contextIsolation: true, backgroundThrottling: false,
          sandbox: true, nodeIntegration: false,
          additionalArguments: [`--omb-local-origin=${local ? new URL(url).origin : "https://remote-fixture.invalid"}`],
        },
      });
      win.webContents.on("console-message", (event) => { if (event.level === "error") console.error(event.message, event.sourceId, event.lineNumber); });
      await win.loadURL(url);
      return win;
    };
    const win = await open(true);
    const evaluate = (code) => win.webContents.executeJavaScript(code);
    win.showInactive();
    const screenshot = async (name) => {
      await evaluate(`(async () => {
        const dialog = document.querySelector('[data-look="settings"]');
        const animations = dialog?.getAnimations().filter(animation => animation.playState === 'running') ?? [];
        await Promise.allSettled(animations.map(animation => animation.finished));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()`);
      writeFileSync(join(output, name), (await win.webContents.capturePage()).toPNG());
    };
    const until = async (check, description) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      await screenshot("failure.png");
      console.error(await evaluate("document.body.innerText"));
      throw new Error(`Timed out: ${description}`);
    };
    const button = (label) => `[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
    const input = (label) => `[...document.querySelectorAll('label')].find(el => el.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input')`;
    const fill = async (label, value) => {
      await evaluate(`(() => { const el = ${input(label)}; if (!el) throw new Error('Missing input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    };
    const selectMode = (value) => evaluate(`(() => { const el = document.querySelector('select'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const connect = button("Connect to server");
    await until(() => evaluate(`Boolean(${connect})`), "server form rendered");
    assert.equal(await evaluate(`${connect}.disabled`), true);
    const link = "https://bots.fixture.example/pair#code=ABCD-EFGH-JKLM";
    await fill("Server pairing link", link);
    await until(() => evaluate(`!${connect}.disabled`), "server form enabled");
    await evaluate(`(() => { const form = ${connect}.form; form.requestSubmit(); form.requestSubmit(); })()`);
    await until(() => calls.length === 1, "server IPC received");
    assert.deepEqual(calls, [{ kind: "server", link }]);
    assert.equal(await evaluate(`${connect}.disabled`), true);
    await evaluate(`${connect}.click()`);
    assert.equal(calls.length, 1, "pending submission is disabled");
    pending.resolve(); // Production native dialog cancellation resolves void.
    await until(() => evaluate(`!${connect}.disabled`), "cancelled confirmation reset");
    assert.equal(await evaluate(`${input("Server pairing link")}.value`), link);
    await evaluate(`${connect}.click()`);
    await until(() => calls.length === 2, "second server IPC received");
    pending.reject(new Error("Fixture pairing link rejected"));
    await until(() => evaluate(`document.querySelector('[role=alert]')?.textContent === 'Fixture pairing link rejected'`), "readable IPC error");
    assert.equal(await evaluate(`${connect}.disabled`), false);
    await evaluate(`${connect}.click()`);
    await until(() => calls.length === 3, "server retry received");
    pending.resolve();
    await until(() => evaluate(`!${connect}.disabled && !document.querySelector('[role=alert]')`), "successful response reset");
    await screenshot("server-form.png");

    await selectMode("companion");
    await until(() => evaluate(`Boolean(${input("Companion address")})`), "companion form rendered");
    await fill("Companion address", "computer.tailnet.ts.net");
    await fill("Six-digit companion code", "12a34567");
    await until(() => evaluate(`${input("Six-digit companion code")}.value === '123456'`), "six-digit companion normalization");
    await evaluate(`${button("Pair and switch to client mode")}.click()`);
    await until(() => calls.length === 4, "companion IPC received");
    assert.deepEqual(calls[3], { kind: "companion", endpoint: "computer.tailnet.ts.net", code: "123456" });
    await until(() => evaluate(`document.querySelector('[role=alert]')?.textContent === 'Fixture companion pairing rejected'`), "companion error rendered");
    win.setSize(390, 700);
    await selectMode("server");
    await until(() => evaluate(`Boolean(${connect})`), "server mode restored");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "narrow layout overflow");
    await screenshot("server-form-narrow.png");

    win.setSize(780, 800);
    await win.loadURL(`${url}?workspaces=1`);
    const hostedConnect = "document.querySelector('[data-own-server-connect]')";
    const addressLabel = "Link or address";
    await until(() => evaluate(`document.querySelector('[data-server-connect]') && document.body.textContent.includes('My cloud team')`), "hosted workspace settings rendered");
    await evaluate("void window.ogb.environments.onOpenSettings(() => { document.body.dataset.settingsRequested = 'yes'; })");
    await evaluate("document.querySelector('[aria-label=\"Switch server: This computer\"]').click()");
    await until(() => evaluate("document.body.dataset.settingsRequested === 'yes'"), "native connect item requested Settings");
    assert.equal(saved.activeId, "local", "opening connection settings did not select a server");

    await evaluate("document.querySelector('[data-server-connect]').click()");
    await fill(addressLabel, "http://unsafe.fixture.example");
    await until(() => evaluate(`Boolean(document.querySelector('[data-connect-problem]')) && ${hostedConnect}.disabled`), "public HTTP address refused");
    await fill(addressLabel, "other.fixture.example");
    await until(() => evaluate(`!${hostedConnect}.disabled`), "hosted server found");
    const beforeHosted = calls.length;
    await evaluate(`(() => { ${hostedConnect}.form.requestSubmit(); ${hostedConnect}.form.requestSubmit(); })()`);
    await until(() => calls.length === beforeHosted + 1, "one hosted submission in flight");
    assert.deepEqual(calls.at(-1), { kind: "hosted", address: "other.fixture.example", code: "" });
    pending.resolve(false);
    await until(() => evaluate(`!${hostedConnect}.disabled`), "cancelled hosted confirmation reset");
    assert.equal(saved.environments.length, 1);
    assert.equal(await evaluate(`${input(addressLabel)}.value`), "other.fixture.example");

    await fill(addressLabel, "https://other.fixture.example/pair#code=7KQ2-M9XD-H4TP");
    await until(() => evaluate(`!${hostedConnect}.disabled`), "pairing link accepted");
    await evaluate(`${hostedConnect}.click()`);
    await until(() => calls.length === beforeHosted + 2, "hosted retry received");
    pending.resolve(true);
    await until(() => saved.environments.length === 2, "named workspace saved");
    assert.equal(saved.environments.find(entry => entry.id === "new-cloud")?.name, "Research team");
    // Production navigates away after confirmation. Reload our local preview
    // instead, to inspect the saved list without contacting a public server.
    await win.loadURL(`${url}?workspaces=1`);
    await until(() => evaluate("document.body.textContent.includes('Research team')"), "saved named workspace rendered");
    assert.deepEqual(saved.environments.map(({ origin }) => origin), ["https://bots.fixture.example", "https://other.fixture.example"]);
    assert.equal(JSON.stringify(saved).includes("7KQ2"), false, "pairing secret not saved with workspace");
    await screenshot("connected-workspaces.png");

    assert.equal(await evaluate("document.querySelector('[aria-label^=\"Computer access for \"]') === null"), true, "feature-off workspace offers no computer access");
    await win.loadURL(`${url}?workspaces=1&share-computer=cloud`);
    await until(() => evaluate("document.body.textContent.includes('My cloud team')"), "feature-off saved workspace rendered");
    assert.equal(await evaluate("document.body.textContent.includes('Computer access · My cloud team')"), false, "stale sharing deep link cannot bypass disabled feature");
    assert.equal(await evaluate(`${button("Choose folder")} === undefined`), true);
    await screenshot("computer-sharing-disabled.png");
    // Explicitly opt this disposable server in for the unfinished feature's
    // existing enabled-path regression coverage. Shipped defaults stay off.
    const enabled = await session.defaultSession.fetch(`${serverUrl}/api/config`, { method: "PATCH", headers: { "content-type": "application/json", origin: serverUrl }, body: JSON.stringify({ features: { sharedComputers: true } }) });
    assert.equal(enabled.status, 200);
    await win.loadURL(`${url}?workspaces=1`);
    await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"Computer access for My cloud team\"]'))"), "explicit fixture opt-in exposes computer access");
    await evaluate("document.querySelector('[aria-label=\"Computer access for My cloud team\"]').click()");
    await until(() => evaluate("document.body.textContent.includes('Not shared')"), "computer sharing defaults off");
    assert.equal(await evaluate("[...document.querySelectorAll('input[type=checkbox]')].every(el => !el.checked)"), true);
    await evaluate(`${button("Choose folder")}.click()`);
    await until(() => evaluate("document.body.textContent.includes('/fixture/Invoices')"), "native folder picker populates read-only draft");
    await evaluate(`${button("Share selected access")}.click()`);
    await until(() => calls.at(-1)?.kind === "sharing", "native consent requested");
    assert.equal(shared.enabled, false, "cancel native consent grants nothing");
    assert.equal(calls.at(-1).folders[0].write, false);
    assert.equal(calls.at(-1).terminal, false); assert.equal(calls.at(-1).computer, false);
    sharingConfirmed = true;
    await until(() => evaluate(`!${button("Share selected access")}.disabled`), "cancel sharing reset");
    await evaluate(`${button("Share selected access")}.click()`);
    await until(() => evaluate("document.body.textContent.includes('Sharing while this desktop is open')"), "saved sharing status rendered");
    await screenshot("computer-access.png");
    await evaluate(`${button("Stop sharing")}.click()`);
    await until(() => evaluate("document.body.textContent.includes('Not shared')"), "stop sharing applies immediately");
    await evaluate("document.querySelector('[aria-label=\"Close computer access\"]').click()");

    await evaluate("document.querySelector('[aria-label=\"Switch to My cloud team\"]').click()");
    await until(() => saved.activeId === "cloud", "Settings switch selected saved workspace");
    menuChoice = "workspace-local";
    await evaluate("document.querySelector('[aria-label^=\"Switch server:\"]').click()");
    await until(() => saved.activeId === "local", "native menu switched back to local");
    await evaluate("document.querySelector('[aria-label=\"Remove Research team\"]').click()");
    await until(() => calls.at(-1)?.kind === "forget", "forget requested");
    assert.equal(saved.environments.length, 2, "cancel forget retains saved workspace");
    await until(() => evaluate("!document.querySelector('[aria-label=\"Remove Research team\"]').disabled"), "forget cancellation reset");
    forgetConfirmed = true;
    await evaluate("document.querySelector('[aria-label=\"Remove Research team\"]').click()");
    await until(() => evaluate("!document.body.textContent.includes('Research team')"), "confirmed forget removed only selected entry");
    assert.deepEqual(saved.environments.map(({ id }) => id), ["cloud"]);
    assert.equal(saved.activeId, "local");
    win.setSize(390, 800);
    await until(() => evaluate("innerWidth === 390"), "narrow workspace viewport");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "workspace narrow layout overflow");
    await screenshot("connected-workspaces-narrow.png");

    // Real app shell, Settings navigation and onboarding against a disposable
    // fake-engine server. Opening the page must not require local AI setup.
    win.setSize(1180, 850);
    await win.loadURL(`${url}?app=1&desktop-settings=workspaces&share-computer=cloud`);
    await until(() => evaluate("Boolean(document.querySelector('[role=dialog] [data-server-connect]'))"), "app opens workspace connection settings");
    assert.equal(await evaluate("location.search.includes('desktop-settings')"), false, "Settings deep link consumed");
    await until(() => evaluate("document.body.textContent.includes('My cloud team')"), "app Settings loaded connections");
    await until(() => evaluate("document.body.textContent.includes('Computer access · My cloud team')"), "post-pair target opens its access controls");
    assert.equal(await evaluate("location.search.includes('share-computer')"), false);
    await evaluate("document.querySelector('[aria-label=\"Close computer access\"]').click()");
    assert.equal(await evaluate("Boolean(document.querySelector('[data-server-connect]'))"), true);
    await evaluate("document.querySelector('[data-server-connect]').scrollIntoView({ block: 'center', behavior: 'instant' })");
    await screenshot("workspace-settings-in-app.png");
    await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await until(() => evaluate("!document.body.textContent.includes('Connect to a server')"), "Settings closes normally");
    win.webContents.send("workspaces:open-settings");
    await until(() => evaluate("Boolean(document.querySelector('[role=dialog] [data-server-connect]'))"), "native request reopens workspace Settings");
    await evaluate("(() => { const el = document.querySelector('input[data-settings-search]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'appearance'); el.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await until(() => evaluate("Boolean(document.querySelector('[data-settings-hit]'))"), "Settings search shows matching destinations");
    win.webContents.send("workspaces:open-settings");
    await until(() => evaluate("document.body.textContent.includes('Connect to a server') && document.querySelector('input[data-settings-search]').value === ''"), "native connection request clears Settings search");

    const remote = await open(false);
    assert.deepEqual(await remote.webContents.executeJavaScript("({ server: typeof window.ogb?.environments, companion: typeof window.ogb?.remoteClient, sharing: typeof window.ogb?.computerSharing, node: typeof window.require, workspaceMethods: Object.keys(window.ogb?.workspaces ?? {}).sort() })"),
      { server: "undefined", companion: "undefined", sharing: "undefined", node: "undefined", workspaceMethods: ["add", "color", "homeOffers", "line", "local", "look", "makeHome", "menu", "onChanged", "onNewLocal", "open", "places", "probe", "recolor", "remove", "rename", "state"] });
    // Exercise Chromium's actual HttpOnly cookie jar and main-process fetch.
    // The server is the isolated fake-engine fixture, never the user's app.
    const opened = await fetch(`${serverUrl}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Electron fixture", scopes: ["client"] }) }).then(response => response.json());
    const paired = await session.defaultSession.fetch(`${serverUrl}/api/auth/pair`, { method: "POST", credentials: "include", headers: { "content-type": "application/json", origin: serverUrl }, body: JSON.stringify({ code: opened.code, cookie: true }) });
    assert.equal(paired.status, 200);
    const { createComputerSharing } = await import("../electron/computer-sharing.mjs");
    const { randomUUID } = await import("node:crypto");
    const nativeEnv = { id: "cookie-fixture", name: "Cookie fixture", origin: serverUrl };
    const sharing = createComputerSharing({ file: join(output, "native-profile", "sharing.json"), fetch: (...args) => session.defaultSession.fetch(...args), environments: () => [nativeEnv], enabled: async () => true, cuaConnection: async () => null });
    try {
      const identity = await sharing.observe(nativeEnv);
      assert.ok(identity?.sessionId, "main fetch sees real paired session cookie");
      const folder = join(output, "shared-folder"); mkdirSync(folder);
      await sharing.save(nativeEnv, { folders: [{ id: randomUUID(), path: folder, write: false }], terminal: false, computer: false }, identity);
      await until(() => sharing.state(nativeEnv.id).connected === true, "native connector registered using paired cookie");
      sharing.revoke(nativeEnv);
      assert.equal(sharing.state(nativeEnv.id).enabled, false);
    } finally { sharing.close(); }
    const unexpected = blockedRequests.filter(request => request.type !== "image" || request.url !== "https://www.google.com/s2/favicons");
    assert.deepEqual(unexpected, [], "unexpected external request attempted");
    const receipt = { passed: true, blockedIcons: blockedRequests.length, renderer: ["RemoteComputerSection", "ConnectedWorkspacesSettings", "DesktopWorkspaceSwitcher"], preload: "electron/preload.cjs", calls,
      checks: ["full custom HTTPS link unchanged", "pending submit disabled", "cancel reset", "rejection and retry", "companion six-digit routing", "390px overflow", "remote-safe bridge", "native connect menu item requests Settings", "hosted URL validation", "discovered server name", "pairing code excluded from saved list", "switch local/cloud", "cancel/confirm forget", "real app Settings deep link", "native Settings event and search reset", "feature-off hides sharing controls and stale deep link", "explicit opt-in enables fixture sharing", "sharing off by default", "read-only folder selection", "cancel/save sharing", "immediate revoke", "post-pair access deep link", "no sharing bridge in remote renderer"],
      nativeConnector: "Real HttpOnly pairing cookie → session.defaultSession.fetch → real fixture registration → revoke",
      limitation: "UI IPC replaces native dialogs, workspace persistence and navigation. Native sharing authentication tested against isolated HTTP server; no public DNS/TLS or live screen control tested." };
    writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify(receipt));
    app.exit(0);
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
} else {
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const { default: tailwindcss } = await import("@tailwindcss/vite");
  const { launchVerificationServer } = await import("./control-omb.ts");
  const fixture = await launchVerificationServer();
  const output = mkdtempSync(join(tmpdir(), "omb-server-connection-"));
  for (const dir of ["home", "user-data"]) mkdirSync(join(output, dir));
  const ui = await createServer({
    configFile: false, root, resolve: { alias: { "@": join(root, "src") } },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, realpathSync(join(root, "node_modules"))] }, proxy: { "/api": { target: fixture.info.url } } },
    plugins: [react(), tailwindcss(), {
      name: "server-connection-fixture",
      resolveId(id) { if (id === "virtual:server-connection") return `\0${id}`; },
      load(id) {
        if (id === "\0virtual:server-connection") return `import React from 'react'; import { createRoot } from 'react-dom/client'; import { setLocale } from '/src/lib/i18n.ts'; import { StoreProvider } from '/src/state/store.tsx'; import { RemoteComputerSection } from '/src/components/RemoteComputerSection.tsx'; import { ConnectedWorkspacesSettings } from '/src/components/ConnectedWorkspacesSettings.tsx'; import { DesktopWorkspaceSwitcher } from '/src/components/DesktopWorkspaceSwitcher.tsx'; import '/src/styles.css'; setLocale('en'); localStorage.setItem('omb-analytics-opt-out', '1'); const root = createRoot(document.getElementById('root')); if (location.search.includes('app=1')) { document.body.classList.remove('p-4'); import('/src/App.tsx').then(({default: App}) => root.render(React.createElement(App))); } else root.render(React.createElement(StoreProvider, null, location.search.includes('workspaces=1') ? React.createElement('div', { className: 'flex flex-col gap-5 max-w-2xl mx-auto' }, React.createElement(DesktopWorkspaceSwitcher), React.createElement('h1', { className: 'text-lg font-semibold text-ink' }, 'Servers'), React.createElement(ConnectedWorkspacesSettings)) : React.createElement(RemoteComputerSection)));`;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/__server-connection.html") return next();
          void server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Isolated server connection verification</title></head><body class="bg-app p-4"><div id="root"></div><script type="module" src="/@id/virtual:server-connection"></script></body></html>')
            .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
        });
      },
    }],
  });
  try {
    await ui.listen();
    const url = `${ui.resolvedUrls.local[0]}__server-connection.html`;
    console.log(JSON.stringify({ previewUrl: url, evidence: output }));
    const electron = createRequire(import.meta.url)("electron");
    const child = spawn(electron, [fileURLToPath(import.meta.url), fixtureFlag, url, output, fixture.info.url], {
      env: { PATH: process.env.PATH, HOME: join(output, "home"), XDG_CONFIG_HOME: join(output, "home"),
        TMPDIR: output, TEMP: output, TMP: output, DISPLAY: process.env.DISPLAY, SystemRoot: process.env.SystemRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => {
      appendFileSync(join(output, "electron.log"), data);
      process.stdout.write(data);
    });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const timeout = setTimeout(stop, 60_000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); })
      .finally(() => { clearTimeout(timeout); process.off("SIGINT", stop); process.off("SIGTERM", stop); });
    assert.equal(code, 0, `Electron smoke failed; inspect ${join(output, "electron.log")}`);
  } finally {
    await ui.close();
    await fixture.close();
    for (const dir of ["home", "user-data", "native-profile", "shared-folder"]) rmSync(join(output, dir), { recursive: true, force: true });
  }
}
