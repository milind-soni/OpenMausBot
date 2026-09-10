// Real Settings component + production preload, offline IPC responses only.
// Run: node scripts/verify-server-connection.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureFlag = "--omb-server-connection-fixture";

if (process.versions.electron && process.argv.includes(fixtureFlag)) {
  const { app, BrowserWindow, ipcMain, session } = await import("electron");
  const [url, output] = process.argv.slice(process.argv.indexOf(fixtureFlag) + 1);
  app.setPath("userData", join(output, "user-data"));
  app.setPath("sessionData", join(output, "user-data"));
  app.commandLine.appendSwitch("disable-background-networking");
  const calls = [];
  let pending;
  ipcMain.handle("desktop-remote:state", () => ({ active: false }));
  ipcMain.handle("desktop-remote:pair", (_event, endpoint, code) => {
    calls.push({ kind: "companion", endpoint, code });
    throw new Error("Fixture companion pairing rejected");
  });
  ipcMain.handle("environments:add-from-link", (_event, link) => {
    calls.push({ kind: "server", link });
    return new Promise((resolve, reject) => { pending = { resolve, reject }; });
  });

  app.whenReady().then(async () => {
    const blockedRequests = [];
    session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
      const target = new URL(request.url);
      const allowed = target.host === new URL(url).host;
      if (!allowed) blockedRequests.push(target.origin);
      callback({ cancel: !allowed });
    });
    const open = async (local) => {
      const win = new BrowserWindow({
        show: false, width: 720, height: 650,
        webPreferences: {
          preload: join(root, "electron/preload.cjs"), contextIsolation: true,
          sandbox: true, nodeIntegration: false,
          additionalArguments: [`--omb-local-origin=${local ? new URL(url).origin : "https://remote-fixture.invalid"}`],
        },
      });
      await win.loadURL(url);
      return win;
    };
    const win = await open(true);
    const evaluate = (code) => win.webContents.executeJavaScript(code);
    const until = async (check, description) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
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
    writeFileSync(join(output, "server-form.png"), (await win.webContents.capturePage()).toPNG());

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
    writeFileSync(join(output, "server-form-narrow.png"), (await win.webContents.capturePage()).toPNG());

    const remote = await open(false);
    assert.deepEqual(await remote.webContents.executeJavaScript("({ server: typeof window.ogb?.environments, companion: typeof window.ogb?.remoteClient, node: typeof window.require })"),
      { server: "undefined", companion: "undefined", node: "undefined" });
    assert.deepEqual(blockedRequests, [], "unexpected external request attempted");
    const receipt = { passed: true, renderer: "RemoteComputerSection", preload: "electron/preload.cjs", calls,
      checks: ["full custom HTTPS link unchanged", "pending submit disabled", "cancel reset", "rejection and retry", "companion six-digit routing", "390px overflow", "remote-safe bridge"],
      limitation: "Fixture IPC replaces native confirmation, persistence and navigation; no server authentication or public DNS/TLS tested." };
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
  const output = mkdtempSync(join(tmpdir(), "omb-server-connection-"));
  for (const dir of ["home", "user-data"]) mkdirSync(join(output, dir));
  const ui = await createServer({
    configFile: false, root, resolve: { alias: { "@": join(root, "src") } },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [react(), tailwindcss(), {
      name: "server-connection-fixture",
      resolveId(id) { if (id === "virtual:server-connection") return `\0${id}`; },
      load(id) {
        if (id === "\0virtual:server-connection") return `import React from 'react'; import { createRoot } from 'react-dom/client'; import { setLocale } from '/src/lib/i18n.ts'; import { RemoteComputerSection } from '/src/components/RemoteComputerSection.tsx'; import '/src/styles.css'; setLocale('en'); createRoot(document.getElementById('root')).render(React.createElement(RemoteComputerSection));`;
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/__server-connection.html") return next();
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
    const child = spawn(electron, [fileURLToPath(import.meta.url), fixtureFlag, url, output], {
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
    for (const dir of ["home", "user-data"]) rmSync(join(output, dir), { recursive: true, force: true });
  }
}
