import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const flag = "--omb-bot-permissions-fixture";

if (process.versions.electron && process.argv.includes(flag)) {
  const { app, BrowserWindow, session } = await import("electron");
  const [url, output, serverUrl, adaId, benId, dataDir] = process.argv.slice(process.argv.indexOf(flag) + 1);
  app.setPath("userData", join(output, "user-data"));
  app.setPath("sessionData", join(output, "user-data"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.whenReady().then(async () => {
    const blocked = [];
    session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
      const target = new URL(request.url);
      const allowed = target.host === new URL(url).host || target.origin === serverUrl || target.protocol === "devtools:";
      if (!allowed) blocked.push(target.origin);
      callback({ cancel: !allowed });
    });
    const win = new BrowserWindow({ show: false, width: 1180, height: 900, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
    const evaluate = code => win.webContents.executeJavaScript(code);
    const until = async (check, description) => {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      writeFileSync(join(output, "failure.png"), (await win.webContents.capturePage()).toPNG());
      console.error(await evaluate("document.body.innerText"));
      console.error(JSON.stringify(errors));
      throw new Error(`Timed out: ${description}`);
    };
    const api = async path => {
      const response = await fetch(serverUrl + path);
      assert.equal(response.status, 200);
      return response.json();
    };
    const bot = async id => (await api("/api/bots?messages=0")).bots.find(row => row.id === id);
    const saved = id => JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")).find(row => row.id === id);
    const cell = (id, resource) => `(() => { const board = document.querySelector('[data-permission-board]'); const cols = [...board.querySelectorAll('thead tr')[1].querySelectorAll('th')]; const index = cols.findIndex(el => el.textContent.includes(${JSON.stringify(resource)})); if (index < 0) throw new Error('Missing column ' + ${JSON.stringify(resource)}); return board.querySelector('[data-permission-bot="${id}"]').querySelectorAll('input[type=checkbox]')[index]; })()`;
    const checked = (id, resource) => evaluate(`${cell(id, resource)}.checked`);
    const ready = () => until(() => evaluate(`Boolean(document.querySelector('[data-permission-bot="${adaId}"] input[type=checkbox]:not(:disabled)'))`), "real board and authoritative inventory");
    const toggle = async (id, resource, expected) => {
      await until(() => evaluate(`!${cell(id, resource)}.disabled`), `${resource} cell enabled`);
      await evaluate(`${cell(id, resource)}.click()`);
      await until(() => evaluate(`${cell(id, resource)}.checked === ${expected} && !${cell(id, resource)}.disabled`), `${resource} persisted tick`);
      assert.equal(await checked(id, resource), expected);
    };
    const screen = async name => {
      await evaluate("document.querySelector('[data-permission-board]').scrollIntoView({block:'start', behavior:'instant'})");
      await evaluate("new Promise(resolve => { for (const animation of document.getAnimations()) { try { animation.finish(); } catch {} } requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); })");
      writeFileSync(join(output, name), (await win.webContents.capturePage()).toPNG());
    };
    const receipts = [];
    // Advanced mode: the board sits on the You and your bots page; navigate away and back through the Settings nav.
    await win.loadURL(`${url}?advanced=1`);
    await ready();
    await evaluate("document.querySelector('[data-settings-page=\"overview\"]').click()");
    await until(() => evaluate("!document.querySelector('[data-permission-board]')"), "navigate away through the Settings nav");
    await evaluate("document.querySelector('[data-settings-page=\"bots\"]').click()");
    await ready();
    receipts.push({ mode: "advanced", pageNavigation: true });
    await screen("permissions-advanced.png");
    // Simple mode: the board comes back through Settings search, which turns Advanced on for what needs it.
    await win.loadURL(`${url}?advanced=0`);
    await until(() => evaluate("Boolean(document.querySelector('[data-settings-search]'))"), "Simple settings opens");
    assert.equal(await evaluate("Boolean(document.querySelector('[data-permission-board]'))"), false);
    await evaluate(`(() => { const el = document.querySelector('[data-settings-search]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'permissions'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await until(() => evaluate("Boolean(document.querySelector('[data-settings-hit=\"bot-permissions\"]'))"), "search offers the board in Simple mode");
    await evaluate("document.querySelector('[data-settings-hit=\"bot-permissions\"]').click()");
    await until(() => evaluate("localStorage.getItem('omb-advanced-mode') === '1'"), "opening the hit turns Advanced on");
    await ready();
    receipts.push({ mode: "simple", via: "settings search" });
    await screen("permissions-search-simple.png");
    assert.equal(await checked(adaId, "Gmail"), true);
    assert.equal(await checked(benId, "Gmail"), false);
    assert.equal(await checked(adaId, "notes"), true);
    assert.equal(await checked(benId, "notes"), true);
    assert.equal(await evaluate(`${cell(adaId, "disabled")}.disabled`), true);
    await toggle(adaId, "Gmail", false);
    assert.deepEqual((await bot(adaId)).connectorScopes, { apps: {} });
    assert.deepEqual(saved(adaId).connectorScopes, { apps: {} });
    await toggle(benId, "Gmail", true);
    assert.equal((await bot(benId)).composio, true);
    assert.deepEqual(saved(benId).connectorScopes, { apps: { gmail: "write" } });
    await toggle(adaId, "notes", false);
    assert.deepEqual(saved(adaId).mcpServers, ["tasks"]);
    await toggle(benId, "tasks", false);
    assert.deepEqual((await bot(benId)).mcpServers, ["notes"]);
    await toggle(adaId, "Gmail", true);
    assert.deepEqual(saved(adaId).connectorTools.gmail, { tools: ["GMAIL_FETCH_EMAILS"] });
    await toggle(benId, "Gmail", false);
    await toggle(benId, "Gmail", true);
    const stateBefore = [adaId, benId].map(id => { const row = saved(id); return { id, composio: row.composio, connectorScopes: row.connectorScopes, connectorTools: row.connectorTools, mcpServers: row.mcpServers }; });
    await screen("permissions-advanced.png");
    await evaluate("history.replaceState(null, '', '?advanced=1')");
    await win.reload();
    await ready();
    assert.equal(await checked(adaId, "Gmail"), true);
    assert.equal(await checked(benId, "Gmail"), true);
    assert.equal(await checked(adaId, "notes"), false);
    assert.equal(await checked(benId, "tasks"), false);
    const fill = async (index, value) => evaluate(`(() => { const el = document.querySelectorAll('[data-permission-board] input[type=search]')[${index}]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await fill(0, "Matrix Ada");
    await until(() => evaluate("document.querySelectorAll('[data-permission-bot]').length === 1"), "bot search narrows rows");
    await fill(0, "");
    await fill(1, "Gmail");
    await until(() => evaluate("document.querySelectorAll('[data-permission-board] thead th').length === 3"), "resource search narrows columns");
    await fill(1, "");
    await evaluate("(() => { const el = document.querySelector('[data-permission-board] select'); el.value = 'mcp'; el.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await until(() => evaluate("document.querySelectorAll('[data-permission-board] thead th').length === 5"), "MCP category narrows columns");
    assert.equal(await evaluate("[...document.querySelectorAll('[data-permission-board] thead th')].some(el => el.textContent.includes('Gmail'))"), false);
    await screen("permissions-mcp-filter.png");
    await evaluate("(() => { const el = document.querySelector('[data-permission-board] select'); el.value = 'all'; el.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await win.loadURL(`${url}?advanced=1&locale=ja`);
    await ready();
    assert.equal(await evaluate("document.documentElement.lang"), "ja");
    assert.equal(await evaluate("document.body.textContent.includes('Botのサービス・MCP権限')"), true);
    await screen("permissions-japanese.png");
    win.setContentSize(390, 844);
    await until(() => evaluate("innerWidth === 390"), "narrow viewport");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "no horizontal document overflow");
    assert.equal(await evaluate("(() => { const region = document.querySelector('[data-permission-board] [role=region]'); return region.scrollWidth > region.clientWidth; })()"), true, "wide matrix scroll is confined to its region");
    await screen("permissions-narrow.png");
    for (const skin of ["midnight", "daylight"]) {
      await evaluate(`document.documentElement.dataset.skin = ${JSON.stringify(skin)}`);
      for (const direction of ["ltr", "rtl"]) {
        await evaluate(`document.documentElement.dir = ${JSON.stringify(direction)}`);
        assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `${skin} ${direction}: no page overflow`);
        await evaluate("document.querySelector('[data-permission-board]').scrollIntoView({block:'start'})");
        await screen(`permissions-${skin}-${direction}-narrow.png`);
      }
    }
    await evaluate("document.documentElement.dir = 'ltr'");
    win.setContentSize(1180, 900);
    await until(() => evaluate("innerWidth === 1180"), "desktop viewport restored");
    for (const skin of ["midnight", "daylight"]) {
      await evaluate(`document.documentElement.dataset.skin = ${JSON.stringify(skin)}`);
      await screen(`permissions-${skin}.png`);
    }
    assert.deepEqual(blocked, [], "no external network request attempted");
    assert.deepEqual(errors, [], "no renderer errors");
    const receipt = { passed: true, renderer: ["SettingsModal", "StoreProvider", "BotPermissionBoard"], navigation: receipts, checks: ["two-bot initial ticks", "disabled global MCP", "real DOM service/MCP switches", "fresh HTTP and on-disk saved grants", "exact-tool grant preserved", "reload persistence", "bot search", "resource search", "MCP category", "Japanese locale loaded and rendered", "390px document overflow absent", "Midnight and Daylight in LTR and RTL", "region contains horizontal matrix scroll", "external requests absent"], state: stateBefore, screenshots: ["permissions-advanced.png", "permissions-search-simple.png", "permissions-mcp-filter.png", "permissions-japanese.png", "permissions-narrow.png", "permissions-midnight.png", "permissions-daylight.png", ...["midnight", "daylight"].flatMap(skin => ["ltr", "rtl"].map(direction => `permissions-${skin}-${direction}-narrow.png`))], limitation: "Mounts the real Settings modal and production store directly, not the entire app shell or packaged preload. All HTTP routes are real in a disposable fake-engine workspace with a loopback connected-app stand-in. No native dialogs, live credentials, or external service tested." };
    writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ passed: true, output, checks: receipt.checks }));
    app.exit(0);
  }).catch(error => { console.error(error); app.exit(1); });
} else {
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const { default: tailwindcss } = await import("@tailwindcss/vite");
  const { launchVerificationServer } = await import("./control-omb.ts");
  const { startFakeConnectedApps } = await import("../server/testing/fake-connected-apps.ts");
  const { removeTempDir } = await import("../server/testing/cleanup.ts");
  const apps = await startFakeConnectedApps();
  const fixture = await launchVerificationServer({ OMB_COMPOSIO_BROKER_URL: apps.url, OMB_COMPOSIO_BROKER_TOKEN: apps.token });
  const output = mkdtempSync(join(tmpdir(), "omb-bot-permissions-"));
  for (const dir of ["home", "user-data"]) mkdirSync(join(output, dir));
  const api = async (method, path, body, expected = 200) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${path}`);
    return result;
  };
  let ui;
  try {
    const ada = (await api("POST", "/api/bots", { name: "Matrix Ada" }, 201)).bot;
    const ben = (await api("POST", "/api/bots", { name: "Matrix Ben" }, 201)).bot;
    await api("PATCH", `/api/bots/${ada.id}`, { connectorScopes: { apps: { gmail: "read" } }, connectorTools: { gmail: { tools: ["GMAIL_FETCH_EMAILS"] } } });
    await api("PATCH", `/api/bots/${ben.id}`, { composio: false, connectorScopes: null, connectorTools: null });
    for (const name of ["notes", "tasks", "disabled"]) {
      await api("POST", "/api/mcp/servers", { name, command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", join(root, "server/testing/fake-mcp-server.ts")] }, 201);
      if (name !== "disabled") await api("PATCH", `/api/mcp/servers/${name}`, { enabled: true });
    }
    ui = await createServer({ configFile: false, root, resolve: { alias: { "@": join(root, "src") } }, server: { host: "127.0.0.1", port: 0, watch: { ignored: ["**/.privacy-dev/**"] }, proxy: { "/api": { target: fixture.info.url, ws: true } } }, plugins: [react(), tailwindcss(), {
      name: "bot-permissions-fixture",
      resolveId(id) { if (id === "virtual:bot-permissions") return `\0${id}`; },
      load(id) {
        if (id !== "\0virtual:bot-permissions") return;
        return `import React, { useEffect } from 'react'; import { createRoot } from 'react-dom/client'; import { StoreProvider, useStore } from '/src/state/store.tsx'; import { SettingsModal } from '/src/components/SettingsModal.tsx'; import { useOwnerOrAdmin } from '/src/lib/use-owner-or-admin.ts'; import { loadLocale } from '/src/lib/i18n.ts'; import '/src/styles.css'; await loadLocale(new URLSearchParams(location.search).get('locale') || 'en'); localStorage.setItem('omb-analytics-opt-out', '1'); localStorage.setItem('omb-advanced-mode', new URLSearchParams(location.search).get('advanced') || '0'); function Fixture() { const { state, dispatch } = useStore(); const allowed = useOwnerOrAdmin(); useEffect(() => { if (state.bots.length && state.config && allowed) dispatch({type:'toggleAppSettings', open:true, section:new URLSearchParams(location.search).get('advanced') === '1' ? 'bots' : 'overview'}); }, [Boolean(state.bots.length && state.config && allowed)]); return state.appSettingsOpen ? React.createElement(SettingsModal) : null; } createRoot(document.getElementById('root')).render(React.createElement(StoreProvider, null, React.createElement(Fixture)));`;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/__bot-permissions.html") return next();
          void server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Isolated bot permissions</title></head><body class="bg-app"><div id="root"></div><script type="module" src="/@id/virtual:bot-permissions"></script></body></html>').then(html => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
        });
      },
    }] });
    await ui.listen();
    const url = `${ui.resolvedUrls.local[0]}__bot-permissions.html`;
    console.log(JSON.stringify({ previewUrl: url, evidence: output, serverLogPath: fixture.info.logPath }));
    const electron = createRequire(import.meta.url)("electron");
    const child = spawn(electron, [fileURLToPath(import.meta.url), flag, url, output, fixture.info.url, ada.id, ben.id, fixture.info.dataDir], { env: { PATH: process.env.PATH, HOME: join(output, "home"), XDG_CONFIG_HOME: join(output, "home"), TMPDIR: output, TEMP: output, TMP: output, DISPLAY: process.env.DISPLAY, SystemRoot: process.env.SystemRoot }, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { appendFileSync(join(output, "electron.log"), data); process.stdout.write(data); });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    const timeout = setTimeout(stop, 120_000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => { clearTimeout(timeout); process.off("SIGINT", stop); process.off("SIGTERM", stop); });
    assert.equal(code, 0, `Electron smoke failed; inspect ${join(output, "electron.log")}`);
  } finally {
    await ui?.close();
    await fixture.close();
    await apps.close();
    await removeTempDir(join(output, "home"));
    await removeTempDir(join(output, "user-data"));
  }
}
