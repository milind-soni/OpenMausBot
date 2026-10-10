const { BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

module.exports = async function verifySkillApprovalUi({ root, home, url, api, until, capability }) {
  const { mountPreview } = await import(pathToFileURL(join(root, "scripts/testing/preview-fixture.ts")).href);
  const bot = (await api("/api/bots", "POST", { name: "Sprout fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  const savedThreadId = bot.threadId;
  const readBot = async () => (await api("/api/bots")).body.bots.find(candidate => candidate.id === bot.id);
  const send = async (threadId, text) => {
    assert.equal((await api(`/api/bots/${bot.id}/messages`, "POST", { threadId, text })).status, 202);
    await until(async () => !(await readBot()).busy);
  };
  await send(savedThreadId, "Keep this conversation");
  const keptMessageIds = (await readBot()).messages.map(message => message.id);
  const pendingTask = (await api(`/api/bots/${bot.id}/tasks`, "POST", { title: "Pending skill" })).body.task;
  const stage = async () => {
    const minted = await capability(bot.id, pendingTask.threadId);
    assert.equal(minted.status, 201);
    const result = await api("/api/internal/skills/stage", "POST", {
      fromBotId: bot.id, fromThreadId: pendingTask.threadId, action: "create", source: "conversation",
      skill_md: "---\nname: fixture-review\ndescription: Review the fixture checklist.\n---\n\n# Fixture review\n\nRead the synthetic checklist and report what passed.\n",
    }, { authorization: `Bearer ${minted.body.token}` });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return (await readBot()).messages.find(message => message.card?.skillRequest?.stagedId === result.body.stagedId);
  };
  const first = await stage();
  const preview = await mountPreview({ info: { url } }, {
    entry: "/scripts/testing/skill-approval-preview.tsx", route: "/__skill-approval.html", title: "Isolated skill approvals", logLevel: "silent",
  });
  const windows = [0, 1].map(() => new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { contextIsolation: true, sandbox: true } }));
  const evaluate = (window, js) => window.webContents.executeJavaScript(js);
  const pending = window => evaluate(window, "document.querySelector('[aria-label=\"Pending skill confirmation\"]') !== null");
  const click = (window, label) => evaluate(window, `(() => {
    const button = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || b.textContent.trim()) === ${JSON.stringify(label)});
    if (!button || button.disabled) throw new Error('Missing enabled button: ' + ${JSON.stringify(label)});
    button.click(); return true;
  })()`);
  const state = window => evaluate(window, "JSON.parse(document.querySelector('#fixture-state').textContent)");
  const evidence = join(root, ".omb-scratch/verify-evidence/skill-approval");
  mkdirSync(evidence, { recursive: true });
  try {
    for (const window of windows) await window.loadURL(`${preview.previewUrl}?bot=${bot.id}`);
    for (const window of windows) await until(() => pending(window));
    writeFileSync(join(evidence, "pending.png"), (await windows[0].webContents.capturePage()).toPNG());
    await click(windows[0], "Deny");
    for (const window of windows) await until(async () => !await pending(window));
    assert.equal((await readBot()).messages.find(message => message.id === first.id).card.answered, "deny");

    // A missing stage must also remain dismissible; no reviewed code is run.
    await stage();
    await until(() => pending(windows[0]));
    writeFileSync(join(home, "skill-state", bot.id, "staged.json"), JSON.stringify({ writes: {} }));
    await click(windows[0], "Deny");
    for (const window of windows) await until(async () => !await pending(window));

    // Reusing the name proves Deny did not leave an invisible reservation.
    const deletedCard = await stage();
    for (const window of windows) await until(() => pending(window));
    await click(windows[0], "All threads");
    await evaluate(windows[0], `(() => {
      const title = [...document.querySelectorAll('button')].find(button => button.querySelector('div')?.textContent === 'Pending skill');
      const remove = title?.parentElement.querySelector('button[aria-label="Delete thread"]');
      if (!remove || remove.disabled) throw new Error('Missing enabled thread deletion control');
      remove.click(); return true;
    })()`);
    await until(async () => !(await readBot()).tasks.some(task => task.threadId === pendingTask.threadId));
    // The second client receives only SSE, not the DELETE response.
    for (const window of windows) {
      await until(async () => (await state(window)).threadId === savedThreadId && !await pending(window));
      await until(async () => (await state(window)).messageIds.includes(keptMessageIds.at(-1)));
      assert.equal((await state(window)).messageIds.includes(deletedCard.id), false);
      assert.equal(await evaluate(window, "document.querySelector('textarea').disabled"), false);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(home, "skill-state", bot.id, "staged.json"), "utf8")).writes, {});
    assert.deepEqual((await readBot()).messages.map(message => message.id), keptMessageIds);
    await click(windows[0], "All threads");
    await evaluate(windows[0], "document.querySelector('textarea').focus(); true");
    windows[0].webContents.insertText("Still here after deleting the skill thread");
    windows[0].webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    windows[0].webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await until(async () => (await readBot()).messages.some(message => message.role === "user" && message.text === "Still here after deleting the skill thread"));
    const reply = await until(async () => {
      const current = await readBot();
      return !current.busy && current.messages.find(message => !keptMessageIds.includes(message.id) && message.role === "bot" && message.kind === "text" && message.text === "hello from fake claude");
    });
    for (const window of windows) await until(async () => (await state(window)).messageIds.includes(reply.id));
    writeFileSync(join(evidence, "after-delete.png"), (await windows[0].webContents.capturePage()).toPNG());
    const result = { deny: true, missingStageDeny: true, activeThreadDeletion: true, secondClient: true, savedConversationIntact: true, sentAfterDeletion: true, botRetained: true };
    writeFileSync(join(evidence, "results.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, evidence }));
  } catch (error) {
    writeFileSync(join(evidence, "failure.json"), JSON.stringify({ bot: await readBot(), ui: await state(windows[0]) }, null, 2));
    writeFileSync(join(evidence, "failure.png"), (await windows[0].webContents.capturePage()).toPNG());
    throw error;
  } finally {
    for (const window of windows) window.destroy();
    await preview.close();
  }
};
