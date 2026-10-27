import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { personKey } from "./person-key.ts";
import type { RequestAuth } from "./request-auth.ts";
import { PASS, type RouteContext } from "./routes/table.ts";
import type { SessionRecord } from "./sessions.ts";
import { createTeamMoveIn, moveInBot, moveInRefusal, type TeamMoveInDeps } from "./team-move-in.ts";

const ACME = { id: "team-acme", name: "Acme" };
const SCOUT = "scout-0001", OTHER = "inbox-0002";
const ada = { id: "s-ada", email: "ada@acme.test", teamRole: "member" as const, membershipAuthority: "team" as const };
const adaKey = personKey({ id: "", email: ada.email });
const url = (path: string) => new URL(`http://x${path}`);

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-move-in-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(over: Partial<TeamMoveInDeps> = {}) {
  const issued: Array<{ bot: string; email: string }> = [];
  const revoked: string[] = [];
  const starters = new Map<string, string>();
  const routines = [
    { id: "r-scout", botId: SCOUT, enabled: false, target: "bot" },
    { id: "r-other", botId: OTHER, enabled: false, target: "bot" },
  ];
  const bots: Array<{ id: string; name: string; threadId: string }> = [{ id: OTHER, name: "Scout", threadId: "other-main" }];
  const deps: TeamMoveInDeps = {
    team: ACME, dataDir: dir,
    sessions: { issueMoveIn: (input) => { issued.push(input); return { token: `omb_sess_${input.bot}`, session: {} as never }; }, revokeMoveIns: (bot) => { revoked.push(bot); return 1; } },
    store: {
      get bots() { return bots; },
      bot: (id) => bots.find((bot) => bot.id === id) ?? null,
      botByThread: (threadId) => bots.find((bot) => bot.threadId === threadId) ?? (threadId.startsWith(`${SCOUT}-`) ? { id: SCOUT } : threadId.startsWith("other-") ? { id: OTHER } : null),
      groupByThread: (threadId) => (threadId === "room-1" ? { id: "room" } : null),
    },
    routines: () => ({ listRoutines: () => routines as never, update: (id: string, patch: { enabled?: boolean }) => { const found = routines.find((routine) => routine.id === id)!; Object.assign(found, patch); return found as never; } }),
    library: () => ({ "team-writing": {} }),
    starters: { get: (threadId) => starters.get(threadId), set: (threadId, person) => { if (person && !starters.has(threadId)) starters.set(threadId, person); } },
    ...over,
  };
  return { moveIn: createTeamMoveIn(deps), issued, revoked, starters, routines, bots };
}

const session = (extra: Partial<SessionRecord> = {}): RequestAuth => ({ kind: "session", via: "bearer", scopes: ["client"], session: { ...ada, tokenHash: "", label: "", scopes: ["client"], createdAt: 0, lastSeenAt: 0, expiresAt: 0, ...extra } as SessionRecord });
const moveInSession = (bot = SCOUT) => session({ moveIn: bot, scopes: ["admin", "client"] });

async function call(route: (ctx: RouteContext) => Promise<unknown>, method: string, path: string, auth: RequestAuth, body?: unknown) {
  let answer: { status: number; body: any } | null = null;
  const ctx = {
    req: { resume() {} } as never, res: {} as never, url: url(path), path: url(path).pathname, method, auth,
    json: (_res: unknown, status: number, sent: unknown) => { answer = { status, body: sent }; },
    readBody: async () => body,
  } as unknown as RouteContext;
  const out = await route(ctx);
  return { out, answer: answer as { status: number; body: any } | null, body: await ctx.readBody(ctx.req) };
}

