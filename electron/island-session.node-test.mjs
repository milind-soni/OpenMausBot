import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createIslandSession } from "./island-session.mjs";
import { prepareIslandMessage } from "./island-context-message.mjs";

const CHAT = { botId: "bot-1", threadId: "thread-1" };
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function harness(options = {}) {
  const h = { views: [], asks: [], preparations: [], requests: [], starts: [], stopped: [], finished: [], opened: [],
    active: false, busy: false, frameList: [], omiContext: "Omi fixture context", disposed: 0, sink: null };
  h.session = createIslandSession({
    screenContext: { snapshot: () => ({ active: h.active, frameCount: h.frameList.length }),
      frames: () => h.frameList, start: () => { h.active = true; }, pause: () => { h.active = false; h.frameList = []; },
      dispose: () => { h.active = false; h.frameList = []; h.disposed += 1; } },
    omi: { snapshot: () => ({ status: "ready" }), context: () => h.omiContext,
      configure: options.configure ?? (async () => {}), disconnect: options.disconnect ?? (async () => {}), refresh: async () => {}, dispose: () => { h.disposed += 1; } },
    speech: { busy: () => h.busy, start: (sink, opts) => { h.sink = sink; h.starts.push(opts); },
      stop: sink => h.stopped.push(sink), finish: sink => h.finished.push(sink) },
    server: { prepare: options.prepare ?? (async () => CHAT), settleSend: options.settleSend, ask: async input => {
      h.asks.push(input);
      if (options.ask) return options.ask(input);
      input.onUpdate({ kind: "reply", text: "Fixture answer" }); return "done";
    } },
    request: async (...args) => { h.requests.push(args); return options.request ? options.request(...args) : { ok: true }; },
    render: view => h.views.push(view), openChat: chat => h.opened.push(chat), allowed: options.allowed ?? (() => true),
    prepareMessage: options.prepareMessage ?? (async input => { h.preparations.push(input); return "prepared: " + input.text; }),
  });
  return h;
}

test("explicit send combines fresh screen and Omi context, follows the answer and opens its chat", async () => {
  const h = harness();
  h.session.repaint();
  assert.equal(h.asks.length, 0);
  h.session.toggleCapture();
  h.frameList = [{ dataUrl: "fixture-image" }];
  await h.session.send("Explain this");
  assert.equal(h.preparations[0].text, "Explain this");
  assert.deepEqual(h.preparations[0].frames, h.frameList);
  assert.equal(h.preparations[0].omiContext, "Omi fixture context");
  assert.equal(h.asks[0].text, "prepared: Explain this");
  assert.equal(h.views.at(-1).state, "reply");
  assert.equal(h.views.at(-1).text, "Fixture answer");
  h.session.openChat(); assert.deepEqual(h.opened, [CHAT]);
  h.session.dispose();
});

test("speech is opt-in, finishes on command and sends only its own final transcript", async () => {
  const h = harness();
  h.session.toggleVoice();
  assert.deepEqual(h.starts, [{ endpointMs: 1500 }]);
  h.sink.transcript({ text: "Ajude com a tela" });
  assert.equal(h.asks.length, 0);
  h.session.toggleVoice(); assert.deepEqual(h.finished, [h.sink]);
  h.sink.end({ code: 0 }); await flush();
  assert.equal(h.preparations[0].text, "Ajude com a tela");
  h.session.dispose();
});

test("busy voice is preserved and forbidden local tasks are not sent", async () => {
  const h = harness({ allowed: () => false });
  h.busy = true; h.session.toggleVoice();
  assert.equal(h.starts.length, 0);
  assert.match(h.views.at(-1).text, /microfone/);
  await h.session.send("Please act");
  assert.equal(h.asks.length, 0);
  assert.match(h.views.at(-1).text, /deste computador/);
  h.session.dispose();
});

test("cancellation during preparation does not send or interrupt an unrelated earlier chat", async () => {
  const ready = deferred(); let preparation = 0;
  const h = harness({ prepare: () => ++preparation === 1 ? Promise.resolve(CHAT) : ready.promise });
  await h.session.send("First request");
  const later = h.session.send("Second request");
  await h.session.pause();
  await later;
  ready.resolve({ botId: "other", threadId: "later" }); await flush();
  assert.equal(h.asks.length, 1);
  assert.equal(h.requests.length, 0);
  assert.equal(h.views.at(-1).state, "idle");
  h.session.dispose();
});

test("cancel calls the real interrupt route, waits before new sends and reports refusal", async () => {
  const interrupted = deferred();
  const h = harness({ ask: input => new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason))),
    request: () => interrupted.promise });
  const sending = h.session.send("Act"); await flush();
  const cancel = h.session.pause();
  await flush();
  assert.equal(h.requests[0][0], "/api/bots/bot-1/interrupt");
  assert.deepEqual(JSON.parse(h.requests[0][1].body), { threadId: "thread-1" });
  await h.session.send("Too soon");
  assert.equal(h.asks.length, 1);
  interrupted.resolve({ ok: false }); await cancel; await sending;
  assert.equal(h.views.at(-1).state, "error");
  assert.match(h.views.at(-1).text, /confirmar o cancelamento/);
  h.session.dispose();
});

test("screen lock clears captures and microphone without forgetting the running task", async () => {
  const answer = deferred();
  const h = harness({ ask: () => answer.promise });
  h.session.toggleCapture(); h.frameList = [{ dataUrl: "fixture" }];
  const sending = h.session.send("Act"); await flush();
  h.session.suspend();
  assert.equal(h.active, false);
  assert.deepEqual(h.frameList, []);
  assert.equal(h.views.at(-1).state, "thinking");
  assert.equal(h.asks[0].signal.aborted, false);
  h.asks[0].onUpdate({ kind: "reply", text: "Finished while locked" });
  answer.resolve("done"); await sending;
  assert.equal(h.views.at(-1).text, "Finished while locked");
  h.session.toggleVoice(); const sink = h.sink;
  h.session.suspend(); sink.transcript({ text: "must not send" }); sink.end({ code: 0 }); await flush();
  assert.deepEqual(h.stopped, [sink]);
  assert.equal(h.asks.length, 1);
  h.session.dispose();
});

