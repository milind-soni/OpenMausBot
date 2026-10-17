// node --experimental-strip-types scripts/smoke-approval-review-settings.cjs
// Real Settings component and config API, confined to a disposable server,
// loopback model catalog, hidden Electron window and temporary browser profile.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const root = resolve(__dirname, "..");
const childFlag = "--approval-review-ui-fixture";
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const until = async (read, description) => {
  const deadline = Date.now() + 20_000;
  do { if (await read()) return; await delay(50); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
};

if (process.versions.electron && process.argv.includes(childFlag)) {
  const { app, BrowserWindow, session } = require("electron");
  const [previewUrl, serverUrl, profile, evidence] = process.argv.slice(process.argv.indexOf(childFlag) + 1);
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.commandLine.appendSwitch("disable-background-networking");
  app.whenReady().then(async () => {
    let window;
    try {
      const allowed = new Set([new URL(previewUrl).origin, new URL(serverUrl).origin]);
      session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
        const target = new URL(request.url);
        callback({ cancel: !["data:", "blob:"].includes(target.protocol) && !allowed.has(target.origin) });
      });
      window = new BrowserWindow({ show: false, width: 880, height: 860, webPreferences: {
        contextIsolation: true, sandbox: true, nodeIntegration: false,
      } });
      const evaluate = source => window.webContents.executeJavaScript(source);
      const config = async () => (await fetch(serverUrl + "/api/config")).json();
      const select = (id, value) => evaluate(`(() => {
        const element = document.getElementById(${JSON.stringify(id)});
        if (!element || element.disabled) throw new Error('Missing enabled select');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, ${JSON.stringify(value)});
        element.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      const save = () => evaluate(`(() => {
        const button = [...document.querySelectorAll('button')].find(element => element.textContent.trim() === 'Save');
        if (!button || button.disabled) throw new Error('Save is unavailable');
        button.click();
      })()`);
      await window.loadURL(previewUrl);
      await until(() => evaluate("Boolean(document.querySelector('#approval-review-engine option[value=openaiCompat]'))"), "configured reviewer appears");
      assert.equal(await evaluate("document.getElementById('approval-review-engine').value"), "");
      await select("approval-review-engine", "openaiCompat");
      await until(() => evaluate("Boolean(document.querySelector('#approval-review-model option[value=fixture-review-model]'))"), "review models appear");
      assert.equal(await evaluate("[...document.querySelectorAll('button')].find(element => element.textContent.trim() === 'Save').disabled"), true);
      await select("approval-review-model", "fixture-review-model");
      await until(() => evaluate("Boolean(document.querySelector('#approval-review-effort option[value=none]'))"), "reasoning off is available");
      await select("approval-review-effort", "none");
      const instructions = "Require a clearly scoped recipient before sending.";
      await evaluate(`(() => {
        const element = document.getElementById('approval-review-instructions');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, ${JSON.stringify(instructions)});
        element.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await save();
      await until(async () => {
        const review = (await config()).approvalReview;
        return review?.model?.model === "fixture-review-model" && review?.model?.effort === "none" && review?.instructions === instructions;
      }, "saved selected reviewer and instructions");
      await window.loadURL(previewUrl);
      await until(() => evaluate("document.getElementById('approval-review-model')?.value === 'fixture-review-model'"), "reload restores selection");
      await until(() => evaluate("[...document.querySelector('#approval-review-engine').options].some(option => option.value === 'openaiCompat' && !option.disabled)"), "reload finishes loading reviewer catalog");
      assert.equal(await evaluate("document.getElementById('approval-review-instructions').value"), instructions);
      assert.equal(await evaluate("document.getElementById('approval-review-effort').value"), "none");
      await select("approval-review-effort", "");
      await save();
      await until(async () => {
        const review = (await config()).approvalReview;
        return review?.model?.model === "fixture-review-model" && review?.model?.effort === undefined;
      }, "saved default reasoning-off selection");
      await window.loadURL(previewUrl);
      await until(() => evaluate("document.getElementById('approval-review-model')?.value === 'fixture-review-model'"), "reload restores default reasoning selection");
      await until(() => evaluate("document.getElementById('approval-review-effort')?.value === '' && !document.getElementById('approval-review-effort').disabled"), "reload finishes loading default reviewer effort");
      assert.equal(await evaluate("document.getElementById('approval-review-effort').value"), "");
      await select("approval-review-engine", "claude");
      await until(() => evaluate("document.querySelectorAll('#approval-review-model option[value]:not([value=\"\"])').length > 0"), "Claude review models appear");
      const claudeModel = await evaluate("[...document.getElementById('approval-review-model').options].find(option => option.value && !option.disabled).value");
      await select("approval-review-model", claudeModel);
      await until(() => evaluate("document.querySelector('#approval-review-effort option[value=low]') !== null"), "Claude effort catalog appears");
      assert.equal(await evaluate("document.querySelector('#approval-review-effort option[value=none]') === null"), true);
      assert.equal(await evaluate("document.querySelector('#approval-review-effort option[value=\"\"]').textContent"),
        require("../src/locales/en.json")["settings.approvalReview.defaultEffort"].replace("{effort}", await evaluate("document.querySelector('#approval-review-effort option[value=low]').textContent")));
      await save();
      await until(async () => (await config()).approvalReview?.model?.instanceId === "claude", "save Claude default reviewer");
      const priorReview = (await config()).approvalReview;
      const unsupported = await fetch(serverUrl + "/api/config", { method: "PUT", headers: { origin: serverUrl, "content-type": "application/json" },
        body: JSON.stringify({ approvalReview: { model: { instanceId: "claude", model: claudeModel, effort: "none" } } }) });
      assert.equal(unsupported.status, 400);
      assert.deepEqual((await config()).approvalReview, priorReview);
      await window.loadURL(previewUrl);
      await until(() => evaluate("document.getElementById('approval-review-effort')?.value === '' && !document.getElementById('approval-review-effort').disabled"), "reload restores Claude supported default");
      window.setSize(390, 844);
      await until(() => evaluate("innerWidth === 390"), "narrow viewport");
      assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
      writeFileSync(join(evidence, "approval-review-settings-narrow.png"), (await window.webContents.capturePage()).toPNG());
      await select("approval-review-engine", "");
      await save();
      await until(async () => {
        const review = (await config()).approvalReview;
        return !review.model && review.instructions === instructions;
      }, "clear selection follows session and keeps instructions");
      await window.loadURL(previewUrl);
      await until(() => evaluate("document.getElementById('approval-review-engine')?.value === '' && !document.getElementById('approval-review-engine').disabled"), "reload restores session mode");
      assert.equal(await evaluate("document.getElementById('approval-review-model').disabled"), true);
      assert.equal(await evaluate("document.getElementById('approval-review-instructions').value"), instructions);
      writeFileSync(join(evidence, "approval-review-settings-session.png"), (await window.webContents.capturePage()).toPNG());
      const result = { selectedReviewerSaved: true, defaultReasoningOffSaved: true, claudeDefaultLowSaved: true, claudeNoneRejected: true, instructionsSaved: true, reloadPersisted: true, missingModelCannotSave: true, sessionFallbackSaved: true, narrowLayout: true };
      writeFileSync(join(evidence, "approval-review-settings-ui.json"), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
      app.exit(0);
    } catch (error) {
      if (window) console.error(await window.webContents.executeJavaScript("document.body.innerText").catch(() => ""));
      console.error(error);
      app.exit(1);
    }
  });
} else {
  (async () => {
    const { launchVerificationServer } = await import(pathToFileURL(join(root, "scripts/control-omb.ts")).href);
    const { mountPreview } = await import(pathToFileURL(join(root, "scripts/testing/preview-fixture.ts")).href);
    const scratchRoot = join(root, ".omb-scratch/approval-review-settings-smoke");
    mkdirSync(scratchRoot, { recursive: true });
    const scratch = mkdtempSync(join(scratchRoot, "run-"));
    const profile = mkdtempSync(join(tmpdir(), "omb-approval-review-ui-"));
    let fixture, preview, child;
    const model = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url !== "/v1/models") { response.statusCode = 404; response.end('{"error":"This catalog fixture accepts no model calls"}'); return; }
      response.end(JSON.stringify({ data: [{ id: "fixture-working-model" }, { id: "fixture-review-model" }] }));
    });
    try {
      await new Promise(resolve => model.listen(0, "127.0.0.1", resolve));
      fixture = await launchVerificationServer();
      const api = async (method, path, body) => {
        const response = await fetch(fixture.info.url + path, { method, headers: { origin: fixture.info.url, "content-type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
        const result = await response.json();
        assert.ok(response.ok, JSON.stringify(result));
        return result;
      };
      await api("PUT", "/api/config", { openaiCompat: { key: "synthetic-ui-fixture-key", url: `http://127.0.0.1:${model.address().port}/v1`, model: "fixture-working-model" } });
      await api("POST", "/api/instances/openaiCompat/refresh-models", {});
      const entry = join(scratch, "entry.tsx");
      writeFileSync(entry, `import { createRoot } from 'react-dom/client';
import { StoreProvider } from '/src/state/store';
import { ApprovalReviewSettings } from '/src/components/ApprovalReviewSettings';
import { setLocale } from '/src/lib/i18n';
import '/src/styles.css';
setLocale('en');
createRoot(document.getElementById('root')!).render(<StoreProvider><div className="p-4"><ApprovalReviewSettings /></div></StoreProvider>);
`);
      preview = await mountPreview(fixture, { entry: entry.slice(root.length), route: "/__approval-review-settings.html", title: "Isolated approval review Settings", logLevel: "silent" });
      const evidence = fixture.info.logPath + ".approval-review-ui";
      mkdirSync(evidence, { recursive: true });
      child = spawn(require("electron"), [__filename, childFlag, preview.previewUrl, fixture.info.url, profile, evidence], {
        cwd: root, env: { ...process.env, HOME: profile, USERPROFILE: profile }, stdio: "inherit",
      });
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(result.code, 0, JSON.stringify(result));
      console.log(JSON.stringify({ serverLog: fixture.info.logPath, evidence, cleanedUp: true }));
    } finally {
      if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGTERM");
      await preview?.close();
      await fixture?.close();
      model.closeAllConnections();
      await new Promise(resolve => model.close(resolve));
      rmSync(scratch, { recursive: true, force: true });
      rmSync(profile, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
