// Real model picker + private desktop confirmation, against the disposable
// approval fixture. Provider replies are synthetic; no account is contacted.
const { BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

module.exports = async function verifyModelSwitch({ root, url, api, until, grant }) {
  const { mountPreview } = await import(pathToFileURL(join(root, "scripts/testing/preview-fixture.ts")).href);
  const bot = (await api("/api/bots", "POST", { name: "Model switch fixture", modelSelection: { instanceId: "codex", model: "gpt-fake-default" } })).body.bot;
  await grant(bot.id, "custom");
  const sibling = (await api(`/api/bots/${bot.id}/tasks`, "POST", { title: "Unrelated custom conversation" })).body.task;
  const selected = (await api(`/api/bots/${bot.id}/tasks`, "POST", { title: "Research brief" })).body.task;
  const read = async () => (await api("/api/bots?messages=0")).body.bots.find(candidate => candidate.id === bot.id);
  const selection = { instanceId: "claude", model: "claude-sonnet-5" };
  // Neither changing the mode separately nor combining fields can bypass
  // the Custom boundary from a bot-accessible HTTP connection.
  assert.equal((await api(`/api/bots/${bot.id}/tasks/${selected.threadId}`, "PATCH", { approvalMode: "ask", modelSelection: selection })).status, 403);
  assert.equal((await api(`/api/bots/${bot.id}/tasks/${selected.threadId}`, "PATCH", { resetApprovalToAsk: true, modelSelection: selection })).status, 403);
  const preview = await mountPreview({ info: { url } }, { entry: "/src/testing/thread-approvals.tsx", route: "/__thread-approvals.html", title: "Isolated model switching", logLevel: "silent" });
  const window = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { preload: join(root, "scripts/testing/approval-preview-preload.cjs"), contextIsolation: true, sandbox: true } });
  const calls = [];
  ipcMain.handle("fixture:thread-approval", (event, botId, mode, options) => {
    assert.equal(event.sender, window.webContents);
    assert.equal(botId, bot.id);
    assert.equal(mode, "ask");
    assert.equal(options.threadId, selected.threadId);
    calls.push(options);
    return grant(botId, mode, options);
  });
  const evaluate = js => window.webContents.executeJavaScript(js).catch(error => { throw new Error(`${error.message}\nExpression: ${js}`); });
  const text = () => evaluate("document.body.innerText");
  const click = name => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(name)} || b.getAttribute('aria-label') === ${JSON.stringify(name)}); if (!button || button.disabled) throw new Error('Missing enabled button: ' + ${JSON.stringify(name)}); button.click(); return true; })()`);
  const openPicker = async () => { await evaluate("document.querySelector('[data-tour=model]').click(); true"); await until(() => evaluate("!!document.querySelector('[data-model-picker-content]')")); };
  const selectClaude = async () => {
    await until(() => evaluate("!!document.querySelector('[data-model-picker-content] button[aria-label=Claude]')"));
    await click("Claude");
    await until(() => evaluate("[...document.querySelectorAll('[data-model-picker-content] button')].some(b => b.textContent.startsWith('Claude Sonnet 5'))"));
    await evaluate("[...document.querySelectorAll('[data-model-picker-content] button')].find(b => b.textContent.startsWith('Claude Sonnet 5')).click(); true");
    await until(async () => (await text()).includes("Switch model with Ask permissions?"));
  };
  const evidence = join(root, ".omb-scratch/verify-evidence/model-switch");
  mkdirSync(evidence, { recursive: true });
  try {
    await window.loadURL(`${preview.previewUrl}?bot=${bot.id}&model-switch=1`);
    await until(() => evaluate("!!document.querySelector('[data-tour=model]')"));
    await openPicker();
    assert.equal(await evaluate("[...document.querySelectorAll('[aria-label=\"Apply model changes to\"] button')].find(b => b.textContent === 'Only this thread').getAttribute('aria-pressed')"), "true");
    await selectClaude();
    assert.equal(await evaluate("document.activeElement.textContent.trim()"), "Cancel");
    await click("Cancel");
    assert.equal(calls.length, 0);
    const cancelledTask = (await read()).tasks.find(task => task.threadId === selected.threadId);
    assert.equal(cancelledTask.approvalMode, "custom");
    assert.equal(cancelledTask.modelSelection.instanceId, "codex");
    await openPicker();
    await selectClaude();
    window.setSize(390, 844);
    await until(() => evaluate("innerWidth === 390"));
    assert.equal(await evaluate("(() => { const r = document.querySelector('[role=alertdialog]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()"), true);
    writeFileSync(join(evidence, "thread-confirmation.png"), (await window.webContents.capturePage()).toPNG());
    await click("Switch with Ask");
    await until(async () => {
      const task = (await read()).tasks.find(task => task.threadId === selected.threadId);
      return task.modelSelection.instanceId === "claude" && task.approvalMode === "ask";
    });
    const threadOnly = await read();
    assert.equal(threadOnly.approvalMode, "custom");
    assert.equal(threadOnly.modelSelection.instanceId, "codex");
    assert.equal(threadOnly.tasks.find(task => task.threadId === sibling.threadId).approvalMode, "custom");
    assert.deepEqual(calls[0], { threadId: selected.threadId, modelSelection: selection, updateBotDefault: false });
    window.setSize(1100, 850);
    await openPicker();
    await click("Thread + bot default");
    await selectClaude();
    assert.ok((await text()).includes("Groups and new threads use this default"));
    writeFileSync(join(evidence, "default-confirmation.png"), (await window.webContents.capturePage()).toPNG());
    await click("Switch with Ask");
    await until(async () => (await read()).modelSelection.instanceId === "claude");
    const after = await read();
    assert.equal(after.approvalMode, "ask");
    assert.equal(after.tasks.find(task => task.threadId === sibling.threadId).approvalMode, "custom");
    assert.equal(calls[1].updateBotDefault, true);
    const newThread = (await api(`/api/bots/${bot.id}/tasks`, "POST", { title: "Uses the new default" })).body.task;
    assert.equal(newThread.modelSelection.instanceId, "claude");
    assert.equal(newThread.approvalMode, "ask");
    await api(`/api/bots/${bot.id}/tasks/${selected.threadId}`, "POST", {});
    await until(async () => (await read()).threadId === selected.threadId);
    // Send a work request through the real composer after both transitions.
    await evaluate("document.querySelector('textarea').focus(); true");
    window.webContents.insertText("Draft three acceptance criteria for the engineering handoff.");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await until(async () => !(await read()).busy && (await text()).includes("hello from fake claude"));
    writeFileSync(join(evidence, "after-send.png"), (await window.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ modelSwitch: true, customHttpRefused: true, cancelPreservedSettings: true,
      scopedCustomSwitch: true, defaultMismatchHandled: true, siblingUnchanged: true, newThreadUsesDefault: true,
      sentAfterSwitch: true, narrowLayout: true, providerReplies: "offline fake CLI", evidence }));
  } finally {
    ipcMain.removeHandler("fixture:thread-approval");
    window.destroy();
    await preview.close();
  }
};
