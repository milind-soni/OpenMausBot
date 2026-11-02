import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { TalkServerError } from "./talk-server.mjs";
import { TALK_TEXT, TALK_TIMING, createTalkSession } from "./talk-session.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));

test.beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
test.afterEach(() => mock.timers.reset());

const CHAT = { botId: "m", threadId: "t1" };
function harness({ busy = false, prepare = async () => CHAT, ask } = {}) {
  const h = { views: [], closed: 0, hovered: false, renderFails: false, closeFails: false, hoverFails: false, startFails: false, releaseFails: false, starts: [], stops: [], finishes: [], opened: [], asks: [], prepares: 0, sink: null };
  h.session = createTalkSession({
    speech: {
      start: (sink, options) => { h.sink = sink; h.starts.push(options); if (h.startFails) throw new Error("spawn failed"); },
      stop: sink => h.stops.push(sink === h.sink),
      finish: sink => h.finishes.push(sink === h.sink),
    },
    server: {
      prepare: () => { h.prepares += 1; return prepare(); },
      ask: ask ?? (async input => { h.asks.push(input); input.onUpdate({ kind: "thinking" }); input.onUpdate({ kind: "reply", text: "Hi" }); input.onUpdate({ kind: "done", ok: true, text: "Hi" }); return "done"; }),
    },
    panel: {
      render: view => { h.views.push(view); if (h.renderFails) throw new Error("render failed"); },
      close: () => { h.closed += 1; if (h.closeFails) throw new Error("close failed"); },
      hovered: () => { if (h.hoverFails) throw new Error("hovered failed"); return h.hovered; },
    },
    voiceInUse: () => busy,
    release: () => { if (h.releaseFails) throw new Error("no key"); return ["control", "option"]; },
    openChat: chat => h.opened.push(chat), newSendId: () => "send-1",
  });
  return h;
}
const say = (h, text) => h.sink.transcript({ text, partial: true });
const release = (h, info = { code: 0, reason: "completed" }) => h.sink.end(info);
const holdAsk = updates => {
  const inputs = [];
  const ask = async input => {
    inputs.push(input);
    for (const update of updates) input.onUpdate(update);
    return new Promise(() => {});
  };
  return { inputs, ask };
};

test("the box's words and timings are fixed", () => {
  assert.deepEqual(TALK_TIMING, { replyHideMs: 12_000, noticeHideMs: 4_000, stillWorkingMs: 120_000, hoverRecheckMs: 500, maxListenMs: 60_000 });
  assert.deepEqual(TALK_TEXT, {
    busy: "Voice is in use in MausBot",
    serverDown: "Open MausBot to talk",
    starting: "MausBot is still starting. Try again in a moment.",
    noMausbot: "Set up MausBot first, then try again.",
    moved: "MausBot lives on My Cloud now — talk to it there",
    permission: "Talking needs Microphone + Speech Recognition access — System Settings → Privacy & Security.",
    dictationOff: "Turn on Dictation in System Settings → Keyboard, then try again.",
    unavailable: "Talking couldn't start. Try again.",
    failed: "MausBot couldn't take that · Open chat",
  });
  assert.ok(Object.isFrozen(TALK_TIMING));
  assert.ok(Object.isFrozen(TALK_TEXT));
});

test("a press listens with the key's release modifiers and shows the live words", () => {
  const h = harness(); h.session.press(); say(h, "what's on");
  assert.deepEqual(h.starts, [{ finishOnRelease: ["control", "option"] }]);
  assert.deepEqual(h.views, [{ state: "listening", text: "" }, { state: "listening", text: "what's on" }]);
  assert.equal(h.prepares, 1);
});