describe("a move-in's sign-in", () => {
  it("reaches only its own bot's move routes, and files only in its own bot's folders", () => {
    const own = { moveIn: SCOUT };
    for (const [method, path] of [["GET", "/api/cloud-send"], ["GET", "/api/cloud-send/manifest"], ["PUT", "/api/cloud-send/kind"], ["POST", "/api/cloud-send/chats"],
      ["POST", "/api/cloud-send/chats/verify"], ["POST", "/api/bots"], ["PATCH", `/api/bots/${SCOUT}`], ["POST", `/api/bots/${SCOUT}/skill-template`],
      ["DELETE", `/api/bots/${SCOUT}/skills/trip-plan`], ["POST", `/api/team-move-in/${SCOUT}/done`], ["POST", "/api/attachments"]] as const) {
      expect(moveInRefusal(own, method, path, url(path)), `${method} ${path}`).toBeNull();
    }
    for (const [method, path] of [["GET", "/api/bots"], ["PATCH", `/api/bots/${OTHER}`], ["POST", `/api/bots/${OTHER}/skill-template`], ["GET", "/api/logins"],
      ["GET", "/api/config"], ["POST", `/api/team-move-in/${OTHER}/done`], ["POST", "/api/team-move-in"], ["GET", "/api/cloud-send/kind"], ["POST", "/api/cloud-send/memory"],
      ["GET", "/api/threads/x/messages"], ["DELETE", `/api/bots/${SCOUT}`]] as const) {
      expect(moveInRefusal(own, method, path, url(path)), `${method} ${path}`).toBe("This sign-in only moves one bot in.");
    }
    expect(moveInRefusal(own, "POST", "/api/cloud-send/files", url(`/api/cloud-send/files?path=workspaces/${SCOUT}/a.md`))).toBeNull();
    expect(moveInRefusal(own, "POST", "/api/cloud-send/files", url(`/api/cloud-send/files?path=task-workspaces/${SCOUT}/t1/a.md`))).toBeNull();
    expect(moveInRefusal(own, "POST", "/api/cloud-send/files", url(`/api/cloud-send/files?path=workspaces/${OTHER}/a.md`))).not.toBeNull();
    expect(moveInRefusal(own, "POST", "/api/cloud-send/files", url(`/api/cloud-send/files?path=workspaces/${SCOUT}--member-p_x/a.md`))).not.toBeNull();
    expect(moveInRefusal(own, "GET", "/api/cloud-send/files", url(`/api/cloud-send/files?path=workspaces/${SCOUT}/a.md`))).not.toBeNull();
    expect(moveInRefusal({}, "GET", "/api/logins", url("/api/logins")), "any other sign-in is not narrowed here").toBeNull();
    expect(moveInBot(moveInSession())).toBe(SCOUT);
    expect(moveInBot(session())).toBeNull();
  });
});

describe("beginning a move-in", () => {
  it("any person in the team may move a bot of their own in, under its name, or \"Scout (Ada)\" beside one of that name", async () => {
    const { moveIn, issued } = setup();
    const begun = await call(moveIn.routes, "POST", "/api/team-move-in", session(), { v: 1, bot: { id: SCOUT, name: "Scout", threadId: "my-main" }, label: "Ada" });
    expect(begun.answer).toEqual({ status: 200, body: { v: 1, token: `omb_sess_${SCOUT}`, name: "Scout (Ada)" } });
    expect(issued).toEqual([{ label: "Move to Acme", email: ada.email, teamRole: "member", bot: SCOUT }]);
    expect(moveIn.list()[SCOUT]).toMatchObject({ person: adaKey, who: "Ada", name: "Scout (Ada)", threadId: "my-main", state: "moving" });
    // Again (a resumed move): the same name, a fresh sign-in.
    expect((await call(moveIn.routes, "POST", "/api/team-move-in", session(), { v: 1, bot: { id: SCOUT, name: "Renamed" } })).answer?.body.name).toBe("Scout (Ada)");
    const plain = setup();
    expect((await call(plain.moveIn.routes, "POST", "/api/team-move-in", session(), { v: 1, bot: { id: "fresh-0003", name: "Quill" } })).answer?.body.name).toBe("Quill");
  });

  it("refuses a bot the team already has, one someone else is moving, a sign-in that is not a member's own, and says done once it arrived", async () => {
    const { moveIn } = setup();
    expect((await call(moveIn.routes, "POST", "/api/team-move-in", session(), { v: 1, bot: { id: OTHER, name: "Inbox" } })).answer).toEqual({ status: 409, body: { error: "Acme already has this bot." } });
    await call(moveIn.routes, "POST", "/api/team-move-in", session(), { v: 1, bot: { id: SCOUT, name: "Scout" } });
    const cleo = session({ email: "cleo@acme.test" });
    expect((await call(moveIn.routes, "POST", "/api/team-move-in", cleo, { v: 1, bot: { id: SCOUT, name: "Scout" } })).answer).toEqual({ status: 409, body: { error: "Someone else is moving this bot into Acme." } });
    expect((await call(moveIn.routes, "POST", "/api/team-move-in", moveInSession(), { v: 1, bot: { id: "x-00000001", name: "X" } })).answer?.status).toBe(403);
    expect((await call(moveIn.routes, "POST", "/api/team-move-in", session({ membershipAuthority: undefined }), { v: 1, bot: { id: "x-00000001", name: "X" } })).answer?.status).toBe(403);
    expect((await call(moveIn.routes, "POST", "/api/team-move-in", { kind: "loopback", scopes: ["admin", "client"] }, { v: 1, bot: { id: "x-00000001", name: "X" } })).answer?.status).toBe(403);
    await call(moveIn.routes, "POST", `/api/team-move-in/${SCOUT}/done`, moveInSession(), { v: 1, on: [] });
    expect((await call(moveIn.routes, "POST", "/api/team-move-in", session(), { v: 1, bot: { id: SCOUT, name: "Scout" } })).answer).toEqual({ status: 200, body: { v: 1, done: true, name: "Scout (ada)" } });
  });
});

