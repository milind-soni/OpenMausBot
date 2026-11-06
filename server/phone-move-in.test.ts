import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { arrivedRoute } from "./cloud-send-arrived.ts";
import { cloudSendChatsRoute } from "./cloud-send-chats.ts";
import { moveFilesRoute, REPEATED_QUERY } from "./cloud-send-files.ts";
import { moveKindsRoute } from "./cloud-send-kinds.ts";
import { moveMemoryRoute } from "./cloud-send-memory.ts";
import { createPhoneMoveIn, MOVE_BODY_LIMITS, PHONE_MOVE_REFUSAL, type PhoneMoveInDeps } from "./phone-move-in.ts";
import type { RequestAuth } from "./request-auth.ts";
import { createBotCreateRoutes } from "./routes/bots-create.ts";
import { dispatchRoutes, PASS, type RouteContext, type RouteHandler } from "./routes/table.ts";

const SCOUT = "pocket-scout-0001";
const DAY = 24 * 60 * 60 * 1000;
const phone: RequestAuth = { kind: "loopback", scopes: ["admin", "client"], companionDevice: "phone-1", companionMove: true };
const repaired: RequestAuth = { ...phone, companionDevice: "phone-2" };
const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const everyday: RequestAuth = { kind: "loopback", scopes: ["admin", "client"], companionDevice: "phone-1" };

let dir = "";
let clock = 1_000_000;
let bots: Array<{ id: string; threadId: string; tasks: Array<{ threadId: string }> }> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-phone-move-"));
  clock = 1_000_000;
  bots = [{ id: "here-bot-0001", threadId: "here-thread-01", tasks: [] }];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const store = () => ({
  get bots() { return bots as never; },
  groups: [{ id: "room-1", threadId: "room-thread-01", tasks: [] }] as never,
  botByThread: (threadId: string) => (bots.find((bot) => bot.threadId === threadId || bot.tasks.some((task) => task.threadId === threadId)) ?? null) as never,
  groupByThread: (threadId: string) => (threadId === "room-thread-01" ? { id: "room-1" } : undefined) as never,
});

function setup(over: Partial<PhoneMoveInDeps> = {}) {
  return createPhoneMoveIn({
    dataDir: dir,
    store: store(),
    routines: () => ({ listRoutines: () => [{ id: "r-here", botId: "here-bot-0001", target: "bot" }] as never }),
    ownerName: () => "Omkar",
    now: () => clock,
    ...over,
  });
}

async function run(moveIn: ReturnType<typeof createPhoneMoveIn>, auth: RequestAuth, method: string, path: string, body?: unknown) {
  const url = new URL(`http://127.0.0.1${path}`);
  let answered: { status: number; body: any } | null = null;
  let reads = 0, resumed = 0;
  const ctx = {
    req: { resume() { resumed++; } } as never, res: {} as never, url, path: url.pathname, method, auth,
    json: (_res: unknown, status: number, sent: unknown) => { answered = { status, body: sent }; },
    readBody: async () => { reads++; return body; },
  } as unknown as RouteContext;
  const out = await moveIn.guard(ctx);
  const done = answered as { status: number; body: any } | null;
  return { out, status: done?.status, body: done?.body, reads, resumed, handedOn: out === PASS ? await ctx.readBody(ctx.req) : undefined };
}

/** The phone makes a bot, and the create route makes it as the move asked. */
async function create(moveIn: ReturnType<typeof createPhoneMoveIn>, id = SCOUT, auth = phone) {
  const answer = await run(moveIn, auth, "POST", "/api/bots", { id, threadId: `${id}-main`, name: "Scout", useDefaults: false });
  bots.push({ id, threadId: `${id}-main`, tasks: [{ threadId: `${id}-t1` }] });
  return answer;
}
const refused = { status: 403, body: { error: PHONE_MOVE_REFUSAL } };