test("letting go sends the words to the Quick asks chat and shows the reply, which hides 12 s later", async () => {
  const h = harness(); h.session.press(); say(h, "what's on my calendar"); release(h); await flush();
  assert.deepEqual(pick(h.asks[0], ["chat", "text", "sendId"]), { chat: CHAT, text: "what's on my calendar", sendId: "send-1" });
  assert.deepEqual([...new Set(h.views.map(v => v.state))], ["listening", "sending", "thinking", "reply"]);
  assert.deepEqual(h.views.find(v => v.state === "sending"), { state: "sending", text: "what's on my calendar" });
  assert.deepEqual(h.views.find(v => v.state === "thinking"), { state: "thinking", text: "what's on my calendar" });
  assert.deepEqual(h.views.at(-1), { state: "reply", text: "Hi" });
  mock.timers.tick(11_999); assert.equal(h.closed, 0);
  mock.timers.tick(1); assert.equal(h.closed, 1);
});

test("a reply under the pointer stays until the pointer leaves", async () => {
  const h = harness(); h.session.press(); say(h, "hello"); release(h); await flush();
  h.hovered = true;
  mock.timers.tick(12_000); assert.equal(h.closed, 0);
  mock.timers.tick(500); assert.equal(h.closed, 0);
  h.hovered = false;
  mock.timers.tick(499); assert.equal(h.closed, 0);
  mock.timers.tick(1); assert.equal(h.closed, 1);
});

test("presses while listening, sending or thinking are ignored", async () => {
  const { inputs, ask } = holdAsk([]);
  const h = harness({ ask });
  h.session.press(); h.session.press(); h.session.press();
  say(h, "book a table"); release(h); await flush();
  assert.equal(h.views.at(-1).state, "sending");
  h.session.press();
  inputs[0].onUpdate({ kind: "thinking" });
  assert.equal(h.views.at(-1).state, "thinking");
  h.session.press();
  assert.equal(h.starts.length, 1);
  assert.equal(h.prepares, 1);
  assert.equal(h.closed, 0);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].signal.aborted, false);
  assert.equal(h.views.filter(v => v.state === "listening" && v.text === "").length, 1);
});

test("a press while a reply shows closes it and starts a new ask", async () => {
  const { inputs, ask } = holdAsk([{ kind: "thinking" }, { kind: "reply", text: "Hi" }]);
  const h = harness({ ask });
  h.session.press(); say(h, "first"); release(h); await flush();
  assert.deepEqual(h.views.at(-1), { state: "reply", text: "Hi" });
  h.session.press();
  assert.equal(inputs[0].signal.aborted, true);
  assert.equal(h.closed, 1);
  assert.equal(h.starts.length, 2);
  assert.deepEqual(h.views.at(-1), { state: "listening", text: "" });
  inputs[0].onUpdate({ kind: "reply", text: "late words from the first ask" });
  mock.timers.tick(TALK_TIMING.stillWorkingMs);
  assert.deepEqual(h.views.at(-1), { state: "listening", text: "" });
  assert.equal(h.closed, 1);

  const settled = harness(); settled.session.press(); say(settled, "first"); release(settled); await flush();
  settled.session.press();
  assert.equal(settled.closed, 1);
  mock.timers.tick(TALK_TIMING.replyHideMs);
  assert.equal(settled.closed, 1);
  assert.deepEqual(settled.views.at(-1), { state: "listening", text: "" });
});

test("voice in use refuses without listening", () => {
  const h = harness({ busy: true }); h.session.press();
  assert.deepEqual(h.starts, []);
  assert.equal(h.prepares, 0);
  assert.deepEqual(h.views, [{ state: "error", text: "Voice is in use in MausBot" }]);
  mock.timers.tick(3_999); assert.equal(h.closed, 0);
  mock.timers.tick(1); assert.equal(h.closed, 1);
});

test("an empty transcript closes silently, even when the recognizer reports an error", async () => {
  for (const info of [{ code: 0, reason: "completed" }, { code: 1, reason: "recognition-error" }, { code: 1, reason: "helper-exited" }]) {
    const h = harness(); h.session.press(); release(h, info); await flush();
    assert.equal(h.closed, 1, info.reason); assert.equal(h.asks.length, 0);
    assert.ok(h.views.every(v => v.state === "listening"), info.reason);
  }
  const blank = harness(); blank.session.press(); say(blank, "  "); release(blank, { code: 1, reason: "recognition-error" }); await flush();
  assert.equal(blank.closed, 1); assert.equal(blank.asks.length, 0);
  assert.ok(blank.views.every(v => v.state === "listening"));
});

