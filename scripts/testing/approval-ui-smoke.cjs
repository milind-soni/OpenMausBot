const { BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

module.exports = async function verifyApprovalUi({ root, url, api, until, grant }) {
  const { mountPreview } = await import(pathToFileURL(join(root, "scripts/testing/preview-fixture.ts")).href);
  const bot = (await api("/api/bots", "POST", { name: "Thread permission fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  await grant(bot.id, "ask");
  const old = (await api(`/api/bots/${bot.id}/tasks`, "POST", { title: "Existing conversation" })).body.task;
  const readMode = async () => (await api("/api/bots?messages=0")).body.bots.find(candidate => candidate.id === bot.id).tasks.find(task => task.threadId === old.threadId).approvalMode;
  const preview = await mountPreview({ info: { url } }, { entry: "/src/testing/thread-approvals.tsx", route: "/__thread-approvals.html", title: "Isolated thread approvals", logLevel: "silent" });
  const window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { preload: join(root, "scripts/testing/approval-preview-preload.cjs"), contextIsolation: true, sandbox: true } });
  let calls = 0;
  ipcMain.handle("fixture:thread-approval", (event, botId, mode, options) => {
    assert.equal(event.sender, window.webContents);
    assert.equal(botId, bot.id);
    assert.equal(mode, "full");
    assert.deepEqual(options, { threadId: old.threadId, threadOnly: true, acknowledgeLocalAuto: false });
    calls++;
    return grant(botId, mode, options);
  });
  const evaluate = js => window.webContents.executeJavaScript(js);
  const text = () => evaluate("document.body.innerText");
  const click = name => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(name)}); if (!button || button.disabled) throw new Error('Missing enabled button'); button.click(); return true; })()`);
  const selectFull = async () => {
    await evaluate("document.querySelector('[data-tour=composer] button[aria-haspopup=menu]').click(); true");
    await until(() => evaluate("Boolean(document.querySelector('[role=menuitemradio]'))"));
    await evaluate("[...document.querySelectorAll('[role=menuitemradio]')].find(b => b.textContent.trim().startsWith('Full access')).click(); true");
  };
  const evidence = join(root, ".omb-scratch/verify-evidence/provider-fixes");
  mkdirSync(evidence, { recursive: true });
  try {
    await window.loadURL(`${preview.previewUrl}?bot=${bot.id}`);
    await until(() => evaluate("Boolean(document.querySelector('[data-tour=composer] button[aria-haspopup=menu]'))"));
    assert.ok((await text()).includes("Full access controls tool approvals, not provider safety checks"));
    assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Retry')"), false);
    await selectFull();
    await until(async () => (await text()).includes("The bot default and other threads keep their approval levels"));
    assert.equal(await evaluate("document.activeElement.textContent.trim()"), "Cancel");
    await click("Cancel");
    assert.equal(calls, 0);
    assert.equal(await readMode(), "ask");
    window.setSize(390, 844);
    await until(async () => await evaluate("innerWidth") === 390);
    writeFileSync(join(evidence, "narrow.png"), (await window.webContents.capturePage()).toPNG());
    await until(() => evaluate("document.documentElement.scrollWidth <= innerWidth"));
    await selectFull();
    await until(async () => (await text()).includes("Enable Full access?"));
    writeFileSync(join(evidence, "confirmation.png"), (await window.webContents.capturePage()).toPNG());
    await click("Enable full access");
    await until(async () => await readMode() === "full");
    await until(() => evaluate("document.querySelector('[data-tour=composer] button[aria-haspopup=menu]').textContent.trim() === 'Full access'"));
    assert.equal((await api("/api/bots?messages=0")).body.bots.find(candidate => candidate.id === bot.id).approvalMode, "ask");
    assert.equal(calls, 1);
    await evaluate("document.querySelector('textarea').focus(); true");
    window.webContents.insertText("Run the safe fixture");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await until(async () => (await text()).includes("hello from fake claude"));
    window.setSize(1100, 800);
    writeFileSync(join(evidence, "applied.png"), (await window.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ ui: true, cancelPreservedAsk: true, confirmedThreadFull: true, sentAfterGrant: true, narrowLayout: true, safetyGuidance: true, evidence }));
  } finally {
    ipcMain.removeHandler("fixture:thread-approval");
    window.destroy();
    await preview.close();
  }
};
