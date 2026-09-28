// Disposable real Electron/preload/renderer/native-transfer smoke. No live URLs.
// The Admin and object store are deliberately tiny loopback test doubles, not R2.
// Run: node scripts/verify-company-backups.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const flag = "--omb-company-backup-fixture";
const PASSWORD = "isolated-cloud-backup-password";
const MARKER = "omb-pending-workspace-restore";
const pause = ms => new Promise(done => setTimeout(done, ms));

if (process.versions.electron && process.argv.includes(flag)) {
  const { app, BrowserWindow, ipcMain, session } = await import("electron");
  const { createCompanyBackups } = await import("../electron/company-backups.mjs");
  const { createCompanyBackupSchedule } = await import("../electron/company-backup-schedule.mjs");
  const [url, output, runtimeUrl, sourceBotId, fixtureDataDir] = process.argv.slice(process.argv.indexOf(flag) + 1);
  const localOrigin = new URL(url).origin;
  app.setPath("userData", join(output, "user-data"));
  app.setPath("sessionData", join(output, "user-data"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.on("window-all-closed", () => {}); // The smoke deliberately reopens its only window.
  const entries = new Map(), objects = new Map(), uploadedParts = new Map();
  const checks = [], progressPhases = new Set();
  let win, origin, prepared = null, transferController = null;
  let state = { busy: false }, organization = { status: "signed-out" };
  let cloudRequests = 0, createCalls = 0, restoreCalls = 0, deleteCalls = 0, objectRequests = 0;
  let scheduler, scheduleRecord = null, scheduleTimer = null, scheduleClock = Date.now(), scheduledRuns = 0, snapshotRequest = null;
  const metadata = entry => ({ id: entry.id, status: entry.status, sizeBytes: entry.sizeBytes, sha256: entry.sha256,
    passwordRequired: false,
    appVersion: entry.appVersion, createdAt: entry.createdAt, ...(entry.completedAt ? { completedAt: entry.completedAt } : {}) });
  const body = async req => {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 8 * 1024 ** 2, "fixture body stays below 8 MiB"); chunks.push(chunk); }
    return Buffer.concat(chunks);
  };
  const admin = createHttpServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    try {
      const path = new URL(req.url, origin).pathname;
      const object = /^\/objects\/([a-f0-9-]+)\/(\d+)$/.exec(path);
      if (object) {
        objectRequests++;
        assert.equal(req.headers.authorization, undefined, "device credentials never reach object storage");
        assert.equal(req.headers.cookie, undefined);
        const entry = entries.get(object[1]); assert.ok(entry);
        if (req.method === "PUT") {
          const data = await body(req); assert.equal(data.length, entry.sizeBytes);
          assert.equal(data.subarray(0, 16).toString(), "OMB-WORKSPACE-1\n");
          assert.equal(createHash("sha256").update(data).digest("hex"), entry.sha256);
          const etag = `"${createHash("md5").update(data).digest("hex")}"`;
          uploadedParts.set(entry.id, { data, etag });
          // Keep real progress visible long enough to inspect and capture it.
          await pause(550);
          res.writeHead(200, { etag }); res.end(); return;
        }
        assert.equal(req.method, "GET");
        const data = objects.get(entry.id); assert.ok(data);
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length }); res.end(data); return;
      }
      cloudRequests++;
      assert.equal(req.headers.authorization, "Bearer fixture-device-capability");
      const bytes = await body(req);
      const input = bytes.length ? JSON.parse(bytes.toString()) : {};
      assert.equal(JSON.stringify(input).includes(PASSWORD), false, "archive password stays local");
      if (path === "/api/desktop/backups" && req.method === "GET") return reply(200, {
        backups: [...entries.values()].map(metadata), usedBytes: [...entries.values()].reduce((total, entry) => total + entry.sizeBytes, 0),
        limits: { ownerQuotaBytes: 30 * 1024 ** 3, retainedSnapshots: 7 },
      });
      if (path === "/api/desktop/backups" && req.method === "POST") {
        assert.ok(input.sizeBytes > 60 && input.sizeBytes < 8 * 1024 ** 2);
        assert.match(input.sha256, /^[a-f0-9]{64}$/);
        assert.deepEqual(Object.keys(input).sort(), ["appVersion", "sha256", "sizeBytes", "unlockKey"]);
        assert.match(input.unlockKey, /^[A-Za-z0-9_-]{43}$/);
        const entry = { ...input, id: randomUUID(), status: "uploading", createdAt: Date.now() };
        entries.set(entry.id, entry);
        return reply(201, { ...metadata(entry), partSizeBytes: 64 * 1024 ** 2, partCount: 1 });
      }
      const route = /^\/api\/desktop\/backups\/([a-f0-9-]+)(?:\/(.*))?$/.exec(path);
      assert.ok(route); const entry = entries.get(route[1]); assert.ok(entry);
      if (route[2] === "parts/1") return reply(200, { partNumber: 1, sizeBytes: entry.sizeBytes,
        url: `${origin}/objects/${entry.id}/1?signature=synthetic-only`, expiresAt: Date.now() + 300_000,
        headers: { "content-length": String(entry.sizeBytes) } });
      if (route[2] === "complete") {
        const part = uploadedParts.get(entry.id); assert.ok(part);
        assert.deepEqual(input.parts, [{ partNumber: 1, etag: part.etag }]);
        objects.set(entry.id, part.data); uploadedParts.delete(entry.id);
        entry.status = "ready"; entry.completedAt = Date.now(); return reply(200, metadata(entry));
      }
      if (route[2] === "download") {
        assert.equal(entry.status, "ready");
        return reply(200, { ...metadata(entry), unlockKey: entry.unlockKey, url: `${origin}/objects/${entry.id}/1?signature=synthetic-only`, expiresAt: Date.now() + 300_000 });
      }
      if (route[2] === "abort" || req.method === "DELETE") {
        entries.delete(entry.id); objects.delete(entry.id); uploadedParts.delete(entry.id); return reply(200, { deleted: true });
      }
      reply(404, { error: "not_found" });
    } catch (error) { console.error(`Synthetic storage assertion: ${error.message}`); reply(500, { error: "fixture_assertion" }); }
  });
  await new Promise(done => admin.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${admin.address().port}`;
  const localRequest = (path, init = {}) => {
    assert.match(path, /^\/api\/workspace-backup\/(?:status|export|upload|preview|restore|download\/[a-f0-9-]+)$/);
    return fetch(`${runtimeUrl}${path}`, { ...init, redirect: "error", credentials: "omit" });
  };
  const localJson = async (path, input) => {
    const response = await localRequest(path, input === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const portalRequest = async (path, { body, method = "GET", signal } = {}) => {
    const response = await fetch(`${origin}${path}`, { method, signal, redirect: "error", headers: {
      authorization: "Bearer fixture-device-capability", "content-type": "application/json",
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok); return response.json();
  };
  const publish = next => {
    state = { ...next, ...(scheduler ? { schedule: scheduler.state() } : {}) };
    if (win && !win.isDestroyed()) win.webContents.send("company-backups:state-changed", state);
  };
  const transfer = async (kind, input) => {
    assert.equal(transferController, null);
    assert.equal((await localJson("/api/workspace-backup/status")).pendingRestore, false);
    const controller = new AbortController(); transferController = controller; prepared = null;
    publish({ busy: true, kind });
    try {
      const native = createCompanyBackups({ localRequest, portalRequest, tempRoot: join(output, "transfer-cache"), allowLoopbackForTests: true });
      const progress = progress => { progressPhases.add(progress.phase); publish({ busy: true, kind, progress }); };
      const result = kind === "backup" ? await native.backup({ ...input, appVersion: "0.1.78" }, controller.signal, progress)
        : await native.prepareRestore(input, controller.signal, progress);
      if (kind === "restore") prepared = result.id;
      publish({ busy: false }); return result;
    } catch (error) { publish({ busy: false, message: error.message }); throw new Error(error.message); }
    finally { transferController = null; }
  };
  const handle = (channel, callback) => ipcMain.handle(channel, (event, input) => {
    assert.equal(event.sender, win.webContents); assert.equal(new URL(event.senderFrame.url).origin, localOrigin);
    return callback(input);
  });
  // The production preload supplies fresh, allowlisted state. Main routing is
  // synthetic here; production origin/generation checks have separate tests.
  ipcMain.on("company-backups:client-state", (event, value) => {
    if (!snapshotRequest || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || value?.requestId !== snapshotRequest.id) return;
    snapshotRequest.resolve(value); snapshotRequest = null;
  });
  const snapshot = async () => {
    const id = randomUUID();
    const result = new Promise(resolve => { snapshotRequest = { id, resolve }; });
    win.webContents.send("company-backups:collect-client-state", { requestId: id });
    const value = await Promise.race([result, pause(3_000).then(() => { throw new Error("Fixture snapshot timeout"); })]);
    assert.equal(value.unavailable, undefined); return value.clientState;
  };
  scheduler = createCompanyBackupSchedule({
    store: { read: async () => structuredClone(scheduleRecord), write: async value => { scheduleRecord = structuredClone(value); } },
    scope: () => organization.status === "connected" && organization.cloudBackups ? { key: "fixture-portal/company/employee/device/workspace", generation: 1 } : null,
    now: () => scheduleClock,
    setTimer: callback => { scheduleTimer = callback; return callback; },
    clearTimer: callback => { if (scheduleTimer === callback) scheduleTimer = null; },
    run: async (signal) => {
      signal.throwIfAborted();
      const clientState = await snapshot(); signal.throwIfAborted();
      assert.equal(Object.hasOwn(clientState, "fixture-auth-token"), false);
      const abort = () => transferController?.abort(); signal.addEventListener("abort", abort, { once: true });
      try { await transfer("backup", { clientState }); scheduledRuns++; }
      finally { signal.removeEventListener("abort", abort); }
    },
    onState: () => publish(state),
  });
  handle("company-backups:configure-schedule", async input => { await scheduler.configure(input); return state; });
  handle("organization:state", () => organization);
  handle("company-backups:state", async () => ({ ...state, pendingRestore: (await localJson("/api/workspace-backup/status")).pendingRestore }));
  handle("company-backups:list", () => portalRequest("/api/desktop/backups"));
  handle("company-backups:create", input => {
    assert.equal(input.clientState["omb-drafts"], "fixture private draft");
    assert.equal(Object.hasOwn(input.clientState, "fixture-auth-token"), false);
    createCalls++; return transfer("backup", input);
  });
  handle("company-backups:preview", input => transfer("restore", input));
  handle("company-backups:cancel", () => transferController?.abort());
  handle("company-backups:delete", input => {
    assert.equal(input.confirmation, "DELETE"); assert.ok(entries.has(input.id)); deleteCalls++;
    return portalRequest(`/api/desktop/backups/${input.id}`, { method: "DELETE" });
  });
  handle("company-backups:restore", async input => {
    assert.equal(input.id, prepared); assert.equal(input.confirmation, "REPLACE");
    assert.equal(await win.webContents.executeJavaScript(`localStorage.getItem(${JSON.stringify(MARKER)})`), input.id, "recovery marker persisted before native commit");
    prepared = null; restoreCalls++;
    const result = await localJson("/api/workspace-backup/restore", input);
    publish({ busy: false, pendingRestore: true }); return { restoreId: result.id };
  });

  app.whenReady().then(async () => {
    await scheduler.start();
    session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
      const target = new URL(request.url);
      callback({ cancel: target.host !== new URL(url).host && target.origin !== runtimeUrl });
    });
    const open = async local => {
      const window = new BrowserWindow({ show: false, width: 850, height: 850, webPreferences: {
        preload: join(root, "electron/preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false,
        additionalArguments: [`--omb-local-origin=${local ? localOrigin : "https://remote-fixture.invalid"}`, "--omb-company-desktop=1"],
      } });
      return window;
    };
    win = await open(true); await win.loadURL(url);
    const evaluate = code => win.webContents.executeJavaScript(code);
    const until = async (check, description) => {
      for (let attempt = 0; attempt < 700; attempt++) { if (await check()) return; await pause(30); }
      writeFileSync(join(output, "failure.png"), (await win.webContents.capturePage()).toPNG());
      throw new Error(`Timed out: ${description}`);
    };
    const screenshot = async name => { await pause(150); writeFileSync(join(output, name), (await win.webContents.capturePage()).toPNG()); };
    const button = label => `[...(document.querySelector('dialog[open]') || document).querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
    const click = async label => { await until(() => evaluate(`Boolean(${button(label)}) && !${button(label)}.disabled`), label); await evaluate(`${button(label)}.click()`); };
    const fill = (selector, value, index = 0) => evaluate(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if(!el) throw Error('Fixture input absent'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    const rowClick = (id, label) => evaluate(`(() => { const row = [...document.querySelectorAll('li')].find(el => el.textContent.includes(${JSON.stringify(id)})); const el = [...row.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)}); if(el.disabled) throw Error('Disabled fixture action'); el.click(); })()`);
    const pushOrganization = value => { organization = value; win.webContents.send("organization:state-changed", value); };
    const connected = { status: "connected", cloudBackups: true, organization: { id: "fixture-company", name: "Fixture Studio" }, email: "employee@example.test", deviceId: "fixture-desktop" };
    await until(() => evaluate("document.body.dataset.ready === 'true'"), "fixture renderer mounted");
    await pause(200); assert.equal(cloudRequests, 0);
    assert.equal(await evaluate("document.body.textContent.includes('Company cloud backups')"), false);
    pushOrganization({ ...connected, cloudBackups: false }); await pause(200);
    assert.equal(cloudRequests, 0);
    pushOrganization(connected);
    await until(() => evaluate("document.body.textContent.includes('No completed cloud backups yet.')"), "eligible company gate");
    assert.equal(createCalls, 0); checks.push("signed-out and no-capability states make no cloud calls; connected user explicitly opts in");
    assert.equal(await evaluate("typeof require"), "undefined");
    assert.equal(await evaluate("JSON.stringify(window.ogb.companyBackups).includes('fixture-device-capability')"), false);
    await click("Back up this installation");
    await until(() => evaluate("Boolean(document.querySelector('dialog[open]'))"), "cancelable native dialog");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await until(() => evaluate("!document.querySelector('dialog[open]')"), "Escape closes only the upload dialog");
    assert.equal(createCalls, 0);

    const createBackup = async capture => {
      await click("Back up this installation");
      await until(() => evaluate("Boolean(document.querySelector('dialog[open]'))"), "native upload dialog");
      assert.equal(await evaluate("document.querySelector('dialog[open]').textContent.includes('THIS installation')"), true);
      assert.equal(await evaluate("document.querySelectorAll('dialog input[type=password]').length"), 0);
      assert.equal(await evaluate("document.querySelector('dialog button[type=submit]').disabled"), false);
      if (capture) await screenshot("company-backup-upload-confirmation.png");
      const previous = entries.size;
      await click("Back up this installation");
      await until(() => evaluate("document.body.textContent.includes('Uploading encrypted backup')"), "native upload progress");
      if (capture) await screenshot("company-backup-upload-progress.png");
      await until(() => entries.size > previous && [...entries.values()].at(-1).status === "ready" && !state.busy, "completed encrypted cloud archive");
      const id = [...entries.keys()].at(-1);
      await until(() => evaluate(`!document.querySelector('dialog[open]') && document.body.textContent.includes(${JSON.stringify(id)})`), "dated completed list row");
      assert.ok(objects.get(id).length > 60);
      assert.equal(objects.get(id).includes(Buffer.from("fixture private draft")), false);
      return id;
    };
    await evaluate("localStorage.setItem('omb-drafts','fixture private draft'); localStorage.setItem('fixture-auth-token','must-stay-local');");
    const first = await createBackup(true), second = await createBackup(false);
    assert.equal(createCalls, 2);
    assert.equal(await evaluate(`Object.values({...localStorage}).some(value => value.includes(${JSON.stringify(PASSWORD)}))`), false, "backup password never persisted in browser storage");
    assert.equal(await evaluate("document.body.textContent.includes('30 GiB') && document.body.textContent.includes('snapshots kept')"), true);
    await screenshot("company-backup-ready-list.png");
    checks.push("passwordless native encryption, SHA256, multipart upload/completion, progress, dates and quota");

    await rowClick(second, "Delete cloud backup");
    await fill("dialog input", "delete");
    assert.equal(await evaluate(`${button("Delete cloud backup")}.disabled`), true);
    await click("Cancel"); assert.equal(deleteCalls, 0); assert.equal(entries.size, 2);
    await rowClick(second, "Delete cloud backup"); await fill("dialog input", "DELETE");
    assert.equal(await evaluate(`document.querySelector('dialog').textContent.includes(${JSON.stringify(second)})`), true);
    await screenshot("company-backup-delete-confirmation.png"); await click("Delete cloud backup");
    await until(() => entries.size === 1 && !state.busy, "only selected archive deleted");
    assert.equal(deleteCalls, 1); assert.ok(entries.has(first)); assert.ok(objects.has(first));
    await until(() => evaluate("!document.querySelector('dialog[open]')"), "deletion dialog closed");
    checks.push("DELETE is case-sensitive, cancel preserves both archives, confirmed delete removes only selected archive");
    win.setSize(390, 780); await until(() => evaluate("innerWidth === 390"), "narrow list viewport");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    await screenshot("company-backup-ready-narrow.png");

    // This new real bot must survive preview and disappear only after REPLACE + restart.
    const extraResponse = await fetch(`${runtimeUrl}/api/bots`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Created after cloud snapshot" }) });
    assert.equal(extraResponse.status, 201); const extra = await extraResponse.json();
    const botIds = async () => (await (await fetch(`${runtimeUrl}/api/bots`)).json()).bots.map(bot => bot.id);
    assert.ok((await botIds()).includes(extra.bot.id));
    await rowClick(first, "Restore this backup");
    assert.equal(await evaluate("document.querySelectorAll('dialog input[type=password]').length"), 0);
    await click("Validate backup");
    await until(() => evaluate("document.body.textContent.includes('Validated backup')"), "actual decrypted archive preview");
    assert.equal(restoreCalls, 0); assert.ok((await botIds()).includes(extra.bot.id));
    assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(MARKER)})`), null);
    win.setSize(390, 780); await until(() => evaluate("innerWidth === 390"), "narrow viewport");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth && document.querySelector('dialog').scrollWidth <= document.querySelector('dialog').clientWidth + 1"), true);
    await screenshot("company-backup-preview-narrow.png");
    await fill("dialog input", "replace"); assert.equal(await evaluate(`${button("Replace installation")}.disabled`), true);
    await fill("dialog input", "REPLACE");
    await evaluate("document.querySelector('dialog input').scrollIntoView({block:'center'}); document.querySelector('dialog input').focus();");
    await screenshot("company-backup-replace-narrow.png");
    await click("Replace installation");
    await until(() => evaluate("document.body.textContent.includes('Fully quit OpenMausBot') && !document.querySelector('dialog[open]')"), "restart-required confirmation");
    const restoreId = await evaluate(`localStorage.getItem(${JSON.stringify(MARKER)})`);
    assert.match(restoreId, /^[a-f0-9-]{36}$/); assert.equal(restoreCalls, 1);
    assert.equal((await localJson("/api/workspace-backup/status")).pendingRestore, true);
    assert.equal((await fetch(`${runtimeUrl}/api/bots`)).status, 503, "workspace locked until restart");
    await screenshot("company-backup-pending-restart.png");
    checks.push("passwordless real preview preserves live data; narrow layout fits; typed REPLACE stages without live replacement");

    // A new renderer instance, not the component's transient restart state.
    win.destroy(); win = await open(true); await win.loadURL(url);
    await until(() => evaluate("document.body.textContent.includes('Fully quit OpenMausBot')"), "pending restore on reopen");
    assert.equal(await evaluate("document.body.textContent.includes('Back up this installation')"), false);
    checks.push("pending restore survives closing and reopening the renderer");
    const restarted = new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error("Owned runtime restart timed out")), 35_000);
      process.once("message", message => { clearTimeout(timer); if (message.ok) done(message); else reject(new Error(message.error)); });
    });
    process.send({ type: "restart-fixture" }); await restarted;
    publish({ busy: false });
    await win.reload();
    await until(() => evaluate(`localStorage.getItem(${JSON.stringify(MARKER)}) === null && document.body.textContent.includes('Company cloud backups')`), "existing recovery restores drafts and clears marker");
    const afterIds = await botIds(); assert.ok(afterIds.includes(sourceBotId)); assert.equal(afterIds.includes(extra.bot.id), false);
    assert.equal(await evaluate("localStorage.getItem('omb-drafts')"), "fixture private draft");
    assert.equal(await evaluate("localStorage.getItem('fixture-auth-token')"), "must-stay-local");
    const afterStatus = await localJson("/api/workspace-backup/status");
    assert.equal(afterStatus.lastRestoreId, restoreId); assert.ok(afterStatus.safetyCopyPath);
    await screenshot("company-backup-restored-after-reopen.png");
    checks.push("exact fixture runtime restart restores snapshot IDs, removes later bot, retains safety copy and runs existing draft recovery");

    // Real schedule + renderer/preload + exporter. Only clock/store/authority are
    // synthetic. Setting a schedule must not create an archive immediately.
    assert.equal(scheduler.state().enabled, false); assert.equal(scheduleRecord, null);
    win.setSize(390, 780); await until(() => evaluate("innerWidth === 390"), "narrow daily backup viewport");
    const switchSelector = "document.querySelector('button[role=switch][aria-label=\"Daily backups\"]')";
    await until(() => evaluate(`Boolean(${switchSelector})`), "daily backup switch");
    await evaluate(`${switchSelector}.click()`);
    await until(() => evaluate("Boolean(document.querySelector('dialog[open]'))"), "daily backup consent dialog");
    assert.equal(await evaluate("document.querySelectorAll('dialog input[type=password]').length"), 0);
    assert.equal(await evaluate(`${button("Enable daily backups")}.disabled`), true, "explicit schedule consent is still needed");
    await evaluate("document.querySelector('dialog input[type=checkbox]').click()");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth && document.querySelector('dialog').scrollWidth <= document.querySelector('dialog').clientWidth + 1"), true);
    await screenshot("company-backup-schedule-consent-narrow.png");
    await evaluate("document.querySelector('dialog input[type=checkbox]').scrollIntoView({block:'center'})");
    await screenshot("company-backup-schedule-confirmation-narrow.png");
    const existingArchives = entries.size;
    await click("Enable daily backups");
    await until(() => scheduler.state().enabled && !snapshotRequest, "daily consent saved");
    assert.equal(entries.size, existingArchives); assert.equal(scheduledRuns, 0);
    assert.equal(scheduler.state().nextBackupAt, scheduleClock + 24 * 60 * 60_000);
    assert.equal(JSON.stringify(scheduler.state()).includes(PASSWORD), false);
    assert.equal(await evaluate(`Object.values({...localStorage}).some(value => value.includes(${JSON.stringify(PASSWORD)}))`), false);
    for (const draft of ["new draft from scheduled day one", "changed draft from scheduled day two"]) {
      await evaluate(`localStorage.setItem('omb-drafts', ${JSON.stringify(draft)})`);
      const previousRuns = scheduledRuns;
      scheduleClock = scheduler.state().nextBackupAt + (previousRuns ? 7 * 24 * 60 * 60_000 : 0);
      const tick = scheduleTimer; assert.equal(typeof tick, "function"); tick();
      await until(() => scheduledRuns === previousRuns + 1 && scheduler.state().status === "waiting", "one scheduled archive completed");
      const latest = [...entries.values()].at(-1);
      await until(() => evaluate(`document.body.textContent.includes(${JSON.stringify(latest.id)})`), "scheduled archive appears without refresh");
      const native = createCompanyBackups({ localRequest, portalRequest, tempRoot: join(output, "transfer-cache"), allowLoopbackForTests: true });
      const preview = await native.prepareRestore({ id: latest.id });
      assert.equal(preview.summary.format, "openmaus.workspace-backup");
      // Check the real staged manifest rather than trusting captured IPC input.
      assert.match(preview.id, /^[a-f0-9-]{36}$/);
      const staged = JSON.parse(readFileSync(join(fixtureDataDir, ".backups", preview.id, "staged", "manifest.json"), "utf8"));
      assert.equal(staged.clientState?.["omb-drafts"], draft);
      assert.equal(Object.hasOwn(staged.clientState ?? {}, "fixture-auth-token"), false);
      assert.equal(scheduler.state().nextBackupAt, scheduleClock + 24 * 60 * 60_000, "missed days are not queued");
    }
    await screenshot("company-backup-schedule-complete-narrow.png");
    await evaluate(`${switchSelector}.click()`);
    await until(() => scheduler.state().enabled === false && scheduleRecord === null, "disable forgets saved schedule");
    assert.equal(scheduleTimer, null);
    checks.push("passwordless daily backups require explicit scope consent; start after 24h; production scheduler takes two encrypted snapshots with fresh private preload drafts; a week missed produces one catch-up; disable forgets the schedule");
    const remote = await open(false); await remote.loadURL(url);
    assert.equal(await remote.webContents.executeJavaScript("typeof window.ogb.companyBackups"), "undefined"); remote.destroy();
    checks.push("production preload omits company backup bridge from remote-origin windows");
    assert.ok(progressPhases.has("uploading") && progressPhases.has("downloading") && progressPhases.has("preparing"));
    const receipt = { passed: true, checks, createCalls, restoreCalls, deleteCalls, cloudRequests, objectRequests, scheduledRuns,
      progressPhases: [...progressPhases], archiveBytes: objects.get(first).length,
      production: ["CompanyBackupSettings", "WorkspaceBackupRecovery", "electron/preload.cjs", "electron/company-backups.mjs", "electron/company-backup-schedule.mjs", "real local workspace-backup HTTP/archive/restart"],
      limits: "Synthetic company state, schedule clock/credential store and fixture IPC wiring, loopback Admin/object store, one small real part; not production main integration, real Admin consent/auth, keychain, R2/TLS, multi-part scale or a 10 GiB stress test." };
    writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify(receipt)); scheduler.close(); admin.close(); win.destroy(); app.exit(0);
  }).catch(async error => {
    console.error(error.stack);
    try { if (win && !win.isDestroyed()) writeFileSync(join(output, "failure.png"), (await win.webContents.capturePage()).toPNG()); } catch { /* Preserve original failure. */ }
    scheduler.close(); transferController?.abort(); admin.close(); app.exit(1);
  });
} else {
  assert.equal(process.argv.length, 2, "This isolated smoke accepts no external URLs or paths");
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const { default: tailwindcss } = await import("@tailwindcss/vite");
  const { launchVerificationServer, runControlOmb } = await import("./control-omb.ts");
  const { waitForExit } = await import("../server/testing/cleanup.ts");
  const fixture = await launchVerificationServer({});
  let runtime = fixture.child, child, ui, restartTask;
  const output = mkdtempSync(join(tmpdir(), "omb-company-backup-ui-"));
  for (const name of ["home", "user-data"]) mkdirSync(join(output, name));
  const restart = async () => {
    await waitForExit(runtime, { signal: "SIGTERM" });
    const config = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
    assert.equal(resolve(config.instances.claude.config.cli), join(root, "server/testing/fake-claude-cli.ts"));
    const home = join(fixture.info.dataDir, "providers", "fixture-home"), temporary = join(fixture.info.dataDir, "tmp");
    mkdirSync(home, { recursive: true }); mkdirSync(temporary, { recursive: true });
    const env = { PATH: dirname(process.execPath), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"),
      TEMP: temporary, TMP: temporary, TMPDIR: temporary, HERMES_HOME: join(home, ".hermes"), OMB_DATA_DIR: fixture.info.dataDir,
      OMB_PORT: new URL(fixture.info.url).port, OMB_WEBHOOK_PORT: String(Number(new URL(fixture.info.url).port) + 1),
      FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: fixture.fixtureDumpPath };
    for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]) if (process.env[key]) env[key] = process.env[key];
    const log = openSync(fixture.info.logPath, "a", 0o600);
    runtime = spawn(process.execPath, ["--experimental-strip-types", join(root, "server/index.ts")], { cwd: root, env, stdio: ["ignore", log, log] }); closeSync(log);
    for (let attempt = 0; attempt < 300; attempt++) {
      if (runtime.exitCode !== null || runtime.signalCode !== null) throw new Error("Owned backup runtime exited during restart");
      try { const response = await fetch(`${fixture.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) }); if (response.ok && (await response.json()).pid === runtime.pid) return; } catch { /* Exact owned PID handshake only. */ }
      await pause(100);
    }
    throw new Error("Owned backup runtime failed its PID handshake");
  };
  try {
    // The general harness HOME is portable data; backup fixtures put it under
    // excluded providers/ so no CLI-login directory can enter an archive.
    await restart();
    const seeded = await runControlOmb(["new-bot", "--name", "Original cloud snapshot bot", "--url", fixture.info.url]);
    ui = await createServer({ configFile: false, root, resolve: { alias: { "@": join(root, "src") } }, define: { __APP_VERSION__: JSON.stringify("0.1.78") },
      server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.info.url } } }, plugins: [react(), tailwindcss(), {
        name: "company-backup-fixture", resolveId(id) { if (id === "virtual:company-backup-fixture") return `\0${id}`; },
        load(id) { if (id === "\0virtual:company-backup-fixture") return `import React from 'react'; import {createRoot} from 'react-dom/client'; import {CompanyBackupSettings} from '/src/components/CompanyBackupSettings.tsx'; import {WorkspaceBackupRecovery} from '/src/components/WorkspaceBackupSettings.tsx'; import {setLocale} from '/src/lib/i18n.ts'; import '/src/styles.css'; setLocale('en'); localStorage.setItem('omb-analytics-opt-out','1'); createRoot(document.getElementById('root')).render(React.createElement(WorkspaceBackupRecovery,null,React.createElement('main',{className:'mx-auto max-w-2xl p-4'},React.createElement(CompanyBackupSettings)))); document.body.dataset.ready='true';`; },
        configureServer(server) { server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/__company-backups.html") return next();
          void server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Isolated company backups</title></head><body class="bg-app"><div id="root"></div><script type="module" src="/@id/virtual:company-backup-fixture"></script></body></html>')
            .then(html => { res.setHeader("content-type", "text/html"); res.end(html); }).catch(next);
        }); },
      }] });
    await ui.listen(); const url = `${ui.resolvedUrls.local[0]}__company-backups.html`;
    console.log(JSON.stringify({ previewUrl: url, evidence: output, runtime: fixture.info, actualPid: runtime.pid }));
    child = spawn(createRequire(import.meta.url)("electron"), [fileURLToPath(import.meta.url), flag, url, output, fixture.info.url, seeded.bot.id, fixture.info.dataDir], {
      env: { PATH: process.env.PATH, HOME: join(output, "home"), XDG_CONFIG_HOME: join(output, "home"), TMPDIR: output, TEMP: output, TMP: output, DISPLAY: process.env.DISPLAY, SystemRoot: process.env.SystemRoot },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { appendFileSync(join(output, "electron.log"), data); process.stdout.write(data); });
    child.on("message", message => {
      if (message?.type !== "restart-fixture" || restartTask) return;
      restartTask = restart().then(() => { if (child.connected) child.send({ ok: true, pid: runtime.pid }); })
        .catch(error => { if (child.connected) child.send({ ok: false, error: error.message }); });
    });
    const stop = () => child.kill("SIGTERM"); process.once("SIGINT", stop); process.once("SIGTERM", stop);
    const timer = setTimeout(stop, 120_000);
    const code = await new Promise((done, reject) => { child.once("error", reject); child.once("close", done); })
      .finally(() => { clearTimeout(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop); });
    assert.equal(code, 0, `Company backup smoke failed; inspect ${join(output, "electron.log")}`);
    assert.equal(JSON.parse(readFileSync(join(output, "receipt.json"), "utf8")).passed, true, "Electron must produce its completed receipt");
  } finally {
    await waitForExit(child, { signal: "SIGTERM" }); await restartTask; await ui?.close(); await waitForExit(runtime, { signal: "SIGTERM" }); await fixture.close();
    for (const name of ["home", "user-data", "transfer-cache"]) rmSync(join(output, name), { recursive: true, force: true });
    writeFileSync(join(output, "cleanup.json"), JSON.stringify({ fixtureRemoved: !existsSync(fixture.info.dataDir), profileRemoved: !existsSync(join(output, "user-data")) }));
    console.log(JSON.stringify({ evidence: output, cleanup: true }));
  }
}