test("words heard before a recognizer error are still sent", async () => {
  const h = harness(); h.session.press(); say(h, "remind me");
  h.sink.transcript({ error: "recognition-error" });
  release(h, { code: 1, reason: "recognition-error" }); await flush();
  assert.equal(h.asks.length, 1);
  assert.equal(h.asks[0].text, "remind me");
  assert.deepEqual(h.views.at(-1), { state: "reply", text: "Hi" });
});

test("permission and setup problems say what to fix, in the composer's words: only a refused permission asks for access", async () => {
  const problems = [
    ["speech-not-authorized", TALK_TEXT.permission],
    ["mic-failed", TALK_TEXT.unavailable],
    ["recognizer-unavailable", TALK_TEXT.unavailable],
    ["dictation-disabled", TALK_TEXT.dictationOff],
    ["helper-build-failed", TALK_TEXT.unavailable],
    ["helper-start-failed", TALK_TEXT.unavailable],
    ["unsupported-platform", TALK_TEXT.unavailable],
  ];
  for (const [reason, text] of problems) {
    const h = harness(); h.session.press(); release(h, { code: 1, reason }); await flush();
    assert.deepEqual(h.views.at(-1), { state: "error", text }, reason);
    assert.equal(h.asks.length, 0, reason);
    mock.timers.tick(3_999); assert.equal(h.closed, 0, reason);
    mock.timers.tick(1); assert.equal(h.closed, 1, reason);
  }
});

test("a server that can't take asks says why and stops listening: down, still starting, no MausBot, or moved to My Cloud", async () => {
  const notices = [
    ["server-down", "Open MausBot to talk"],
    ["starting", TALK_TEXT.starting],
    ["no-mausbot", TALK_TEXT.noMausbot],
    ["moved", "MausBot lives on My Cloud now — talk to it there"],
  ];
  for (const [code, text] of notices) {
    const h = harness({ prepare: async () => { throw new TalkServerError(code); } });
    h.session.press(); await flush();
    assert.deepEqual(h.stops, [true], code);
    assert.deepEqual(h.views.at(-1), { state: "error", text }, code);
    say(h, "too late"); release(h); await flush();
    assert.equal(h.asks.length, 0, code);
    assert.deepEqual(h.views.at(-1), { state: "error", text }, code);
    mock.timers.tick(3_999); assert.equal(h.closed, 0, code);
    mock.timers.tick(1); assert.equal(h.closed, 1, code);
  }
});

test("a server that goes away as the words are sent says Open MausBot to talk", async () => {
  let fail;
  const late = harness({ prepare: () => new Promise((_, reject) => { fail = reject; }) });
  late.session.press(); say(late, "hello"); release(late); await flush();
  assert.equal(late.views.at(-1).state, "sending");
  fail(new TalkServerError("server-down")); await flush();
  assert.deepEqual(late.stops, []);
  assert.equal(late.asks.length, 0);
  assert.deepEqual(late.views.at(-1), { state: "error", text: TALK_TEXT.serverDown });
  mock.timers.tick(TALK_TIMING.noticeHideMs); assert.equal(late.closed, 1);

  const gone = harness({ ask: async () => { throw new TalkServerError("server-down"); } });
  gone.session.press(); say(gone, "hello"); release(gone); await flush();
  assert.deepEqual(gone.views.at(-1), { state: "error", text: TALK_TEXT.serverDown });
  mock.timers.tick(TALK_TIMING.noticeHideMs); assert.equal(gone.closed, 1);

  const moved = harness({ ask: async () => { throw new TalkServerError("moved"); } });
  moved.session.press(); say(moved, "hello"); release(moved); await flush();
  assert.deepEqual(moved.views.at(-1), { state: "error", text: TALK_TEXT.moved });
  mock.timers.tick(TALK_TIMING.noticeHideMs); assert.equal(moved.closed, 1);
});

