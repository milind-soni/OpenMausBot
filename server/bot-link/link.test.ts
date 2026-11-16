// Two places, each with a real coordinator over its own data folder, joined by the real routes and the real dialer over
// HTTP on this machine: "the computer" asks, "the Cloud" answers. Only the engines are fake.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCoordinator, type CoordinateBotsCall, type Coordinator, type CoordinatorHost, type HandoffView, type HostTurnResult } from "../coordinator.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import type { PassedFile } from "../host/handoff-files.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createDialer } from "./dial.ts";
import { createBotLink, SPOOL_KEEP_MS, type BotLink } from "./link.ts";
import { createBotLinkRoutes as routesOf, linkSessionRefusal } from "../routes/bot-link.ts";
import { EXCHANGE_BYTES, LINK_EXPIRES_MS, PAIR_PATH, STATE_PATH, SYNC_PATH, linkedId, peerKey, type Frame } from "./protocol.ts";

/** How a place addresses a bot of another: by that place's key and the bot's id there. */
const CLOUD = peerKey("cloud-environment"), COMPUTER = peerKey("computer-environment");
const onCloud = (id: string) => linkedId(CLOUD, id), onComputer = (id: string) => linkedId(COMPUTER, id);

type Bot = { id: string; name: string; hidden?: boolean };
type Run = (node: HandoffView, resumed: boolean, signal: AbortSignal) => Promise<HostTurnResult>;

