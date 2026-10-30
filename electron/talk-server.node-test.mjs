import assert from "node:assert/strict";
import test from "node:test";
import { createReplyTracker, createTalkServer, findMausBot, readFrames } from "./talk-server.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
const turn = turnId => (turnId ? { turnId } : {});
const userMessage = (threadId, sendId, fields = {}) => ({ kind: "message", threadId, message: { id: `u-${sendId}`, role: "user", kind: "text", text: "asked", sendId, ...fields } });
const delta = (threadId, itemId, text, turnId) => ({ kind: "runtime", event: { type: "content.delta", streamKind: "assistant_text", threadId, itemId, delta: text, ...turn(turnId) } });
const itemDone = (threadId, itemId, text, turnId) => ({ kind: "runtime", event: { type: "item.completed", itemType: "assistant_text", threadId, itemId, text, ...turn(turnId) } });
const botText = (threadId, text, turnId) => ({ kind: "message", threadId, message: { id: `b-${text}`, role: "bot", kind: "text", text, ...turn(turnId) } });
const card = (threadId, cardFields) => ({ kind: "message", threadId, message: { id: "card", role: "bot", kind: "options", card: { question: "Allow?", options: ["Allow", "Deny"], ...cardFields } } });
const opened = threadId => ({ kind: "runtime", event: { type: "request.opened", threadId, requestType: "permission", tool: "Bash", summary: "ls" } });
const completed = (threadId, ok, turnId) => ({ kind: "runtime", event: { type: "turn.completed", threadId, ok, ...turn(turnId) } });
const HELLO = { kind: "hello", cursor: "s:1", resumed: false };
const CHAT = { botId: "m", threadId: "t1" };

const MOVED = { error: "This bot lives on My Cloud now.", code: "moved" };

function fakeServer({ bots, saved = null, sendStatus = 202, sendBody = { ok: true }, made = null, starting }) {
  const encoder = new TextEncoder();
  const server = { calls: [], saves: [], events: null, listing: { down: false, status: 200 } };
  const request = async (route, init = {}) => {
    const method = init.method ?? "GET";
    server.calls.push([method, route, init.body === undefined ? undefined : JSON.parse(init.body)]);
    if (method === "GET" && route === "/api/bots?messages=0") {
      if (server.listing.down) throw new TypeError("fetch failed");
      return Response.json({ bots }, { status: server.listing.status });
    }
    if (method === "POST" && /^\/api\/bots\/[\w-]+\/tasks$/.test(route)) return made ? Response.json(made.body, { status: made.status }) : Response.json({ task: { threadId: "t-new", title: "Quick asks" } }, { status: 201 });
    if (method === "GET" && route === "/api/events?screens=off") {
      let stream;
      const body = new ReadableStream({ start: controller => { stream = controller; }, cancel: () => { server.events.cancelled = true; } });
      server.events = { cancelled: false, push: frame => stream.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)), end: () => stream.close() };
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (method === "POST" && /^\/api\/bots\/[\w-]+\/messages$/.test(route)) return Response.json(sendBody, { status: sendStatus });
    return new Response(null, { status: 404 });
  };
  server.talk = createTalkServer({ request, serverKey: () => "server-a", starting, prefs: { quickAsksChat: () => saved, setQuickAsksChat: (key, chat) => server.saves.push([key, chat]) } });
  return server;
}

const asking = (server, { signal = new AbortController().signal, onUpdate = () => {} } = {}) =>
  server.talk.ask({ chat: CHAT, text: "hi", sendId: "s1", signal, onUpdate });

test("findMausBot picks this computer's MausBot, else the Chief of Staff", () => {
  const mine = { id: "m", defaultBot: {} }, member = { id: "p", defaultBot: { person: "a@b.test" } }, chief = { id: "c", chiefOfStaff: true };
  assert.equal(findMausBot([member, chief, mine]).id, "m");
  assert.equal(findMausBot([member, chief]).id, "c");
  assert.equal(findMausBot([{ id: "x" }, { ...chief, hidden: true }]), null);
});

test("prepare reuses the saved Quick asks chat while MausBot still has it", async () => {
  const server = fakeServer({ bots: [{ id: "m", defaultBot: {}, tasks: [{ threadId: "t0" }, { threadId: "t1" }] }], saved: { botId: "m", threadId: "t1" } });
  assert.deepEqual(await server.talk.prepare(), { botId: "m", threadId: "t1" });
  assert.deepEqual(server.calls.map(([method]) => method), ["GET"]);
  assert.deepEqual(server.saves, []);
});

test("prepare makes a Quick asks chat without selecting it when the saved one is gone, and keeps it", async () => {
  const server = fakeServer({ bots: [{ id: "m", defaultBot: {}, tasks: [] }], saved: { botId: "m", threadId: "t-gone" } });
  assert.deepEqual(await server.talk.prepare(), { botId: "m", threadId: "t-new" });
  assert.deepEqual(server.calls.at(-1), ["POST", "/api/bots/m/tasks", { title: "Quick asks", select: false }]);
  assert.deepEqual(server.saves, [["server-a", { botId: "m", threadId: "t-new" }]]);
});