test("busy while listening, sending or thinking; not once a reply, a notice or nothing shows", async () => {
  const { inputs, ask } = holdAsk([]);
  const h = harness({ ask });
  assert.equal(h.session.busy(), false);
  h.session.press();
  assert.equal(h.session.busy(), true, "listening");
  say(h, "hello"); release(h); await flush();
  assert.equal(h.views.at(-1).state, "sending");
  assert.equal(h.session.busy(), true, "sending");
  inputs[0].onUpdate({ kind: "thinking" });
  assert.equal(h.session.busy(), true, "thinking");
  inputs[0].onUpdate({ kind: "reply", text: "Hi" });
  assert.equal(h.session.busy(), false, "reply");
  h.session.dismiss();
  assert.equal(h.session.busy(), false, "closed");

  const refused = harness({ busy: true });
  refused.session.press();
  assert.equal(refused.session.busy(), false, "a notice");
});

test("a box that fails to close or to say where the pointer is still hides, and the next press works", async () => {
  const h = harness(); h.session.press(); say(h, "hello"); release(h); await flush();
  h.hoverFails = true; h.closeFails = true;
  assert.doesNotThrow(() => mock.timers.tick(TALK_TIMING.replyHideMs));
  assert.equal(h.closed, 1);
  h.closeFails = false;
  h.session.press();
  assert.equal(h.starts.length, 2);
  assert.deepEqual(h.views.at(-1), { state: "listening", text: "" });
});

test("needs-you shows and hides like a reply", async () => {
  const h = harness({ ask: async input => { input.onUpdate({ kind: "thinking" }); input.onUpdate({ kind: "reply", text: "Checking" }); input.onUpdate({ kind: "needs-you" }); return "needs-you"; } });
  h.session.press(); say(h, "clean up my downloads"); release(h); await flush();
  assert.deepEqual(h.views.at(-1), { state: "needs-you", text: "Checking" });
  mock.timers.tick(11_999); assert.equal(h.closed, 0);
  mock.timers.tick(1); assert.equal(h.closed, 1);
});

test("no answer in 120 s shows Still working · Open chat", async () => {
  let signal; const h = harness({ ask: async input => { signal = input.signal; input.onUpdate({ kind: "thinking" }); return new Promise(() => {}); } });
  h.session.press(); say(h, "book a table"); release(h); await flush();
  mock.timers.tick(119_999); assert.notEqual(h.views.at(-1).state, "still-working");
  mock.timers.tick(1);
  assert.deepEqual(h.views.at(-1), { state: "still-working", text: "" });
  assert.equal(signal.aborted, true);
  mock.timers.tick(11_999); assert.equal(h.closed, 0);
  mock.timers.tick(1); assert.equal(h.closed, 1);
});

test("a lost stream shows Still working; a refused send shows the failure", async () => {
  const lost = harness({ ask: async input => { input.onUpdate({ kind: "thinking" }); input.onUpdate({ kind: "reply", text: "Half an answer" }); throw new TalkServerError("lost"); } });
  lost.session.press(); say(lost, "summarise my inbox"); release(lost); await flush();
  assert.deepEqual(lost.views.at(-1), { state: "still-working", text: "Half an answer" });
  mock.timers.tick(11_999); assert.equal(lost.closed, 0);
  mock.timers.tick(1); assert.equal(lost.closed, 1);

  const refused = harness({ ask: async () => { throw new TalkServerError("refused"); } });
  refused.session.press(); say(refused, "summarise my inbox"); release(refused); await flush();
  assert.deepEqual(refused.views.at(-1), { state: "error", text: TALK_TEXT.failed });
  mock.timers.tick(11_999); assert.equal(refused.closed, 0);
  mock.timers.tick(1); assert.equal(refused.closed, 1);
});

test("a turn that fails shows the failure", async () => {
  const h = harness({ ask: async input => { input.onUpdate({ kind: "thinking" }); input.onUpdate({ kind: "done", ok: false, text: "" }); return "failed"; } });
  h.session.press(); say(h, "summarise my inbox"); release(h); await flush();
  assert.deepEqual(h.views.at(-1), { state: "error", text: TALK_TEXT.failed });
  mock.timers.tick(11_999); assert.equal(h.closed, 0);
  mock.timers.tick(1); assert.equal(h.closed, 1);
});

