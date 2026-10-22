// The one-time move to the person's own Cloud, end to end: this computer's server and a Cloud home
// (scripts/testing/cloud-send-fixture.ts) with main's own wiring between them, the move run and checked as main runs and
// checks it, the connected-apps service with a fake Composio behind it, a fake sign-in server for an MCP server's own
// account and a fake HighLevel. Disposable homes; no network.
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createComputerSharing } from "../electron/computer-sharing.mjs";
import { itemKey } from "../electron/cloud-send-parts.mjs";
import { launchCloudSendFixture, type CloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";
import { FAKE_LOCATION_ID, startFakeHighLevel, startFakeRelay, type FakeHighLevel, type FakeRelay } from "./testing/fake-highlevel.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

// Obvious fakes only.
const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const TOKEN = `ops_fake-move-${hex(12)}`;
const PASSWORD = `fake-move-Passw0rd-${hex(6)}`;
const DODO_KEY = `dodo_test_fake_${hex(12)}`;
const DOCS_TOKEN = `fake-docs-token-${hex(8)}`;
const CLIENT_SECRET = `fake-client-secret-${hex(8)}`;
const OPENROUTER_KEY = `sk-or-v1-fake${hex(16)}`;
const PIT = `pit-fake-move-${hex(8)}`;
const ACCESS = `fake-access-${hex(8)}`, REFRESH = `fake-refresh-${hex(8)}`;
const SECRETS = [TOKEN, PASSWORD, DODO_KEY, DOCS_TOKEN, CLIENT_SECRET, OPENROUTER_KEY, PIT, ACCESS, REFRESH];
const LINEAR_URL = "https://mcp.linear.example.test/mcp";

let broker: BrokerFake;
let hl: FakeHighLevel;
let relay: FakeRelay;
let fx: CloudSendFixture;
let signIns: Server;
let tokenEndpoint = "";
let scratch = "";
/** While it is missing, a turn on My Cloud waits; a test removes it to hold one there. */
let release = "";
const proxies: ChildProcess[] = [];

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "omb-cloud-move-"));
  release = join(scratch, "release");
  mkdirSync(join(scratch, "turns"));
  writeFileSync(release, "");
  broker = await startBrokerFake();
  hl = await startFakeHighLevel();
  relay = await startFakeRelay({ onAccessToken: (token) => hl.tokens.add(token) });
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, broker, toolCalls: 36, env: { OMB_HIGHLEVEL_RELAY_URL: relay.url, OMB_HIGHLEVEL_API_URL: hl.url },
    cloudEngine: `process.env.FAKE_CLAUDE_MODE = "hang"; process.env.FAKE_CLAUDE_RELEASE = ${JSON.stringify(release)};
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(join(scratch, "turns"))} + "/" + process.pid + ".json"; process.env.FAKE_CLAUDE_TEXT_DUMP = ${JSON.stringify(join(scratch, "one-shot.json"))}; }` });
  signIns = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const form = new URLSearchParams(body);
      const good = form.get("grant_type") === "refresh_token" && form.get("refresh_token") === REFRESH && form.get("client_secret") === CLIENT_SECRET;
      res.writeHead(good ? 200 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify(good ? { access_token: `fake-access-${hex(8)}`, refresh_token: `fake-refresh-${hex(8)}`, expires_in: 3600, token_type: "Bearer" } : { error: "invalid_grant" }));
    });
  });
  await new Promise<void>((resolve) => signIns.listen(0, "127.0.0.1", resolve));
  tokenEndpoint = `http://127.0.0.1:${(signIns.address() as { port: number }).port}/token`;
}, hostTimeout(90_000));
afterAll(async () => {
  for (const proxy of proxies) proxy.kill();
  await fx?.close();
  await broker?.close();
  await relay?.close();
  await hl?.close();
  await new Promise((resolve) => signIns?.close(resolve));
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

type Side = CloudSendFixture["local"];
type Row = { id: string; parentId?: string | null; kind: string; role: string; text?: string; at: number; sender?: { id?: string } };
/** A conversation as a server holds it: every row, paged back with `before` as the chat view pages, and the path from the
 * server's own leaf, which is what its bot reads. */
async function history(side: Side, threadId: string) {
  const rows: Row[] = [];
  let leaf: string | null = null;
  for (let before: string | null = null, more = true; more;) {
    const page: { messages: Row[]; activeLeafId: string | null; hasMore?: boolean } = (await side("GET", `/api/threads/${threadId}/messages?limit=500${before ? `&before=${before}` : ""}`)).body;
    rows.unshift(...page.messages);
    leaf = page.activeLeafId;
    more = page.hasMore === true;
    before = page.messages[0]?.id ?? null;
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const path: string[] = [];
  for (let row = leaf ? byId.get(leaf) : undefined; row; row = row.parentId ? byId.get(row.parentId) : undefined) path.unshift(row.id);
  return { rows, stored: rows.length, leaf, path, summaries: rows.filter((row) => row.kind === "compaction").length };
}
const idle = async (side: Side) => (await side("GET", "/api/bots")).body.bots.every((entry: { activity?: string; busy?: boolean }) => entry.activity !== "working" && !entry.busy);
async function turn(side: Side, bot: { id: string; threadId: string }, text: string) {
  const before = (await history(side, bot.threadId)).stored;
  expect((await side("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
  await expect.poll(async () => await idle(side) && (await history(side, bot.threadId)).stored >= before + 2, { timeout: 60_000, interval: 100 }).toBe(true);
}
const newBot = async (name: string) => (await fx.local("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot as { id: string; threadId: string };

/** Everything arrived, the bots' daily logs too: the check finds nothing missing. */
function everythingArrived(report: Awaited<ReturnType<CloudSendFixture["check"]>>): boolean {
  expect(report.gaps).toEqual({ items: [], parts: [], memory: [], rooms: [], connections: [], conversations: [], files: [], runs: [], journal: [], learned: [], teams: [], settings: [] });
  expect(report.chats.filter((entry) => entry.missing || entry.unstamped || entry.path === "broken")).toEqual([]);
  expect([report.attachments, report.secrets.differs, report.secrets.missing]).toEqual([[], [], []]);
  return report.ok;
}

/** As a Bring in 0.1.117 to 0.1.119 left a computer's chats on My Cloud: its owner's lines there name nobody. My Cloud
 * starts again over its own data with those lines stripped of who wrote them, before anything reads them. */
async function asABringLeftThem(threadIds: string[]) {
  const strip = `import { DatabaseSync } from "node:sqlite"; import { join } from "node:path";
const db = new DatabaseSync(join(process.env.OMB_DATA_DIR, "messages.db"));
const forget = db.prepare("UPDATE messages SET json = json_remove(json, '$.sender') WHERE thread_id = ? AND role = 'user'");
for (const id of ${JSON.stringify(threadIds)}) forget.run(id);
db.close(); delete process.env.NODE_OPTIONS;`;
  await fx.relaunch({ kill: false, cloud: { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(strip).replaceAll("'", "%27")}` } });
}

let archie: { id: string; threadId: string }, cleo: { id: string; threadId: string }, pip: { id: string; threadId: string }, ember: { id: string; threadId: string };
let kai: { id: string; threadId: string };
let room: { id: string; threadId: string };

/** The latest turn on My Cloud of a bot in a conversation, as its engine got it (fake-claude-cli.ts's dump). */
async function turnDump(botId: string, threadId: string, seen: Set<string>) {
  let dump: { systemPrompt?: string; mcpConfig?: { mcpServers?: { agents?: { command: string; args: string[]; env: Record<string, string> } } } } | undefined;
  await expect.poll(() => {
    for (const name of readdirSync(join(scratch, "turns")).filter((entry) => entry.endsWith(".json") && !seen.has(entry))) {
      let found: typeof dump;
      try { found = JSON.parse(readFileSync(join(scratch, "turns", name), "utf8")); } catch { continue; }
      const env = found?.mcpConfig?.mcpServers?.agents?.env;
      if (env?.OMB_BOT_ID === botId && env.OMB_THREAD_ID === threadId) { dump = found; return true; }
    }
    return false;
  }, { timeout: 30_000 }).toBe(true);
  return dump!;
}

it("lines My Cloud already held of this computer's become its owner's when the move names them, at once for what its bots recall", async () => {
  const { local, onCloud } = fx;
  // Kai's and Lux's conversations reached My Cloud before My Cloud kept its owner's lines as theirs, as an older app's send
  // or Bring left them. The move (next) names Kai's; Lux's are named here, over the owner's own session.
  kai = await newBot("Kai");
  await turn(local, kai, "Keep the Acme notes.");
  const lux = await newBot("Lux");
  await turn(local, lux, "Draft the launch memo.");
  // An older app's whole Send everything, which carried the chats too (a send of some items never does).
  const sent = (await fx.olderSend()).result;
  expect(sent.bots.sort()).toEqual(["Kai", "Lux"]);
  expect(sent.chats?.messages, "the chats went with the bots").toBeGreaterThan(0);
  await asABringLeftThem([kai.threadId, lux.threadId]);
  for (const bot of [kai, lux]) {
    const brought = (await history(onCloud, bot.threadId)).rows.filter((row) => row.role === "user");
    expect(brought.map((row) => row.sender?.id ?? null), "the line came over naming nobody").toEqual([null]);
  }

  // What Lux, in a conversation of its own on My Cloud, is told of its recent work elsewhere.
  const latest = (await history(onCloud, lux.threadId)).rows.filter((row) => row.role === "bot" && row.kind === "text" && row.text).sort((a, b) => a.at - b.at).at(-1)!;
  const said = `you said: ${JSON.stringify(latest.text!.replace(/\s+/gu, " ").trim().slice(0, 40)).slice(0, -1)}`;
  const recentWork = async () => {
    const task = (await onCloud("POST", `/api/bots/${lux.id}/tasks`, { title: "Follow-up" })).body.task as { threadId: string };
    const seen = new Set(readdirSync(join(scratch, "turns")));
    expect((await onCloud("POST", `/api/bots/${lux.id}/messages`, { text: "Where are we?", threadId: task.threadId })).status).toBe(202);
    const prompt = (await turnDump(lux.id, task.threadId, seen)).systemPrompt ?? "";
    await expect.poll(() => idle(onCloud), { timeout: 30_000, interval: 100 }).toBe(true);
    return prompt;
  };
  expect(await recentWork()).not.toContain(said);
  const before = await recentWork();
  expect(before, "the first Follow-up is listed").toContain("Your recent work");
  expect(before, "a conversation with a line that names nobody is never recalled on a Cloud home").not.toContain(said);
  const ids = (await history(local, lux.threadId)).rows.map((row) => row.id);
  expect((await onCloud("POST", "/api/cloud-send/chats/owner", { v: 1, conversations: [{ threadId: lux.threadId, ids }] })).body).toEqual({ v: 1, stamped: 1 });
  expect(await recentWork(), "once its lines are the owner's, at once: nothing else in it changed").toContain(said);
}, hostTimeout(180_000));

it("a move carries everything, apps and keys first, and its check finds every row, path, attachment and credential there", async () => {
  const { local, onCloud } = fx;
  // Archie, as the real-app run found it: a long tool-heavy conversation with 22 context summaries along it.
  archie = await newBot("Archie");
  for (let summaries = 0; summaries < 22 || (await history(local, archie.threadId)).stored < 1_599;) {
    await turn(local, archie, `Step ${summaries}: check the next server.`);
    if (summaries >= 22) continue;
    expect((await local("POST", `/api/bots/${archie.id}/compact`, { threadId: archie.threadId })).status).toBe(202);
    await expect.poll(async () => (await history(local, archie.threadId)).summaries, { timeout: 30_000, interval: 100 }).toBe(++summaries);
    await expect.poll(() => idle(local), { timeout: 30_000, interval: 100 }).toBe(true);
  }
  const ro = await newBot("Ro");
  room = (await local("POST", "/api/groups", { name: "Launch", memberIds: [ro.id], setup: { bulletin: "Ship on Friday.", defaultResponder: { kind: "mentions" } } })).body.group;
  for (let i = 0; i < 610; i++) expect((await local("POST", `/api/groups/${room.id}/messages`, { text: `Note ${i} for the launch.`, threadId: room.threadId })).status).toBeLessThan(300);
  cleo = await newBot("Cleo");
  await turn(local, cleo, "Read the report.");
  pip = await newBot("Pip");
  await turn(local, pip, "Plan the trip.");
  ember = await newBot("Ember");
  await local("PATCH", `/api/bots/${ember.id}`, { soul: "You are Ember." });
  expect((await local("PUT", `/api/bots/${ember.id}/memory/file`, { path: "memory/clients.md", text: "Acme pays on the 5th.\n" })).status).toBe(200);
  expect((await local("POST", "/api/logins", { site: "accounts.example.test", username: "alice", password: PASSWORD, totp: "JBSWY3DPEHPK3PXP", bots: [ember.id] })).status).toBe(201);
  expect((await local("POST", "/api/logins/1password", { token: TOKEN })).status).toBe(200);

  // Apps and keys: an MCP server's key and another's header token, a sign-in of its own, an AI key, HighLevel by its token,
  // and the connected-apps account.
  for (const server of [
    { name: "dodo", command: "node", args: ["-e", "process.stdin.resume()"], env: { DODO_PAYMENTS_API_KEY: DODO_KEY } },
    { name: "docs", type: "http", url: "https://mcp.docs.example.test/mcp", headers: { Authorization: `Bearer ${DOCS_TOKEN}` } },
    { name: "linear", type: "http", url: LINEAR_URL, oauth: { clientId: "omb-fixture-client", clientSecret: CLIENT_SECRET } },
  ]) {
    expect((await local("POST", "/api/mcp/servers", server)).status).toBe(201);
    expect((await local("PATCH", `/api/mcp/servers/${server.name}`, { enabled: true })).status).toBe(200);
  }
  const desktopSignIns = join(fx.root, "desktop", ".openmausbot", "mcp-oauth.json");
  writeFileSync(desktopSignIns, JSON.stringify({ servers: { linear: { url: LINEAR_URL, state: "signed-in", clientId: "omb-fixture-client", tokenAuth: "client_secret_post",
    tokenEndpoint, tokens: { access: ACCESS, refresh: REFRESH, expiresAt: Date.now() + 3_600_000 } } } }));
  expect((await local("PATCH", "/api/config", { openrouter: { key: OPENROUTER_KEY } })).status).toBe(200);
  hl.tokens.add(PIT);
  expect((await local("POST", "/api/highlevel/token", { token: PIT, locationId: FAKE_LOCATION_ID })).status).toBe(200);
  const gmail = broker.account(fx.desktopInstallation!.userId, "gmail");

  // The first pass: everything but the sign-in that refreshes itself, which stays here while this computer is home.
  const first = await fx.move();
  expect(first.result.failed).toEqual([]);
  expect(first.result.bots).toEqual(expect.arrayContaining(["Archie", "Ro", "Cleo", "Pip", "Ember"]));
  expect(first.result.connections).toBeGreaterThanOrEqual(5);
  expect(fx.sessions.at(-1)).toEqual({ label: "Move to My Cloud", background: false });
  const linearThere = async () => (await onCloud("GET", "/api/mcp/servers")).body.servers.find((server: { name: string }) => server.name === "linear");
  expect((await linearThere()).auth).not.toBe("signed-in");
  expect(JSON.parse(readFileSync(desktopSignIns, "utf8")).servers.linear).toBeDefined();

  // Cleo goes on on both sides before the final pass.
  await turn(local, cleo, "And the appendix.");
  await turn(onCloud, cleo, "From My Cloud: and the summary.");
  const final = await fx.move({ final: true });
  expect(final.result.failed).toEqual([]);
  expect((await linearThere()).auth).toBe("signed-in");
  expect(JSON.parse(readFileSync(desktopSignIns, "utf8")).servers.linear, "this computer let go of its own copy").toBeUndefined();
  expect(broker.actingUser(broker.installationIds().find((id) => id !== fx.desktopInstallation!.id && broker.actingUser(id) === fx.desktopInstallation!.userId)!))
    .toBe(fx.desktopInstallation!.userId);
  expect((await onCloud("GET", "/api/connectors/connected")).body.services.gmail).toMatchObject({ connected: true, accounts: [expect.objectContaining({ id: gmail })] });

  const report = await fx.check();
  expect(everythingArrived(report)).toBe(true);
  const path = Object.fromEntries(report.chats.map((entry) => [entry.threadId, entry]));
  expect(path[archie.threadId]).toEqual({ threadId: archie.threadId, missing: 0, unstamped: 0, path: "equal" });
  expect(path[room.threadId]).toEqual({ threadId: room.threadId, missing: 0, unstamped: 0, path: "equal" });
  expect(path[cleo.threadId]).toEqual({ threadId: cleo.threadId, missing: 0, unstamped: 0, path: "inside" });
  expect(path[kai.threadId], "the line Kai's conversation came with is its owner's now").toEqual({ threadId: kai.threadId, missing: 0, unstamped: 0, path: "equal" });
  expect(report.attachments).toEqual([]);
  expect(report.secrets.differs).toEqual([]);
  expect(report.secrets.missing).toEqual([]);
  expect(report.secrets.equal).toEqual(expect.arrayContaining([itemKey.login("example.test", "alice"), "1password", "key:openrouter", "mcp:dodo", "mcp:docs", "mcp:linear", "highlevel"]));

  // Read back the way each side's chat view and bot read it.
  const [here, there] = [await history(local, archie.threadId), await history(onCloud, archie.threadId)];
  expect(here.stored).toBeGreaterThanOrEqual(1_599);
  expect([here.summaries, there.summaries]).toEqual([22, 22]);
  expect(there.path).toEqual(here.path);
  expect((await history(onCloud, room.threadId)).path).toEqual((await history(local, room.threadId)).path);
  for (const where of [...fx.answers, fx.logs()]) for (const value of SECRETS) expect(where).not.toContain(value);
}, hostTimeout(900_000));

it("a move run again changes nothing on My Cloud, and its check still finds everything there", async () => {
  const manifest = async () => (await fx.onCloud("GET", "/api/cloud-send/manifest")).body;
  const before = await manifest();
  const again = await fx.move({ final: true });
  expect(again.result).toMatchObject({ bots: [], updatedBots: [], skills: 0, logins: 0, onePassword: false, settings: [], failed: [], chats: { conversations: 0, messages: 0, left: 0 },
    moved: 0, memory: 0, files: { sent: 0, kept: 0 }, conversationSettings: 0 });
  expect(await manifest()).toEqual(before);
  expect(everythingArrived(await fx.check())).toBe(true);
}, hostTimeout(300_000));

/** The latest turn on My Cloud of a bot in a conversation: its agents tools, as the engine got them. */
async function agentsFor(botId: string, threadId: string, seen: Set<string>) {
  const agents = (await turnDump(botId, threadId, seen)).mcpConfig!.mcpServers!.agents!;
  const proxy = spawn(agents.command, agents.args, { env: { PATH: process.env.PATH, HOME: scratch, ...agents.env }, stdio: ["pipe", "pipe", "pipe"] });
  proxies.push(proxy);
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: proxy.stdout! }).on("line", (line) => { const message = JSON.parse(line); replies.get(message.id)?.(message.result); replies.delete(message.id); });
  let next = 0;
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve) => {
    const id = ++next; replies.set(id, resolve);
    proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05" });
  return (name: string, args: unknown = {}) => request("tools/call", { name, arguments: args });
}

it("a moved conversation may use the lent Mac and feeds its bot's memory on My Cloud", async () => {
  const folderPath = realpathSync(mkdtempSync(join(tmpdir(), "omb-moved-lent-")));
  writeFileSync(join(folderPath, "plan.md"), "from the Mac");
  const env = { id: "my-cloud", name: "My Cloud", origin: fx.cloudBase };
  const connector = createComputerSharing({
    file: join(scratch, "desktop-profile", "computer-sharing.json"), environments: () => [env], cuaConnection: async () => null, enabled: async () => false,
    cloud: () => ({ status: "connected", accountId: "acct_fixture", origin: fx.cloudBase }), home: join(scratch, "mac-home"),
    fetch: (url: string, init: RequestInit) => fetch(url, { ...init, headers: { ...init.headers as Record<string, string>, ...fx.edge, authorization: `Bearer ${fx.owner}` } }),
  });
  try {
    const folder = { id: randomUUID(), name: "Plans", path: folderPath, write: false };
    await connector.saveCloud(env, { folders: [folder], screen: false });
    await expect.poll(() => connector.cloudState(env).connected, { timeout: 10_000 }).toBe(true);
    const lent = (await fx.onCloud("GET", "/api/shared-computers")).body.computers;
    expect(lent).toHaveLength(1);

    // Pip's conversation came with the move: its owner goes on there, and the turn may read the lent Mac.
    rmSync(release, { force: true });
    const seen = new Set(readdirSync(join(scratch, "turns")));
    expect((await fx.onCloud("POST", `/api/bots/${pip.id}/messages`, { text: "Read plan.md from my Mac.", threadId: pip.threadId })).status).toBe(202);
    const call = await agentsFor(pip.id, pip.threadId, seen);
    const listing = JSON.parse((await call("list_shared_computers")).content[0].text);
    expect(listing.unavailable).toBeUndefined();
    expect(listing.computers.map((entry: { id: string }) => entry.id)).toEqual([lent[0].id]);
    const read = await call("shared_computer", { computer_id: lent[0].id, folder_id: folder.id, action: "read_file", path: "plan.md" });
    expect(JSON.parse(read.content[0].text).content).toBe("from the Mac");

    // ...and once it ends, it feeds the bot's memory there, as only the owner's own conversations do.
    writeFileSync(release, "");
    const logs = async () => ((await fx.onCloud("GET", `/api/bots/${pip.id}/memory`)).body?.logs ?? []) as Array<{ path: string }>;
    await expect.poll(async () => (await logs()).length, { timeout: 30_000, interval: 250 }).toBeGreaterThan(0);
    const today = (await fx.onCloud("GET", `/api/bots/${pip.id}/memory/file?path=${encodeURIComponent((await logs())[0]!.path)}`)).body.text as string;
    expect(today.trim().length).toBeGreaterThan(0);

    // Kai's conversation, there before My Cloud kept its owner's lines as theirs, may use the lent Mac too.
    rmSync(release, { force: true });
    const seenBefore = new Set(readdirSync(join(scratch, "turns")));
    expect((await fx.onCloud("POST", `/api/bots/${kai.id}/messages`, { text: "Read plan.md from my Mac.", threadId: kai.threadId })).status).toBe(202);
    const kaiCall = await agentsFor(kai.id, kai.threadId, seenBefore);
    const kaiListing = JSON.parse((await kaiCall("list_shared_computers")).content[0].text);
    expect(kaiListing.unavailable).toBeUndefined();
    expect(kaiListing.computers.map((entry: { id: string }) => entry.id)).toEqual([lent[0].id]);
    writeFileSync(release, "");
  } finally {
    connector.close();
    writeFileSync(release, "");
    rmSync(folderPath, { recursive: true, force: true });
  }
}, hostTimeout(180_000));

it("lines the owner wrote on this computer arrive as the same owner as the lines they write on My Cloud", async () => {
  const before = (await history(fx.onCloud, kai.threadId)).rows.filter((row) => row.role === "user").map((row) => row.sender?.id);
  expect(before.length).toBeGreaterThan(0);
  const [here, there] = [await history(fx.local, cleo.threadId), await history(fx.onCloud, cleo.threadId)];
  const typedHere = new Set(here.rows.filter((row) => row.role === "user").map((row) => row.id));
  expect(here.rows.filter((row) => row.role === "user").every((row) => row.sender === undefined), "this computer's own lines name nobody").toBe(true);
  const owners = there.rows.filter((row) => row.role === "user").map((row) => [typedHere.has(row.id), row.sender?.id]);
  expect(owners.filter(([mine]) => mine)).toHaveLength(typedHere.size);
  expect(new Set(owners.map(([, owner]) => owner)), "this computer's lines and My Cloud's own carry one owner").toEqual(new Set([owners[0]![1]]));
  expect(owners[0]![1]).toMatch(/^p_/u);
  expect(new Set(before), "and so do the lines My Cloud held from before").toEqual(new Set([owners[0]![1]]));
});