for (const transition of ["toggleCapture", "suspend"]) {
  test(`${transition} revokes pending screen uploads without cancelling the text request`, async () => {
    const firstUpload = deferred();
    const uploads = [];
    const h = harness({ prepareMessage: prepareIslandMessage, request: async (route, init) => {
      uploads.push({ route, init });
      if (uploads.length === 1) await firstUpload.promise;
      return { ok: true, json: async () => ({ path: `/attachments/frame-${uploads.length}.png`, mime: "image/png", bytes: init.body.length }) };
    } });
    h.session.toggleCapture();
    h.frameList = ["one", "two", "three"].map(value => ({ dataUrl: `data:image/png;base64,${Buffer.from(value).toString("base64")}` }));
    const sending = h.session.send("Explique a tela");
    await flush();
    assert.equal(uploads.length, 1);
    h.session[transition]();
    firstUpload.resolve();
    await sending;
    assert.equal(h.active, false);
    assert.deepEqual(h.frameList, []);
    assert.equal(uploads.length, 1);
    assert.equal(h.asks.length, 1);
    assert.ok(h.asks[0].text.startsWith("Explique a tela"));
    assert.match(h.asks[0].text, /Omi fixture context/);
    assert.doesNotMatch(h.asks[0].text, /<attached-image/);
    h.session.dispose();
  });
}

test("pausing capture after message acceptance keeps the running task", async () => {
  const answer = deferred();
  const h = harness({ ask: () => answer.promise });
  h.session.toggleCapture();
  h.frameList = [{ dataUrl: "fixture-image" }];
  const sending = h.session.send("Act");
  await flush();
  assert.equal(h.asks.length, 1);
  h.session.toggleCapture();
  assert.equal(h.asks[0].signal.aborted, false);
  assert.equal(h.requests.length, 0);
  answer.resolve("done");
  await sending;
  assert.equal(h.views.at(-1).state, "reply");
  h.session.dispose();
});

test("cancel waits for message acceptance before interrupting and keeps new sends blocked", async () => {
  const delivery = deferred();
  const h = harness({ settleSend: () => delivery.promise,
    ask: input => new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason))) });
  const sending = h.session.send("Act"); await flush();
  const cancellation = h.session.pause(); await flush();
  assert.equal(h.requests.length, 0);
  await h.session.send("Too early"); assert.equal(h.asks.length, 1);
  delivery.resolve(); await cancellation; await sending;
  assert.equal(h.requests[0][0], "/api/bots/bot-1/interrupt");
  assert.equal(h.views.at(-1).state, "idle");
  h.session.dispose();
});

test("uncertain message acceptance is not reported as a confirmed cancellation", async () => {
  const h = harness({ settleSend: async () => { throw new Error("private transport error"); },
    ask: input => new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(input.signal.reason))) });
  const sending = h.session.send("Act"); await flush();
  await h.session.pause(); await sending;
  assert.equal(h.requests.length, 0);
  assert.equal(h.views.at(-1).state, "error");
  assert.match(h.views.at(-1).text, /confirmar o cancelamento/);
  assert.equal(h.views.at(-1).text.includes("private"), false);
  h.session.dispose();
});

test("timeout while preparing restores an actionable error instead of remaining busy", async t => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const h = harness({ prepare: () => new Promise(() => {}) });
  const send = h.session.send("Act");
  mock.timers.tick(180_000); await send;
  assert.equal(h.views.at(-1).state, "error");
  assert.match(h.views.at(-1).text, /espera terminou/);
  assert.equal(h.asks.length, 0);
  h.session.dispose();
});

test("other UI errors during preparation cannot replace the person's prompt", async () => {
  const ready = deferred();
  const h = harness({ prepare: () => ready.promise, configure: async () => { throw new Error("keychain locked"); } });
  const send = h.session.send("Original question");
  await h.session.configureOmi("omi_dev_fixture");
  ready.resolve(CHAT); await send;
  assert.equal(h.preparations[0].text, "Original question");
  h.session.dispose();
});

for (const [action, message] of [["configureOmi", /conectar o Omi/], ["disconnectOmi", /remover a chave do Omi/]]) {
  test(`a failed ${action} keeps an active task cancellable`, async () => {
    const answer = deferred();
    const failure = async () => { throw new Error("fixture Omi error"); };
    const h = harness({ ask: () => answer.promise, configure: failure, disconnect: failure });
    const sending = h.session.send("Original question"); await flush();
    await h.session[action]("omi_dev_fixture");
    assert.equal(h.views.at(-1).state, "thinking");
    assert.equal(h.views.at(-1).text, "Original question");
    assert.equal(h.views.at(-1).omi.status, "error");
    assert.match(h.views.at(-1).omi.message, message);
    answer.resolve("done"); await sending;
    assert.equal(h.views.at(-1).state, "reply");
    h.session.dispose();
  });
}

test("dispose releases capture, Omi and microphone, and ignores late transcripts", async () => {
  const h = harness();
  h.session.toggleVoice(); const sink = h.sink;
  h.session.dispose(); sink.transcript({ text: "late" }); sink.end({ code: 0 }); await flush();
  assert.equal(h.disposed, 2);
  assert.deepEqual(h.stopped, [sink]);
  assert.equal(h.asks.length, 0);
});