test("a box that fails to draw never breaks the reply stream", async () => {
  const { inputs, ask } = holdAsk([{ kind: "thinking" }]);
  const h = harness({ ask });
  h.session.press(); say(h, "hello"); release(h); await flush();
  h.renderFails = true;
  assert.doesNotThrow(() => inputs[0].onUpdate({ kind: "reply", text: "Hi" }));
  h.renderFails = false;
  inputs[0].onUpdate({ kind: "reply", text: "Hi there" });
  assert.deepEqual(h.views.at(-1), { state: "reply", text: "Hi there" });
});

test("replaced while listening closes the box and nothing is sent", async () => {
  const h = harness(); h.session.press(); say(h, "hello");
  h.sink.replaced();
  assert.equal(h.closed, 1);
  say(h, "hello there"); release(h); await flush();
  assert.equal(h.asks.length, 0);
  assert.equal(h.closed, 1);
  assert.deepEqual(h.views.at(-1), { state: "listening", text: "hello" });
  h.session.press();
  assert.equal(h.starts.length, 2);
});

test("clicking the box opens the chat; before the chat is known it only brings MausBot forward", async () => {
  const idle = harness(); idle.session.open();
  assert.deepEqual(idle.opened, []); assert.equal(idle.closed, 0);

  const listening = harness(); listening.session.press(); say(listening, "hello"); await flush();
  listening.session.open();
  assert.deepEqual(listening.opened, [null]);
  assert.deepEqual(listening.stops, [true]);
  assert.equal(listening.closed, 1);

  const preparing = harness({ prepare: () => new Promise(() => {}) });
  preparing.session.press(); say(preparing, "hello"); release(preparing); await flush();
  preparing.session.open();
  assert.deepEqual(preparing.opened, [null]);
  assert.deepEqual(preparing.stops, []);
  assert.equal(preparing.closed, 1);

  const { inputs, ask } = holdAsk([{ kind: "thinking" }]);
  const thinking = harness({ ask });
  thinking.session.press(); say(thinking, "hello"); release(thinking); await flush();
  thinking.session.open();
  assert.deepEqual(thinking.opened, [CHAT]);
  assert.equal(inputs[0].signal.aborted, true);
  assert.equal(thinking.closed, 1);

  const answered = harness(); answered.session.press(); say(answered, "hello"); release(answered); await flush();
  answered.session.open();
  assert.deepEqual(answered.opened, [CHAT]);
  assert.equal(answered.closed, 1);
  mock.timers.tick(TALK_TIMING.replyHideMs);
  assert.equal(answered.closed, 1);
});

test("dismissing while listening cancels capture", async () => {
  const h = harness(); h.session.press(); say(h, "hello");
  h.session.dismiss();
  assert.deepEqual(h.stops, [true]);
  assert.equal(h.closed, 1);
  say(h, "hello there"); release(h); await flush();
  assert.equal(h.asks.length, 0);
  assert.deepEqual(h.views.at(-1), { state: "listening", text: "hello" });
  assert.deepEqual(h.opened, []);

  const { inputs, ask } = holdAsk([{ kind: "thinking" }]);
  const thinking = harness({ ask });
  thinking.session.press(); say(thinking, "hello"); release(thinking); await flush();
  thinking.session.dismiss();
  assert.equal(inputs[0].signal.aborted, true);
  assert.equal(thinking.closed, 1);
  assert.deepEqual(thinking.opened, []);
});

test("quitting closes the box and cancels the ask under way", async () => {
  const listening = harness(); listening.session.press();
  listening.session.close();
  assert.deepEqual(listening.stops, [true]);
  assert.equal(listening.closed, 1);

  const { inputs, ask } = holdAsk([{ kind: "thinking" }]);
  const thinking = harness({ ask });
  thinking.session.press(); say(thinking, "hello"); release(thinking); await flush();
  thinking.session.close();
  assert.equal(inputs[0].signal.aborted, true);
  assert.equal(thinking.closed, 1);
  mock.timers.tick(TALK_TIMING.stillWorkingMs);
  assert.equal(thinking.views.at(-1).state, "thinking");
});