const until = async (what: () => boolean, label: string, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const call = (botIds: string[], message: string, more: Partial<CoordinateBotsCall> = {}): CoordinateBotsCall =>
  ({ botIds, message, rework: false, thread: "standing", reply: "resume", consult: false, ...more });

/** One place. `boot()` again over the same folder is that place's server restarted. */
function place(label: string, bots: Bot[]) {
  const dir = mkdtempSync(join(tmpdir(), `bot-link-${label}-`));
  const threads = new Set<string>();
  const runs: Array<{ botId: string; threadId: string; text: string; resumed: boolean; requester: string; origin: unknown }> = [];
  const sent: Array<{ recipient: string; threadId: string }> = [];
  const results: Array<{ thread: string; name: string; status: string; result: string }> = [];
  const requests: string[] = [];
  const issued = new Map<string, string>();
  /** The attachment store and the hand-off file ledger, as handoff-files.ts keeps them. */
  const attachments = join(dir, "attachments");
  mkdirSync(attachments);
  const ledger = new Map<string, { from: { botId: string; name: string }; files: PassedFile[] }>();
  const keep = (name: string, data: Buffer): PassedFile => {
    const path = join(attachments, `${createHash("sha256").update(data).digest("hex").slice(0, 24)}${extname(name)}`);
    writeFileSync(path, data);
    return { kind: "file", path, name, mime: "text/plain", bytes: data.length };
  };
  /** Requests this place's server answers with a failure, once each. */
  const failing: Array<{ match: RegExp; status: number }> = [];
  let run: Run = async (node) => ({ ok: true, text: `${node.botId} did: ${node.text}` });
  let coordinator!: Coordinator, link!: BotLink, dialer!: ReturnType<typeof createDialer>, ticker: NodeJS.Timeout | undefined, http: Server | undefined;
  let opened = 0, port = 0, generation = 0, skew = 0, minted = 0;
  const sockets = new Set<import("node:net").Socket>();

  function boot(options: { limits?: { queueMs?: number; stallMs?: number } } = {}) {
    link = createBotLink({
      dataDir: dir, coordinator: () => coordinator, bots: () => bots, bot: (id) => bots.find((bot) => bot.id === id), level: () => "full",
      openThread: (bot) => { const id = `${bot.id}-work-${++opened}`; threads.add(id); return id; },
      hasThread: (_botId, threadId) => threads.has(threadId), personName: () => "Sam",
      sentRow: (input) => { sent.push({ recipient: input.recipient.name, threadId: input.threadId }); },
      resultRow: (parent, child, name) => { results.push({ thread: parent.threadId, name, status: child.status, result: child.result }); },
      kick: () => { queueMicrotask(() => { try { coordinator.tick(); } catch { /* closed */ } }); },
      revoke: (sessionId) => { for (const [token, id] of issued) if (id === sessionId) issued.delete(token); },
      now: () => Date.now() + skew,
      files: {
        carried: (id, way) => ledger.get(`${id}:${way}`)?.files ?? [],
        crossed: (id, way, from, files) => { if (!ledger.has(`${id}:${way}`)) ledger.set(`${id}:${way}`, { from, files: [...files] }); },
        store: async (files) => files.map((file) => { if (file.name.endsWith(".exe")) throw new Error(`${file.name} is not a supported attachment type`); return keep(file.name, readFileSync(file.path)); }),
      },
    });
    const inner: CoordinatorHost = {
      validate: () => undefined, busy: () => false, report: () => {}, changed: () => {}, park: () => {},
      names: (node, parent) => ({ requester: parent ? parent.botId : "Sam", assignee: node.botId }),
      levelOf: () => ({ level: "full" }), chiefOf: () => false,
      run: (node, resumed, signal, composed) => {
        runs.push({ botId: node.botId, threadId: node.threadId, text: node.text, resumed, requester: composed.text, origin: node.origin });
        return run(node, resumed, signal);
      },
    };
    coordinator = createCoordinator({ dataDir: dir, host: link.host(inner), log: () => {}, ...(options.limits ? { runtimeLimits: options.limits } : {}) });
    dialer = createDialer({ link, holdMs: 400, firstRetryMs: 20 });
    ticker = setInterval(() => coordinator.tick(), 15);
    return api;
  }

  const auth = (req: IncomingMessage): RequestAuth => {
    const bearer = /^Bearer (.+)$/u.exec(req.headers.authorization ?? "")?.[1];
    if (!bearer) return { kind: "loopback", scopes: ["admin", "client"] };
    const id = bearer === "owner" ? "owner-session" : bearer === "guest" ? "guest-session" : issued.get(bearer) ?? "unknown";
    return { kind: "session", via: "bearer", scopes: ["client"], session: { id, email: "sam@example.com" } as SessionRecord };
  };

  async function listen(at = 0): Promise<string> {
    const routes = routesOf({
      link, dialer, environmentId: `${label}-environment`, seenMs: 900, power: () => null,
      local: (who) => who.kind === "loopback", owner: (who) => who.kind === "session" && who.session.id === "owner-session",
      issue: () => { const token = `link-token-${++minted}-0123456789`; issued.set(token, `link-session-${minted}`); return { token, sessionId: issued.get(token)! }; },
      revoke: (sessionId) => { for (const [token, id] of issued) if (id === sessionId) issued.delete(token); },
    });
    const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const readBody = async (req: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; };
    http = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      requests.push(`${req.method} ${url.pathname}${url.searchParams.has("probe") ? "?probe" : ""}`);
      const fails = failing.findIndex((one) => one.match.test(requests.at(-1)!));
      if (fails >= 0) { const status = failing.splice(fails, 1)[0]!.status; req.resume(); json(res, status, { error: "try again" }); return; }
      void routes({ req, res, url, path: url.pathname, method: req.method ?? "GET", auth: auth(req), json: json as never, readBody: readBody as never })
        .catch((error) => { if (!res.headersSent) json(res, 500, { error: String(error) }); });
    });
    http.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => http!.listen(at, "127.0.0.1", resolve));
    port = (http.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }
  /** The network goes: every open exchange is cut and nothing answers. */
  async function unplug() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => { if (http) http.close(() => resolve()); else resolve(); });
    http = undefined;
  }
  async function shutdown() {
    if (ticker) clearInterval(ticker);
    dialer.close();
    await unplug();
    link.close();
    try { coordinator.close(); } catch { /* already closed */ }
  }

  /** One of this place's bots takes a turn in which it hands work on; the turn then ends and waits for it. */
  async function handOff(from: string, input: CoordinateBotsCall, local: (input: CoordinateBotsCall) => Promise<{ status: number; body: Record<string, unknown> }> = async () => ({ status: 200, body: { receipts: [] } })) {
    const id = `${label}-turn-${++generation}`, address = { botId: from, threadId: `${from}-chat` };
    coordinator.beginTurn({ id, address, brief: "Sort it out", level: "full", origin: { kind: "user", request: "Sort it out" } });
    const answer = await link.coordinate(input, { sender: bots.find((bot) => bot.id === from)!, address, generation: id, external: false, handed: () => {} }, local);
    coordinator.endTurn(id, { ok: true, text: "Handed on." });
    return { id, answer, receipts: (answer.body.receipts ?? []) as Array<{ botId: string; outcome: string; detail: string; requestId?: string }> };
  }

  const api = {
    dir, bots, runs, sent, results, requests, boot, listen, unplug, shutdown, handOff, keep, ledger,
    failOnce: (match: RegExp, status = 500) => { failing.push({ match, status }); },
    /** What an assignment here carries one way: who it is from and each file's name and words. */
    carries: (id: string, way: "sent" | "returned") => { const batch = ledger.get(`${id}:${way}`); return batch ? { from: batch.from.name, files: batch.files.map((file) => [file.name, readFileSync(file.path, "utf8")]) } : undefined; },
    /** The bot working on `id` attaches a file: it goes back with its result. */
    attach: (id: string, name: string, words: string) => { const batch = ledger.get(`${id}:returned`) ?? { from: { botId: "x", name: "x" }, files: [] }; batch.files.push(keep(name, Buffer.from(words))); ledger.set(`${id}:returned`, batch); },
    /** The files still waiting in this place's spool folder. */
    spooled: () => { const root = join(dir, "bot-link-files"); return existsSync(root) ? readdirSync(root, { recursive: true }).map(String).filter((entry) => /[\\/](?:sent|returned)[\\/]/.test(entry)) : []; },
    get link() { return link; }, get dialer() { return dialer; }, get coordinator() { return coordinator; }, get port() { return port; },
    engine(next: Run) { run = next; },
    /** Time passes for this place's link. */
    later(ms: number) { skew += ms; },
    sessions: () => [...issued.values()],
    async fetch(method: string, path: string, body?: unknown, bearer?: string) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    },
    async restart(options?: Parameters<typeof boot>[0]) { const at = port; const serving = Boolean(http); await shutdown(); boot(options); if (serving) await listen(at); },
    remove() { removeTempDir(dir); },
  };
  return api;
}

const places: Array<ReturnType<typeof place>> = [];
afterEach(async () => {
  for (const each of places.splice(0)) { await each.shutdown(); each.remove(); }
});

