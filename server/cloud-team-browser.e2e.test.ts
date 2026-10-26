// A real Team Cloud (OMB_CLOUD_ROLE=team) for the two things one member must never get from another: their browser and
// their phone's view. Each member's private chat with a team bot drives a browser of its own, a group chat its own, and a
// live view shows the browser of the conversation it is opened from, to whoever may read that conversation. A member's
// phone pairs with a code the member made, and gets their role and their chats. The engine is the synthetic Claude CLI.
// The sign-in part needs a real browser (agent-browser and its Chrome, on Linux): it runs where one resolves or
// OMB_TEAM_BROWSER_E2E=1 asks for it, and says why it is skipped otherwise.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { resolveAgentBrowserBinary } from "./browser-engine.ts";
import { audienceBrowserSuffix } from "./browser/audience.ts";
import { TEAM_SESSION_MAX_MS } from "./cloud-team.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ben@acme.test", role: "admin" as const };
const MEMBER_A = { email: "ada@acme.test", role: "member" as const };
const MEMBER_C = { email: "cleo@acme.test", role: "member" as const };
const ENGINE = `import { readFileSync as readToolCalls } from "node:fs";
try { process.env.FAKE_CLAUDE_TOOL_CALLS = readToolCalls(process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json", "utf8"); } catch {}`;
const REAL_BROWSER = process.env.OMB_TEAM_BROWSER_E2E === "1" || (process.platform === "linux" && Boolean(resolveAgentBrowserBinary({ env: process.env })));
if (!REAL_BROWSER) console.log("skipping the Team Cloud sign-in check: it needs agent-browser and its Chrome on Linux (or OMB_TEAM_BROWSER_E2E=1)");

/** Without a real browser, an agent-browser stand-in that logs each command with the session it is for, so the browser
 * each turn and each view reaches is visible by name. */
const stub = REAL_BROWSER ? null : (() => {
  const dir = mkdtempSync(join(tmpdir(), "omb-team-browser-stub-"));
  const engine = join(dir, "agent-browser"), log = join(dir, "commands.log");
  writeFileSync(engine, ["#!/bin/sh", `printf '%s %s\\n' "$AGENT_BROWSER_SESSION" "$1" >> '${log}'`,
    `if [ "$1" = session ]; then printf '{"success":true,"data":{"sessions":[]}}\\n'; fi`, "exit 0"].join("\n"), { mode: 0o755 });
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter(Boolean);
  return { dir, engine, lines, sessions: () => lines().map((line) => line.split(" ")[0]!).filter(Boolean) };
})();

