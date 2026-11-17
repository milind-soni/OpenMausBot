// Disposable Electron host for preview-browser-repairs.mjs.
import { app, BrowserWindow, nativeImage } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capturePreviewPNG, PreviewBrowserSession } from "../../electron/preview-browser.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  assert.ok(process.env.GBS_QA_USER_DATA, "Use the Node runner for an isolated profile");
  app.setPath("userData", process.env.GBS_QA_USER_DATA);
  app.whenReady().then(async () => {
    console.log("Isolated Electron ready");
    const artifacts = join(root, ".omb-scratch", "preview-repairs"); mkdirSync(artifacts, { recursive: true });
    const fixture = `<!doctype html><style>*{box-sizing:border-box}body{margin:0;background:white}header{height:50px;position:sticky;top:0;background:red}section{height:400px}aside{position:fixed;bottom:0;height:30px;width:100%;background:blue}</style><header>Sticky header</header>${Array.from({length:8},(_,i)=>`<section style="background:rgb(${20+i*25},${200-i*20},80)">Section ${i}</section>`).join("")}<aside>Fixed footer</aside><p>100&#8239;000 FCFA</p><button disabled>Unavailable</button><fieldset disabled><button>Inherited disabled</button></fieldset><div aria-disabled="true"><button>ARIA disabled</button></div>`;
    const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(fixture); });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const win = new BrowserWindow({ width: 1000, height: 950, show: true, webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    let browser;
    try {
      const guestReady = new Promise(resolve => win.webContents.once("did-attach-webview", (_e, wc) => { wc.once("did-finish-load", () => resolve(wc)); }));
      await win.loadURL("data:text/html," + encodeURIComponent(`<webview src="http://127.0.0.1:${server.address().port}" style="width:393px;height:852px;transform:scale(.8);transform-origin:top left"></webview>`));
      const wc = await guestReady; browser = new PreviewBrowserSession(wc, () => true); await browser.ready;
      const signal = new AbortController().signal;
      await browser.perform("wait", { text: "100 000 FCFA", timeout_ms: 0 }, signal);
      const snapshot = await browser.snapshot();
      for (const c of snapshot.controls.filter(c => c.tag === "button")) {
        assert.equal(c.disabled, true, c.name);
        await assert.rejects(browser.perform("click", { ref: c.ref }, signal), /This control is disabled/);
      }
      const state = () => browser.script('({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,position:getComputedStyle(document.querySelector("header")).position,style:document.querySelector("section").getAttribute("style")})');
      await browser.script('(scrollTo(0,1300),true)'); const before = await state();
      const image = Buffer.from(await capturePreviewPNG(wc, true, signal), "base64");
      writeFileSync(join(artifacts, "full-page.png"), image);
      const png = nativeImage.createFromBuffer(image); const { width, height } = png.getSize();
      assert.equal(width, 393); assert.ok(height > 3250 && height < 3600);
      const bitmap = png.toBitmap({ scaleFactor: 1 });
      for (let i = 0; i < 8; i++) {
        const offset = ((250 + i * 400) * width + 200) * 4;
        const expected = [80, 200 - i * 20, 20 + i * 25, 255];
        for (let c = 0; c < 4; c++) assert.ok(Math.abs(bitmap[offset + c] - expected[c]) <= 3, `Section ${i} channel ${c}: ${bitmap[offset+c]} vs ${expected[c]}`);
      }
      assert.deepEqual(await state(), before, "Capture must restore viewport, scroll, sticky positioning and original inline styles");
      const capture = wc.capturePage.bind(wc);
      wc.capturePage = async () => { throw new Error("Injected capture failure"); };
      await assert.rejects(capturePreviewPNG(wc, true, signal), /Injected capture failure/);
      assert.deepEqual(await state(), before, "Failure must restore the page");
      wc.capturePage = capture;
      const abort = new AbortController();
      wc.capturePage = async () => { const result = await capture(); abort.abort(); return result; };
      await assert.rejects(capturePreviewPNG(wc, true, abort.signal), /cancelled/);
      assert.deepEqual(await state(), before, "Cancellation must restore the page");
      wc.capturePage = capture;
      const visible = Buffer.from(await capturePreviewPNG(wc), "base64");
      writeFileSync(join(artifacts, "visible.png"), visible);
      const visibleSize = nativeImage.createFromBuffer(visible).getSize();
      assert.equal(visibleSize.width / visibleSize.height, 393 / 852);
      assert.equal(wc.debugger.isAttached(), true, "Capture must retain the bot's debugger");
      // A document wider than its viewport must also stitch columns correctly.
      await browser.script(`(() => {
        document.body.innerHTML = '<div style="width:800px;height:1800px;background:linear-gradient(to right,red 0,red 400px,blue 400px,blue 800px)"></div>';
        scrollTo(0,0);
      })()`);
      const wide = nativeImage.createFromBuffer(Buffer.from(await capturePreviewPNG(wc, true, signal), 'base64'));
      assert.deepEqual(wide.getSize(), { width: 800, height: 1800 });
      const widePixels = wide.toBitmap({ scaleFactor: 1 });
      for (const y of [200, 1000, 1700]) for (const x of [200, 600, 790]) {
        const offset = (y * 800 + x) * 4;
        const expected = x < 400 ? [0,0,255,255] : [255,0,0,255];
        for (let c = 0; c < 4; c++) assert.ok(Math.abs(widePixels[offset + c] - expected[c]) <= 3, `Wide tile at ${x},${y} channel ${c}`);
      }
      console.log(`PASS: Unicode waits; three disabled-control types; ${width}x${height} full-page pixels; viewport/style/scroll restoration on success, failure and cancellation; visible capture; debugger ownership.`);
    } finally { browser?.dispose(); win.destroy(); await new Promise(r => server.close(r)); }
    app.quit();
  }).catch(error => { console.error(error); app.exit(1); });