/** A paired device's `POST /api/bots` through the guard and the create route, whose store makes nothing. */
async function createThrough(moveIn: ReturnType<typeof createPhoneMoveIn>, auth: RequestAuth, body: Record<string, unknown>) {
  let answered: { status: number; body: any } | null = null;
  const url = new URL("http://127.0.0.1/api/bots");
  await dispatchRoutes([moveIn.guard, createBotCreateRoutes({ store: store(), routines: () => null } as never)], {
    req: { headers: { "x-openmausbot-companion": "1" }, resume() {} } as never, res: {} as never, url, path: url.pathname, method: "POST", auth,
    json: ((_res: unknown, status: number, sent: any) => { answered = { status, body: sent }; }) as never, readBody: (async () => body) as never });
  return answered as { status: number; body: any } | null;
}

describe("a phone's move into this computer", () => {
  it("does nothing for a request that is not a phone's move", async () => {
    const moveIn = setup();
    for (const auth of [owner, everyday]) {
      expect(moveIn.moving(auth)).toBeNull();
      expect(moveIn.owner(auth)).toBeNull();
      for (const [method, path] of [["POST", "/api/bots"], ["PUT", "/api/cloud-send/kind"], ["POST", "/api/cloud-send/chats"], ["POST", "/api/bots/here-bot-0001/skill-template"]] as const) {
        const answer = await run(moveIn, auth, method, path, { id: "here-bot-0001", key: "webhook:w1" });
        expect([answer.out, answer.status, answer.reads], `${method} ${path}`).toEqual([PASS, undefined, 0]);
      }
    }
    expect(moveIn.moving(phone)).toBe("phone-1");
    expect(moveIn.owner(phone)).toEqual({ person: "", name: "Omkar" });
  });

  it("a bot becomes the phone's when it creates it under the grant, and stays so after a restart", async () => {
    const moveIn = setup();
    const made = await create(moveIn);
    expect(made.out).toBe(PASS);
    expect(made.handedOn).toEqual({ id: SCOUT, threadId: `${SCOUT}-main`, name: "Scout", useDefaults: false });
    expect(moveIn.brings(phone, SCOUT)).toBe(true);
    expect(moveIn.brings(everyday, SCOUT)).toBe(false);
    expect(moveIn.brings(owner, SCOUT)).toBe(false);
    expect(setup().brings(phone, SCOUT)).toBe(true);
    const file = join(dir, "phone-move-ins.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, bots: { [SCOUT]: clock } });
  });

  it("a phone paired again partway through finishes the move", async () => {
    const moveIn = setup();
    await create(moveIn);
    expect(moveIn.brings(repaired, SCOUT)).toBe(true);
    const kind = await run(setup(), repaired, "PUT", "/api/cloud-send/kind", { v: 1, key: `bot:${SCOUT}`, dataDir: "/phone", record: {} });
    expect(kind.out).toBe(PASS);
    const chats = await run(moveIn, repaired, "POST", "/api/cloud-send/chats", { v: 1, dataDir: "/phone", conversations: [{ bot: SCOUT, threadId: `${SCOUT}-main` }] });
    expect(chats.out).toBe(PASS);
  });

  it("a brought bot is the computer's own 24 hours after it arrived", async () => {
    const moveIn = setup();
    await create(moveIn);
    clock += DAY - 1;
    expect(moveIn.brings(phone, SCOUT)).toBe(true);
    clock += 1;
    expect(moveIn.brings(phone, SCOUT)).toBe(false);
    expect(await run(moveIn, phone, "PUT", "/api/cloud-send/kind", { v: 1, key: `bot:${SCOUT}`, dataDir: "/phone", record: {} })).toMatchObject(refused);
    expect(setup().brings(phone, SCOUT)).toBe(false);
  });

  it("a phone's arrived announces no webhook and names no place: the computer's bots say nothing, and no told list is kept", async () => {
    const moveIn = setup();
    await create(moveIn);
    const sent = await run(moveIn, phone, "POST", "/api/cloud-send/arrived", { v: 1, computer: "Omkar's iPhone", webhooks: ["wh_known"], place: "evil.example", bots: [SCOUT] });
    expect(sent.handedOn).toEqual({ v: 1, computer: "Omkar's iPhone", webhooks: [], bots: [SCOUT] });
    const lines: string[] = [];
    let answered: unknown;
    await arrivedRoute({ dataDir: dir, owner: moveIn.owner, phone: (auth: RequestAuth) => moveIn.moving(auth) !== null, lineLanguage: () => "en",
      store: { bot: () => ({ threadId: "here-thread-01" }), appendMessage: (threadId: string) => { lines.push(threadId); } },
      webhooks: () => ({ list: () => [{ id: "wh_known", name: "Orders", botId: "here-bot-0001" }] }) } as never,
    { path: "/api/cloud-send/arrived", method: "POST", req: {} as never, res: {} as never, auth: phone, url: new URL("http://x/"),
      json: (_res: unknown, _status: number, value: unknown) => { answered = value; }, readBody: async () => sent.handedOn } as never);
    expect(answered).toEqual({ v: 1, told: 0 });
    expect(lines).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "moved-from.json"), "utf8")).told).toEqual([]);
  });

  it("a bot's move ends when the phone says it arrived", async () => {
    const moveIn = setup();
    await create(moveIn);
    await create(moveIn, "pocket-notes-0002");
    const arrived = await run(moveIn, phone, "POST", "/api/cloud-send/arrived", { v: 1, computer: "Omkar's iPhone", webhooks: [], bots: [SCOUT] });
    expect(arrived.out).toBe(PASS);
    expect(arrived.handedOn).toEqual({ v: 1, computer: "Omkar's iPhone", webhooks: [], bots: [SCOUT] });
    expect(moveIn.brings(phone, SCOUT)).toBe(false);
    expect(moveIn.brings(phone, "pocket-notes-0002")).toBe(true);
    expect(await run(moveIn, phone, "POST", `/api/bots/${SCOUT}/skill-template`, { name: "x" })).toMatchObject(refused);
    expect(setup().brings(phone, SCOUT)).toBe(false);
    expect(setup().brings(phone, "pocket-notes-0002")).toBe(true);
  });

  it("a bot already on this computer never becomes the phone's", async () => {
    const moveIn = setup();
    for (const id of ["here-bot-0001", "here-thread-01", "room-thread-01", "short"]) {
      expect((await run(moveIn, phone, "POST", "/api/bots", { id })).out, id).toBe(PASS);
      expect(moveIn.brings(phone, id), id).toBe(false);
    }
    expect((await run(moveIn, phone, "POST", "/api/bots", { id: "pocket-new-0003", threadId: "here-thread-01" })).out).toBe(PASS);
    expect(moveIn.brings(phone, "pocket-new-0003")).toBe(false);
  });

  it("a computer bot's id or conversation in other capitals is taken: the create answers 409 and nothing opens", async () => {
    const moveIn = setup();
    const make = (auth: RequestAuth, body: Record<string, unknown>) => createThrough(moveIn, auth, body);
    for (const body of [{ id: "HERE-BOT-0001" }, { id: "Here-Thread-01" }, { id: "ROOM-THREAD-01" }, { id: "pocket-new-0005", threadId: "HERE-THREAD-01" },
      { id: "pocket-new-0006", threadId: "Here-Bot-0001" }, { id: "pocket-new-0007", threadId: "POCKET-NEW-0007" }]) {
      expect((await make(phone, body))?.status, JSON.stringify(body)).toBe(409);
      expect(moveIn.brings(phone, body.id), body.id).toBe(false);
    }
    expect(existsSync(join(dir, "phone-move-ins.json"))).toBe(false);
    // The desktop owner's create is held to the same rule.
    expect((await make(owner, { id: "Here-Bot-0001" }))?.status).toBe(409);
    expect((await make(owner, { id: "pocket-new-0008", threadId: "HERE-THREAD-01" }))?.status).toBe(409);
  });

  it("a paired phone without the grant keeps no bot id of its own: 403 before anything is made or opened", async () => {
    const moveIn = setup();
    const lapsed = { status: 403, body: { error: "Allow this move on the computer first." } };
    for (const body of [{ id: SCOUT, threadId: `${SCOUT}-main`, name: "Scout", useDefaults: false }, { id: SCOUT }, { id: "here-bot-0001" }, { id: "HERE-BOT-0001" }]) {
      expect(await createThrough(moveIn, everyday, body), JSON.stringify(body)).toEqual(lapsed);
    }
    expect(bots.map((bot) => bot.id)).toEqual(["here-bot-0001"]);
    expect(moveIn.brings(phone, SCOUT)).toBe(false);
    expect(existsSync(join(dir, "phone-move-ins.json"))).toBe(false);
  });

  it("refuses a path an engine or git reads as its configuration, in any capitals and at any depth, and lets notes and instructions through", async () => {
    const moveIn = setup();
    await create(moveIn);
    const file = (path: string) => `/api/cloud-send/files?path=${encodeURIComponent(path)}&size=1&sha256=x&offset=0&mode=new`;
    for (const rel of [".mcp.json", ".claude/settings.json", ".claude/hooks/x.sh", ".agents/skills/x/SKILL.md", "opencode.json", "opencode.jsonc", ".opencode/plugin/x.ts",
      ".gemini/settings.json", ".qwen/settings.json", ".codex/config.toml", ".grok/config.toml", ".cursor/mcp.json", ".github/hooks/hooks.json",
      ".copilot/mcp-config.json", ".factory/mcp.json", ".kimi/config.toml", ".kimi-code/config.toml", ".cline/settings.json", ".clinerules/hooks/PreToolUse",
      ".pi/extensions/x.ts", ".dsh/config.yaml", ".git/config", ".git/hooks/pre-commit",
      ".MCP.JSON", ".Claude/settings.json", "OpenCode.JSON", ".mcp.j\u017fon", "trip/.Git/config", "trip/site/.gemini/settings.json"]) {
      const answer = await run(moveIn, phone, "POST", file(`workspaces/${SCOUT}/${rel}`));
      expect([answer.status, answer.body, answer.reads, answer.resumed], rel).toEqual([403, { error: PHONE_MOVE_REFUSAL }, 0, 1]);
    }
    expect(await run(moveIn, phone, "POST", file(`task-workspaces/${SCOUT}/t1/.mcp.json`))).toMatchObject(refused);
    for (const rel of ["notes.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".gitignore", "my.mcp.json", "opencode.json.md", "github/readme.md", "trip/.mcp.json.bak"]) {
      expect((await run(moveIn, phone, "POST", file(`workspaces/${SCOUT}/${rel}`))).out, rel).toBe(PASS);
    }
  });

  it("refuses every move write for a bot the phone did not bring", async () => {
    const moveIn = setup();
    await create(moveIn);
    const writes: Array<[string, string, unknown?]> = [
      ["POST", "/api/bots/here-bot-0001/skill-template", { name: "x" }],
      ["GET", "/api/bots/here-bot-0001/skills"],
      ["PUT", "/api/cloud-send/kind", { v: 1, key: "bot:here-bot-0001", dataDir: "/phone", record: {} }],
      ["POST", "/api/cloud-send/chats", { v: 1, dataDir: "/phone", conversations: [{ bot: "here-bot-0001", threadId: "new-thread-01" }] }],
      ["POST", "/api/cloud-send/chats", { v: 1, dataDir: "/phone", conversations: [{ bot: SCOUT, threadId: "here-thread-01" }] }],
      ["POST", "/api/cloud-send/chats", { v: 1, dataDir: "/phone", conversations: [{ bot: SCOUT, threadId: "HERE-THREAD-01" }] }],
      ["POST", "/api/cloud-send/chats", { v: 1, dataDir: "/phone", conversations: [{ bot: SCOUT, threadId: "Room-Thread-01" }] }],
      ["POST", "/api/cloud-send/chats/verify", { v: 1, conversations: [{ threadId: "HERE-THREAD-01", ids: [] }] }],
      ["POST", "/api/cloud-send/chats/verify", { v: 1, conversations: [{ threadId: "here-thread-01", ids: [] }] }],
      ["POST", "/api/cloud-send/memory", { v: 1, bot: "here-bot-0001", files: [] }],
      ["POST", "/api/cloud-send/files?path=workspaces/here-bot-0001/a.md&size=1&sha256=x&offset=0&mode=new"],
      ["POST", "/api/cloud-send/files?path=task-workspaces/here-bot-0001/a.md"],
      ["POST", "/api/cloud-send/files?path=workspaces/a.md"],
      ["POST", "/api/cloud-send/files"],
    ];
    for (const [method, path, body] of writes) {
      const answer = await run(moveIn, phone, method, path, body);
      expect(answer, `${method} ${path}`).toMatchObject(refused);
      if (body === undefined) expect([answer.reads, answer.resumed], path).toEqual([0, 1]);
    }
  });

  it("lets the bots it brought through, reading a raw body never", async () => {
    const moveIn = setup();
    await create(moveIn);
    const writes: Array<[string, string, unknown?]> = [
      ["POST", `/api/bots/${SCOUT}/skill-template`],
      ["GET", `/api/bots/${SCOUT}/skills`],
      ["POST", `/api/cloud-send/chats`, { v: 1, dataDir: "/phone", conversations: [{ bot: SCOUT, threadId: `${SCOUT}-main` }, { bot: SCOUT, threadId: "new-thread-02" }] }],
      ["POST", "/api/cloud-send/chats/verify", { v: 1, conversations: [{ threadId: `${SCOUT}-main`, ids: [] }, { threadId: "new-thread-02" }] }],
      ["POST", "/api/cloud-send/memory", { v: 1, bot: SCOUT, files: [{ path: "MEMORY.md", text: "x" }] }],
      ["POST", `/api/cloud-send/files?path=workspaces/${SCOUT}/a.md&size=1&sha256=x&offset=0&mode=new`],
      ["POST", `/api/cloud-send/files?path=task-workspaces/${SCOUT}/t1/a.md`],
    ];
    for (const [method, path, body] of writes) {
      const answer = await run(moveIn, phone, method, path, body);
      expect(answer.out, `${method} ${path}`).toBe(PASS);
      if (body === undefined) expect(answer.reads, path).toBe(0);
      else expect(answer.handedOn, path).toEqual(body);
    }
  });

  it("keeps the phone's everyday requests to the computer's own bots working while it moves", async () => {
    const moveIn = setup();
    await create(moveIn);
    for (const [method, path] of [["PATCH", "/api/bots/here-bot-0001"], ["PATCH", `/api/bots/${SCOUT}`], ["POST", "/api/cloud-send/chats/attachments"],
      ["POST", "/api/cloud-send/chats/attachment/a1.png"], ["POST", "/api/phone-move/key"]] as const) {
      const answer = await run(moveIn, phone, method, path, { pinned: true, unread: false });
      expect([answer.out, answer.reads], `${method} ${path}`).toEqual([PASS, 0]);
    }
    expect(moveIn.brings(phone, "here-bot-0001")).toBe(false);
  });

  it("refuses rooms, other kinds and place-wide memory from a phone", async () => {
    const moveIn = setup();
    await create(moveIn);
    const bodies: Array<[string, string, unknown]> = [
      ["POST", "/api/cloud-send/chats", { v: 1, dataDir: "/phone", conversations: [{ bot: SCOUT, room: "room-1", threadId: "room-thread-02" }] }],
      ["POST", "/api/cloud-send/chats", { v: 1, dataDir: "/phone", conversations: [{ bot: SCOUT, threadId: "room-thread-01" }] }],
      ["POST", "/api/cloud-send/chats/verify", { v: 1, conversations: [{ threadId: "room-thread-01" }] }],
      ...["webhook:w1", "call:c1", "app-event:e1", "imported-skill:x", "library-skill:x", "bot:", SCOUT].map((key): [string, string, unknown] =>
        ["PUT", "/api/cloud-send/kind", { v: 1, key, dataDir: "/phone", record: { id: key, botId: SCOUT, target: "bot" } }]),
      ["POST", "/api/cloud-send/memory", { v: 1, bot: SCOUT, files: [], about: { learned: [] } }],
      ["POST", "/api/cloud-send/memory", { v: 1, teams: [] }],
      ["POST", "/api/cloud-send/memory", { v: 1, bot: SCOUT, teams: [] }],
    ];
    for (const [method, path, body] of bodies) expect(await run(moveIn, phone, method, path, body), JSON.stringify(body)).toMatchObject(refused);
  });

  it("a routine arrives only for a brought bot and never replaces a computer bot's routine", async () => {
    const moveIn = setup();
    await create(moveIn);
    const put = (id: string, record: Record<string, unknown>) => run(moveIn, phone, "PUT", "/api/cloud-send/kind", { v: 1, key: `routine:${id}`, dataDir: "/phone", record });
    expect(await put("r-here", { botId: SCOUT, target: "bot" })).toMatchObject(refused);
    expect(await put("r-new", { botId: SCOUT, target: "bot", resultsThreadId: "here-thread-01" })).toMatchObject(refused);
    expect(await put("r-new", { botId: "here-bot-0001", target: "bot" })).toMatchObject(refused);
    expect(await put("r-new", { botId: SCOUT, target: "room-goal", groupId: "room-1" })).toMatchObject(refused);
    expect(await put("r-new", { id: "r-here", botId: SCOUT, target: "bot" })).toMatchObject(refused);
    const withRuns = (runs: unknown[]) => run(moveIn, phone, "PUT", "/api/cloud-send/kind", { v: 1, key: "routine:r-new", dataDir: "/phone", record: { botId: SCOUT, target: "bot" }, runs });
    expect(await withRuns([{ id: "run-1", routineId: "r-new", botId: SCOUT }, { id: "run-2", routineId: "r-new", botId: "here-bot-0001" }])).toMatchObject(refused);
    expect(await withRuns(["run-3"])).toMatchObject(refused);
    expect(await withRuns([{ id: "run-1", routineId: "r-new", botId: SCOUT, threadId: "here-thread-01" }])).toMatchObject(refused);
    expect((await withRuns([{ id: "run-1", routineId: "r-new", botId: SCOUT, threadId: `${SCOUT}-t1` }])).out).toBe(PASS);
    expect((await withRuns([{ id: "run-1", routineId: "r-new", botId: SCOUT }])).out).toBe(PASS);
    const ok = await put("r-new", { botId: SCOUT, target: "bot" });
    expect(ok.out).toBe(PASS);
    expect(ok.handedOn).toEqual({ v: 1, key: "routine:r-new", dataDir: "/phone", record: { botId: SCOUT, target: "bot" }, mainIfUnused: true });
    expect((await put("r-new", { botId: SCOUT, target: "bot", resultsThreadId: `${SCOUT}-t1` })).out).toBe(PASS);
  });

  it("refuses a move whose query names a key twice, and writes in neither folder", async () => {
    const moveIn = setup();
    await create(moveIn);
    const text = "x";
    const target = new URL(`http://127.0.0.1/api/cloud-send/files?path=workspaces/${SCOUT}/a.md&path=workspaces/here-bot-0001/b.md&size=1&sha256=${createHash("sha256").update(text).digest("hex")}&offset=0&mode=new`);
    let answered: { status: number; body: unknown } | null = null;
    const files: RouteHandler = async (ctx) => ((await moveFilesRoute({ dataDir: dir, bots: () => bots, owner: () => ({ person: "", name: "Omkar" }) }, ctx)) ? undefined : PASS);
    await dispatchRoutes([moveIn.guard, files], {
      req: Readable.from([Buffer.from(text)]) as never, res: { setHeader() {} } as never, url: target, path: target.pathname, method: "POST", auth: phone,
      json: ((_res: unknown, status: number, body: unknown) => { answered = { status, body }; }) as never, readBody: (async () => null) as never,
    });
    expect(answered).toEqual({ status: 400, body: REPEATED_QUERY });
    expect(existsSync(join(dir, "workspaces", SCOUT, "a.md"))).toBe(false);
    expect(existsSync(join(dir, "workspaces", "here-bot-0001", "b.md"))).toBe(false);
    for (const [method, path] of [["POST", "/api/cloud-send/chats?v=1&v=2"], ["GET", `/api/bots/${SCOUT}/skills?a=1&a=1`], ["PATCH", "/api/bots/here-bot-0001?a=1&a=2"]] as const) {
      const answer = await run(moveIn, phone, method, path, { v: 1 });
      expect([answer.status, answer.body, answer.reads, answer.resumed], `${method} ${path}`).toEqual([400, REPEATED_QUERY, 0, 1]);
    }
  });

  it("refuses a body that is not a JSON object", async () => {
    const moveIn = setup();
    await create(moveIn);
    for (const path of ["/api/bots", "/api/cloud-send/chats", "/api/cloud-send/chats/verify", "/api/cloud-send/memory", "/api/cloud-send/arrived"]) {
      for (const body of [[SCOUT], "text", 1]) expect(await run(moveIn, phone, "POST", path, body), `${path} ${JSON.stringify(body)}`).toMatchObject(refused);
    }
    expect(await run(moveIn, phone, "PUT", "/api/cloud-send/kind", [`bot:${SCOUT}`])).toMatchObject(refused);
  });

  it("reads each body at the limit its route reads it with", async () => {
    const moveIn = setup();
    await create(moveIn);
    const owner = () => ({ person: "", name: "Omkar" });
    const routes: Record<string, RouteHandler> = {
      "POST /api/bots": createBotCreateRoutes({ routines: () => null } as never),
      "PUT /api/cloud-send/kind": async (ctx) => { await moveKindsRoute({ owner } as never, ctx); },
      "POST /api/cloud-send/chats": async (ctx) => { await cloudSendChatsRoute({ store: {} } as never, ctx); },
      "POST /api/cloud-send/chats/verify": async (ctx) => { await cloudSendChatsRoute({ store: {} } as never, ctx); },
      "POST /api/cloud-send/memory": async (ctx) => { await moveMemoryRoute({ owner } as never, ctx); },
      "POST /api/cloud-send/arrived": async (ctx) => { await arrivedRoute({ owner, dataDir: dir } as never, ctx); },
    };
    const limit = async (route: RouteHandler, method: string, path: string) => {
      let read: number | undefined | "unread" = "unread";
      const url = new URL(`http://127.0.0.1${path}`);
      await route({ req: { resume() {}, headers: {} } as never, res: { setHeader() {} } as never, url, path, method, auth: phone, json: (() => {}) as never,
        readBody: (async (_req: unknown, max?: number) => { read = max; return null; }) as never });
      return read;
    };
    for (const route of Object.keys(MOVE_BODY_LIMITS)) {
      const handler = routes[route];
      expect(handler, `no handler to compare ${route} with`).toBeDefined();
      const [method, path] = route.split(" ") as [string, string];
      const handlerLimit = await limit(handler!, method, path);
      expect(handlerLimit, route).not.toBe("unread");
      expect(await limit(moveIn.guard, method, path), route).toBe(handlerLimit);
    }
  });

  it("hands a bot record on without a package, asking to be main only over an unused MausBot", async () => {
    const moveIn = setup();
    await create(moveIn);
    const answer = await run(moveIn, phone, "PUT", "/api/cloud-send/kind", { v: 1, key: `bot:${SCOUT}`, dataDir: "/phone", record: { defaultBot: {}, installedPackage: { id: "p" } } });
    expect(answer.out).toBe(PASS);
    expect(answer.handedOn).toEqual({ v: 1, key: `bot:${SCOUT}`, dataDir: "/phone", record: { defaultBot: {} }, mainIfUnused: true });
  });
});
