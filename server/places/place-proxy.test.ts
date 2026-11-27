// The proxy that serves a My Cloud bot opened in place, against a stand-in My Cloud: the page asks this computer's server
// in its own (`cloud:`) ids, My Cloud is asked in its own, the session never leaves this process, and the bot's live
// stream is passed on frame by frame.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { createPlaceProxy, frameForBot, parsePlaceSession, placedPath, type PlaceProxy } from "./place-proxy.ts";

const TOKEN = "omb_sess_test-token-0123456789";
const OWNER = "o".repeat(43);

interface Seen { method: string; url: string; authorization: string | undefined; body: string }

const codeOf = async (response: Response) => ((await response.json()) as { code?: string }).code;
let cloud: Server, local: Server, cloudUrl: string, localUrl: string, proxy: PlaceProxy;
const seen: Seen[] = [];
/** The stand-in Cloud's answer to each request; the live stream is handled apart. */
let answerWith: (req: IncomingMessage, res: ServerResponse, body: string) => void;
let streamTo: ((res: ServerResponse, req: IncomingMessage) => void) | null = null;

const scout = {
  id: "scout", name: "Scout", threadId: "t1", mainThreadId: "t1", chiefOfStaff: true,
  tasks: [{ threadId: "t1", title: "Flats" }, { threadId: "t2", title: "Trains" }],
  messages: [{ id: "m1", role: "bot", kind: "text", text: "cloud: four flats", attachments: [{ kind: "image", path: "/data/attachments/aa11-bb22.png", mime: "image/png" }] }],
};

const listen = (server: Server) => new Promise<string>((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

beforeEach(async () => {
  seen.length = 0;
  streamTo = null;
  answerWith = (req, res) => {
    if (req.url?.startsWith("/api/bots/scout")) return void res.writeHead(200, { "content-type": "application/json", "set-cookie": "omb_session=secret" }).end(JSON.stringify({ bot: scout }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
  };
  cloud = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization, body });
      if (req.url?.startsWith("/api/events") && streamTo) return streamTo(res, req);
      answerWith(req, res, body);
    });
  });
  cloudUrl = await listen(cloud);
  proxy = createPlaceProxy();
  proxy.setOwnerToken(OWNER);
  proxy.setSession({ origin: cloudUrl, token: TOKEN });
  local = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    void proxy.route({ req, res, url, path: url.pathname, method: req.method!, auth: { kind: "loopback", scopes: [] }, json, readBody }).then((out) => {
      if (typeof out === "symbol") res.writeHead(418).end("passed");
    });
  });
  localUrl = await listen(local);
});

afterEach(async () => {
  local.closeAllConnections();
  cloud.closeAllConnections();
  await Promise.all([new Promise((done) => local.close(done)), new Promise((done) => cloud.close(done))]);
});

