// Run: pnpm exec electron scripts/testing/inkbox-setup-ui-smoke.cjs
// Owns a throwaway Electron profile and fake loopback API; no Inkbox calls or live workspace.
const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");

const root = resolve(__dirname, "../..");
const profile = mkdtempSync(join(tmpdir(), "omb-inkbox-ui-"));
app.setPath("userData", join(profile, "electron"));
const evidence = join(root, ".omb-scratch/verify-evidence/inkbox-setup");
const idle = { available: true, phase: "disconnected", canReconnect: false, deliveries: [] };
const pairing = { number: "+15555550123", connectText: "connect @maus-fixture", smsLink: "sms:+15555550123?&body=connect%20%40maus-fixture" };
const paired = { ...idle, botId: "fixture-bot", ownerPhone: "+919876543210", canReconnect: true, phase: "awaiting_phone", approvalMode: "ask", pairing, capabilitiesAvailable: true, resources: [
  { channel: "email", status: "ready", address: "atlas@fixture.invalid", reason: "Read and send email with your bot." },
  { channel: "imessage", status: "ready", reason: "Link your phone below." },
  { channel: "sms", status: "needs_setup", reason: "Attach a phone number in Inkbox." },
  { channel: "calls", status: "ready", reason: "Ask your bot to place calls with Inkbox Voice AI." },
  { channel: "slack", status: "needs_setup", reason: "Connect a Slack workspace in Inkbox." },
  { channel: "a2a", status: "needs_setup", reason: "Enable agent communication in Inkbox." },
  { channel: "whatsapp", status: "unavailable", reason: "Inkbox does not currently offer a WhatsApp API." },
] };
let snapshot = idle;
let finishSetup;
let preview;
let window;
let server;
const calls = [];
const faults = [];
const json = (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
async function until(check) {
  const deadline = Date.now() + 20_000;
  do { const result = await check(); if (result) return result; await delay(25); } while (Date.now() < deadline);
  throw new Error(`Inkbox UI fixture timed out: ${faults.join("; ")}`);
}
app.whenReady().then(async () => {
  server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://127.0.0.1").pathname;
      if (req.method === "GET" && path === "/api/inkbox/setup") return json(res, snapshot);
      if (req.method !== "POST") return json(res, { error: "Unknown fixture route" }, 404);
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ path, body });
      if (path === "/api/inkbox/setup") {
        finishSetup = () => { snapshot = paired; json(res, snapshot); };
        return;
      }
      if (path === "/api/inkbox/setup/disconnect") { snapshot = { ...paired, phase: "disconnected", pairing: undefined }; return json(res, snapshot); }
      if (path === "/api/inkbox/setup/reconnect") { snapshot = paired; return json(res, snapshot); }
      return json(res, { error: "Unknown fixture mutation" }, 404);
    } catch (error) { faults.push(error.message); json(res, { error: "Fixture failed" }, 500); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const { mountPreview } = await import(pathToFileURL(join(root, "scripts/testing/preview-fixture.ts")).href);
  preview = await mountPreview({ info: { url: apiUrl } }, { entry: "/scripts/testing/inkbox-setup-preview.tsx", route: "/__inkbox-setup-preview.html", title: "Isolated iMessage setup", logLevel: "error" });
  const browserSession = session.fromPartition(`inkbox-ui-fixture-${Date.now()}`);
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const allowed = ["http:", "ws:"].includes(url.protocol) && url.hostname === "127.0.0.1" || ["devtools:", "data:"].includes(url.protocol);
    if (!allowed) faults.push(`Blocked external request to ${url.origin}`);
    callback({ cancel: !allowed });
  });
  window = new BrowserWindow({ show: false, width: 900, height: 1600, webPreferences: { contextIsolation: true, sandbox: true, session: browserSession } });
  window.webContents.on("console-message", event => { if (event.level === "error") faults.push(event.message); });
  window.webContents.on("render-process-gone", (_event, details) => faults.push(`renderer ${details.reason}`));
  const evaluate = js => window.webContents.executeJavaScript(js);
  const click = async label => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) throw new Error('Missing enabled fixture button'); button.click(); return true; })()`);
  const textIncludes = value => evaluate(`document.body.textContent.includes(${JSON.stringify(value)})`);
  const capture = async name => writeFileSync(join(evidence, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  mkdirSync(evidence, { recursive: true });
  await window.loadURL(preview.previewUrl);
  await until(() => evaluate("document.querySelector('input[type=password]') !== null"));
  assert.equal(await evaluate("document.querySelector('select').textContent"), "Atlas");
  await capture("01-form");
  await evaluate(`(() => { for (const [label, value] of [['Inkbox API key', 'synthetic-fixture-key'], ['Your phone number', '+919876543210']]) { const field = document.querySelector('input[aria-label="' + label + '"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
  await until(() => evaluate("[...document.querySelectorAll('button')].some(button => button.textContent === 'Connect' && !button.disabled)"));
  await click("Connect");
  await until(() => Boolean(finishSetup));
  assert.deepEqual(calls[0], { path: "/api/inkbox/setup", body: { apiKey: "synthetic-fixture-key", botId: "fixture-bot", ownerPhone: "+919876543210" } });
  await until(() => evaluate("document.querySelector('input[type=password]').value === '' && document.querySelector('fieldset').disabled"));
  assert.equal(await evaluate("JSON.stringify(localStorage).includes('synthetic-fixture-key') || document.documentElement.outerHTML.includes('synthetic-fixture-key')"), false);
  finishSetup();
  await until(() => textIncludes("Waiting for your first message"));
  assert.equal(await evaluate("document.querySelector('a[href^=\"sms:\"]') === null"), true);
  // A fixture clipboard keeps this smoke from replacing the user's actual clipboard.
  await evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.fixtureCopiedText = text; } } }); true");
  await click("Copy connect message");
  await until(() => textIncludes("Connect message copied"));
  assert.equal(await evaluate("window.fixtureCopiedText"), pairing.connectText);
  assert.equal(await evaluate("Boolean(document.querySelector('svg[role=img]')) && document.querySelector('img') === null"), true);
  assert.equal(await textIncludes("What your bot can use"), true);
  assert.equal(await textIncludes("atlas@fixture.invalid"), true);
  assert.equal(await textIncludes("Not supported"), true);
  assert.equal(await textIncludes("Approvals and questions are answered in Mausbot"), false);
  assert.equal(await textIncludes("Messaging approvals: Ask first"), true);
  await capture("02-pairing");
  window.setSize(390, 1600);
  await delay(100);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
  await capture("05-narrow-channels");
  window.setSize(900, 1600);
  snapshot = { ...paired, phase: "connected", approvalMode: "auto", deliveries: [{ id: "fixture-delivery", sender: "+919876543210", status: "sent", reply: "Hello from the synthetic fixture." }] };
  await until(() => textIncludes("Your message reached Mausbot"));
  assert.equal(await textIncludes("Hello from the synthetic fixture."), true);
  assert.equal(await textIncludes("Messaging approvals: Automatic"), true);
  await capture("03-message-received");
  await click("Disconnect");
  await until(() => evaluate("[...document.querySelectorAll('button')].some(button => button.textContent === 'Reconnect')"));
  assert.equal(await evaluate("document.querySelector('input[type=password]') === null"), true);
  await capture("04-disconnected");
  await click("Reconnect");
  await until(() => textIncludes("Waiting for your first message"));
  assert.deepEqual(calls.slice(1), [{ path: "/api/inkbox/setup/disconnect", body: undefined }, { path: "/api/inkbox/setup/reconnect", body: undefined }]);
  assert.deepEqual(faults, []);
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ passed: true, checks: ["bot-selection", "form-submit", "key-cleared-while-pending", "local-qr-apple-sms-uri", "copy-connect-message", "observed-message", "disconnect", "reconnect-without-key", "discovered-channel-status", "unsupported-channel-label", "narrow-channel-layout", "messaging-approval-preference"], calls: calls.map(({ path }) => path) }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence, screenshots: 5 }));
}).catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  window?.destroy();
  await preview?.close();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  rmSync(profile, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
