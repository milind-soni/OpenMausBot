// Full server + built viewer + synthetic Docker/RFB, in disposable homes.
// Build first, then run with explicit OMB_AGENT_BROWSER_PATH and
// AGENT_BROWSER_EXECUTABLE_PATH if reusing installed browser binaries.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "./control-omb.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv } from "./testing/control-omb-ui.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";
import { fakeVnc } from "./testing/fake-vnc.ts";
import { BASE_IMAGE_DIGEST, CUA_DRIVER_VERSION, IMAGE, IMAGE_LAYER_VERSION } from "../server/container-computer.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "omb-viewer-fixture-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
mkdirSync(join(scratch, "tmp"));
const desktop = await fakeVnc();
let fixture: VerificationServer | undefined;
let browser: { binary: string; env: NodeJS.ProcessEnv } | undefined;
try {
  // This executable answers only read-only inspection. No command can reach
  // the machine's real Docker installation, even during fixture startup.
  writeFileSync(join(bin, "docker"), `#!${process.execPath}
let args = process.argv.slice(2);
if (args[0] === "-H") args = args.slice(2);
const labels = ${JSON.stringify({ "com.openmausbot.local-vm": "1", "com.openmausbot.cua-driver": CUA_DRIVER_VERSION, "com.openmausbot.cua-base": BASE_IMAGE_DIGEST, "com.openmausbot.image-layer": IMAGE_LAYER_VERSION, "com.openmausbot.workspace": "1" })};
let result;
const imageId = 'sha256:' + 'a'.repeat(64);
if (args[0] === 'inspect' && /^openmausbot-vps-/.test(args[1])) result = [{
  Id:'b'.repeat(64), Image:imageId, State:{Running:true}, Mounts:[],
  Config:{Image:${JSON.stringify(IMAGE)}, Env:['VNC_PW=fixture-password'], Labels:{...labels,
    'com.openmausbot.vps':'1', 'com.openmausbot.container':args[1], 'com.openmausbot.vps-viewer':'1'}},
  HostConfig:{Privileged:false,NetworkMode:'bridge',PortBindings:{},Memory:4294967296,MemorySwap:4294967296,NanoCpus:2000000000,
    PidsLimit:512,CapDrop:['ALL'],CapAdd:['CAP_SETUID','CAP_SETGID'],IpcMode:'private',ShmSize:536870912,
    CgroupnsMode:'private',SecurityOpt:[],RestartPolicy:{Name:'unless-stopped',MaximumRetryCount:0}},
  NetworkSettings:{Networks:{bridge:{IPAddress:'172.17.0.5'}}}
}];
else if (args[0] === 'exec') result = args.includes('--version') ? 'cua-driver ${CUA_DRIVER_VERSION}'
  : args.includes('health_report') ? {schema_version:'1',overall:'ok',checks:[]} : {};
else if (args[0] === 'info') result = 'fixture';
else if (args[0] === 'image' && args[1] === 'inspect') result = [{Id:imageId,Config:{Labels:labels}}];
else if (args[0] === 'inspect' && args[1] === 'openmausbot-computer') result = [{
  Config:{Image:${JSON.stringify(IMAGE)},Labels:labels,Env:['VNC_PW=fixture-password']},
  State:{Running:true},Image:imageId,
  HostConfig:{PortBindings:{'6901/tcp':[{HostIp:'127.0.0.1',HostPort:'${desktop.port}'}]}},
  NetworkSettings:{Ports:{'6901/tcp':[{HostIp:'127.0.0.1',HostPort:'${desktop.port}'}]}}
}];
else if (args[0] === 'ps') result = '';
else process.exit(1);
process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result));
`, { mode: 0o700 });
  // Stand in for SSH with an owned loopback TCP forward. It cannot dial a VPS.
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
const net = require('node:net');
const fs = require('node:fs');
const args = process.argv.slice(2);
const forward = args[args.indexOf('-L') + 1];
if (!args.includes('-N') || !/^127\\.0\\.0\\.1:[0-9]+:172\\.17\\.0\\.5:6901$/.test(forward)) process.exit(1);
const log = ${JSON.stringify(join(scratch, "tunnels.log"))};
const server = net.createServer(socket => {
  const peer = net.connect(${desktop.port}, '127.0.0.1');
  socket.on('error',()=>peer.destroy()); peer.on('error',()=>socket.destroy());
  socket.on('close',()=>peer.destroy()); peer.on('close',()=>socket.destroy());
  socket.pipe(peer).pipe(socket);
});
server.listen(Number(forward.split(':')[1]),'127.0.0.1',()=>fs.appendFileSync(log,'open '));
process.on('SIGTERM',()=>{fs.appendFileSync(log,'close ');process.exit(0)});
`, { mode: 0o700 });
  fixture = await launchVerificationServer(process.env, undefined, {
    binDir: bin, host: "ssh://127.0.0.1:1", sshKey: join(scratch, "unused-key"), staticDir: join(root, "dist"),
  });
  console.log(JSON.stringify(fixture.info));
  const api = fixtureApi(fixture.info.url);
  const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  const { binary, chrome } = await ensureUiBrowser(process.env);
  const env = sessionEnv({ home: scratch, session: `viewer-${process.pid}`, chrome });
  browser = { binary, env };
  const command = (...args: string[]) => agentBrowser(binary, env, args);
  const evaluate = async <T = unknown>(js: string) => (await command("eval", js)).result as T;
  await command("open", `${fixture.info.url}/desktop-viewer#target=local%2Fshared`);
  // Pair through the actual HTTP endpoint in this disposable browser. The
  // resulting cookie forces both status and upgrades through session auth.
  assert.equal(await evaluate(`(async () => (await fetch('/api/auth/pair', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:${JSON.stringify(pairing.code)},cookie:true,label:'Viewer fixture'})})).status)()`), 200);
  await command("wait", "--fn", "document.getElementById('retry') !== null");
  let nextConnection = desktop.nextConnection();
  await command("click", "#retry");
  await nextConnection;
  await command("wait", "--fn", "document.getElementById('status').textContent === 'Desktop connected'");
  assert.equal(await evaluate("document.querySelector('canvas').width"), 16);
  await command("wait", "--fn", "document.querySelector('canvas').getContext('2d').getImageData(0,0,1,1).data[0] === 255");
  assert.equal(await evaluate("document.querySelector('canvas').getContext('2d').getImageData(0,0,1,1).data[0]"), 255);
  const status = await evaluate<{ viewer_url: string }>("fetch('/api/local-computer').then(r=>r.json())");
  assert.equal(status.viewer_url, "/desktop-viewer#target=local%2Fshared");
  assert.equal(status.viewer_url.includes("password"), false);
  const matchingBackgrounds = "getComputedStyle(document.querySelector('#screen > div')).backgroundColor === getComputedStyle(document.querySelector('main')).backgroundColor";
  assert.equal(await evaluate(matchingBackgrounds), true);
  const evidenceDir = process.env.OMB_UI_EVIDENCE_DIR ? resolve(root, process.env.OMB_UI_EVIDENCE_DIR) : dirname(fixture.info.logPath);
  mkdirSync(evidenceDir, { recursive: true });
  const desktopScreenshot = join(evidenceDir, `viewer-${process.pid}-desktop.png`);
  await command("wait", "--fn", "document.getAnimations().every(a => a.playState !== 'running')");
  await command("screenshot", desktopScreenshot);
  await command("click", "#keyboard");
  await command("fill", "#text", "Hello\n世界");
  await command("click", "#send");
  await desktop.untilKey(0x0100754c);
  assert.ok(desktop.keys.includes(72));
  assert.ok(desktop.keys.includes(0xff0d));
  assert.ok(desktop.keys.includes(0x01004e16));
  await command("click", "#ctrl-alt-del");
  await desktop.untilKey(0xffff);
  assert.ok(desktop.keys.includes(0xffff));
  await command("click", "#clipboard");
  desktop.sendClipboard("From the desktop");
  await command("wait", "--fn", "document.getElementById('clipboard-text').value === 'From the desktop'");
  assert.equal(await evaluate("document.getElementById('send') === null"), true);
  await command("wait", "--fn", "document.getAnimations().every(a => a.playState !== 'running')");
  assert.equal(await evaluate("(() => { const title = document.querySelector('section h1').getBoundingClientRect(), close = document.querySelector('section button').getBoundingClientRect(); return close.height <= 32 && Math.abs((title.top + title.bottom - close.top - close.bottom) / 2) < 1; })()"), true);
  const clipboardScreenshot = join(evidenceDir, `viewer-${process.pid}-clipboard.png`);
  await command("screenshot", clipboardScreenshot);
  let nextClipboard = desktop.nextClipboard();
  await command("fill", "#clipboard-text", "To the desktop");
  assert.deepEqual(await nextClipboard, ["To the desktop"]);
  nextClipboard = desktop.nextClipboard();
  await evaluate("document.getElementById('clipboard-text').select()");
  await command("press", "Backspace");
  assert.deepEqual(await nextClipboard, [""]);
  // Editing this field syncs automatically; device clipboard permissions are never requested.
  await command("click", "#clipboard");
  assert.equal(await evaluate("document.getElementById('fit') === null"), true);
  const normalFit = "(() => { const r = document.getElementById('screen').getBoundingClientRect(), m = document.querySelector('main').getBoundingClientRect(); return r.width / m.width > .94 && r.width / m.width < .96 && r.height / m.height > .94 && r.height / m.height < .96; })()";
  assert.equal(await evaluate(normalFit), true);
  assert.equal(await evaluate("document.getElementById('keyboard').title"), "Keyboard");
  assert.equal(await evaluate("document.getElementById('viewer-notice').title"), "noVNC licenses and source");
  assert.equal(await evaluate("document.getElementById('viewer-notice').target"), "_blank");
  assert.ok((await api("GET", "/api/local-computer")).viewer_url);
  const notice = await fetch(await evaluate<string>("document.getElementById('viewer-notice').href"));
  assert.equal(notice.status, 200);
  assert.equal(notice.headers.get("content-type"), "text/plain; charset=utf-8");
  const noticeText = await notice.text();
  assert.equal(noticeText, readFileSync(join(root, "public/novnc-NOTICE.txt"), "utf8"));
  const novncVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies["@novnc/novnc"];
  assert.ok(noticeText.includes(`https://github.com/novnc/noVNC/tree/v${novncVersion}`));
  assert.ok(noticeText.includes(readFileSync(join(root, "node_modules/@novnc/novnc/vendor/pako/LICENSE"), "utf8")));
  const desNotice = readFileSync(join(root, "node_modules/@novnc/novnc/core/crypto/des.js"), "utf8").split("*/", 1)[0] + "*/";
  assert.ok(noticeText.includes(desNotice));
  const dockedWidth = await evaluate<number>("document.querySelector('main').getBoundingClientRect().width");
  await command("click", "#hide-controls");
  await command("wait", "--fn", "document.querySelector('aside').getBoundingClientRect().width === 0");
  assert.ok(await evaluate<number>("document.querySelector('main').getBoundingClientRect().width") > dockedWidth);
  assert.equal(await evaluate("document.querySelector('aside').inert"), true);
  await command("wait", "--fn", "document.activeElement?.id === 'show-controls'");
  assert.equal(await evaluate("(() => { const link = document.getElementById('viewer-notice'), r = link.getBoundingClientRect(); return !link.closest('[inert]') && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === link; })()"), true);
  const balancedMargins = "(() => { const r = document.querySelector('main').getBoundingClientRect(); return r.left > 0 && Math.abs(r.left - (innerWidth - r.right)) < 1; })()";
  assert.equal(await evaluate(balancedMargins), true);
  await command("click", "#show-controls");
  await command("wait", "--fn", "document.querySelector('aside').getBoundingClientRect().width === 72");
  await command("wait", "--fn", "document.activeElement?.id === 'hide-controls'");
  if (await evaluate("document.fullscreenEnabled")) {
    await command("click", "#fullscreen");
    await command("wait", "--fn", "Boolean(document.fullscreenElement)");
    const fullscreenFit = "(() => { const r = document.getElementById('screen').getBoundingClientRect(), m = document.querySelector('main').getBoundingClientRect(); return r.top === 0 && r.bottom === innerHeight && r.left === m.left && r.right === innerWidth; })()";
    await command("wait", "--fn", fullscreenFit);
    await command("screenshot", join(evidenceDir, `viewer-${process.pid}-fullscreen.png`));
    await command("click", "#hide-controls");
    await command("wait", "--fn", "document.querySelector('aside').getBoundingClientRect().width === 0");
    assert.equal(await evaluate(fullscreenFit), true);
    assert.equal(await evaluate("document.getElementById('screen').getBoundingClientRect().left"), 0);
    await command("click", "#show-controls");
    await command("wait", "--fn", "document.querySelector('aside').getBoundingClientRect().width === 72");
    await command("click", "#fullscreen");
    await command("wait", "--fn", "!document.fullscreenElement");
    await command("wait", "--fn", normalFit);
  }
  await command("set", "viewport", "390", "844");
  await command("click", "#hide-controls");
  await command("wait", "--fn", "document.querySelector('aside').getBoundingClientRect().width === 0");
  assert.equal(await evaluate(balancedMargins), true);
  await command("click", "#show-controls");
  await command("wait", "--fn", "document.querySelector('aside').getBoundingClientRect().width === 72");
  await command("click", "#keyboard");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  const phoneScreenshot = join(evidenceDir, `viewer-${process.pid}-phone.png`);
  await command("wait", "--fn", "document.getAnimations().every(a => a.playState !== 'running')");
  await command("screenshot", phoneScreenshot);
  assert.equal(await evaluate("(() => { const r = document.querySelector('section').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()"), true);
  await evaluate("document.documentElement.dataset.skin = 'daylight'");
  await command("wait", "--fn", "getComputedStyle(document.getElementById('retry')).color === 'rgb(87, 87, 87)'");
  assert.equal(await evaluate(matchingBackgrounds), true);
  const lightScreenshot = join(evidenceDir, `viewer-${process.pid}-light.png`);
  await command("screenshot", lightScreenshot);
  // Match the shared skin rules for both enabled and disabled accent buttons.
  await evaluate("document.documentElement.dataset.skin = 'foundry'");
  await command("wait", "--fn", "getComputedStyle(document.getElementById('send')).color === 'rgb(176, 166, 150)'");
  await command("fill", "#text", "Foundry preview");
  await command("wait", "--fn", "getComputedStyle(document.getElementById('send')).color === 'rgb(28, 21, 12)'");
  const foundryScreenshot = join(evidenceDir, `viewer-${process.pid}-foundry.png`);
  await command("screenshot", foundryScreenshot);
  // A short landscape viewport must keep both the dock and panel scrollable.
  await command("set", "viewport", "844", "390");
  assert.equal(await evaluate("document.documentElement.scrollHeight <= innerHeight && document.querySelector('section').getBoundingClientRect().height <= innerHeight"), true);
  assert.equal(await evaluate("(async () => { document.getElementById('keyboard').click(); await new Promise(requestAnimationFrame); const p = document.querySelector('section'); return !p || p.inert; })()"), true);
  await command("wait", "--fn", "!document.querySelector('section')");
  // Reuse the app's reduced-motion path and verify that a closed panel leaves
  // no focusable controls behind, including during its normal animated exit.
  await evaluate("document.documentElement.dataset.reducedMotion = 'true'");
  await command("click", "#keyboard");
  await command("click", "#keyboard");
  await command("wait", "--fn", "!document.querySelector('section')");
  nextConnection = desktop.nextConnection();
  await command("click", "#retry");
  await nextConnection;
  await command("wait", "--fn", "document.getElementById('status').textContent === 'Desktop connected'");
  // Leaving while the credentials request is in flight must abort it. A
  // persisted-page restore must then establish a fresh connection.
  await evaluate(`(() => {
    const fetch = window.fetch;
    window.fetch = async (input, init) => {
      if (input !== '/api/desktop-viewer/local/shared') return fetch(input, init);
      window.fetch = fetch;
      window.viewerSignal = init.signal;
      const response = await fetch(input, init);
      await new Promise(resolve => { window.releaseViewerRequest = resolve; });
      return response;
    };
  })()`);
  await command("click", "#retry");
  await command("wait", "--fn", "typeof window.releaseViewerRequest === 'function'");
  assert.equal(await evaluate("(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true})); return window.viewerSignal.aborted; })()"), true);
  await evaluate("window.releaseViewerRequest()");
  nextConnection = desktop.nextConnection();
  await evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}))");
  await nextConnection;
  await command("wait", "--fn", "document.getElementById('status').textContent === 'Desktop connected'");
  // Exercise the real VPS join route, SSH process lifecycle and the same UI.
  await runControlOmb(["new-bot", "--name", "VPS fixture", "--url", fixture.info.url]);
  const { bots } = await api("GET", "/api/bots?messages=0");
  const vpsBot = bots.find((bot: { name: string }) => bot.name === "VPS fixture");
  await api("PATCH", "/api/config", { vps: { sshAlias: "viewer-fixture" } });
  await api("PATCH", `/api/bots/${vpsBot.id}`, { computer: "cloud", cloudBackend: "vps" });
  // Two tabs opening at once share one join instead of the second being refused.
  const [joined] = await evaluate<{joinUrl:string}[]>(`Promise.all([0, 1].map(() => fetch('/api/bots/${vpsBot.id}/computer/join',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(async r=>{if(!r.ok)throw new Error(await r.text());return r.json()})))`);
  const viewer = new URL(joined.joinUrl, fixture.info.url);
  assert.equal(viewer.pathname, "/desktop-viewer");
  const target = new URLSearchParams(viewer.hash.slice(1));
  assert.equal(target.get("target"), `vps/${vpsBot.id}`);
  assert.ok(target.get("threadId"));
  assert.equal(target.has("password"), false);
  await command("click", "#clipboard");
  desktop.sendClipboard("Only on the previous desktop");
  await command("wait", "--fn", "document.getElementById('clipboard-text').value === 'Only on the previous desktop'");
  nextConnection = desktop.nextConnection();
  await Promise.all([nextConnection, command("open", `${fixture.info.url}${joined.joinUrl}`)]);
  await command("wait", "--fn", "document.getElementById('status').textContent === 'Desktop connected'");
  assert.equal(await evaluate("document.querySelector('section') === null || document.querySelector('section').inert"), true);
  await command("click", "#clipboard");
  assert.equal(await evaluate("document.getElementById('clipboard-text').value"), "");
  await command("click", "#clipboard");
  await command("wait", "--fn", "document.getElementById('status').textContent === 'Desktop connected'");
  await command("wait", "--fn", "document.querySelector('canvas').getContext('2d').getImageData(0,0,1,1).data[0] === 255");
  nextConnection = desktop.nextConnection();
  await command("click", "#retry");
  await nextConnection;
  await command("wait", "--fn", "document.getElementById('status').textContent === 'Desktop connected'");
  assert.equal(readFileSync(join(scratch, "tunnels.log"), "utf8").split("open").length - 1, 1);
  const beforeLogout = desktop.connections();
  assert.equal(await evaluate("fetch('/api/auth/session').then(r=>r.json()).then(s=>s.kind)"), "session");
  assert.equal(await evaluate("fetch('/api/auth/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status)"), 200);
  await command("wait", "--fn", "document.getElementById('status').textContent.includes('disconnected')");
  assert.ok(beforeLogout >= 2);
  console.log(JSON.stringify({ ok: true, checks: ["built noVNC renders RFB pixels", "paired status uses app URL", "keyboard, Unicode and Ctrl-Alt-Del", "clipboard sync without Send, including clearing", "matching desktop backgrounds in both themes", "Foundry accent text", "95% fit, full-height fullscreen and fit restoration", "balanced collapsed margins and compact panel header", "native tooltips and reduced-motion panels", "phone and landscape viewports", "reconnect", "page exit aborts pending connection and restore reconnects", "VPS join, synthetic SSH forward and reconnect", "logout closes socket"], logPath: fixture.info.logPath, screenshots: [desktopScreenshot, clipboardScreenshot, phoneScreenshot, lightScreenshot, foundryScreenshot] }));
} catch (error) {
  if (browser) console.error(await agentBrowser(browser.binary, browser.env, ["eval", "document.body.innerText"]).catch(() => "Browser unavailable"));
  throw error;
} finally {
  if (browser) await agentBrowser(browser.binary, browser.env, ["close"], 10_000).catch(() => {});
  await fixture?.close();
  await desktop.close();
  rmSync(scratch, { recursive: true, force: true });
}
