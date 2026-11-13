// Isolated browser + actual second Electron regression and security smoke.
// GBS_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs node scripts/testing/preview-scroll-regression.mjs
// Uses --user-data-dir, own ELECTRON_START_URL/GBS_PORT/GBS_DATA_DIR and no real models.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createServer as portServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PREVIEW_SIZE_PRESETS } from '../../src/lib/previewSizes.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'package.json'));
const { chromium, _electron } = await import(process.env.GBS_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.GBS_PLAYWRIGHT_MODULE).href : 'playwright-core');
const temp = mkdtempSync(join(tmpdir(), 'gbs-scroll-')), data = join(temp, 'data'), project = join(temp, 'project'), profile = join(temp, 'electron-profile');
for (const dir of [data, project, profile, join(temp, 'logs')]) mkdirSync(dir);
writeFileSync(join(data, 'config.json'), JSON.stringify({ profile: { name: 'Scroll QA', email: '' }, instances: { ghost: { driver: 'not-a-real-driver', displayName: 'QA no AI' } } }));
const longBody = '<h1>Scroll fixture</h1>' + Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i}: ${'Wrapping page content. '.repeat(6)}</p>`).join('');
const attack = `<script>Promise.all(['/api/bots','/api/preview/asset/'+ 'a'.repeat(64) +'/project/%2e%2e/%2e%2e/%2e%2e/%2e%2e/bots'].map(url=>fetch(url).then(r=>r.status).catch(()=>'refused'))).then(results=>window.qaSecurity=results)</script>`;
writeFileSync(join(project, 'page.html'), '<!doctype html><html><head><style>body{font:18px/1.5 sans-serif}p{margin:24px}</style></head><body>'+longBody+attack+'</body></html>');
writeFileSync(join(project, 'sample.md'), '# Markdown viewer\n\n'+Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: ${'Wrapping Markdown text. '.repeat(6)}\n\n`).join(''));
writeFileSync(join(project, 'sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
writeFileSync(join(project, 'sample.pdf'), '%PDF-1.4\n%%EOF');
writeFileSync(join(project, 'attack.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/bots")</script></svg>');
const children = []; let browser, electron; let logs = '';
async function freePort() { const s = portServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p; }
const apiPort=await freePort(), uiPort=await freePort();
const api=`http://127.0.0.1:${apiPort}`, ui=`http://127.0.0.1:${uiPort}`;
const external=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><style>body{font:18px/1.5 sans-serif}</style>'+longBody)});
await new Promise(r=>external.listen(0,'127.0.0.1',r)); const site=`http://127.0.0.1:${external.address().port}`;
const env={PATH:process.env.PATH,HOME:temp,USERPROFILE:temp,GBS_DATA_DIR:data,GBS_PROJECTS_FILE:join(data,'projects.json'),GBS_PORT:String(apiPort)};
function start(args){const child=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});children.push(child);child.stderr.on('data',b=>{logs=(logs+b).slice(-10000)});}
async function until(read,valid){const end=Date.now()+20000;for(;;){const value=await read().catch(()=>null);if(valid(value))return value;if(Date.now()>end)throw Error(logs||'QA state timed out');await new Promise(r=>setTimeout(r,50))}}
async function stop(child){if(child.exitCode!==null)return;await new Promise(r=>{const t=setTimeout(()=>child.kill('SIGKILL'),3000);t.unref();child.once('close',()=>{clearTimeout(t);r()});child.kill('SIGTERM')})}
async function raw(port,path){return new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,headers:{origin:'null','sec-fetch-site':'cross-site'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.end()})}
const check = name => console.log('PASS '+name);
try {
  start(['server/index.ts']);start(['node_modules/vite/bin/vite.js','--port',String(uiPort),'--strictPort']);
  await until(()=>fetch(api+'/api/health'),r=>r?.ok);await until(()=>fetch(ui),r=>r?.ok);
  const registration=await fetch(api+'/api/projects/add-existing',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectPath:project})}).then(r=>r.json());
  const projectId=registration.project.id;
  const file=(fileType,filePath)=>({kind:'file',fileType,filePath,projectId});
  const html=file('html','page.html'), md=file('markdown','sample.md'), pdf=file('pdf','sample.pdf'), image=file('image','sample.png'), web={kind:'url',url:site,raw:site,isLocalOrPrivate:true};
  async function open(page,source,desktop=false){
    await page.goto(ui);
    await page.evaluate(({source,ids})=>{localStorage.setItem('gbs-email-gate','skipped');localStorage.setItem('gbs-preview-studio-state-v1',JSON.stringify({source,input:source.filePath||source.url,mode:'canvas',selectedSizeIds:ids,scrollSync:true,autoRefresh:false,zoom:'0.5',presetId:'phone-small',rotated:true,rotatedById:{}}))},{source,ids:PREVIEW_SIZE_PRESETS.slice(0,desktop?8:3).map(p=>p.id)});
    await page.reload();await page.getByRole('button',{name:'Preview',exact:true}).click();
  }
  browser=await chromium.launch({executablePath:process.env.GBS_CHROME_EXECUTABLE??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined),headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);page.on('crash',()=>console.error('QA browser renderer crashed'));page.on('pageerror',error=>console.error('QA page error:',error.message));
  const sends=[];
  await page.route('**/*',route=>{const req=route.request(),url=new URL(req.url());if(url.protocol.startsWith('http')&&![ui,site].includes(url.origin))return route.abort();if(req.method()==='POST'&&/\/api\/(bots|groups)\/[^/]+\/messages/.test(url.pathname)){sends.push(req.postDataJSON());return route.fulfill({status:202,json:{ok:true}})};return route.continue()});
  async function checkViewer(page,source) {
    await open(page,source);
    const viewer=page.locator('main [data-preview-file-viewer]');await viewer.waitFor();
    assert.equal(await viewer.count(),1);
    assert.equal(await page.getByRole('tablist',{name:'Preview layout mode'}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Sync scroll',exact:true}).count(),0);
    assert.equal(await page.getByRole('combobox',{name:'Preview zoom level'}).count(),0);
    const bounds=await viewer.boundingBox();assert.ok(bounds.width>900&&bounds.height>600,JSON.stringify(bounds));
    assert.equal(await viewer.evaluate(el=>el.firstElementChild.style.transform),'');
    // Stored Canvas/device state must survive without being applied to this file.
    await page.keyboard.press('r');await page.keyboard.press(']');
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('gbs-preview-studio-state-v1')).presetId),'phone-small');
    return bounds;
  }
  for(const source of [md,image,pdf]) {
    const bounds=await checkViewer(page,source);
    if(source===md)await page.locator('main .chat-md').waitFor();
    if(source===image)await page.waitForFunction(()=>document.querySelector('main img')?.naturalWidth>0);
    const before=sends.length;
    await page.getByRole('button',{name:'Share to chat…',exact:true}).click();
    const modal=page.getByRole('dialog',{name:'Share preview to chat'});
    assert.equal(await modal.getByRole('radio',{name:/All selected sizes/}).count(),0);
    await modal.getByRole('button',{name:/^Send to /}).click();
    await until(async()=>sends.length,n=>n===before+1);
    const sent=sends.at(-1);
    assert.equal(sent.attachments.length,source===pdf?0:1);
    if(source!==pdf)assert.ok(sent.attachments[0].name.includes(`${Math.round(bounds.width)}x${Math.round(bounds.height)}`));
    else assert.ok(sent.text.includes('no screenshot was captured'));
  }
  check('browser non-HTML files ignore stored Canvas/rotation/size, fill one viewer, hide device controls, and share once (PDF honestly shares a link)');
  await open(page,md);
  await page.getByRole('button',{name:'Back to chat',exact:true}).click();
  const showPanel=page.getByRole('button',{name:'Show mobile preview',exact:true});
  if(await showPanel.count())await showPanel.click();
  const panel=page.getByRole('complementary',{name:'Quick preview panel'});
  const quickViewer=panel.locator('[data-preview-file-viewer]');await quickViewer.waitFor();
  assert.equal(await quickViewer.count(),1);
  const quickBounds=await quickViewer.boundingBox(), panelBounds=await panel.boundingBox();
  assert.ok(quickBounds.width>panelBounds.width-50&&quickBounds.height>300,JSON.stringify({quickBounds,panelBounds}));
  assert.equal(await quickViewer.evaluate(el=>el.firstElementChild.style.transform),'');
  check('Quick preview shared frame fills the file viewer without applying device scale (panel header controls remain Z-owned)');

  await open(page,html);await page.getByText(/To sync web pages and HTML files, use the desktop app/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Sync scroll',exact:true}).isDisabled(),true);
  const frame=await until(async()=>page.frames().find(f=>f.url().includes('/page.html')),Boolean);
  await frame.waitForFunction(()=>window.qaSecurity?.length===2);
  assert.deepEqual(await frame.evaluate(()=>window.qaSecurity),['refused','refused']);
  for(const iframe of await page.locator('iframe').all())assert.ok(!(await iframe.getAttribute('sandbox')).includes('allow-same-origin'));
  const response=await fetch(`${api}/api/preview/file/${projectId}/page.html`);assert.ok(response.headers.get('content-security-policy').includes('sandbox'));assert.ok(!response.headers.get('content-security-policy').includes('allow-same-origin'));
  const svg=await fetch(`${api}/api/preview/file/${projectId}/attack.svg`);assert.ok(!svg.headers.get('content-security-policy').includes('allow-same-origin'));
  for(const port of [apiPort,uiPort])for(const segment of ['..','%2e%2e','.%2E','%2e.'])assert.equal(await raw(port,`/api/preview/asset/${'a'.repeat(64)}/project/${Array(4).fill(segment).join('/')}/bots`),403);
  for(const port of [apiPort,uiPort])assert.equal(await raw(port,'/api/bots'),403);
  check('security smoke: actual opaque browser requests refused; HTML/SVG sandbox and raw/encoded dot-segment guards intact on harness and proxy');
  await open(page,web);assert.equal(await page.getByRole('button',{name:'Sync scroll',exact:true}).isDisabled(),true);
  await page.getByText(/To sync web pages and HTML files, use the desktop app/).waitFor();
  check('browser web-only synchronization gives visible desktop guidance');
  await browser.close();browser=null;
  // Set all paths BEFORE importing real main.mjs and acquiring its instance lock.
  const bootstrap=join(temp,'electron-qa.cjs');
  writeFileSync(bootstrap,`const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});app.setPath('home',${JSON.stringify(temp)});app.setPath('logs',${JSON.stringify(join(temp,'logs'))});import(${JSON.stringify(pathToFileURL(join(root,'electron/main.mjs')).href)});`);
  electron=await _electron.launch({executablePath:process.env.GBS_ELECTRON_EXECUTABLE??require('electron'),args:[`--user-data-dir=${profile}`,bootstrap],env:{...env,ELECTRON_START_URL:ui,CUA_DRIVER_PATH:join(temp,'no-cua-driver')},timeout:30000});
  const identity=await electron.evaluate(({app,BrowserWindow})=>({userData:app.getPath('userData'),home:app.getPath('home'),urls:BrowserWindow.getAllWindows().map(w=>w.webContents.getURL())}));
  assert.equal(identity.userData,profile);assert.equal(identity.home,temp);assert.ok(identity.urls.every(url=>!url.includes(':8899')&&!url.includes(':5199')));
  const desktop=await electron.firstWindow();desktop.setDefaultTimeout(15000);await desktop.waitForURL(ui+'/**');
  for(const [label,source]of [['project HTML',html],['external website',web]]){
    await open(desktop,source,true);
    await desktop.waitForFunction(async()=>{const views=[...document.querySelectorAll('webview')];if(views.length!==6)return false;try{return(await Promise.all(views.map(v=>v.executeJavaScript('document.scrollingElement.scrollHeight-document.scrollingElement.clientHeight')))).every(n=>n>0)}catch{return false}});
    assert.equal(await desktop.getByRole('button',{name:'Sync scroll',exact:true}).getAttribute('aria-pressed'),'true');
    const scroll=ratio=>desktop.evaluate(ratio=>document.querySelector('webview').executeJavaScript(`window.scrollTo({top:(document.scrollingElement.scrollHeight-document.scrollingElement.clientHeight)*${ratio},behavior:'instant'})`),ratio);
    const waitRatio=ratio=>desktop.waitForFunction(async ratio=>{try{return(await Promise.all([...document.querySelectorAll('webview')].map(v=>v.executeJavaScript('document.scrollingElement.scrollTop/(document.scrollingElement.scrollHeight-document.scrollingElement.clientHeight)')))).every(value=>Math.abs(value-ratio)<0.002)}catch{return false}},ratio);
    await scroll(0.37);await waitRatio(0.37);
    await desktop.evaluate(()=>document.querySelectorAll('webview')[2].executeJavaScript("window.scrollTo({top:(document.scrollingElement.scrollHeight-document.scrollingElement.clientHeight)*0.62,behavior:'instant'})"));await waitRatio(0.62);
    const prefs=await electron.evaluate(({webContents})=>webContents.getAllWebContents().filter(w=>w.getType()==='webview').map(w=>{const p=w.getLastWebPreferences();return{sandbox:p.sandbox,node:p.nodeIntegration,isolated:p.contextIsolation}}));
    assert.ok(prefs.length>=6&&prefs.every(p=>p.sandbox&&!p.node&&p.isolated));
    if(label==='project HTML')assert.deepEqual(await desktop.evaluate(()=>document.querySelector('webview').executeJavaScript('window.qaSecurity')),['refused','refused']);
    await desktop.getByRole('button',{name:'Sync scroll',exact:true}).click();
    const positions=await desktop.evaluate(()=>Promise.all([...document.querySelectorAll('webview')].slice(1).map(v=>v.executeJavaScript('document.scrollingElement.scrollTop'))));
    await scroll(0.1);
    // Observe more than two polling cycles; no follower should move with sync off.
    await desktop.evaluate(()=>new Promise(r=>setTimeout(r,400)));
    assert.deepEqual(await desktop.evaluate(()=>Promise.all([...document.querySelectorAll('webview')].slice(1).map(v=>v.executeJavaScript('document.scrollingElement.scrollTop')))),positions);
    check(`actual isolated Electron ${label}: six live views follow either leader; sync-off stops followers; guest sandbox/Node isolation retained`);
  }
  for(const source of [md,image,pdf])await checkViewer(desktop,source);
  check('actual isolated Electron non-HTML files ignore Canvas/device state and show one full-screen viewer');
  console.log(`Isolated desktop/browser/security checks passed; harness ${apiPort}, Vite ${uiPort}, external fixture ${external.address().port}; userData=${profile}; no model turns.`);
} finally {
  await electron?.close();await browser?.close();for(const child of children)await stop(child);await new Promise(r=>external.close(r));rmSync(temp,{recursive:true,force:true});
}
