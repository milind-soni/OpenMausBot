// Run only against scripts/verify-browser-approvals.ts's disposable preview.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const url = process.argv[2];
const parsed = new URL(url);
if (parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/__browser-approvals.html') throw new Error('Expected an explicit isolated browser-approval preview URL');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'omb-browser-approvals-'));
app.setPath('userData', path.join(output, 'profile'));
app.setPath('sessionData', path.join(output, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
const api = async (route, body, cookie) => {
  const response = await fetch(parsed.origin + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: parsed.origin, ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`Fixture API ${route}: ${response.status} ${await response.text()}`);
  return { body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
};
app.whenReady().then(async () => {
  let win;
  let exitCode = 0;
  try {
    const preview = await fetch(url);
    assert.equal(preview.headers.get('x-openmausbot-fixture'), 'browser-approvals', 'Refusing to mutate a server without the isolated fixture marker');
    const opened = await api('/api/auth/pairing', { scopes: ['admin', 'client'] });
    const paired = await api('/api/auth/pair', { code: opened.body.code, cookie: true, label: 'Disposable UI smoke' });
    const separator = paired.cookie.indexOf('=');
    await session.defaultSession.cookies.set({ url: parsed.origin, name: paired.cookie.slice(0, separator), value: paired.cookie.slice(separator + 1), httpOnly: true, sameSite: 'lax' });
    session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
      const target = new URL(request.url);
      callback({ cancel: !['data:', 'blob:'].includes(target.protocol) && target.host !== parsed.host });
    });
    win = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', event => { if(event.level === 'error') console.error(event.message); });
    const evaluate = code => win.webContents.executeJavaScript(code);
    const until = async (code, label) => {
      for (let i = 0; i < 300; i++) {
        if (await evaluate(code)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out: ${label}`);
    };
    const click = label => evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(label)}); if (!button) throw new Error('Missing button: ' + ${JSON.stringify(label)}); button.click(); })()`);
    const openMenu = () => evaluate(`document.querySelector('button[aria-haspopup="menu"][aria-label$=" for Verification fixture"]').click()`);
    const chooseFull = async () => {
      await openMenu();
      await until(`Boolean(document.querySelector('[role="menuitemradio"]'))`, 'permission menu');
      assert.equal(await evaluate(`document.querySelector('[role="menu"]').innerText.includes('Custom (config.toml)')`), false);
      await evaluate(`Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(el => el.textContent.startsWith('Dangerously approve all')).click()`);
      await until(`Boolean(document.querySelector('[role="alertdialog"]'))`, 'confirmation');
    };
    const readBot = async () => (await api('/api/bots', undefined, paired.cookie)).body.bots[0];
    await win.loadURL(url);
    await until(`Boolean(document.querySelector('button[aria-haspopup="menu"][aria-label$=" for Verification fixture"]'))`, 'composer');
    // Capability loading is a separate snapshot request.
    await until(`fetch('/api/approval-capabilities').then(r=>r.json()).then(x=>x.browserFullAccess)`, 'browser eligibility');
    await chooseFull();
    await click('Cancel');
    assert.equal((await readBot()).tasks[0].approvalMode ?? 'ask', 'ask');
    await chooseFull();
    await click('Enable full access');
    await until(`fetch('/api/bots').then(r=>r.json()).then(x=>x.bots[0].tasks[0].approvalMode==='full')`, 'thread full saved');
    assert.equal((await readBot()).approvalMode ?? 'ask', 'ask');
    await win.loadURL(url);
    await until(`Boolean(document.querySelector('button[aria-label="Dangerously approve all for Verification fixture"]'))`, 'full survives reload');
    await evaluate(`(() => { const input=document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Complete this isolated browser test'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await until(`Boolean(document.querySelector('button[aria-label="Send message"]:not(:disabled)'))`, 'send enabled');
    await evaluate(`document.querySelector('button[aria-label="Send message"]').click()`);
    await until(`document.body.innerText.includes('hello from fake claude')`, 'fake-provider completion');
    await openMenu();
    await evaluate(`Array.from(document.querySelectorAll('[role="menuitemradio"]')).find(el => el.textContent.startsWith('Ask for approval')).click()`);
    await until(`fetch('/api/bots').then(r=>r.json()).then(x=>x.bots[0].tasks[0].approvalMode==='ask')`, 'thread ask saved');
    await click('Show bot permissions');
    await chooseFull();
    await click('Enable full access');
    await until(`fetch('/api/bots').then(r=>r.json()).then(x=>x.bots[0].approvalMode==='full')`, 'bot default full saved');
    assert.equal((await readBot()).tasks[0].approvalMode, 'ask');
    await win.webContents.capturePage().then(img=>fs.writeFileSync(path.join(output,'permissions.png'),img.toPNG()));
    const evidence = { passed: true, previewUrl: url, checks: ['Full available, Custom hidden', 'cancel preserves Ask', 'confirm grants one thread', 'reload preserves mode', 'real composer send completes with fake provider', 'Ask restores prompts', 'bot default leaves existing thread unchanged'], output };
    fs.writeFileSync(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify(evidence));
  } catch(error) {
    exitCode = 1;
    if(win) {
      console.error(await win.webContents.executeJavaScript('document.body.innerText'));
      fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());
    }
    console.error(error);
  } finally {
    win?.destroy();
    app.exit(exitCode);
  }
});