describe("what a move-in may write", () => {
  async function moving() {
    const made = setup();
    await call(made.moveIn.routes, "POST", "/api/team-move-in", session(), { v: 1, bot: { id: SCOUT, name: "Scout", threadId: "my-main" }, label: "Ada" });
    made.bots.push({ id: SCOUT, name: "Scout (Ada)", threadId: `${SCOUT}-teammain` });
    return made;
  }

  it("makes only its own bot, with a main chat of the team's and the name the team gave it", async () => {
    const { moveIn } = await moving();
    const own = await call(moveIn.guard, "POST", "/api/bots", moveInSession(), { id: SCOUT, threadId: "my-main", name: "Scout", useDefaults: false });
    expect([own.out, own.body]).toEqual([PASS, { id: SCOUT, name: "Scout (Ada)", useDefaults: false }]);
    expect((await call(moveIn.guard, "POST", "/api/bots", moveInSession(), { id: OTHER, name: "Copy" })).answer?.status).toBe(403);
  });

  const ADMINS_SET = {
    approvalMode: "full", autoApprove: true, alwaysAllow: ["Bash(*)"], chiefOfStaff: true, managedSections: ["Ops"], computer: "local", cwd: "/",
    cloudBackend: "vps", peers: [OTHER], approvePeerComms: false, composio: true, browser: true, browserProfile: "guest", mcpServers: ["github"],
    toolScope: { allow: ["native:*"] }, connectorTools: {}, connectorScopes: {}, outbound: {}, xResearch: true, phoneApps: [], section: "Finance",
    visibility: { audience: "members" }, recordBrowserSteps: true, cacheKeepWarm: true,
  };

  it("leaves what the bot may do, and being a Chief of Staff, to the team's admins", async () => {
    const { moveIn } = await moving();
    const patched = await call(moveIn.guard, "PATCH", `/api/bots/${SCOUT}`, moveInSession(), { soul: "Plans trips.", color: "teal", ...ADMINS_SET, name: "Scout" });
    expect(patched.body).toEqual({ soul: "Plans trips.", color: "teal", name: "Scout (Ada)" });
    const fields = await call(moveIn.guard, "PUT", "/api/cloud-send/kind", moveInSession(), { v: 1, key: `bot:${SCOUT}`, dataDir: "/d",
      record: { chiefOfStaff: true, managedSections: ["Ops"], defaultBot: {}, installedPackage: { installId: "acme-ops" }, pinned: true, projects: [] } });
    expect(fields.body).toEqual({ v: 1, key: `bot:${SCOUT}`, dataDir: "/d", record: { pinned: true, projects: [] } });
  });

  it("makes its bot with who it is and how it looks only: never an admin's setting, the team's defaults, a preset, or reporting to anyone but the mover", async () => {
    const { moveIn } = await moving();
    const model = { instanceId: "claude", model: "claude-sonnet-5" };
    const made = await call(moveIn.guard, "POST", "/api/bots", moveInSession(), {
      id: SCOUT, name: "Scout", useDefaults: true, modelSelection: model, requireAvailableModel: true, title: "Trips",
      preset: "ops-chief", reportsTo: "olive@acme.test", acknowledgeLocalAuto: true, acknowledgePeerScope: true, section: "Finance", visibility: { audience: "members" },
      settings: { soul: "Plans trips.", color: "teal", ...ADMINS_SET },
    });
    expect(made.out).toBe(PASS);
    expect(made.body).toEqual({ id: SCOUT, name: "Scout (Ada)", useDefaults: false, modelSelection: model, requireAvailableModel: true, title: "Trips",
      settings: { soul: "Plans trips.", color: "teal" } });
    const own = await call(moveIn.guard, "POST", "/api/bots", moveInSession(), { id: SCOUT, name: "Scout", reportsTo: "Ada@acme.test" });
    expect(own.body).toEqual({ id: SCOUT, name: "Scout (Ada)", useDefaults: false, reportsTo: "Ada@acme.test" });
  });

  it("takes its own routines only, reporting into the mover's conversation, and a library skill only when the team lacks it", async () => {
    const { moveIn, starters } = await moving();
    const put = (key: string, record: Record<string, unknown>) => call(moveIn.guard, "PUT", "/api/cloud-send/kind", moveInSession(), { v: 1, key, dataDir: "/d", record });
    expect((await put("routine:r-new", { id: "r-new", botId: SCOUT, target: "bot" })).body).toMatchObject({ record: { resultsThreadId: "my-main" } });
    starters.set(`${SCOUT}-results`, adaKey);
    expect((await put("routine:r-new", { id: "r-new", botId: SCOUT, target: "bot", resultsThreadId: `${SCOUT}-results` })).body).toMatchObject({ record: { resultsThreadId: `${SCOUT}-results` } });
    expect((await put("routine:r-new", { id: "r-new", botId: SCOUT, target: "bot", resultsThreadId: "other-main" })).body, "never another bot's conversation").toMatchObject({ record: { resultsThreadId: "my-main" } });
    expect((await put("routine:r-other", { id: "r-other", botId: SCOUT, target: "bot" })).answer?.status, "another bot's routine id").toBe(403);
    expect((await put("routine:r-new", { id: "r-new", botId: OTHER, target: "bot" })).answer?.status).toBe(403);
    expect((await put("routine:r-new", { id: "r-new", botId: SCOUT, target: "room-goal" })).answer?.status).toBe(403);
    expect((await put("call:c1", { id: "c1", botIds: [SCOUT] })).answer?.status).toBe(403);
    expect((await put("webhook:w1", { id: "w1", botId: SCOUT })).answer?.status).toBe(403);
    expect((await put("library-skill:trip-plan", { text: "x" })).out).toBe(PASS);
    expect((await put("library-skill:team-writing", { text: "x" })).answer?.status, "never over the team's own").toBe(403);
    expect((await put("imported-skill:mine", {})).answer?.status).toBe(403);
  });

  it("brings its conversations as the mover's own, never the team's main chat, a room's or another person's, with the owner's lines as the mover's", async () => {
    const { moveIn, starters } = await moving();
    const owner = "p_mycloudownerkeyxxxxxxx";
    const sent = await call(moveIn.guard, "POST", "/api/cloud-send/chats", moveInSession(), { v: 1, dataDir: "/d", owner, conversations: [
      { bot: SCOUT, threadId: "my-main", task: null, rows: [{ id: "m1", at: 5, role: "user", text: "hi", sender: { id: owner, name: "Ada M" } }, { id: "m2", at: 6, role: "user", text: "guest", sender: { id: "p_someoneelsexxxxxxxxxx", name: "Guest" } }], leaf: null, sent: false },
      { bot: SCOUT, threadId: "my-task", task: { threadId: "my-task", createdAt: 1, title: "Budget" }, rows: [], leaf: null, sent: false },
    ] });
    expect(sent.out).toBe(PASS);
    expect(sent.body.owner).toBeUndefined();
    expect(sent.body.conversations[0].task).toEqual({ threadId: "my-main", title: "Scout (Ada)", createdAt: 5 });
    expect(sent.body.conversations[0].rows.map((row: { sender: unknown }) => row.sender)).toEqual([{ id: adaKey, name: "Ada" }, { id: "p_someoneelsexxxxxxxxxx", name: "Guest" }]);
    expect(sent.body.conversations[1].task.title).toBe("Budget");
    expect([starters.get("my-main"), starters.get("my-task")]).toEqual([adaKey, adaKey]);
    const refused = (conversation: Record<string, unknown>) => call(moveIn.guard, "POST", "/api/cloud-send/chats", moveInSession(), { v: 1, dataDir: "/d", conversations: [{ task: null, rows: [], leaf: null, sent: false, ...conversation }] });
    expect((await refused({ bot: OTHER, threadId: "x1" })).answer?.status).toBe(403);
    expect((await refused({ room: "room", threadId: "room-1" })).answer?.status).toBe(403);
    expect((await refused({ bot: SCOUT, threadId: `${SCOUT}-teammain` })).answer?.status, "the team's main chat").toBe(403);
    expect((await refused({ bot: SCOUT, threadId: `${SCOUT}-cleos` })).answer?.status, "Cleo opened it with the half-moved bot").toBe(403);
    expect((await refused({ bot: SCOUT, threadId: "room-1" })).answer?.status).toBe(403);
    const verify = await call(moveIn.guard, "POST", "/api/cloud-send/chats/verify", moveInSession(), { v: 1, conversations: [{ threadId: "other-main", ids: [] }] });
    expect(verify.answer?.status).toBe(403);
  });

  it("switches on its own routines at the end, ends every sign-in that moved it, and takes nothing after", async () => {
    const { moveIn, routines, revoked } = await moving();
    routines.push({ id: "r-new", botId: SCOUT, enabled: false, target: "bot" });
    const done = await call(moveIn.routes, "POST", `/api/team-move-in/${SCOUT}/done`, moveInSession(), { v: 1, on: ["routine:r-new", "routine:r-other", "webhook:w1"] });
    expect(done.answer).toEqual({ status: 200, body: { v: 1, switched: 1 } });
    expect(routines.map((routine) => [routine.id, routine.enabled])).toEqual([["r-scout", false], ["r-other", false], ["r-new", true]]);
    expect(revoked).toEqual([SCOUT]);
    expect(moveIn.list()[SCOUT]?.state).toBe("done");
    expect((await call(moveIn.guard, "PATCH", `/api/bots/${SCOUT}`, moveInSession(), { soul: "late" })).answer?.status).toBe(403);
    expect(moveIn.owner(moveInSession())).toBeNull();
    expect(moveIn.scope(moveInSession())).toBeNull();
    expect((await call(moveIn.routes, "POST", `/api/team-move-in/${OTHER}/done`, moveInSession(), { v: 1, on: [] })).answer?.status).toBe(403);
  });

  it("names the mover as the lines and routines that arrive name them, and keeps reads to its bot", async () => {
    const { moveIn } = await moving();
    expect(moveIn.owner(moveInSession())).toEqual({ person: adaKey, name: "Ada" });
    expect(moveIn.scope(moveInSession())).toBe(SCOUT);
    expect(moveIn.owner(session())).toBeNull();
    expect(moveIn.owner(moveInSession(OTHER)), "a sign-in for a bot with no move-in").toBeNull();
    expect(moveIn.owner(session({ moveIn: SCOUT, email: "cleo@acme.test" })), "a sign-in for this bot but another person").toBeNull();
  });
});