test("prepare makes a new chat when the saved one belongs to another bot", async () => {
  const server = fakeServer({ bots: [{ id: "m", defaultBot: {}, tasks: [{ threadId: "t1" }] }], saved: { botId: "old", threadId: "t1" } });
  assert.deepEqual(await server.talk.prepare(), { botId: "m", threadId: "t-new" });
});

test("two prepares at once make one chat", async () => {
  const server = fakeServer({ bots: [{ id: "m", defaultBot: {}, tasks: [] }] });
  const first = server.talk.prepare(), second = server.talk.prepare();
  assert.equal(first, second);
  assert.deepEqual(await Promise.all([first, second]), [{ botId: "m", threadId: "t-new" }, { botId: "m", threadId: "t-new" }]);
  assert.equal(server.calls.filter(([method]) => method === "POST").length, 1);
});

test("prepare says why it cannot ask", async () => {
  const server = fakeServer({ bots: [{ id: "m", defaultBot: {}, tasks: [] }] });
  server.listing.down = true;
  await assert.rejects(server.talk.prepare(), { name: "TalkServerError", code: "server-down" });
  server.listing = { down: false, status: 503 };
  await assert.rejects(server.talk.prepare(), { code: "server-down" });
  server.listing.status = 200;
  assert.deepEqual(await server.talk.prepare(), { botId: "m", threadId: "t-new" });
  await assert.rejects(fakeServer({ bots: [] }).talk.prepare(), { code: "no-mausbot" });
  await assert.rejects(fakeServer({ bots: [{ id: "m", defaultBot: {}, tasks: [] }], made: { status: 500, body: {} } }).talk.prepare(), { code: "refused" });
});

test("a server still on its way up says starting, not down", async () => {
  let starting = true;
  const server = fakeServer({ bots: [{ id: "m", defaultBot: {}, tasks: [] }], starting: () => starting });
  server.listing.down = true;
  await assert.rejects(server.talk.prepare(), { code: "starting" });
  starting = false;
  await assert.rejects(server.talk.prepare(), { code: "server-down" });
});

test("a computer whose bots moved to My Cloud says so, on making the chat and on sending", async () => {
  const frozen = fakeServer({ bots: [{ id: "m", defaultBot: {}, tasks: [] }], made: { status: 409, body: MOVED } });
  await assert.rejects(frozen.talk.prepare(), { name: "TalkServerError", code: "moved" });
  assert.deepEqual(frozen.saves, []);
  await assert.rejects(fakeServer({ bots: [{ id: "m", defaultBot: {}, tasks: [] }], made: { status: 409, body: { code: "thread_busy" } } }).talk.prepare(), { code: "refused" });

  const sending = fakeServer({ bots: [], sendStatus: 409, sendBody: MOVED });
  const refusing = asking(sending);
  await flush();
  sending.events.push(HELLO);
  await assert.rejects(refusing, { name: "TalkServerError", code: "moved" });
  assert.equal(sending.events.cancelled, true);
});

test("the reply tracker follows only this ask", () => {
  const track = createReplyTracker({ threadId: "t1", sendId: "s1" });
  for (const early of [delta("t1", "i0", "old answer"), completed("t1", true), userMessage("t1", "s0"), userMessage("t2", "s1")]) assert.equal(track(early), null);
  assert.deepEqual(track(userMessage("t1", "s1")), { kind: "thinking" });
  assert.deepEqual(track(delta("t1", "i1", "Let me ")), { kind: "reply", text: "Let me " });
  assert.deepEqual(track(delta("t1", "i1", "check")), { kind: "reply", text: "Let me check" });
  assert.deepEqual(track(delta("t1", "i2", "You have")), { kind: "reply", text: "You have" });
  assert.deepEqual(track(botText("t1", "You have two meetings.")), { kind: "reply", text: "You have two meetings." });
  assert.equal(track(delta("t2", "i9", "elsewhere")), null);
  assert.deepEqual(track(completed("t1", true)), { kind: "done", ok: true, text: "You have two meetings." });
});

test("an earlier turn's turn.completed after this ask's echo does not end the box", () => {
  const track = createReplyTracker({ threadId: "t1", sendId: "s2" });
  assert.equal(track(delta("t1", "i1", "The first answer", "turn-1")), null);
  assert.deepEqual(track(userMessage("t1", "s2")), { kind: "thinking" });
  assert.equal(track(delta("t1", "i1", " goes on", "turn-1")), null);
  assert.equal(track(botText("t1", "The first answer goes on", "turn-1")), null);
  assert.equal(track(completed("t1", true, "turn-1")), null);
  assert.deepEqual(track(delta("t1", "i2", "The second", "turn-2")), { kind: "reply", text: "The second" });
  assert.equal(track(delta("t1", "i1", " and more of the first", "turn-1")), null);
  assert.deepEqual(track(itemDone("t1", "i2", "The second answer", "turn-2")), { kind: "reply", text: "The second answer" });
  assert.deepEqual(track(completed("t1", true, "turn-2")), { kind: "done", ok: true, text: "The second answer" });
});