/** A computer and a Cloud. The same id, `shared`, is a different bot in each. */
async function two(options: { paired?: boolean; limits?: { queueMs?: number; stallMs?: number } } = {}) {
  const computer = place("computer", [{ id: "shared", name: "Scout" }, { id: "local-writer", name: "Writer" }]).boot(options);
  const cloud = place("cloud", [{ id: "shared", name: "Atlas" }, { id: "cloud-analyst", name: "Analyst" }]).boot(options);
  places.push(computer, cloud);
  const cloudOrigin = await cloud.listen();
  await computer.listen();
  if (options.paired !== false) await pair(computer, cloud, cloudOrigin);
  return { computer, cloud, cloudOrigin };
}
async function pair(computer: ReturnType<typeof place>, cloud: ReturnType<typeof place>, cloudOrigin: string, as = { id: "computer-environment", name: "Sam's Mac" }) {
  const paired = await cloud.fetch("POST", PAIR_PATH, { computer: as, name: "My Cloud" }, "owner");
  expect(paired.status).toBe(200);
  const on = await computer.fetch("PUT", STATE_PATH, { on: true, origin: cloudOrigin, token: paired.body.token, name: as.name, cloud: paired.body.place, account: "account-1" });
  expect(on.status).toBe(200);
  await until(() => computer.link.online() && cloud.link.online(peerKey(as.id)) && computer.link.agents().length > 0 && cloud.link.agents().some((bot) => bot.id.startsWith(`link-${peerKey(as.id)}-`)), "the two places meet");
  return paired.body.token as string;
}

