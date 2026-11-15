import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";

type Bot = { id: string; name: string };
type Room = { id: string; threadId: string };
type Message = { id: string; kind: string; role: string; text?: string; from?: { botId: string }; routedBy?: unknown };
let fixture: VerificationServer;
let upstream: Server;
const bots: Bot[] = [];
let routingCalls = 0;

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
      const choice = bots[1]!.id;
      return json({ answers: { answer: { type: "choice", choice, confidence: 0.99, probabilities: { [choice]: 0.99 } } } });
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "I received your message." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
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

it("still asks the decision model for a reply to a person's message", async () => {
  const { room, person } = await quotedRoom();
  const before = routingCalls;
  expect((await round(room, "Who can review this?", person.id)).replies.map((message) => message.from?.botId)).toEqual([bots[1]!.id]);
  expect(routingCalls).toBe(before + 1);
}, 120_000);

it.each(["held", "hidden", "removed"])("falls back to Auto when the quoted bot is %s", async (unavailable) => {
  const { room, quote } = await quotedRoom();
  if (unavailable === "held") await api("POST", `/api/groups/${room.id}/holds`, { botId: bots[0]!.id, held: true });
  if (unavailable === "hidden") await api("PATCH", `/api/bots/${bots[0]!.id}`, { hidden: true });
  if (unavailable === "removed") await api("PATCH", `/api/groups/${room.id}`, { memberIds: bots.slice(1).map((bot) => bot.id) });
  try {
    const before = routingCalls;
    expect((await round(room, "Please review this.", quote.id)).replies.map((message) => message.from?.botId)).toEqual([bots[1]!.id]);
    expect(routingCalls).toBe(before + 1);
  } finally {
    if (unavailable === "hidden") await api("PATCH", `/api/bots/${bots[0]!.id}`, { hidden: false });
  }
}, 120_000);

it("leaves a fixed-lead room's policy unchanged", async () => {
  const { room, quote } = await quotedRoom();
  await api("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "member", botId: bots[2]!.id } });
  const before = routingCalls;
  expect((await round(room, "Please review this.", quote.id)).replies.map((message) => message.from?.botId)).toEqual([bots[2]!.id]);
  expect(routingCalls).toBe(before);
}, 120_000);
