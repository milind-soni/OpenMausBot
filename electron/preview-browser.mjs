import { randomUUID } from "node:crypto";

const debuggers = new WeakMap();
function debuggerState(wc) {
  let state = debuggers.get(wc);
  if (!state) { state = { refs: 0, owned: false, tail: Promise.resolve() }; debuggers.set(wc, state); }
  return state;
}
export function acquirePreviewDebugger(wc) {
  const state = debuggerState(wc);
  if (!wc.debugger.isAttached()) { wc.debugger.attach("1.3"); state.owned = true; }
  state.refs++;
  let released = false;
  return () => {
    if (released) return;
    released = true; state.refs--;
    if (!state.refs && state.owned && !wc.isDestroyed() && wc.debugger.isAttached()) { wc.debugger.detach(); state.owned = false; }
  };
}
export function withPreviewDebugger(wc, work) {
  const state = debuggerState(wc);
  const operation = state.tail.catch(() => {}).then(async () => {
    const release = acquirePreviewDebugger(wc);
    try { return await work(wc.debugger); } finally { release(); }
  });
  state.tail = operation.catch(() => {});
  return operation;
}
export async function capturePreviewPNG(wc, fullPage = false, signal) {
  if (!fullPage) return (await wc.capturePage()).toPNG().toString("base64");
  return withPreviewDebugger(wc, async dbg => {
    const metrics = await dbg.sendCommand("Page.getLayoutMetrics");
    const size = metrics.cssContentSize ?? metrics.contentSize;
    const width = Math.ceil(size.width), height = Math.ceil(size.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 24_000_000) throw new Error("Page is too large for a full-page image. Capture the visible area instead.");
    // Electron's beyond-viewport compositor capture can repeat tiles (notably
    // in Retina webviews). Assemble real viewport captures at CSS resolution.
    const { nativeImage } = await import("electron");
    const key = JSON.stringify(`__gbsCapture_${randomUUID()}`);
    const script = code => wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], true);
    const pixels = Buffer.alloc(width * height * 4);
    try {
      await script(`(() => {
        const saved = { x: scrollX, y: scrollY, styles: [] };
        globalThis[${key}] = saved;
        const set = (el, values) => {
          saved.styles.push([el, el.getAttribute('style')]);
          for (const [name, value] of Object.entries(values)) el.style.setProperty(name, value, 'important');
        };
        set(document.documentElement, { 'scroll-behavior': 'auto', 'scroll-snap-type': 'none', 'overflow-anchor': 'none', 'scrollbar-color': 'transparent transparent' });
        scrollTo(0, 0);
        // Pin overlays once at their initial document coordinates. Sticky
        // elements retain their place in flow while later tiles scroll past.
        const overlays = Array.from(document.querySelectorAll('*')).map(el => ({ el, position: getComputedStyle(el).position, rect: el.getBoundingClientRect() })).filter(o => ['fixed', 'sticky'].includes(o.position));
        for (const { el, position, rect } of overlays) {
          if (position === 'sticky') set(el, { position: 'relative', top: 'auto', bottom: 'auto', left: 'auto', right: 'auto' });
          else set(el, { position: 'absolute', top: rect.top + 'px', left: rect.left + 'px', bottom: 'auto', right: 'auto', width: rect.width + 'px', height: rect.height + 'px', 'box-sizing': 'border-box', margin: '0' });
        }
      })()`);
      let tileHeight = 0, tileWidth = 0;
      for (let y = 0; y < height; y += tileHeight) {
        for (let x = 0; x < width; x += tileWidth) {
          if (signal?.aborted || wc.isDestroyed()) throw new Error("Preview screenshot cancelled.");
          const view = await script(`(async () => {
            scrollTo(${x}, ${y});
            await new Promise(resolve => { const timer = setTimeout(resolve, 250); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); });
            return { x: scrollX, y: scrollY, width: innerWidth, height: innerHeight };
          })()`);
          tileWidth = Math.floor(view.width); tileHeight = Math.floor(view.height);
          const sourceX = Math.round(x - view.x), sourceY = Math.round(y - view.y);
          const copyWidth = Math.min(tileWidth - sourceX, width - x), copyHeight = Math.min(tileHeight - sourceY, height - y);
          if (copyWidth <= 0 || copyHeight <= 0) throw new Error("Page cannot be scrolled for a full-page image. Capture the visible area instead.");
          const captured = await wc.capturePage();
          const actual = captured.getSize();
          if (Math.abs(actual.width * tileHeight - actual.height * tileWidth) > Math.max(actual.width, actual.height) * 2) throw new Error("Preview viewport changed or was clipped during screenshot. Try the visible area.");
          const shot = captured.resize({ width: tileWidth, height: tileHeight });
          if (signal?.aborted) throw new Error("Preview screenshot cancelled.");
          const bitmap = shot.toBitmap({ scaleFactor: 1 });
          if (bitmap.length !== tileWidth * tileHeight * 4) throw new Error("Unexpected Preview screenshot dimensions.");
          for (let row = 0; row < copyHeight; row++) {
            const start = ((sourceY + row) * tileWidth + sourceX) * 4;
            bitmap.copy(pixels, ((y + row) * width + x) * 4, start, start + copyWidth * 4);
          }
        }
      }
      return nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 }).toPNG().toString("base64");
    } finally {
      if (!wc.isDestroyed()) await script(`(() => {
        const saved = globalThis[${key}]; if (!saved) return;
        for (const [el, style] of saved.styles.reverse()) {
          if (style === null) el.removeAttribute('style'); else el.setAttribute('style', style);
        }
        scrollTo({ left: saved.x, top: saved.y, behavior: 'instant' });
        delete globalThis[${key}];
      })()`);
    }
  });
}
const WORLD = 1004;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export class PreviewBrowserSession {
  constructor(wc, allowedURL) {
    this.wc = wc;
    this.allowedURL = allowedURL;
    this.diagnostics = [];
    this.requests = new Map();
    this.release = acquirePreviewDebugger(wc);
    this.listener = (_event, method, params) => {
      if (method === "Runtime.exceptionThrown") this.log({ kind: "exception", message: String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? "Page error").slice(0, 2000) });
      if (method === "Runtime.consoleAPICalled" && ["error", "warning", "warn"].includes(params.type)) this.log({ kind: "console", level: params.type, message: (params.args ?? []).map(a => String(a.value ?? a.description ?? "")).join(" ").slice(0, 2000) });
      if (method === "Network.requestWillBeSent") {
        if (this.requests.size > 200) this.requests.delete(this.requests.keys().next().value);
        try { const url = new URL(params.request.url); url.search = ""; url.hash = ""; url.username = ""; url.password = ""; this.requests.set(params.requestId, url.href); } catch {}
      }
      if (method === "Network.loadingFailed") { this.log({ kind: "network", url: this.requests.get(params.requestId), error: String(params.errorText).slice(0, 500) }); this.requests.delete(params.requestId); }
      if (method === "Network.responseReceived" && params.response?.status >= 400) this.log({ kind: "http", url: this.requests.get(params.requestId), status: params.response.status });
      if (method === "Network.loadingFinished") this.requests.delete(params.requestId);
    };
    wc.debugger.on("message", this.listener);
    this.ready = Promise.all([wc.debugger.sendCommand("Runtime.enable"), wc.debugger.sendCommand("Network.enable"), wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {})]);
  }
  log(entry) { this.diagnostics.push({ at: Date.now(), ...entry }); if (this.diagnostics.length > 100) this.diagnostics.shift(); }
  dispose() { this.wc.debugger.removeListener("message", this.listener); this.release(); }
  async script(code) {
    // Electron replaces thrown guest errors with "Script failed to execute".
    // Carry expected validation errors across the world boundary as data.
    const result = await this.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(() => {
      try { return { ok: true, value: (${code}) }; }
      catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 1000) }; }
    })()` }], true);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }
  async snapshot() {
    const revision = randomUUID();
    return this.script(`(() => {
      const nodes = new Map(); globalThis.__gbsPreviewNodes = nodes;
      const controls = [];
      for (const el of document.querySelectorAll('a[href],button,input,textarea,select,[role],[contenteditable="true"],h1,h2,h3')) {
        if (controls.length >= 160) break;
        if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden' || el.closest('[inert],[aria-hidden="true"]')) continue;
        const ref = ${JSON.stringify(revision)} + ':' + (controls.length + 1); nodes.set(ref, el);
        const labelIds = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
        const name = el.getAttribute('aria-label') || labelIds.map(id => document.getElementById(id)?.textContent || '').join(' ') || Array.from(el.labels || []).map(n => { const clone = n.cloneNode(true); clone.querySelectorAll('input,select,textarea,button').forEach(c => c.remove()); return clone.textContent; }).join(' ') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || '';
        controls.push({ ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined, name: name.trim().slice(0, 200), type: el.getAttribute('type') || undefined, disabled: el.matches(':disabled') || Boolean(el.closest('[aria-disabled="true"]')), value: el.type === 'password' ? '[redacted]' : typeof el.value === 'string' ? el.value.slice(0, 300) : undefined });
      }
      return { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, text: (document.body?.innerText || '').slice(0, 20000), controls, limitations: ['Main document only; nested frames and shadow DOM are not inspected.'] };
    })()`);
  }
  async element(ref, operation) {
    if (typeof ref !== "string" || ref.length > 100) throw new Error("Use an element ref from preview_snapshot.");
    return this.script(`(() => {
      const el = globalThis.__gbsPreviewNodes?.get(${JSON.stringify(ref)});
      if (!el?.isConnected) throw new Error('Stale element reference. Take a new preview_snapshot.');
      if (el.matches(':disabled') || el.closest('[aria-disabled="true"]')) throw new Error('This control is disabled.');
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      ${operation}
    })()`);
  }
  async perform(operation, args, signal) {
    const check = () => { if (signal.aborted || this.wc.isDestroyed()) throw new Error("Preview action cancelled."); };
    check(); await this.ready; check();
    const send = async (method, value) => { check(); return withPreviewDebugger(this.wc, dbg => { check(); return dbg.sendCommand(method, value); }); };
    if (operation === "snapshot" || operation === "open") return this.snapshot();
    if (operation === "diagnostics") return { url: this.wc.getURL(), events: [...this.diagnostics] };
    if (operation === "screenshot") {
      const image = await capturePreviewPNG(this.wc, args.full_page === true, signal); check();
      if (image.length > 11_000_000) throw new Error("Screenshot is too large; try the visible area.");
      return { image, mimeType: "image/png", ...(await this.script('({ url: location.href, viewport: { width: innerWidth, height: innerHeight } })')) };
    }
    if (operation === "click") {
      const point = await this.element(args.ref, `const r = el.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; const hit = document.elementFromPoint(x, y); if (!hit || (hit !== el && !el.contains(hit))) throw new Error('Control is covered or outside the viewport.'); return { x, y };`);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    } else if (operation === "fill") {
      if (typeof args.text !== "string" || args.text.length > 20_000) throw new Error("Provide input text up to 20000 characters.");
      check(); this.wc.focus();
      await this.element(args.ref, `if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || ['file','checkbox','radio','button','submit','hidden'].includes(el.type)) throw new Error('Choose a text input or textarea.'); if (el.readOnly) throw new Error('Input is read-only.'); el.focus(); el.select(); return true;`);
      check();
      // CDP input works without OS window focus; wc.insertText silently drops text when Studio is in the background.
      if (args.text) await send("Input.insertText", { text: args.text });
      else {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      }
      const value = JSON.stringify(args.text);
      // Last resort for pages that swallow synthetic key input: native setter + input/change so frameworks observe it.
      const filled = await this.element(args.ref, `if (el.value !== ${value}) { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${value}); el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: ${value} })); el.dispatchEvent(new Event('change', { bubbles: true })); } return el.value === ${value};`);
      if (!filled) throw new Error("Preview input did not accept the requested text.");
    } else if (operation === "select") {
      if (typeof args.value !== "string" || args.value.length > 2000) throw new Error("Provide a select option value.");
      await this.element(args.ref, `if (!(el instanceof HTMLSelectElement) || !Array.from(el.options).some(o => o.value === ${JSON.stringify(args.value)} && !o.disabled)) throw new Error('Choose an available select option.'); el.value = ${JSON.stringify(args.value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    } else if (operation === "press") {
      const keys = { Enter: ["Enter", "Enter", 13], Tab: ["Tab", "Tab", 9], Escape: ["Escape", "Escape", 27], Space: [" ", "Space", 32], ArrowDown: ["ArrowDown", "ArrowDown", 40], ArrowUp: ["ArrowUp", "ArrowUp", 38], ArrowLeft: ["ArrowLeft", "ArrowLeft", 37], ArrowRight: ["ArrowRight", "ArrowRight", 39], Backspace: ["Backspace", "Backspace", 8], Delete: ["Delete", "Delete", 46], Home: ["Home", "Home", 36], End: ["End", "End", 35] };
      const key = keys[args.key];
      if (!key) throw new Error(`Supported keys: ${Object.keys(keys).join(', ')}`);
      check(); this.wc.focus();
      if (args.ref) await this.element(args.ref, "el.focus(); return true;");
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: key[0], code: key[1], windowsVirtualKeyCode: key[2], ...(args.key === "Enter" ? { text: "\r" } : args.key === "Space" ? { text: " " } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: key[0], code: key[1], windowsVirtualKeyCode: key[2] });
    } else if (operation === "scroll") {
      const x = Number(args.x ?? 0), y = Number(args.y ?? 600);
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 10000 || Math.abs(y) > 10000) throw new Error("Scroll distances must be within ±10000 pixels.");
      await this.script(`(scrollBy({ left: ${x}, top: ${y}, behavior: 'instant' }), true)`);
    } else if (operation === "wait") {
      if ((!args.text && !args.ref) || (args.text && (typeof args.text !== "string" || args.text.length > 2000))) throw new Error("Wait needs text or an element ref.");
      const timeout = args.timeout_ms ?? 5000;
      if (!Number.isInteger(timeout) || timeout < 0 || timeout > 10000) throw new Error("Wait timeout must be 0–10000ms.");
      const deadline = Date.now() + timeout;
      while (true) {
        check();
        const matched = args.ref ? await this.element(args.ref, 'return Boolean(el.getClientRects().length);') : await this.script(`(() => {
          const normalize = text => text.replace(/\\s+/gu, ' ').trim();
          return normalize(document.body?.innerText || '').includes(normalize(${JSON.stringify(args.text)}));
        })()`);
        if (matched) break;
        if (Date.now() >= deadline) throw new Error("Preview wait timed out.");
        await pause(100);
      }
    } else if (operation === "navigate") {
      if (!this.allowedURL(args.url)) throw new Error("Navigation to this URL is not allowed.");
      await this.wc.loadURL(args.url); check();
    } else if (["reload", "back", "forward"].includes(operation)) {
      if (operation === "reload") this.wc.reload();
      if (operation === "back" && this.wc.navigationHistory.canGoBack()) this.wc.navigationHistory.goBack();
      if (operation === "forward" && this.wc.navigationHistory.canGoForward()) this.wc.navigationHistory.goForward();
      return { accepted: true, note: "Navigation started. Use preview_snapshot or preview_action wait to check the result." };
    } else throw new Error("Unsupported Preview operation.");
    check();
    return { url: this.wc.getURL(), completed: operation };
  }
}
