import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import type { Message } from "./store.ts";

type Bot = { id: string; name: string };
type Room = { id: string; threadId: string };
let fixture: VerificationServer;
let upstream: Server;
const bots: Bot[] = [];
let routingCalls = 0;
let routingOptions: string[] = [];
let replyGate: { started: boolean; release: Promise<void> } | undefined;
let replyContent = "I received your message.";
let routingFailure = false;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { "content-type": "application/json", origin: fixture.info.url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as Record<string, any>;
  expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
  return result;
};
const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
const messages = async (room: Room) => (await api("GET", `/api/threads/${room.threadId}/messages?limit=200`)).messages as Message[];

beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    const json = (value: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/v1/models") return json({ data: [{ id: "fixture-model" }] });
    if (req.method === "GET") { res.writeHead(404); res.end(); return; }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    if (req.url === "/v1/systemone") {
      if (body.questions?.answer?.type === "noul") return json({ answers: { answer: { type: "noul", noul: 0.99 } } });
      routingCalls++;
      routingOptions = Object.keys(body.questions.answer.criteria);
      if (routingFailure) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "fixture router unavailable" })); return; }
      const choice = bots[1]!.id;
      return json({ answers: { answer: { type: "choice", choice, confidence: 0.99, probabilities: { [choice]: 0.99 } } } });
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const gate = replyGate;
    replyGate = undefined;
    if (gate) {
      res.flushHeaders();
      gate.started = true;
      await gate.release;
    }
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: replyContent }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture provider address missing");
  fixture = await launchVerificationServer();
  const endpoint = `http://127.0.0.1:${address.port}`;
  // The key check uses the saved base URL, so the fixture's URL is saved first and the key never reaches the real service.
  await api("PATCH", "/api/config", {
    openaiCompat: { key: "fixture-room-key", url: `${endpoint}/v1`, model: "fixture-model" },
    decider: { baseUrl: endpoint },
  });
  await api("PATCH", "/api/config", { decider: { key: "tsk_room_fixture", enabled: true, jobs: { roomRouting: true } } });
  for (const name of ["Atlas", "Boreal", "Cyra"]) {
    const { bot } = await control(["new-bot", "--name", name]);
    await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-model"]);
    bots.push(bot);
  }
}, 120_000);