test("an ask steered into the running turn follows that turn to its end", () => {
  const track = createReplyTracker({ threadId: "t1", sendId: "s2" });
  assert.equal(track(delta("t1", "i1", "Looking at the first", "turn-1")), null);
  assert.deepEqual(track(userMessage("t1", "s2", { steered: true })), { kind: "thinking" });
  assert.deepEqual(track(delta("t1", "i2", "Both done", "turn-1")), { kind: "reply", text: "Both done" });
  assert.equal(track(delta("t1", "i3", "unrelated", "turn-0")), null);
  assert.deepEqual(track(completed("t1", true, "turn-1")), { kind: "done", ok: true, text: "Both done" });
});

test("a waiting card or an opened request means MausBot needs the person", () => {
  const track = createReplyTracker({ threadId: "t1", sendId: "s1" });
  track(userMessage("t1", "s1"));
  assert.equal(track(card("t1", { answered: "Allow" })), null);
  assert.equal(track(card("t1", { dismissed: true })), null);
  assert.equal(track(card("t1", { expired: true })), null);
  assert.deepEqual(track(card("t1", {})), { kind: "needs-you" });
  assert.deepEqual(track(opened("t1")), { kind: "needs-you" });
});

test("ask listens before it sends, posts to the Quick asks chat, and ends with the turn", async () => {
  const server = fakeServer({ bots: [] });
  const updates = [];
  const asking = server.talk.ask({ chat: { botId: "m", threadId: "t1" }, text: "hi", sendId: "s1", signal: new AbortController().signal, onUpdate: u => updates.push(u) });
  await flush();
  assert.deepEqual(server.calls.map(c => c[1]), ["/api/events?screens=off"]);
  server.events.push({ kind: "hello", cursor: "s:1", resumed: false });
  await flush();
  assert.deepEqual(server.calls[1], ["POST", "/api/bots/m/messages", { text: "hi", threadId: "t1", sendId: "s1" }]);
  for (const frame of [userMessage("t1", "s1"), botText("t1", "Hello"), completed("t1", true)]) server.events.push(frame);
  assert.equal(await asking, "done");
  assert.deepEqual(updates.map(u => u.kind), ["thinking", "reply", "done"]);
  assert.equal(server.events.cancelled, true);
});

test("a refused send, a lost stream, a failed turn and an abort", async () => {
  const refused = fakeServer({ bots: [], sendStatus: 409 });
  const refusing = asking(refused);
  await flush();
  refused.events.push(HELLO);
  await assert.rejects(refusing, { name: "TalkServerError", code: "refused" });
  assert.equal(refused.events.cancelled, true);

  const lost = fakeServer({ bots: [] });
  const updates = [];
  const losing = asking(lost, { onUpdate: update => updates.push(update) });
  await flush();
  lost.events.push(HELLO);
  lost.events.push(userMessage("t1", "s1"));
  await flush();
  assert.deepEqual(updates, [{ kind: "thinking" }]);
  lost.events.end();
  await assert.rejects(losing, { code: "lost" });

  const failed = fakeServer({ bots: [] });
  const failing = asking(failed);
  await flush();
  for (const frame of [HELLO, userMessage("t1", "s1"), completed("t1", false)]) failed.events.push(frame);
  assert.equal(await failing, "failed");

  const waiting = fakeServer({ bots: [] });
  const waits = asking(waiting);
  await flush();
  for (const frame of [HELLO, userMessage("t1", "s1"), card("t1", {})]) waiting.events.push(frame);
  assert.equal(await waits, "needs-you");
  assert.equal(waiting.events.cancelled, true);

  const aborted = fakeServer({ bots: [] });
  const controller = new AbortController();
  const aborting = asking(aborted, { signal: controller.signal });
  await flush();
  aborted.events.push(HELLO);
  await flush();
  controller.abort();
  await assert.rejects(aborting, { name: "AbortError" });
  assert.equal(aborted.events.cancelled, true);
});

test("a failed turn that still said something is done, not failed", async () => {
  const server = fakeServer({ bots: [] });
  const ending = asking(server);
  await flush();
  for (const frame of [HELLO, userMessage("t1", "s1"), botText("t1", "I hit a limit"), completed("t1", false)]) server.events.push(frame);
  assert.equal(await ending, "done");
});

test("readFrames joins frames split across chunks and skips heartbeats and junk", async () => {
  const chunks = [": heartbeat\n\n", "id: s:1\ndata: {\"kind\":\"he", "llo\"}\n\ndata: not json\n\n", "data: {\"kind\":\"x\"}\n\n"];
  const frames = [];
  await readFrames(ReadableStream.from(chunks.map(c => new TextEncoder().encode(c))), f => frames.push(f));
  assert.deepEqual(frames, [{ kind: "hello" }, { kind: "x" }]);
});
