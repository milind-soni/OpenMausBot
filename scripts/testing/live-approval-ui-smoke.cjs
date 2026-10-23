// Real composer, HTTP persistence and permission boundaries in a disposable desktop.
const { BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
module.exports = async function ({ root, url, api, until, grant }) {
  const { mountPreview } = await import(pathToFileURL(join(root, 'scripts/testing/preview-fixture.ts')).href);
  const bot = (await api('/api/bots', 'POST', { name: 'Live approval fixture', approvalMode: 'ask', modelSelection: { instanceId: 'codex', model: 'gpt-6-astra' } })).body.bot;
  await api(`/api/bots/${bot.id}`, 'PATCH', { approvalMode: 'ask' });
  const task = (await api(`/api/bots/${bot.id}/tasks`, 'POST', { title: 'Running conversation' })).body.task;
  const publicTask = (await api(`/api/bots/${bot.id}/tasks`, 'POST', { title: 'Public Full access' })).body.task;
  const sibling = (await api(`/api/bots/${bot.id}/tasks`, 'POST', { title: 'Unaffected conversation' })).body.task;
  for (const thread of [task, sibling]) await api(`/api/bots/${bot.id}/tasks/${thread.threadId}`, 'PATCH', { approvalMode: 'ask' });
  await api(`/api/bots/${bot.id}/tasks/${task.threadId}`, 'POST');
  const read = async () => (await api('/api/bots?messages=0')).body.bots.find(b => b.id === bot.id);
  const cards = async () => (await api(`/api/threads/${task.threadId}/messages?limit=100`)).body.messages.filter(m => m.card?.requestId && !m.card.answered && !m.card.dismissed);
  await api(`/api/bots/${bot.id}/messages`, 'POST', { text: 'Hold for synthetic approval.', threadId: task.threadId });
  const card = await until(async () => (await cards())[0]);
  const preview = await mountPreview({ info: { url } }, { entry: '/src/testing/thread-approvals.tsx', route: '/__thread-approvals.html', title: 'Live approval fixture', logLevel: 'silent' });
  const window = new BrowserWindow({ show: false, width: 1000, height: 850, webPreferences: { preload: join(root, 'scripts/testing/approval-preview-preload.cjs'), contextIsolation: true, sandbox: true } });
  ipcMain.handle('fixture:thread-approval', (event, id, mode, options) => {
    assert.equal(event.sender, window.webContents);
    assert.equal(id, bot.id);
    assert.ok(['auto', 'full'].includes(mode));
    assert.deepEqual(options, { threadId: task.threadId, threadOnly: true, acknowledgeLocalAuto: false });
    return grant(id, mode, options);
  });
  const evaluate = code => window.webContents.executeJavaScript(code);
  const select = async label => {
    await evaluate(`document.querySelector('[data-tour=composer] button[aria-haspopup=menu][aria-label*=" for "]').click(); true`);
    await until(() => evaluate(`Boolean(document.querySelector('[role=menuitemradio]'))`));
    assert.ok((await evaluate('document.body.innerText')).includes('next user turn'));
    await evaluate(`(() => { const b = [...document.querySelectorAll('[role=menuitemradio]')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b || b.disabled) throw Error('Mode unavailable while working'); b.click(); return true; })()`);
  };
  try {
    await window.loadURL(`${preview.previewUrl}?bot=${bot.id}`);
    await until(() => evaluate(`Boolean(document.querySelector('[data-tour=composer] button[aria-haspopup=menu][aria-label*=" for "]'))`));
    await select('Approve for me');
    await until(async () => (await read()).tasks.find(t => t.threadId === task.threadId).approvalMode === 'auto');
    assert.equal((await read()).tasks.find(t => t.threadId === task.threadId).busy, true);
    await select('Full access');
    assert.equal(await evaluate(`Boolean(document.querySelector('[role=alertdialog]'))`), false);
    await until(async () => (await read()).tasks.find(t => t.threadId === task.threadId).approvalMode === 'full');
    assert.equal((await read()).tasks.find(t => t.threadId === task.threadId).busy, true);
    assert.equal((await read()).tasks.find(t => t.threadId === sibling.threadId).approvalMode, 'ask');
    assert.equal((await cards())[0].card.requestId, card.card.requestId);
    assert.equal((await api(`/api/bots/${bot.id}/tasks/${publicTask.threadId}`, 'PATCH', { approvalMode: 'full' })).status, 200);
    await api(`/api/bots/${bot.id}/respond`, 'POST', { threadId: task.threadId, requestId: card.card.requestId, behavior: 'deny' });
    await until(async () => !(await read()).tasks.find(t => t.threadId === task.threadId).busy);
    const before = (await api(`/api/threads/${task.threadId}/messages?limit=100`)).body.messages.filter(m => m.card?.requestId).length;
    await api(`/api/bots/${bot.id}/messages`, 'POST', { threadId: task.threadId, text: 'Run with the newly selected mode.' });
    await until(async () => !(await read()).tasks.find(t => t.threadId === task.threadId).busy);
    assert.equal((await api(`/api/threads/${task.threadId}/messages?limit=100`)).body.messages.filter(m => m.card?.requestId).length, before);
    console.log(JSON.stringify({ realComposerWhileBusy: true, autoPersisted: true, fullPersistedWithoutDialog: true, openCardRetained: true, nativeNextTurnFull: true, siblingUnchanged: true, publicFullAllowed: true }));
  } finally {
    ipcMain.removeHandler('fixture:thread-approval');
    window.destroy();
    await preview.close();
  }
};