afterAll(async () => {
  await fixture?.close();
  upstream?.closeAllConnections();
  if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

async function newRoom(): Promise<Room> {
  return (await api("POST", "/api/groups", {
    name: "Quoted reply fixture", memberIds: bots.map((bot) => bot.id),
    setup: { bulletin: "", defaultResponder: { kind: "auto" } },
  })).group;
}

async function round(room: Room, text: string, replyToId?: string) {
  const before = new Set((await messages(room)).map((message) => message.id));
  const sent = await api("POST", `/api/groups/${room.id}/messages`, { text, threadId: room.threadId, ...(replyToId ? { replyToId } : {}) });
  expect((await control(["wait", "--channel", room.id, "--timeout", "30"])).status).toBe("settled");
  return { sent: sent.message as Message, replies: (await messages(room)).filter((message) => !before.has(message.id) && message.kind === "text" && message.role === "bot") };
}

async function quotedRoom() {
  const room = await newRoom();
  const seed = await round(room, "@Atlas please post your status.");
  expect(seed.replies[0]?.from?.botId).toBe(bots[0]!.id);
  return { room, quote: seed.replies[0]!, person: seed.sent };
}

it("sends an unmentioned quoted reply to its bot without asking the decision model", async () => {
  const { room, quote } = await quotedRoom();
  const before = routingCalls;
  const { replies } = await round(room, "I will test; Boreal can review the rest.", quote.id);
  expect(replies.map((message) => message.from?.botId)).toEqual([bots[0]!.id]);
  expect(replies[0]!.routedBy).toBeUndefined();
  expect(routingCalls).toBe(before);
}, 120_000);

it("lets an explicit mention override the quoted bot", async () => {
  const { room, quote } = await quotedRoom();
  const before = routingCalls;
  expect((await round(room, "@Cyra please review this.", quote.id)).replies.map((message) => message.from?.botId)).toEqual([bots[2]!.id]);
  expect(routingCalls).toBe(before);
}, 120_000);

it.each([
  ["quoted then unquoted", "atlas", undefined, [0, 1]],
  ["unquoted then quoted", undefined, "atlas", [1, 0]],
  ["different quoted bots", "atlas", "boreal", [0, 1]],
  ["the same quoted bot", "atlas", "atlas", [0]],
  ["both unquoted", undefined, undefined, [1]],
] as const)("routes queued %s messages without changing their reply targets", async (_name, firstTarget, secondTarget, responders) => {
  const { room, quote } = await quotedRoom();
  const secondQuote = (await round(room, "@Boreal please post your status.")).replies[0]!;
  expect(secondQuote.from?.botId).toBe(bots[1]!.id);
  const quoteIds = { atlas: quote.id, boreal: secondQuote.id };
  const before = new Set((await messages(room)).map((message) => message.id));
  let release!: () => void;
  const gate = { started: false, release: new Promise<void>((resolve) => { release = resolve; }) };
  replyGate = gate;
  try {
    await api("POST", `/api/groups/${room.id}/messages`, { text: "@Cyra keep this room busy.", threadId: room.threadId });
    await expect.poll(() => gate.started, { timeout: 30_000 }).toBe(true);
    for (const [index, target] of [firstTarget, secondTarget].entries()) {
      const sent = await api("POST", `/api/groups/${room.id}/messages`, {
        text: `Please review detail ${index + 1}.`, threadId: room.threadId,
        ...(target ? { replyToId: quoteIds[target] } : {}),
      });
      expect(sent.queued).toBe(true);
    }
  } finally {
    replyGate = undefined;
    release();
  }
  expect((await control(["wait", "--channel", room.id, "--timeout", "30"])).status).toBe("settled");
  const replies = (await messages(room)).filter((message) => !before.has(message.id) && message.kind === "text" && message.role === "bot");
  expect(replies.map((message) => message.from?.botId)).toEqual([bots[2]!.id, ...responders.map((index) => bots[index]!.id)]);
}, 120_000);

it("still asks the decision model for a reply to a person's message", async () => {
  const { room, person } = await quotedRoom();
  const before = routingCalls;
  expect((await round(room, "Who can review this?", person.id)).replies.map((message) => message.from?.botId)).toEqual([bots[1]!.id]);
  expect(routingCalls).toBe(before + 1);
}, 120_000);

it.each(["held", "hidden", "removed", "paused", "department-paused"])("falls back to Auto when the quoted bot is %s", async (unavailable) => {
  const { room, quote } = await quotedRoom();
  if (unavailable === "held") await api("POST", `/api/groups/${room.id}/holds`, { botId: bots[0]!.id, held: true });
  if (unavailable === "hidden") await api("PATCH", `/api/bots/${bots[0]!.id}`, { hidden: true });
  if (unavailable === "removed") await api("PATCH", `/api/groups/${room.id}`, { memberIds: bots.slice(1).map((bot) => bot.id) });
  if (unavailable === "paused") await api("POST", "/api/paused", { kind: "bot", id: bots[0]!.id, paused: true });
  if (unavailable === "department-paused") {
    await api("POST", "/api/sidebar-sections", { name: "Quoted pause fixture", botIds: [bots[0]!.id] });
    await api("POST", "/api/paused", { kind: "department", id: "Quoted pause fixture", paused: true });
  }
  try {
    const before = routingCalls;
    expect((await round(room, "Please review this.", quote.id)).replies.map((message) => message.from?.botId)).toEqual([bots[1]!.id]);
    expect(routingCalls).toBe(before + 1);
    expect(routingOptions).not.toContain(bots[0]!.id);
  } finally {
    if (unavailable === "hidden") await api("PATCH", `/api/bots/${bots[0]!.id}`, { hidden: false });
    if (unavailable === "paused") await api("POST", "/api/paused", { kind: "bot", id: bots[0]!.id, paused: false });
    if (unavailable === "department-paused") await api("POST", "/api/paused", { kind: "department", id: "Quoted pause fixture", paused: false });
  }
}, 120_000);

it("does not reroute an explicit mention of a paused bot", async () => {
  const { room, quote } = await quotedRoom();
  await api("POST", "/api/paused", { kind: "bot", id: bots[0]!.id, paused: true });
  try {
    const before = routingCalls;
    expect((await round(room, "@Atlas please review this.", quote.id)).replies).toEqual([]);
    expect(routingCalls).toBe(before);
    expect((await api("GET", "/api/paused")).heldBots).toContain(bots[0]!.id);
  } finally {
    await api("POST", "/api/paused", { kind: "bot", id: bots[0]!.id, paused: false });
  }
}, 120_000);

it("leaves a fixed-lead room's policy unchanged", async () => {
  const { room, quote } = await quotedRoom();
  await api("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "member", botId: bots[2]!.id } });
  const before = routingCalls;
  expect((await round(room, "Please review this.", quote.id)).replies.map((message) => message.from?.botId)).toEqual([bots[2]!.id]);
  expect(routingCalls).toBe(before);
}, 120_000);

it.each(["held", "paused", "department-paused"])("uses the remaining Auto member when the configured fallback is %s", async (unavailable) => {
  const { room, quote } = await quotedRoom();
  await api("PATCH", `/api/groups/${room.id}`, {
    memberIds: bots.slice(0, 2).map((bot) => bot.id), defaultResponder: { kind: "auto", fallbackBotId: bots[0]!.id },
  });
  if (unavailable === "held") await api("POST", `/api/groups/${room.id}/holds`, { botId: bots[0]!.id, held: true });
  if (unavailable === "paused") await api("POST", "/api/paused", { kind: "bot", id: bots[0]!.id, paused: true });
  if (unavailable === "department-paused") {
    await api("POST", "/api/sidebar-sections", { name: "Auto fallback fixture", botIds: [bots[0]!.id] });
    await api("POST", "/api/paused", { kind: "department", id: "Auto fallback fixture", paused: true });
  }
  try {
    const before = routingCalls;
    expect((await round(room, "Please review this.", quote.id)).replies.map((message) => message.from?.botId)).toEqual([bots[1]!.id]);
    expect(routingCalls).toBe(before);
  } finally {
    if (unavailable === "paused") await api("POST", "/api/paused", { kind: "bot", id: bots[0]!.id, paused: false });
    if (unavailable === "department-paused") await api("POST", "/api/paused", { kind: "department", id: "Auto fallback fixture", paused: false });
  }
}, 120_000);

it("retains an available configured Auto fallback when the decision model is disabled", async () => {
  const room = await newRoom();
  await api("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "auto", fallbackBotId: bots[2]!.id } });
  await api("PATCH", "/api/config", { decider: { jobs: { roomRouting: false } } });
  try {
    const before = routingCalls;
    expect((await round(room, "Please review this.")).replies.map((message) => message.from?.botId)).toEqual([bots[2]!.id]);
    expect(routingCalls).toBe(before);
  } finally {
    await api("PATCH", "/api/config", { decider: { jobs: { roomRouting: true } } });
  }
}, 120_000);

it.each(["disabled", "unavailable"])("uses an unpaused Auto fallback when the decision model is %s", async (state) => {
  const room = await newRoom();
  await api("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "auto", fallbackBotId: bots[0]!.id } });
  await api("POST", "/api/paused", { kind: "bot", id: bots[0]!.id, paused: true });
  if (state === "disabled") await api("PATCH", "/api/config", { decider: { jobs: { roomRouting: false } } });
  routingFailure = state === "unavailable";
  try {
    const before = routingCalls;
    expect((await round(room, "Please review this.")).replies.map((message) => message.from?.botId)).toEqual([bots[1]!.id]);
    expect(routingCalls - before).toBe(state === "disabled" ? 0 : 1);
  } finally {
    routingFailure = false;
    await api("POST", "/api/paused", { kind: "bot", id: bots[0]!.id, paused: false });
    if (state === "disabled") await api("PATCH", "/api/config", { decider: { jobs: { roomRouting: true } } });
  }
}, 120_000);

it("keeps the held notice when every Auto member is held", async () => {
  const room = await newRoom();
  for (const bot of bots) await api("POST", `/api/groups/${room.id}/holds`, { botId: bot.id, held: true });
  const before = routingCalls;
  expect((await round(room, "Please review this.")).replies).toEqual([]);
  expect(routingCalls).toBe(before);
  expect((await messages(room)).find((message) => message.kind === "activity" && message.from?.botId === bots[0]!.id)?.tool?.name).toContain("Atlas");
}, 120_000);

it.each(["explicit mention", "configured lead", "Auto fallback"])("preserves a paused goal coordinator chosen by %s", async (choice) => {
  const room = await newRoom();
  await api("PATCH", `/api/groups/${room.id}`, {
    defaultResponder: choice === "Auto fallback" ? { kind: "auto", fallbackBotId: bots[0]!.id }
      : { kind: "member", botId: bots[choice === "explicit mention" ? 1 : 0]!.id },
  });
  await api("POST", "/api/paused", { kind: "bot", id: bots[0]!.id, paused: true });
  replyContent = 'Goal done.\n<openmaus-goal>{"status":"completed","detail":"Fixture goal done."}</openmaus-goal>';
  try {
    const before = routingCalls;
    await api("POST", `/api/groups/${room.id}/messages`, {
      text: `${choice === "explicit mention" ? "@Atlas " : ""}Please finish this goal.`, threadId: room.threadId, mode: "goal",
    });
    await expect.poll(async () => {
      const status = (await messages(room)).find((message) => message.kind === "goal.run")?.goalRun?.status;
      return status !== undefined && status !== "working";
    }, { timeout: 30_000 }).toBe(true);
    expect((await messages(room)).find((message) => message.kind === "goal.run")?.goalRun).toMatchObject({
      coordinatorBotId: bots[0]!.id, status: "blocked", turnCount: 0, detail: expect.stringContaining("Atlas"),
    });
    expect(routingCalls).toBe(before);
  } finally {
    replyContent = "I received your message.";
    await api("POST", "/api/paused", { kind: "bot", id: bots[0]!.id, paused: false });
  }
}, 120_000);

it("still excludes a room-held member from goal coordination", async () => {
  const room = await newRoom();
  await api("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "member", botId: bots[0]!.id } });
  await api("POST", `/api/groups/${room.id}/holds`, { botId: bots[0]!.id, held: true });
  replyContent = 'Goal done.\n<openmaus-goal>{"status":"completed","detail":"Fixture goal done."}</openmaus-goal>';
  try {
    await api("POST", `/api/groups/${room.id}/messages`, { text: "@Atlas please finish this goal.", threadId: room.threadId, mode: "goal" });
    await expect.poll(async () => (await messages(room)).find((message) => message.kind === "goal.run")?.goalRun?.status, { timeout: 30_000 }).toBe("completed");
    expect((await messages(room)).find((message) => message.kind === "goal.run")?.goalRun).toMatchObject({
      coordinatorBotId: bots[1]!.id, turnCount: 1,
    });
  } finally {
    replyContent = "I received your message.";
  }
}, 120_000);