const ask = (path: string, init: RequestInit = {}, owner: string | null = OWNER) =>
  fetch(`${localUrl}${path}`, { ...init, headers: { ...(owner ? { "x-openmausbot-desktop-owner": owner } : {}), ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });

describe("the conversation of a My Cloud bot, through this computer's server", () => {
  it("reads it in My Cloud's ids and hands it back in the page's, files included, with no session or cookie in it", async () => {
    const answer = await ask("/api/bots/cloud%3Ascout?messages=80");
    expect(answer.status).toBe(200);
    expect(answer.headers.get("set-cookie")).toBeNull();
    const text = await answer.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(cloudUrl);
    const { bot } = JSON.parse(text);
    expect(bot.id).toBe("cloud:scout");
    expect(bot.threadId).toBe("cloud:t1");
    expect(bot.mainThreadId).toBe("cloud:t1");
    expect(bot.tasks.map((task: { threadId: string }) => task.threadId)).toEqual(["cloud:t1", "cloud:t2"]);
    // Words are never rewritten; a file is asked for under a name of the page's.
    expect(bot.messages[0].text).toBe("cloud: four flats");
    expect(bot.messages[0].attachments[0].path).toBe("cloud--aa11-bb22.png");
    expect(seen).toEqual([{ method: "GET", url: "/api/bots/scout?messages=80", authorization: `Bearer ${TOKEN}`, body: "" }]);
  });

  it("sends, stops and pages back in My Cloud's ids, and a file a message names goes back as My Cloud gave it", async () => {
    await (await ask("/api/bots/cloud%3Ascout?messages=80")).text();
    seen.length = 0;
    expect((await ask("/api/bots/cloud:scout/messages", { method: "POST", body: JSON.stringify({ threadId: "cloud:t1", text: "cloud: hi", attachments: [{ path: "cloud--aa11-bb22.png" }] }) })).status).toBe(200);
    expect((await ask("/api/bots/cloud:scout/interrupt", { method: "POST", body: JSON.stringify({ threadId: "cloud:t1" }) })).status).toBe(200);
    expect((await ask("/api/threads/cloud%3At2/messages?limit=40&before=m1")).status).toBe(200);
    expect(seen.map(({ method, url }) => `${method} ${url}`)).toEqual(["POST /api/bots/scout/messages", "POST /api/bots/scout/interrupt", "GET /api/threads/t2/messages?limit=40&before=m1"]);
    expect(JSON.parse(seen[0]!.body)).toEqual({ threadId: "t1", text: "cloud: hi", attachments: [{ path: "/data/attachments/aa11-bb22.png" }] });
    expect(JSON.parse(seen[1]!.body)).toEqual({ threadId: "t1" });
  });

  it("serves My Cloud's file by the page's name for it", async () => {
    answerWith = (_req, res) => void res.writeHead(200, { "content-type": "image/png", "content-length": "3" }).end(Buffer.from([1, 2, 3]));
    const answer = await ask("/api/attachments/cloud--aa11-bb22.png");
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await answer.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(seen[0]!.url).toBe("/api/attachments/aa11-bb22.png");
  });

  it("answers nobody but the app's own window, and asks My Cloud nothing for anyone else", async () => {
    for (const owner of [null, "x".repeat(43)]) {
      const answer = await ask("/api/bots/cloud:scout", {}, owner);
      expect(answer.status).toBe(404);
      expect(await answer.text()).not.toContain(cloudUrl);
    }
    // A page from another site carries the header too (Chromium adds it below JavaScript): not its own page, refused.
    expect((await ask("/api/bots/cloud:scout", { headers: { "sec-fetch-site": "cross-site", origin: "https://elsewhere.example" } })).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it("refuses what a conversation does not need, without asking My Cloud: settings, deleting the bot, renaming", async () => {
    for (const [method, path] of [["PATCH", "/api/bots/cloud:scout"], ["DELETE", "/api/bots/cloud:scout"], ["GET", "/api/bots/cloud:scout/soul"], ["PATCH", "/api/bots/cloud:scout/tasks/cloud:t1"]] as const) {
      const answer = await ask(path, { method, ...(method === "PATCH" ? { body: "{}" } : {}) });
      expect(answer.status).toBe(404);
      expect(await codeOf(answer)).toBe("place_unsupported");
    }
    expect(seen).toEqual([]);
  });

  it("leaves this computer's own bots alone", async () => {
    expect((await ask("/api/bots/ledger/messages", { method: "POST", body: "{}" })).status).toBe(418);
    expect((await ask("/api/attachments/aa11-bb22.png")).status).toBe(418);
    expect(seen).toEqual([]);
  });

  it("says a sleeping My Cloud, a sign-in it refused and a route it lacks as My Cloud's, never as this server's own", async () => {
    answerWith = (_req, res) => void res.writeHead(503, { "content-type": "application/json", "x-omb-cloud-power": "asleep" }).end(JSON.stringify({ error: "asleep" }));
    let answer = await ask("/api/bots/cloud:scout/messages", { method: "POST", body: "{}" });
    expect(answer.status).toBe(503);
    expect(answer.headers.get("x-omb-cloud-power")).toBeNull();
    expect(await codeOf(answer)).toBe("place_asleep");

    answerWith = (_req, res) => void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    answer = await ask("/api/bots/cloud:scout");
    expect(answer.status).toBe(502);
    expect(await codeOf(answer)).toBe("place_signin");

    // An older My Cloud: no such route, answered by whatever serves unknown paths there.
    answerWith = (_req, res) => void res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
    answer = await ask("/api/bots/cloud:scout/read", { method: "POST", body: "{}" });
    expect(answer.status).toBe(404);
    expect(await codeOf(answer)).toBe("place_unsupported");

    // My Cloud's own refusal keeps its words, never its code: this page must not read it as its own bot limit.
    answerWith = (_req, res) => void res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "Too many bots", code: "bot_limit" }));
    answer = await ask("/api/bots/cloud:scout/messages", { method: "POST", body: "{}" });
    expect(answer.status).toBe(409);
    expect(await answer.json()).toEqual({ error: "Too many bots", code: "place_refused" });
  });

  it("says My Cloud can't be reached, and that nothing is open before main opened a session", async () => {
    proxy.setSession({ origin: "http://127.0.0.1:9", token: TOKEN });
    expect(await codeOf(await ask("/api/bots/cloud:scout"))).toBe("place_offline");
    proxy.setSession(null);
    const answer = await ask("/api/bots/cloud:scout");
    expect(answer.status).toBe(503);
    expect(await codeOf(answer)).toBe("place_closed");
  });
});

describe("the bot's live stream", () => {
  it("passes each of the bot's frames on as it arrives, in the page's ids, and nothing of My Cloud's other bots", async () => {
    let more!: () => void;
    const later = new Promise<void>((done) => { more = done; });
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((done) => { upstreamClosed = done; });
    streamTo = (res, req) => {
      req.on("close", () => upstreamClosed());
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ kind: "hello", cursor: "s:4", resumed: false })}\n\n`);
      res.write(`id: s:5\ndata: ${JSON.stringify({ kind: "message", threadId: "t9", message: { id: "x", role: "bot", text: "another bot's" } })}\n\n`);
      res.write(`id: s:6\ndata: ${JSON.stringify({ kind: "routine", routine: { id: "r" } })}\n\n`);
      res.write(`id: s:7\ndata: ${JSON.stringify({ kind: "runtime", event: { type: "text.delta", threadId: "t1", text: "Fou" } })}\n\n`);
      void later.then(() => res.write(`id: s:8\ndata: ${JSON.stringify({ kind: "message", threadId: "t2", message: { id: "y", role: "bot", kind: "text", text: "Trains at 9" } })}\n\n`));
    };
    const stop = new AbortController();
    const answer = await ask("/api/places/cloud/events?bot=cloud%3Ascout&since=s%3A3", { signal: stop.signal });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const reader = answer.body!.getReader(), decoder = new TextDecoder();
    let text = "";
    const until = async (part: string) => { while (!text.includes(part)) { const { value, done } = await reader.read(); if (done) throw new Error(`ended before ${part}`); text += decoder.decode(value, { stream: true }); } };
    // The runtime frame arrives while My Cloud's stream is still open: nothing waits for more.
    await until("text.delta");
    expect(text).toContain(`"threadId":"cloud:t1"`);
    expect(text).toContain("id: s:7\n");
    expect(text).not.toContain("another bot's");
    expect(text).not.toContain("routine");
    more();
    await until("Trains at 9");
    expect(text).toContain(`"threadId":"cloud:t2"`);
    const events = seen.find((request) => request.url.startsWith("/api/events"))!;
    expect(events.authorization).toBe(`Bearer ${TOKEN}`);
    expect(new URL(events.url, "http://x").searchParams.get("since")).toBe("s:3");
    // The page closing its stream closes My Cloud's.
    stop.abort();
    await closed;
  });

  it("refuses a stream for anyone but the app's window, and says a My Cloud without the stream plainly", async () => {
    expect((await ask("/api/places/cloud/events?bot=cloud:scout", {}, null)).status).toBe(404);
    streamTo = (res) => void res.writeHead(200, { "content-type": "text/html" }).end("old");
    const answer = await ask("/api/places/cloud/events?bot=cloud:scout");
    expect(answer.status).toBe(502);
    expect(await codeOf(answer)).toBe("place_unsupported");
  });
});

describe("pieces", () => {
  it("names My Cloud's own path for a placed one, and nothing for this computer's", () => {
    expect(placedPath("/api/bots/cloud%3Ascout/tasks/cloud:t1")).toBe("/api/bots/scout/tasks/t1");
    expect(placedPath("/api/threads/cloud:t1/respond")).toBe("/api/threads/t1/respond");
    expect(placedPath("/api/attachments/cloud--a1.png")).toBe("/api/attachments/a1.png");
    expect(placedPath("/api/bots/scout/messages")).toBeNull();
    expect(placedPath("/api/bots/cloud:../x")).toBeNull();
    expect(placedPath("/api/groups/cloud:g")).toBeNull();
  });

  it("takes a session only as main sends it", () => {
    expect(parsePlaceSession({ type: "openmausbot:place-session", place: "cloud", origin: "https://c.example", token: TOKEN })).toEqual({ origin: "https://c.example", token: TOKEN });
    expect(parsePlaceSession({ type: "openmausbot:place-session", place: "cloud", token: null })).toBeNull();
    expect(parsePlaceSession({ type: "openmausbot:place-session", place: "cloud", origin: "https://c.example/path", token: TOKEN })).toBeUndefined();
    expect(parsePlaceSession({ type: "openmausbot:place-session", place: "cloud", origin: "file:///x", token: TOKEN })).toBeUndefined();
    expect(parsePlaceSession({ type: "openmausbot:place-session", place: "cloud", origin: "https://c.example", token: "nope" })).toBeUndefined();
    expect(parsePlaceSession({ type: "other" })).toBeUndefined();
  });

  it("keeps the frames of the bot's conversations, learning new ones from the bot", () => {
    const threads = new Set(["t1"]);
    expect(frameForBot({ kind: "thread", threadId: "t3", activeLeafId: "a" }, "scout", threads)).toBeNull();
    expect(frameForBot({ kind: "bot", bot: { id: "scout", tasks: [{ threadId: "t3" }] } }, "scout", threads)).not.toBeNull();
    expect(frameForBot({ kind: "thread", threadId: "t3", activeLeafId: "a" }, "scout", threads)).not.toBeNull();
    expect(frameForBot({ kind: "bot", bot: { id: "atlas" } }, "scout", threads)).toBeNull();
    expect(frameForBot({ kind: "bot.queued", queues: {} }, "scout", threads)).toBeNull();
    expect(frameForBot({ kind: "power", state: "sleeping" }, "scout", threads)).not.toBeNull();
  });
});