describe("the link between a computer and its Cloud", () => {
  it("off: nothing asks the Cloud, nothing is listed, and coordinate_bots is what it always was", async () => {
    const { computer, cloud } = await two({ paired: false });
    computer.dialer.start({ gentle: true });
    const input = call(["Atlas"], "Count the orders");
    let passed: CoordinateBotsCall | undefined;
    const { answer } = await computer.handOff("local-writer", input, async (through) => { passed = through; return { status: 409, body: { error: "No bot with id or name \"Atlas\"" } }; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(passed).toBe(input);
    expect(answer.status).toBe(409);
    expect(cloud.requests).toEqual([]);
    expect(computer.link.agents()).toEqual([]);
    expect(computer.link.status()).toEqual({ on: false });
    expect(existsSync(join(computer.dir, "bot-link.json"))).toBe(false);
    expect(existsSync(join(cloud.dir, "bot-link.json"))).toBe(false);
    const inner: CoordinatorHost = { validate: () => "x", busy: () => true, run: async () => ({ ok: true, text: "" }), report: () => {}, changed: () => {}, names: () => ({ requester: "a", assignee: "b" }), park: () => {}, levelOf: () => ({ level: "ask" }), chiefOf: () => true };
    const wrapped = computer.link.host(inner), node = { botId: "local-writer", threadId: "t", id: "n", parentId: "p" } as HandoffView;
    expect([wrapped.validate(node), wrapped.busy(node), wrapped.away?.(node), wrapped.chiefOf(node)]).toEqual(["x", true, false, true]);
  });

  it("only the owner pairs, only the app on the computer flips the switch, and only the link's own sign-in exchanges", async () => {
    const { computer, cloud, cloudOrigin } = await two({ paired: false });
    expect((await cloud.fetch("POST", PAIR_PATH, { computer: { id: "x", name: "Mac" }, name: "My Cloud" }, "guest")).status).toBe(403);
    expect((await computer.fetch("PUT", STATE_PATH, { on: true, origin: cloudOrigin, token: "0123456789abcdefgh", name: "Mac", cloud: { id: "c", name: "My Cloud" } }, "owner")).status).toBe(403);
    expect((await computer.fetch("PUT", STATE_PATH, { on: true, origin: "http://203.0.113.9", token: "0123456789abcdefgh", name: "Mac", cloud: { id: "c", name: "My Cloud" } })).status).toBe(400);
    expect((await cloud.fetch("POST", SYNC_PATH, { ack: 0, frames: [], wait: 0 }, "owner")).status).toBe(403);
    const token = await pair(computer, cloud, cloudOrigin);
    expect((await cloud.fetch("POST", SYNC_PATH, { ack: 0, frames: [], wait: 0 }, "owner")).status).toBe(403);
    expect((await cloud.fetch("POST", SYNC_PATH, { ack: 0, frames: [], wait: 0 }, token)).status).toBe(200);
  });

  it("each side learns the other's bots, and the same id on both sides is two bots", async () => {
    const { computer, cloud } = await two();
    expect(computer.link.agents().map((bot) => [bot.id, bot.name, bot.statusText])).toEqual([[onCloud("shared"), "Atlas", "on My Cloud"], [onCloud("cloud-analyst"), "Analyst", "on My Cloud"]]);
    expect(cloud.link.agents().map((bot) => [bot.id, bot.name])).toEqual([[onComputer("shared"), "Scout"], [onComputer("local-writer"), "Writer"]]);
    expect(computer.link.resolve("shared")).toBeUndefined();
    expect(computer.link.resolve(onCloud("shared"))?.bot.name).toBe("Atlas");
    expect(computer.link.resolve("@analyst")?.bot.id).toBe("cloud-analyst");
    expect(computer.link.resolve("Scout")).toBeUndefined();
    computer.bots.push({ id: "new", name: "Newcomer" });
    computer.link.botsChanged();
    await until(() => cloud.link.agents().some((bot) => bot.name === "Newcomer"), "the Cloud hears of the new bot");

    const { receipts } = await computer.handOff("shared", call([onCloud("shared")], "Which of us is which?"));
    expect(receipts[0]).toMatchObject({ botId: onCloud("shared"), outcome: "queued" });
    await until(() => computer.results.length === 1, "the answer is back");
    expect(cloud.runs.filter((run) => !run.resumed).map((run) => run.botId)).toEqual(["shared"]);
    expect(computer.runs.filter((run) => run.botId === "shared" && !run.resumed)).toEqual([]);
    expect(computer.results[0]).toMatchObject({ name: "Atlas (My Cloud)", status: "completed", result: "shared did: Which of us is which?" });
  });

  it("work goes from the computer to the Cloud and its result resumes the requester once, as the person's own work", async () => {
    const { computer, cloud } = await two();
    const { receipts, answer } = await computer.handOff("local-writer", call(["Analyst"], "Count the orders", { doneWhen: "a number" }));
    expect(answer.status).toBe(200);
    expect(receipts[0]!.detail).toContain("sent to Analyst on My Cloud");
    await until(() => computer.runs.some((run) => run.resumed), "the requester is resumed");
    expect(computer.sent).toEqual([{ recipient: "Analyst (My Cloud)", threadId: "local-writer-chat" }]);
    expect(computer.results).toEqual([{ thread: "local-writer-chat", name: "Analyst (My Cloud)", status: "completed", result: "cloud-analyst did: Count the orders" }]);
    const worked = cloud.runs.filter((run) => run.botId === "cloud-analyst");
    expect(worked).toHaveLength(1);
    expect(worked[0]).toMatchObject({ threadId: "cloud-analyst-work-1", origin: { kind: "user", request: "Sort it out" } });
    expect(worked[0]!.requester).toContain("Writer (Sam's Mac)");
    expect(computer.runs.filter((run) => run.resumed)).toHaveLength(1);
    expect(computer.runs.find((run) => run.resumed)!.requester).toContain("cloud-analyst did: Count the orders");

    await computer.handOff("local-writer", call(["Analyst"], "Now the refunds"));
    await until(() => computer.results.length === 2, "the second result is back");
    expect(cloud.runs.filter((run) => run.botId === "cloud-analyst").map((run) => run.threadId)).toEqual(["cloud-analyst-work-1", "cloud-analyst-work-1"]);
  });

  it("work goes from the Cloud to the computer over the same link, and a one-way notice returns nothing", async () => {
    const { computer, cloud } = await two();
    await cloud.handOff("cloud-analyst", call(["Writer"], "Draft the summary"));
    await until(() => cloud.results.length === 1, "the Cloud has the computer's result");
    expect(cloud.results[0]).toMatchObject({ name: "Writer (Sam's Mac)", result: "local-writer did: Draft the summary" });
    const { receipts } = await cloud.handOff("cloud-analyst", call(["Writer"], "FYI: the numbers changed", { reply: "none" }));
    expect(receipts[0]!.detail).toContain("nothing comes back");
    await until(() => computer.runs.some((run) => run.text === "FYI: the numbers changed"), "the notice arrives");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cloud.results).toHaveLength(1);
  });

  it("a hand-off that arrives twice runs once, and a result that arrives twice resumes once", async () => {
    const { computer, cloud } = await two();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    cloud.engine(async (node) => { await gate; return { ok: true, text: `${node.botId} did: ${node.text}` }; });
    const { receipts } = await computer.handOff("local-writer", call(["Analyst"], "Count the orders"));
    await until(() => cloud.runs.length === 1, "the work starts");
    const again: Frame = { t: "handoff", id: receipts[0]!.requestId!, to: "cloud-analyst", from: { botId: "local-writer", name: "Writer", threadId: "local-writer-chat" },
      thread: "x", text: "Count the orders", mode: "work", origin: { kind: "person" } };
    cloud.link.receive(COMPUTER, [again, again]);
    computer.link.sessionStarted(CLOUD);
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await until(() => computer.results.length === 1, "the result is back");
    const result: Frame = { t: "result", id: receipts[0]!.requestId!, ok: true, text: "a second copy" };
    computer.link.receive(CLOUD, [result, result]);
    cloud.link.receive(COMPUTER, [again]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(cloud.runs.filter((run) => run.botId === "cloud-analyst")).toHaveLength(1);
    expect(computer.results).toHaveLength(1);
    expect(computer.runs.filter((run) => run.resumed)).toHaveLength(1);
  });

  it("the link drops while the work runs: the result waits and arrives when the link is back, once", async () => {
    const { computer, cloud } = await two();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    cloud.engine(async (node) => { await gate; return { ok: true, text: `${node.botId} did: ${node.text}` }; });
    await computer.handOff("local-writer", call(["Analyst"], "Count the orders"));
    await until(() => cloud.runs.length === 1, "the work starts");
    const at = cloud.port;
    await cloud.unplug();
    await until(() => !computer.link.online(), "the computer sees the link gone");
    release();
    await until(() => !cloud.link.online(), "the Cloud sees the computer gone");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(computer.results).toEqual([]);
    await cloud.listen(at);
    await until(() => computer.results.length === 1, "the result arrives after the link returns");
    expect(computer.results[0]!.result).toBe("cloud-analyst did: Count the orders");
    expect(cloud.runs.filter((run) => run.botId === "cloud-analyst")).toHaveLength(1);
    await until(() => computer.runs.some((run) => run.resumed), "the requester is resumed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(computer.runs.filter((run) => run.resumed)).toHaveLength(1);
  });

  it("the computer is off: the Cloud bot is told, the work waits past every clock and a restart of either side, and runs once when it is back", async () => {
    const { computer, cloud } = await two({ limits: { queueMs: 80, stallMs: 1_500 } });
    await computer.dialer.stop();
    await until(() => !cloud.link.online(), "the Cloud sees the computer gone");
    const { receipts, id } = await cloud.handOff("cloud-analyst", call(["Writer"], "Draft the summary"));
    expect(receipts[0]).toMatchObject({ outcome: "queued" });
    expect(receipts[0]!.detail).toContain("Sam's Mac is offline now");
    expect(cloud.link.agents().find((bot) => bot.name === "Writer")!.statusText).toContain("offline now");
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    expect(cloud.coordinator.node(receipts[0]!.requestId!)?.status).toBe("queued");
    expect(cloud.coordinator.node(id)?.status).toBe("waiting");
    expect(cloud.coordinator.pace()).toBe("parked");

    await cloud.restart({ limits: { queueMs: 80, stallMs: 1_500 } });
    // Only the Cloud holds work here, so only its clocks are short: the computer starts its work with its usual ones.
    await computer.restart();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(cloud.coordinator.node(receipts[0]!.requestId!)?.status).toBe("queued");
    expect(computer.runs).toEqual([]);

    computer.dialer.start();
    await until(() => cloud.results.length === 1, "the result is back after the computer returns");
    expect(cloud.results[0]).toMatchObject({ name: "Writer (Sam's Mac)", status: "completed", result: "local-writer did: Draft the summary" });
    expect(computer.runs.filter((run) => run.botId === "local-writer")).toHaveLength(1);
    await until(() => cloud.runs.some((run) => run.resumed), "the Cloud bot is resumed");
    expect(cloud.runs.filter((run) => run.resumed)).toHaveLength(1);
  });

  it("the working side restarts after it finished but before the requester heard: the kept result is sent, nothing runs again", async () => {
    const { computer, cloud } = await two();
    await computer.dialer.stop();
    await until(() => !cloud.link.online(), "the link is down");
    const frame: Frame = { t: "handoff", id: "as-1", to: "cloud-analyst", from: { botId: "local-writer", name: "Writer", threadId: "local-writer-chat" },
      thread: "t", text: "Count the orders", mode: "work", origin: { kind: "person", quote: "Sort it out" } };
    cloud.link.receive(COMPUTER, [frame]);
    await until(() => cloud.runs.length === 1, "the work ran");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await cloud.restart();
    cloud.link.sessionStarted(COMPUTER);
    expect(cloud.link.outgoing(COMPUTER, 0).map((entry) => entry.frame).filter((sentFrame) => sentFrame.t === "result")).toEqual([{ t: "result", id: "as-1", ok: true, text: "cloud-analyst did: Count the orders", outcome: "done" }]);
    cloud.link.receive(COMPUTER, [frame, { t: "done", id: "as-1" }]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(cloud.runs).toHaveLength(1);
    cloud.link.sessionStarted(COMPUTER);
    expect(cloud.link.outgoing(COMPUTER, 0).some((entry) => entry.frame.t === "result")).toBe(false);
  });

  it("stopping the requester stops the work on the other side", async () => {
    const { computer, cloud } = await two();
    let stopped = false;
    cloud.engine((_node, _resumed, signal) => new Promise((resolve) => { signal.addEventListener("abort", () => { stopped = true; resolve({ ok: false, text: "stopped" }); }); }));
    await computer.handOff("local-writer", call(["Analyst"], "Count the orders"));
    await until(() => cloud.runs.length === 1, "the work starts");
    computer.coordinator.cancelDirect("local-writer-chat");
    await until(() => stopped, "the Cloud's turn is stopped");
    expect(computer.results.map((row) => row.status)).not.toContain("completed");
  });

  it("turned off on the computer: the Cloud is told, both forget the link, its sign-in ends and waiting work ends with the reason", async () => {
    const { computer, cloud, cloudOrigin } = await two();
    const token = JSON.parse((await import("node:fs")).readFileSync(join(computer.dir, "bot-link.json"), "utf8")).token as string;
    cloud.engine(() => new Promise(() => {}));
    await computer.handOff("local-writer", call(["Analyst"], "Count the orders"));
    await until(() => cloud.runs.length === 1, "the work starts");
    const off = await computer.fetch("PUT", STATE_PATH, { on: false });
    expect(off.body).toEqual({ on: false });
    await until(() => !cloud.link.on(), "the Cloud forgets the link");
    expect(existsSync(join(computer.dir, "bot-link.json"))).toBe(false);
    expect(existsSync(join(cloud.dir, "bot-link.json"))).toBe(false);
    expect((await cloud.fetch("POST", SYNC_PATH, { ack: 0, frames: [], wait: 0 }, token)).status).toBe(403);
    await until(() => computer.results.length === 1, "the waiting work ends");
    expect(computer.results[0]).toMatchObject({ status: "failed" });
    expect(computer.results[0]!.result).toContain("turned off");
    expect(computer.link.agents()).toEqual([]);
    const before = cloud.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(cloud.requests.length).toBe(before);
    expect(cloudOrigin).toContain("127.0.0.1");
  });

  it("two computers on one Cloud: each has its own link, and work, results and stops go only to the computer they belong to", async () => {
    const { computer, cloud, cloudOrigin } = await two();
    const laptop = place("laptop", [{ id: "shared", name: "Scout" }, { id: "laptop-coder", name: "Coder" }]).boot();
    places.push(laptop);
    await laptop.listen();
    const firstSessions = cloud.sessions();
    await pair(laptop, cloud, cloudOrigin, { id: "laptop-environment", name: "Sam's Laptop" });
    const LAPTOP = peerKey("laptop-environment");
    expect(cloud.sessions()).toEqual(expect.arrayContaining(firstSessions));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(computer.link.online() && laptop.link.online()).toBe(true);
    expect(cloud.link.agents().map((bot) => [bot.id, bot.statusText])).toEqual([
      [onComputer("shared"), "on Sam's Mac"], [onComputer("local-writer"), "on Sam's Mac"], [linkedId(LAPTOP, "shared"), "on Sam's Laptop"], [linkedId(LAPTOP, "laptop-coder"), "on Sam's Laptop"]]);
    expect(cloud.link.resolve("Scout")).toBeUndefined();
    expect(cloud.link.resolve("Coder")?.peer).toBe(LAPTOP);

    await laptop.dialer.stop();
    await until(() => !cloud.link.online(LAPTOP), "the laptop goes");
    const forLaptop = await cloud.handOff("cloud-analyst", call([linkedId(LAPTOP, "shared")], "Laptop: build it"));
    expect(forLaptop.receipts[0]!.detail).toContain("Sam's Laptop is offline now");
    const forMac = await cloud.handOff("cloud-analyst", call([onComputer("shared")], "Mac: write it"));
    expect(forMac.receipts[0]!.detail).toContain("sent to Scout on Sam's Mac");
    await until(() => cloud.results.length === 1, "the Mac's result is back");
    expect(cloud.results[0]).toMatchObject({ name: "Scout (Sam's Mac)", result: "shared did: Mac: write it" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(computer.runs.map((run) => run.text)).toEqual(["Mac: write it"]);
    expect(laptop.runs).toEqual([]);
    expect(cloud.coordinator.node(forLaptop.receipts[0]!.requestId!)?.status).toBe("queued");

    // A result or a stop from the wrong computer changes nothing.
    computer.link.receive(CLOUD, []);
    cloud.link.receive(COMPUTER, [{ t: "result", id: forLaptop.receipts[0]!.requestId!, ok: true, text: "not mine to give" }, { t: "cancel", id: forLaptop.receipts[0]!.requestId! }]);
    laptop.dialer.start();
    await until(() => cloud.results.length === 2, "the laptop's result is back");
    expect(cloud.results[1]).toMatchObject({ name: "Scout (Sam's Laptop)", result: "shared did: Laptop: build it" });
    expect(laptop.runs.map((run) => run.text)).toEqual(["Laptop: build it"]);

    // One computer turns its link off: the other's stays.
    expect((await laptop.fetch("PUT", STATE_PATH, { on: false })).body).toEqual({ on: false });
    await until(() => cloud.link.agents().length === 2, "the Cloud forgets the laptop only");
    expect(cloud.link.online(COMPUTER)).toBe(true);
    expect(cloud.sessions()).toEqual(firstSessions);
  });

  it("a computer that goes off while it works for the Cloud holds the work without a clock and without keeping the Cloud busy", async () => {
    const { computer, cloud } = await two();
    // Only the Cloud's clocks are short: the computer's own work is not what is measured.
    await cloud.restart({ limits: { queueMs: 80, stallMs: 2_000 } });
    await until(() => computer.link.online() && cloud.link.online(), "the link is back after the Cloud restarted");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    computer.engine(async (node) => { await gate; return { ok: true, text: `${node.botId} did: ${node.text}` }; });
    const { receipts } = await cloud.handOff("cloud-analyst", call(["Writer"], "Draft the summary"));
    await until(() => computer.runs.length === 1, "the work starts on the computer");
    expect(cloud.coordinator.pace()).toBe("busy");
    await computer.dialer.stop();
    await until(() => !cloud.link.online(), "the Cloud sees the computer gone");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(cloud.coordinator.node(receipts[0]!.requestId!)?.status).toBe("running");
    expect(cloud.coordinator.pace()).toBe("parked");
    release();
    computer.dialer.start();
    await until(() => cloud.results.length === 1, "the result is back");
    expect(cloud.results[0]).toMatchObject({ status: "completed", result: "local-writer did: Draft the summary" });
    expect(computer.runs.filter((run) => !run.resumed)).toHaveLength(1);
  });

  it("a computer not heard from for thirty days is unlinked on the Cloud: its sign-in ends and work waiting for it fails with the reason", async () => {
    const { computer, cloud } = await two();
    await computer.dialer.stop();
    await until(() => !cloud.link.online(), "the Cloud sees the computer gone");
    await cloud.handOff("cloud-analyst", call(["Writer"], "Draft the summary"));
    cloud.later(LINK_EXPIRES_MS - 60_000);
    cloud.link.tidy();
    expect(cloud.link.on()).toBe(true);
    cloud.later(120_000);
    cloud.link.tidy();
    expect(cloud.link.on()).toBe(false);
    expect(cloud.sessions()).toEqual([]);
    await until(() => cloud.results.length === 1, "the waiting work ends");
    expect(cloud.results[0]).toMatchObject({ status: "failed" });
    expect(existsSync(join(cloud.dir, "bot-link.json"))).toBe(false);
  });

  it("turned off while the Cloud cannot be told: the Cloud is told when the app next says it is awake, and only for that Cloud", async () => {
    const { computer, cloud, cloudOrigin } = await two();
    const at = cloud.port;
    await cloud.unplug();
    expect((await computer.fetch("PUT", STATE_PATH, { on: false })).body).toEqual({ on: false, ended: [cloudOrigin] });
    expect(JSON.parse(readFileSync(join(computer.dir, "bot-link-ended.json"), "utf8"))).toHaveLength(1);
    await cloud.listen(at);
    expect(cloud.link.on()).toBe(true);
    await computer.fetch("PUT", STATE_PATH, { cloud: "awake", origin: "https://another.example" });
    expect(cloud.link.on()).toBe(true);
    await computer.fetch("PUT", STATE_PATH, { cloud: "awake", origin: cloudOrigin });
    expect(cloud.link.on()).toBe(false);
    expect(cloud.sessions()).toEqual([]);
    expect(existsSync(join(computer.dir, "bot-link-ended.json"))).toBe(false);
  });

  it("the app's word about one Cloud is not fed to a link to another", async () => {
    const { computer, cloudOrigin } = await two();
    expect((await computer.fetch("PUT", STATE_PATH, { cloud: "asleep", origin: "https://another.example" })).body).toMatchObject({ asleep: false, online: true });
    expect((await computer.fetch("PUT", STATE_PATH, { cloud: "asleep", origin: cloudOrigin })).body).toMatchObject({ asleep: true, online: false });
    expect((await computer.fetch("GET", STATE_PATH)).body).toMatchObject({ origin: cloudOrigin, account: "account-1" });
    await computer.fetch("PUT", STATE_PATH, { cloud: "awake", origin: cloudOrigin });
    await until(() => computer.link.online(), "the link is back");
  });

  it("more results than one exchange carries go a part at a time, and all arrive", async () => {
    const { computer, cloud } = await two();
    const words = "x".repeat(11_000);
    cloud.engine(async (node) => ({ ok: true, text: `${node.text}:${words}` }));
    await computer.dialer.stop();
    await until(() => !cloud.link.online(), "the link is down");
    const ids = Array.from({ length: 160 }, (_, index) => `big-${index}`);
    cloud.link.receive(COMPUTER, ids.map((id): Frame => ({ t: "handoff", id, to: "cloud-analyst", from: { botId: "local-writer", name: "Writer", threadId: "local-writer-chat" }, thread: `t-${id}`, text: id, mode: "work", origin: { kind: "person" } })));
    await until(() => cloud.coordinator.all().filter((node) => node.botId === "cloud-analyst" && node.status === "completed").length === ids.length, "all the work is done", 30_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    cloud.link.sessionStarted(COMPUTER);
    const part = cloud.link.outgoing(COMPUTER, 0);
    expect(part.length).toBeLessThan(ids.length);
    expect(JSON.stringify(part).length).toBeLessThan(EXCHANGE_BYTES + 20_000);
    const taken: string[] = [];
    for (let ack = 0, rounds = 0; rounds < 30; rounds += 1) {
      const next = cloud.link.outgoing(COMPUTER, ack);
      if (next.length === 0) break;
      for (const entry of next) if (entry.frame.t === "result") taken.push(entry.frame.id);
      ack = next.at(-1)!.seq;
    }
    expect(taken.sort()).toEqual([...ids].sort());
    computer.dialer.start();
    await until(() => cloud.link.outgoing(COMPUTER, 0).every((entry) => entry.frame.t !== "result") && cloud.link.online(), "the computer took them all", 15_000);
  }, 60_000);

  it("a requester cut by two restarts fails the hand-off and stops the work where it runs", async () => {
    const { computer, cloud } = await two();
    let stopped = false;
    cloud.engine((_node, _resumed, signal) => new Promise((resolve) => { signal.addEventListener("abort", () => { stopped = true; resolve({ ok: false, text: "stopped" }); }); }));
    await computer.handOff("local-writer", call(["Analyst"], "Count the orders"));
    await until(() => cloud.runs.length === 1, "the work starts");
    await computer.restart();
    computer.dialer.start();
    await until(() => computer.link.online(), "the computer is back");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(stopped).toBe(false);
    expect(cloud.runs).toHaveLength(1);
    await computer.restart();
    computer.dialer.start();
    await until(() => stopped, "the Cloud's turn is stopped");
    expect(cloud.runs).toHaveLength(1);
  });

  it("files go with a hand-off and come back with its result, from the computer to the Cloud", async () => {
    const { computer, cloud } = await two();
    cloud.engine(async (node) => { cloud.attach(node.id, "totals.csv", "orders,42"); return { ok: true, text: "Counted: see totals.csv" }; });
    const { receipts } = await computer.handOff("local-writer", call(["Analyst"], "Count the orders in this export", { files: [computer.keep("orders.csv", Buffer.from("id\n1\n2")), computer.keep("notes.txt", Buffer.from("skip refunds"))] }));
    await until(() => computer.results.length === 1, "the result is back");
    const worked = cloud.coordinator.all().find((node) => node.botId === "cloud-analyst")!;
    expect(cloud.carries(worked.id, "sent")).toEqual({ from: "Writer", files: [["orders.csv", "id\n1\n2"], ["notes.txt", "skip refunds"]] });
    expect(computer.carries(receipts[0]!.requestId!, "returned")).toEqual({ from: "Analyst", files: [["totals.csv", "orders,42"]] });
    expect(computer.results[0]!.result).toBe("Counted: see totals.csv");
    expect(cloud.spooled()).toEqual([]);
    expect(computer.spooled()).toEqual([]);
  });

  it("files go with a hand-off and come back with its result, from the Cloud to the computer", async () => {
    const { computer, cloud } = await two();
    computer.engine(async (node) => { computer.attach(node.id, "draft.md", "# Summary"); return { ok: true, text: "Drafted." }; });
    const { receipts } = await cloud.handOff("cloud-analyst", call(["Writer"], "Write this up", { files: [cloud.keep("figures.csv", Buffer.from("a,b\n1,2"))] }));
    await until(() => cloud.results.length === 1, "the result is back");
    const worked = computer.coordinator.all().find((node) => node.botId === "local-writer")!;
    expect(computer.carries(worked.id, "sent")).toEqual({ from: "Analyst", files: [["figures.csv", "a,b\n1,2"]] });
    expect(cloud.carries(receipts[0]!.requestId!, "returned")).toEqual({ from: "Writer", files: [["draft.md", "# Summary"]] });
    expect(cloud.spooled()).toEqual([]);
    expect(computer.spooled()).toEqual([]);
  });

  it("files wait for a computer that is off, and a file the working side will not take ends the hand-off with the reason", async () => {
    const { computer, cloud } = await two();
    await computer.dialer.stop();
    await until(() => !cloud.link.online(), "the Cloud sees the computer gone");
    const { receipts } = await cloud.handOff("cloud-analyst", call(["Writer"], "Write this up", { files: [cloud.keep("figures.csv", Buffer.from("a,b"))] }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    computer.dialer.start();
    await until(() => cloud.results.length === 1, "the result is back");
    expect(computer.carries(computer.coordinator.all().find((node) => node.botId === "local-writer")!.id, "sent")?.files).toEqual([["figures.csv", "a,b"]]);
    expect(cloud.results[0]).toMatchObject({ status: "completed" });
    expect(receipts[0]!.outcome).toBe("queued");

    await computer.handOff("local-writer", call(["Analyst"], "Run this", { files: [computer.keep("tool.exe", Buffer.from("MZ"))] }));
    await until(() => computer.results.length === 1, "the refusal is back");
    expect(computer.results[0]).toMatchObject({ status: "failed" });
    expect(computer.results[0]!.result).toContain("tool.exe is not a supported attachment type");
    expect(cloud.runs.filter((run) => run.botId === "cloud-analyst" && !run.resumed)).toEqual([]);
    expect(cloud.spooled()).toEqual([]);
    expect((await cloud.fetch("GET", "/api/bot-link/file?id=nope&way=sent&index=0&name=x.txt", undefined, "owner")).status).toBe(403);
  });

  it("a new session does not send again the files the Cloud already holds, and nothing is left in its spool", async () => {
    const { computer, cloud } = await two();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    cloud.engine(async (node) => { await gate; return { ok: true, text: `${node.botId} did: ${node.text}` }; });
    await computer.handOff("local-writer", call(["Analyst"], "Count the orders", { files: [computer.keep("orders.csv", Buffer.from("id\n1\n2"))] }));
    await until(() => cloud.runs.length === 1, "the work starts");
    const puts = () => cloud.requests.filter((request) => request === "PUT /api/bot-link/file").length;
    expect(puts()).toBe(1);
    expect(cloud.spooled()).toEqual([]);
    const at = cloud.port;
    for (let round = 0; round < 3; round += 1) {
      await cloud.unplug();
      await until(() => !computer.link.online(), "the link drops");
      await cloud.listen(at);
      await until(() => computer.link.online(), "the link is back");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(puts()).toBe(1);
    expect(cloud.requests.filter((request) => request === "GET /api/bot-link/file?probe").length).toBeGreaterThanOrEqual(3);
    expect(cloud.spooled()).toEqual([]);
    release();
    await until(() => computer.results.length === 1, "the result is back");
    expect(cloud.runs.filter((run) => run.botId === "cloud-analyst")).toHaveLength(1);
  });

  it("a file that could not cross is tried again on a timer, on a link that never drops", async () => {
    const { computer, cloud } = await two();
    cloud.failOnce(/^GET \/api\/bot-link\/file$/);
    await cloud.handOff("cloud-analyst", call(["Writer"], "Write this up", { files: [cloud.keep("figures.csv", Buffer.from("a,b\n1,2"))] }));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(computer.runs).toEqual([]);
    expect(computer.link.online()).toBe(true);
    await until(() => cloud.results.length === 1, "the result is back after the retry", 12_000);
    expect(cloud.results[0]).toMatchObject({ status: "completed" });
    expect(cloud.requests.filter((request) => request === "GET /api/bot-link/file")).toHaveLength(2);

    cloud.failOnce(/^PUT \/api\/bot-link\/file$/);
    await computer.handOff("local-writer", call(["Analyst"], "Count the orders", { files: [computer.keep("orders.csv", Buffer.from("id\n1"))] }));
    await until(() => computer.results.length === 1, "the upload was tried again", 12_000);
    expect(computer.results[0]).toMatchObject({ status: "completed" });
  }, 40_000);

  it("a file that turns out larger than it was said to be is not kept, and the hand-off ends with the reason", async () => {
    const { computer, cloud } = await two();
    await computer.dialer.stop();
    await until(() => !cloud.link.online(), "the Cloud sees the computer gone");
    const file = cloud.keep("figures.csv", Buffer.from("a,b"));
    await cloud.handOff("cloud-analyst", call(["Writer"], "Write this up", { files: [file] }));
    writeFileSync(file.path, "a,b and a great deal more than was said");
    computer.dialer.start();
    await until(() => cloud.results.length === 1, "the refusal is back");
    expect(cloud.results[0]).toMatchObject({ status: "failed" });
    expect(cloud.results[0]!.result).toContain("larger than it was said to be");
    expect(computer.runs).toEqual([]);
    expect(computer.spooled()).toEqual([]);
  });

  it("bytes left in the spool by hand-offs that never came are swept: the old ones, and the oldest when there is too much", async () => {
    const { cloud } = await two();
    const root = join(cloud.dir, "bot-link-files");
    const leave = (name: string, ageMs: number) => { const dir = join(root, name, "sent"); mkdirSync(dir, { recursive: true }); const file = join(dir, "0-x.txt"); writeFileSync(file, "left"); const at = new Date(Date.now() - ageMs); utimesSync(file, at, at); };
    leave("stale", SPOOL_KEEP_MS + 60_000);
    leave("fresh", 60_000);
    cloud.link.tidy();
    expect(readdirSync(root)).toEqual(["fresh"]);
    cloud.later(SPOOL_KEEP_MS);
    cloud.link.tidy();
    expect(readdirSync(root)).toEqual([]);
  });

  it("the link's sign-in reaches the link's own routes and nothing else", () => {
    const linked = { userId: "bot-link:computer-environment" };
    expect(linkSessionRefusal(linked, "POST", SYNC_PATH)).toBeNull();
    for (const [method, path] of [["GET", "/api/bots"], ["GET", SYNC_PATH], ["POST", PAIR_PATH], ["DELETE", PAIR_PATH], ["GET", STATE_PATH], ["POST", "/api/bots/x/messages"]] as const) {
      expect(linkSessionRefusal(linked, method, path)).toContain("only for the link");
    }
    expect(linkSessionRefusal({}, "GET", "/api/bots")).toBeNull();
    expect(linkSessionRefusal({ userId: "portal:abc" }, "GET", "/api/bots")).toBeNull();
  });
});
