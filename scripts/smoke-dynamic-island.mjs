import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, screen, nativeImage, powerMonitor } from "electron";
import { createDynamicIsland } from "../electron/island-main.mjs";

const smoke = process.argv.includes("--smoke");
const outputArg = process.argv.indexOf("--output");
const output = path.resolve(outputArg >= 0 ? process.argv[outputArg + 1] : "docs/verification/evidence/dynamic-island");
const temporary = await mkdtemp(path.join(os.tmpdir(), "openmaus-island-smoke-"));
app.setPath("userData", path.join(temporary, "profile"));
app.setPath("sessionData", path.join(temporary, "session"));
app.setName("MausBot Island Fixture");

const BOT = "fixture-mausbot", THREAD = "fixture-island-thread";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhX8AAAAASUVORK5CYII=", "base64");
const messages = [], uploads = [], stops = [], opened = [], checks = [];
const events = new EventEmitter();
let island, savedChat = null, stream = null, key = null, speaking = null;
const encoder = new TextEncoder();
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function emit(value) { stream?.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); }

async function request(route, options = {}) {
  const url = new URL(route, "http://fixture.invalid");
  if (url.pathname === "/api/bots" && !options.method) return json({ bots: [{ id: BOT, defaultBot: true, tasks: savedChat ? [{ threadId: THREAD }] : [] }] });
  if (url.pathname === `/api/bots/${BOT}/tasks` && options.method === "POST") return json({ task: { threadId: THREAD } });
  if (url.pathname === "/api/attachments" && options.method === "POST") {
    uploads.push({ mime: options.headers["content-type"], bytes: Buffer.from(options.body) });
    return json({ path: `/fixture/attachments/screen-${uploads.length}.png`, mime: options.headers["content-type"], bytes: options.body.length });
  }
  if (url.pathname === "/api/events" && !options.method) {
    const body = new ReadableStream({
      start(controller) { stream = controller; emit({ kind: "hello" }); },
      cancel() { stream = null; },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }
  if (url.pathname === `/api/bots/${BOT}/messages` && options.method === "POST") {
    const message = JSON.parse(options.body);
    messages.push(message);
    events.emit("message", message);
    emit({ kind: "message", threadId: THREAD, message: { role: "user", sendId: message.sendId, turnId: `fixture-turn-${messages.length}` } });
    if (!message.text.startsWith("Aguarde a interrupção")) {
      const turnId = `fixture-turn-${messages.length}`;
      emit({ kind: "runtime", event: { type: "item.completed", itemType: "assistant_text", threadId: THREAD, turnId,
        text: "Resposta simulada: contexto recebido e imagem anexada." } });
      emit({ kind: "runtime", event: { type: "turn.completed", threadId: THREAD, turnId, ok: true } });
    }
    return new Response(null, { status: 202 });
  }
  if (url.pathname === `/api/bots/${BOT}/interrupt` && options.method === "POST") { stops.push(JSON.parse(options.body)); return json({ ok: true }); }
  throw new Error(`Unexpected fixture request: ${options.method ?? "GET"} ${url.pathname}`);
}

function createOmi({ readKey, writeKey, onChange }) {
  let configured = false, status = "disconnected", disposed = false;
  const snapshot = () => ({ configured, status });
  return {
    snapshot, context: () => configured ? "Memória simulada do Omi: o projeto deve responder em português." : "",
    async configure(next) { await writeKey(next); assert.equal(await readKey(), next); configured = true; status = "connected"; onChange(snapshot()); },
    async disconnect() { await writeKey(null); configured = false; status = "disconnected"; onChange(snapshot()); },
    async refresh() { assert.equal(disposed, false); status = configured ? "connected" : "disconnected"; onChange(snapshot()); },
    dispose() { disposed = true; },
  };
}

const speech = {
  busy: () => Boolean(speaking),
  start(target) { speaking = target; target.transcript({ text: "Comando de voz simulado" }); },
  finish(target) { assert.equal(target, speaking); speaking = null; target.end({ code: 0 }); },
  stop(target) { if (speaking === target) speaking = null; },
};

function ready(win) {
  if (!win.webContents.isLoading()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    win.webContents.once("did-finish-load", resolve);
    win.webContents.once("did-fail-load", (_event, code, description) => reject(new Error(`${code}: ${description}`)));
  });
}
const evaluate = source => island.window.webContents.executeJavaScript(source, true);
async function waitFor(expression) {
  await evaluate(`new Promise((resolve,reject)=>{
    const matches=()=>Boolean(${expression});
    if(matches()){resolve(true);return;}
    const observer=new MutationObserver(()=>{if(matches()){clearTimeout(timer);observer.disconnect();resolve(true)}});
    const timer=setTimeout(()=>{observer.disconnect();reject(new Error("Timed out waiting for fixture UI"))},6000);
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
  })`);
}
const click = id => evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
async function fill(id, value) {
  await evaluate(`(()=>{const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event("input",{bubbles:true}))})()`);
}
async function send(text) {
  const received = once(events, "message", { signal: AbortSignal.timeout(6000) });
  await fill("prompt", text); await evaluate('document.getElementById("composer").requestSubmit()');
  await received;
}
function passed(name) { checks.push(name); console.log(`PASS ${name}`); }

async function run() {
try {
  await app.whenReady();
  island = createDynamicIsland({ BrowserWindow, screen, nativeImage, powerMonitor, speech, request,
    iconPath: fileURLToPath(new URL("../electron/resources/app-icon.png", import.meta.url)),
    dataDir: temporary, prefs: { quickAsksChat: () => savedChat, setQuickAsksChat: (_server, chat) => { savedChat = chat; } },
    openChat: chat => { opened.push(chat); events.emit("open-chat"); }, allowed: () => true, starting: () => false,
    globalShortcut: { register: () => false, unregister: () => {} }, createOmi,
    captureFrame: async () => ({ dataUrl: `data:image/png;base64,${PNG.toString("base64")}`, displayId: "fixture-display" }),
    keyStore: { read: async () => key, write: async value => { key = value; } },
  });
  await ready(island.window);
  await waitFor('document.getElementById("label").textContent === "Pronto para ajudar"');
  assert.equal(island.window.isFocusable(), false);
  await click("brand");
  await waitFor('document.getElementById("brand").getAttribute("aria-expanded") === "true"');
  assert.equal(island.window.isFocusable(), true);
  passed("compact and expanded window through real preload");

  await click("capture");
  await waitFor('document.getElementById("context").textContent.startsWith("1 imagens")');
  assert.equal(uploads.length, 0);
  passed("continuous capture stays local before send");

  await click("configure");
  await fill("omi-key", "omi_dev_fixture_only");
  await click("connect");
  await waitFor('document.getElementById("omi-state").textContent.includes("Conectado")');
  assert.equal(key, "omi_dev_fixture_only");
  assert.equal(await evaluate('document.getElementById("omi-key").value'), "");
  await click("refresh");
  passed("Omi configure, secure field clearing and refresh");

  await send("Explique a tela e considere o contexto do Omi");
  await waitFor('document.getElementById("label").textContent === "Resposta"');
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /Memória simulada do Omi/);
  assert.match(messages[0].text, /<attached-image path="\/fixture\/attachments\/screen-1.png"/);
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0].bytes, PNG);
  assert.match(await evaluate('document.getElementById("reply").textContent'), /Resposta simulada/);
  assert.doesNotMatch(messages[0].text, /omi_dev_fixture_only/);
  passed("text sends Omi and image context and displays streamed reply");

  await mkdir(output, { recursive: true });
  for (const theme of ["dark", "light"]) {
    await evaluate(`render({...view,theme:${JSON.stringify(theme)}})`);
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const screenshot = await island.window.webContents.capturePage();
    assert.equal(screenshot.isEmpty(), false);
    await writeFile(path.join(output, `${theme}-reply.png`), screenshot.toPNG());
  }
  passed("dark and light screenshots contain only fixture data");

  await click("voice");
  await waitFor('document.getElementById("label").textContent === "Ouvindo…"');
  const voiceReceived = once(events, "message", { signal: AbortSignal.timeout(6000) });
  await click("voice");
  await voiceReceived;
  await waitFor('document.getElementById("label").textContent === "Resposta"');
  assert.equal(messages.length, 2);
  assert.ok(messages[1].text.startsWith("Comando de voz simulado"));
  assert.equal(speaking, null);
  passed("voice start, finish and transcript submission");

  const chatOpened = once(events, "open-chat", { signal: AbortSignal.timeout(6000) });
  await click("open-chat");
  await chatOpened;
  assert.deepEqual(opened, [{ botId: BOT, threadId: THREAD }]);
  await send("Aguarde a interrupção");
  await waitFor('document.getElementById("label").textContent === "Trabalhando…"');
  await new Promise(resolve => setImmediate(resolve));
  await click("cancel");
  await waitFor('document.getElementById("label").textContent === "Pronto para ajudar"');
  assert.equal(stops.length, 1);
  assert.equal(stops[0].threadId, THREAD);
  passed("open chat and cancel target only the fixture thread");

  await click("capture");
  await waitFor('document.getElementById("capture").getAttribute("aria-pressed") === "false"');
  await click("configure");
  await click("disconnect");
  await waitFor('document.getElementById("omi-state").textContent.includes("Não conectado")');
  assert.equal(key, null);
  const uploadCount = uploads.length;
  await send("Agora sem contexto");
  await waitFor('document.getElementById("label").textContent === "Resposta"');
  assert.equal(messages.at(-1).text, "Agora sem contexto");
  assert.equal(uploads.length, uploadCount);
  passed("pause and disconnect prevent stale context on the next send");

  await writeFile(path.join(output, "result.json"), JSON.stringify({ ok: true, checks, messages: messages.length, uploads: uploads.length,
    limitations: ["Omi, microphone, screen and server are simulated; native permissions and a real Omi key are not exercised."] }, null, 2));
  console.log(`Evidence: ${output}`);
  console.log(`PASS ${checks.length} integration checks; no real network, account or screen content used.`);
  if (smoke) { island.dispose(); await rm(temporary, { recursive: true, force: true }); app.exit(0); }
  else app.once("before-quit", () => { island.dispose(); void rm(temporary, { recursive: true, force: true }); });
} catch (error) {
  console.error(error);
  island?.dispose();
  await rm(temporary, { recursive: true, force: true });
  app.exit(1);
}
}
void run();
