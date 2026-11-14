import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { dynamicIslandHtml, ISLAND_SIZE } from "./island-page.mjs";
import { createIslandSession } from "./island-session.mjs";

function page() {
  const html = dynamicIslandHtml("AA==");
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    value: "", textContent: "", hidden: ["settings", "details"].includes(id), disabled: false, attributes: {}, listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, handler) { this.listeners[name] = handler; },
  }]));
  const calls = [], listeners = {};
  const context = vm.createContext({
    document: { body: {}, getElementById: id => elements.get(id), addEventListener: (name, fn) => { listeners[name] = fn; } },
    window: { island: new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) }) },
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return { context, calls, elements, listeners, render: next => vm.runInContext(`render(${JSON.stringify(next)})`, context), click: id => elements.get(id).listeners.click() };
}

test("compact island expands with accessible controls and respects localized labels", () => {
  const p = page();
  assert.equal(p.elements.get("details").hidden, true);
  p.click("brand");
  assert.deepEqual(p.calls, [["toggleExpanded"]]);
  const size = p.render({ expanded: true, state: "idle", labels: { prompt: "Ask", captureOff: "See screen" } });
  assert.equal(size.height, ISLAND_SIZE.expandedHeight);
  assert.equal(size.width, ISLAND_SIZE.expandedWidth);
  assert.equal(p.elements.get("details").hidden, false);
  assert.equal(p.elements.get("brand").attributes["aria-expanded"], "true");
  assert.equal(p.elements.get("capture").textContent, "See screen");
  assert.equal(p.elements.get("prompt").attributes["aria-label"], "Ask");
});

test("prompt submit trims, bounds and sends once, and blocks duplicate submission while busy", () => {
  const p = page();
  const field = p.elements.get("prompt");
  field.value = "  Resuma esta tela  ";
  field.listeners.input();
  assert.equal(p.elements.get("send").disabled, false);
  p.elements.get("composer").listeners.submit({ preventDefault() {} });
  assert.deepEqual(p.calls, [["send", "Resuma esta tela"]]);
  assert.equal(field.value, "");
  assert.equal(p.elements.get("send").disabled, true);
  p.render({ state: "thinking" });
  field.value = "Outra tarefa";
  p.elements.get("composer").listeners.submit({ preventDefault() {} });
  assert.equal(p.calls.length, 1);
  assert.equal(p.elements.get("cancel").hidden, false);
  p.click("cancel");
  assert.deepEqual(p.calls.at(-1), ["pause"]);
});

test("Omi key goes only to named command and is immediately erased", () => {
  const p = page();
  p.render({ expanded: true, omi: { status: "disconnected" } });
  p.click("configure");
  assert.equal(p.elements.get("settings").hidden, false);
  p.elements.get("omi-key").value = "  omi_dev_fixture  ";
  p.click("connect");
  assert.deepEqual(p.calls, [["configureOmi", "omi_dev_fixture"]]);
  assert.equal(p.elements.get("omi-key").value, "");
  assert.equal(p.elements.get("settings").hidden, true);
  p.render({ omi: { status: "connected", configured: true } });
  assert.equal(p.elements.get("disconnect").hidden, false);
  assert.equal(p.elements.get("refresh").hidden, false);
  p.click("disconnect");
  assert.deepEqual(p.calls.at(-1), ["disconnectOmi"]);
});

test("Omi failure during a task keeps Cancel visible and preserves a new draft", async () => {
  const p = page();
  let finish;
  const session = createIslandSession({
    screenContext: { snapshot: () => ({ active: false }), frames: () => [], dispose() {} },
    omi: { snapshot: () => ({ status: "disconnected" }), context: () => "",
      configure: async () => { throw new Error("fixture Omi error"); }, dispose() {} },
    speech: {},
    server: { prepare: async () => ({ botId: "fixture", threadId: "fixture" }),
      ask: () => new Promise(resolve => { finish = resolve; }) },
    render: view => p.render(view), prepareMessage: async ({ text }) => text,
  });
  const sending = session.send("Primeiro pedido");
  await new Promise(resolve => setImmediate(resolve));
  await session.configureOmi("omi_dev_fixture");
  const field = p.elements.get("prompt");
  field.value = "Segundo pedido";
  field.listeners.input();
  assert.equal(p.elements.get("cancel").hidden, false);
  assert.equal(p.elements.get("send").disabled, true);
  p.elements.get("composer").listeners.submit({ preventDefault() {} });
  assert.equal(field.value, "Segundo pedido");
  assert.deepEqual(p.calls, []);
  finish("done");
  await sending;
  session.dispose();
});

test("capture and microphone state remain independent and content never becomes HTML", () => {
  const p = page();
  const unsafe = '<img src=x onerror="alert(1)">';
  p.render({ state: "listening", text: unsafe, capture: { enabled: true }, contextSummary: unsafe });
  assert.equal(p.elements.get("reply").textContent, unsafe);
  assert.equal(p.elements.get("context").textContent, unsafe);
  assert.equal(p.elements.get("capture").attributes["aria-pressed"], "true");
  assert.equal(p.elements.get("voice").attributes["aria-pressed"], "true");
  p.click("capture");
  p.click("voice");
  assert.deepEqual(p.calls, [["toggleCapture"], ["toggleVoice"]]);
  p.render({ state: "idle", capture: { enabled: true } });
  assert.equal(p.elements.get("voice").attributes["aria-pressed"], "false");
  assert.equal(p.elements.get("capture").attributes["aria-pressed"], "true");
});

test("Escape clears credentials before collapsing, and errors keep reconnect reachable", () => {
  const p = page();
  p.render({ expanded: true, omi: { status: "error", configured: false } });
  assert.equal(p.elements.get("refresh").hidden, true);
  p.click("configure");
  p.elements.get("omi-key").value = "temporary";
  p.listeners.keydown({ key: "Escape" });
  assert.equal(p.elements.get("omi-key").value, "");
  assert.equal(p.calls.length, 0);
  p.listeners.keydown({ key: "Escape" });
  assert.deepEqual(p.calls, [["toggleExpanded"]]);
});

test("page has no network access or HTML interpolation of context and guards icon markup", () => {
  const html = dynamicIslandHtml('"><script>alert(1)</script>');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /type="password" autocomplete="off"/);
  assert.doesNotMatch(html, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage|alert\(1\)/);
});