test("listening stops by itself after 60 s and sends what was heard", async () => {
  const h = harness(); h.session.press(); say(h, "remind me to call mum");
  mock.timers.tick(59_999);
  assert.deepEqual(h.finishes, []);
  assert.equal(h.views.at(-1).state, "listening");
  mock.timers.tick(1);
  assert.deepEqual(h.finishes, [true]);
  assert.deepEqual(h.stops, []);
  release(h); await flush();
  assert.equal(h.asks[0].text, "remind me to call mum");
  assert.deepEqual(h.views.at(-1), { state: "reply", text: "Hi" });

  const sent = harness(); sent.session.press(); say(sent, "hello"); release(sent); await flush();
  mock.timers.tick(TALK_TIMING.maxListenMs);
  assert.deepEqual(sent.finishes, []);

  const dismissed = harness(); dismissed.session.press(); dismissed.session.dismiss();
  mock.timers.tick(TALK_TIMING.maxListenMs);
  assert.deepEqual(dismissed.finishes, []);
});

test("an earlier ask's sink cannot touch the next ask", async () => {
  const h = harness(); h.session.press();
  const first = h.sink;
  h.session.dismiss();
  h.session.press();
  assert.notEqual(h.sink, first);
  const before = { views: h.views.length, closed: h.closed, stops: [...h.stops] };
  first.transcript({ text: "old words", partial: true });
  first.end({ code: 0, reason: "completed" });
  first.end({ code: 1, reason: "speech-not-authorized" });
  first.replaced();
  await flush();
  assert.equal(h.views.length, before.views);
  assert.equal(h.closed, before.closed);
  assert.deepEqual(h.stops, before.stops);
  assert.equal(h.asks.length, 0);
  assert.deepEqual(h.views.at(-1), { state: "listening", text: "" });
  say(h, "new words"); release(h); await flush();
  assert.equal(h.asks.length, 1);
  assert.equal(h.asks[0].text, "new words");
});

test("a box that fails to draw when listening starts leaves later presses working", () => {
  const h = harness();
  h.renderFails = true;
  assert.doesNotThrow(() => h.session.press());
  assert.equal(h.starts.length, 1);
  h.renderFails = false;
  release(h);
  assert.equal(h.closed, 1);
  h.session.press();
  assert.equal(h.starts.length, 2);
  assert.deepEqual(h.views.at(-1), { state: "listening", text: "" });
});

test("speech that fails to start says Talking couldn't start, and a later press works", () => {
  const h = harness();
  h.startFails = true;
  assert.doesNotThrow(() => h.session.press());
  assert.deepEqual(h.views.at(-1), { state: "error", text: TALK_TEXT.unavailable });
  assert.deepEqual(h.stops, [true]);
  mock.timers.tick(3_999); assert.equal(h.closed, 0);
  mock.timers.tick(1); assert.equal(h.closed, 1);
  mock.timers.tick(TALK_TIMING.maxListenMs);
  assert.deepEqual(h.finishes, []);
  h.startFails = false;
  h.session.press();
  assert.equal(h.starts.length, 2);
  assert.deepEqual(h.views.at(-1), { state: "listening", text: "" });

  const keyless = harness();
  keyless.releaseFails = true;
  assert.doesNotThrow(() => keyless.session.press());
  assert.deepEqual(keyless.starts, []);
  assert.deepEqual(keyless.views.at(-1), { state: "error", text: TALK_TEXT.unavailable });
  keyless.releaseFails = false;
  keyless.session.press();
  assert.equal(keyless.starts.length, 1);
});

test("a box that fails to draw when speech ends never throws back into speech", async () => {
  const h = harness(); h.session.press(); say(h, "hello");
  h.renderFails = true;
  assert.doesNotThrow(() => release(h));
  h.renderFails = false;
  await flush();
  assert.equal(h.asks.length, 1);
  assert.deepEqual(h.views.at(-1), { state: "reply", text: "Hi" });

  const denied = harness(); denied.session.press();
  denied.renderFails = true;
  assert.doesNotThrow(() => release(denied, { code: 1, reason: "mic-failed" }));
  mock.timers.tick(TALK_TIMING.noticeHideMs);
  assert.equal(denied.closed, 1);
});