let fx: CloudSendFixture, team: CloudTeamFixture;
let owner = "", admin = "", ada = "", cleo = "";
let bot: { id: string; mainThreadId: string };
let adaThread = "", cleoThread = "", roomId = "", roomThread = "";

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme", engine: ENGINE, ...(stub ? { env: { OMB_AGENT_BROWSER_PATH: stub.engine } } : {}) } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  ada = (await team.pair(MEMBER_A)).token!;
  cleo = (await team.pair(MEMBER_C)).token!;
  const created = await team.as(owner, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  bot = created.body.bot;
  const opened = async (token: string, title: string) => {
    const task = await team.as(token, "POST", `/api/bots/${bot.id}/tasks`, { title });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    return task.body.task.threadId as string;
  };
  adaThread = await opened(ada, "Ada and Scout");
  cleoThread = await opened(cleo, "Cleo and Scout");
  const room = await team.as(owner, "POST", "/api/groups", { name: "Launch", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
  expect(room.status, JSON.stringify(room.body)).toBe(201);
  roomId = room.body.group.id; roomThread = room.body.group.threadId;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
  if (stub) rmSync(stub.dir, { recursive: true, force: true });
});

/** The live view's first answer: a refusal names its reason; an open view (a real browser) is cut off after its headers. */
async function liveView(token: string, threadId?: string): Promise<{ status: number; error?: string }> {
  const abort = new AbortController();
  const response = await fetch(`${team.base}/api/bots/${bot.id}/browser/live${threadId ? `?threadId=${threadId}` : ""}`, { headers: { ...fx.edge, authorization: `Bearer ${token}` }, signal: abort.signal });
  if (response.headers.get("content-type")?.includes("event-stream")) { abort.abort(); return { status: response.status }; }
  return { status: response.status, error: ((await response.json().catch(() => ({}))) as { error?: string }).error };
}

it("shows a member's live browser only from her own chat, to her alone: never to another member or an admin", async () => {
  expect(await liveView(cleo, adaThread), "Cleo opening the browser of Ada's private chat").toEqual({ status: 404, error: "no such conversation" });
  expect(await liveView(ada, cleoThread), "Ada opening the browser of Cleo's private chat").toEqual({ status: 404, error: "no such conversation" });
  expect(await liveView(admin, adaThread), "Ben (Admin) opening the browser of Ada's private chat").toEqual({ status: 404, error: "no such conversation" });
  expect(await liveView(owner, adaThread), "the Owner opening the browser of Ada's private chat").toEqual({ status: 404, error: "no such conversation" });
  expect(await liveView(ada, "not-a-conversation")).toEqual({ status: 404, error: "no such conversation" });
  for (const [who, token, threadId] of [["Ada, her own chat", ada, adaThread], ["Ben (Admin), the group chat", admin, roomThread], ["Cleo, the group chat", cleo, roomThread], ["Ada, no chat named", ada, undefined]] as const) {
    expect((await liveView(token, threadId)).error, who).not.toBe("no such conversation");
  }
  // Signed-in sites are an admin's, of the team's browser and the group chats', never of a member's own.
  expect((await team.as(ada, "GET", `/api/browser-sites?bot=${bot.id}&threadId=${adaThread}`)).status).toBe(403);
  expect((await team.as(admin, "GET", `/api/browser-sites?bot=${bot.id}&threadId=${adaThread}`)).status).toBe(404);
  expect((await team.as(admin, "GET", `/api/browser-sites?bot=${bot.id}&threadId=${roomThread}`)).status).not.toBe(404);
}, hostTimeout(60_000));

// The agent-browser stand-in is a POSIX shell script, which Windows cannot run as a program, so no command reaches its
// log there; a Team Cloud is a Linux machine. The other checks in this file still run on Windows.
it.skipIf(!stub || process.platform === "win32")("drives each member's private chat, the group chat and the team's chat on browsers of their own, and opens a view on the conversation's", async () => {
  const session = (audience: string) => `bot-${bot.id}${audience === "team" ? "" : audienceBrowserSuffix(audience as `member:${string}`)}`;
  const ADA = session(`member:${personKey({ id: "", email: MEMBER_A.email })}`), CLEO = session(`member:${personKey({ id: "", email: MEMBER_C.email })}`);
  const ROOM = session(`room:${roomId}`), TEAM = session("team");
  const quietTurn = async (token: string, threadId: string, text: string, room?: string) => browserTurn(token, threadId, text, [], room);
  await quietTurn(ada, adaThread, "Hello from Ada.");
  expect(stub!.sessions(), "Ada's private turn prepared her own browser").toContain(ADA);
  expect(stub!.sessions()).not.toContain(CLEO);
  await quietTurn(cleo, cleoThread, "Hello from Cleo.");
  await quietTurn(admin, roomThread, "Hello, group.", roomId);
  await quietTurn(owner, bot.mainThreadId, "Hello, team.");
  expect(new Set(stub!.sessions().filter((name) => name.startsWith("bot-"))), "one browser per audience, the team's being the bot's own").toEqual(new Set([ADA, CLEO, ROOM, TEAM]));
  // A view opens the browser of the conversation it is opened from, for whoever may read it.
  const before = stub!.sessions().length;
  for (const [token, threadId] of [[admin, cleoThread], [cleo, cleoThread], [ada, undefined]] as const) await liveView(token, threadId);
  const viewed = stub!.sessions().slice(before).filter((name) => name.startsWith("bot-"));
  expect([...new Set(viewed)], "Ben's view of Cleo's chat reached nothing; Cleo's reached her browser; Ada's own view, hers").toEqual([CLEO, ADA]);
  // A tool call from Ada's turn goes through the harness to her own browser, the one her turn was given.
  const mark = stub!.lines().length;
  const called = await browserTurn(ada, adaThread, "Which tabs are open?", [{ server: "browser", name: "agent_browser_tab_list", input: {} }]);
  expect(stub!.lines().slice(mark), "the tool call ran in Ada's own browser").toContain(`${ADA} mcp`);
  expect(called).toContain("agent_browser_tab_list");
}, hostTimeout(240_000));

it("pairs a member's phone with a code she made: her address and role, her chats, an end no later than her desktop's", async () => {
  const made = await team.as(ada, "POST", "/api/team/phone-pairing", {});
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  expect(made.body).toMatchObject({ serverName: "Acme", team: { id: "team-acme-1", name: "Acme", role: "member" } });
  expect(made.body.url).toMatch(/^https:\/\/[^/]+\/pair#code=[A-Z0-9-]{14}$/);
  // The phone scans the link and redeems the code here, as the phone apps do (Session.pair / redeemPairing).
  const redeemed = await fetch(`${team.base}/api/auth/pair`, { method: "POST", headers: { ...fx.edge, "content-type": "application/json" }, body: JSON.stringify({ code: made.body.code, label: "Ada's phone", attemptId: "phone-attempt-1" }) });
  expect(redeemed.status).toBe(200);
  const answer = await redeemed.json() as { token: string; environment: { label: string } };
  expect(answer.environment.label, "the name the phone shows for the place").toBe("Acme");
  const phone = answer.token;
  const phoneSession = (await team.as(phone, "GET", "/api/auth/session")).body;
  const desktopSession = (await team.as(ada, "GET", "/api/auth/session")).body;
  expect(phoneSession).toMatchObject({ kind: "session", scopes: ["client"], email: MEMBER_A.email, team: { id: "team-acme-1", role: "member" } });
  expect(phoneSession.expiresAt, "the phone never outlives the Admin's last check of Ada").toBeLessThanOrEqual(desktopSession.expiresAt);
  expect(phoneSession.expiresAt - Date.now()).toBeLessThanOrEqual(TEAM_SESSION_MAX_MS);
  // Her phone reads her chats and the team's, never Cleo's private one, nor its browser.
  const messages = (token: string, threadId: string) => team.as(token, "GET", `/api/threads/${threadId}/messages?limit=20`);
  expect((await messages(phone, adaThread)).status).toBe(200);
  expect((await messages(phone, roomThread)).status).toBe(200);
  expect((await messages(phone, cleoThread)).status, "Ada's phone opening Cleo's private chat").toBe(404);
  expect(await liveView(phone, cleoThread)).toEqual({ status: 404, error: "no such conversation" });
  const listed = ((await team.as(phone, "GET", "/api/bots")).body.bots as Array<{ id: string; tasks: Array<{ threadId: string }> }>).find((entry) => entry.id === bot.id)!.tasks.map((task) => task.threadId);
  expect(listed).toContain(adaThread);
  expect(listed).not.toContain(cleoThread);
  // A member makes nothing wider: the admins' pairing route stays theirs.
  expect((await team.as(phone, "POST", "/api/bots", { name: "Nope" })).status).toBe(403);
  expect((await team.as(ada, "POST", "/api/auth/pairing", {})).status).toBe(403);
  // An admin's code, from either route, carries the admin too.
  const bens = await team.as(admin, "POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
  expect(bens.status).toBe(200);
  const benPhone = (await (await fetch(`${team.base}/api/auth/pair`, { method: "POST", headers: { ...fx.edge, "content-type": "application/json" }, body: JSON.stringify({ code: bens.body.code }) })).json() as { token: string }).token;
  expect((await team.as(benPhone, "GET", "/api/auth/session")).body).toMatchObject({ scopes: ["admin", "client"], email: ADMIN.email, team: { role: "admin" } });
  expect((await messages(benPhone, cleoThread)).status, "an admin's phone never reads a member's private chat, as the admin never does").toBe(404);
  // My Cloud is one person's: no member code there.
  expect((await fx.onCloud("POST", "/api/team/phone-pairing", {})).status).not.toBe(200);
}, hostTimeout(60_000));

const scriptToolCalls = (calls: unknown[] | null) => {
  const file = join(team.home, "tool-calls.json");
  if (calls) writeFileSync(file, JSON.stringify(calls)); else rmSync(file, { force: true });
};
const COOKIE_SITE = "https://example.com/";
const readCookies = [
  { server: "browser", name: "agent_browser_open", input: { url: COOKIE_SITE } },
  { server: "browser", name: "agent_browser_eval", input: { script: "'cookies:' + document.cookie" } },
];
async function browserTurn(token: string, threadId: string, text: string, calls: unknown[], room?: string): Promise<string> {
  scriptToolCalls(calls);
  const read = () => team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`);
  const before = ((await read()).body.messages as unknown[]).length;
  const sent = room ? await team.as(token, "POST", `/api/groups/${room}/messages`, { text: `@Scout ${text}` }) : await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  let after: unknown[] = [];
  await expect.poll(async () => {
    after = (await read()).body.messages as unknown[];
    const idle = ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ id: string; busy?: boolean; activity?: string }>).every((entry) => !entry.busy && entry.activity !== "working");
    return idle && after.length >= before + 2;
  }, { timeout: 120_000, interval: 250 }).toBe(true);
  return JSON.stringify(after.slice(before));
}

it.skipIf(!REAL_BROWSER)("keeps one member's sign-in out of another member's chat and the group chat, and back in her own", async () => {
  const signIn = [readCookies[0], { server: "browser", name: "agent_browser_eval", input: { script: "document.cookie = 'omb_member=ada; max-age=86400; path=/'; 'cookies:' + document.cookie" } }];
  expect(await browserTurn(ada, adaThread, "Sign in to the test site.", signIn)).toContain("omb_member=ada");
  const cleoSees = await browserTurn(cleo, cleoThread, "What does the test site show you?", readCookies);
  expect(cleoSees, "Cleo's private turn reached the site").toContain("cookies:");
  expect(cleoSees, "Cleo's private turn saw Ada's sign-in").not.toContain("omb_member=ada");
  const roomSees = await browserTurn(admin, roomThread, "What does the test site show the group?", readCookies, roomId);
  expect(roomSees).toContain("cookies:");
  expect(roomSees, "the group chat's turn saw Ada's private sign-in").not.toContain("omb_member=ada");
  expect(await browserTurn(ada, adaThread, "Are you still signed in?", readCookies), "Ada's own browser kept her sign-in").toContain("omb_member=ada");
  // Each browser has its own profile on disk, and the team's own is not one of them.
  const kept = JSON.parse(readFileSync(join(team.home, ".openmausbot", "browser", "audiences.json"), "utf8")) as { suffixes: string[] };
  expect(kept.suffixes).toEqual(expect.arrayContaining([audienceBrowserSuffix(`room:${roomId}`)]));
  expect(kept.suffixes.filter((suffix) => suffix.startsWith("--member-"))).toHaveLength(2);
  scriptToolCalls(null);
}, hostTimeout(600_000));
