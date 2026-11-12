import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { createComputerSharing, type SharedFolder } from "../electron/computer-sharing.mjs";
import { sessionCookieName } from "./request-auth.ts";

let fixture: VerificationServer;
let connector: ReturnType<typeof createComputerSharing>;
let proxy: ChildProcess;
let env: { id: string; origin: string; name: string };
let pairing: any;
let lendingToken = "";
let folder: SharedFolder;
let grantFile: string;
let bot: any;
let localSharingEnabled = true;
let sequence = 0;
const waiting = new Map<number, (value: any) => void>();
const evidence: string[] = [];
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method, headers: { "content-type": "application/json", origin: fixture.info.url, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
};
const rpc = (method: string, params?: unknown): Promise<any> => new Promise((resolve, reject) => {
  const id = ++sequence;
  // A shared terminal operation can legitimately run 30 seconds before its result crosses the connector and MCP boundaries.
  const timeout = setTimeout(() => { waiting.delete(id); reject(new Error(`MCP ${method} ${JSON.stringify(params)} timed out`)); }, 40_000);
  waiting.set(id, value => { clearTimeout(timeout); resolve(value); });
  proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const tool = async (name: string, args: unknown = {}) => (await rpc("tools/call", { name, arguments: args })).result;
const computers = async () => JSON.parse((await tool("list_shared_computers")).content[0].text).computers;
const storedGrant = () => JSON.parse(readFileSync(grantFile, "utf8")).records[env.id];
const operation = async (action: string, rest = {}) => tool("shared_computer", { computer_id: storedGrant().id, folder_id: folder.id, action, ...rest });
const data = (result: any) => JSON.parse(result.content[0].text);
const markedWaitCommand = (marker: string) => process.platform === "win32"
  ? `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', [string]$PID); Start-Sleep -Seconds 20`
  : `echo $$ > '${marker.replaceAll("'", "'\"'\"'")}'; sleep 20`;
const commandAlive = (marker: string) => {
  const pid = Number(readFileSync(marker, "utf8").trim());
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
};

beforeAll(async () => {
  fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  // Computer sharing ships off: turn it on before anything is paired, since routes, capability and agent tools read one gate.
  expect((await api("PATCH", "/api/config", { features: { sharedComputers: true } })).status).toBe(200);
  env = { id: "hosted-fixture", name: "Hosted fixture", origin: fixture.info.url };
  const local = join(fixture.info.dataDir, "shared-folder"); mkdirSync(local);
  folder = { id: randomUUID(), name: "Shared fixture", path: realpathSync(local), write: false };
  writeFileSync(join(local, "brief.txt"), "A real local file. 🌱");
  grantFile = join(fixture.info.dataDir, "desktop-profile", "computer-sharing.json");
  const opened = await api("POST", "/api/auth/pairing", { label: "Desktop fixture", scopes: ["client"] });
  expect(opened.status).toBe(200);
  pairing = (await api("POST", "/api/auth/pair", { code: opened.body.code })).body;
  expect(pairing.token).toMatch(/^omb_sess_/);
  lendingToken = pairing.token;
  connector = createComputerSharing({
    file: grantFile, environments: () => [env], cuaConnection: async () => null,
    enabled: async () => localSharingEnabled,
    fetch: (url: string, init: RequestInit) => fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${lendingToken}` } }),
  });
  bot = (await api("POST", "/api/bots", { name: "Shared desktop tester" })).body.bot;
  proxy = await agentProxyFor(bot.id, pairing.token, "Inspect the folder shared by my desktop; do not use files on the server.");
  createInterface({ input: proxy.stdout! }).on("line", line => { const msg = JSON.parse(line); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); });
  await rpc("initialize", { protocolVersion: "2024-11-05" });
}, 30_000);

/** The fake model hangs, so the turn and its agents capability stay live. */
async function agentProxyFor(botId: string, token: string, text: string): Promise<ChildProcess> {
  return proxyForTurn(async () => {
    expect((await api("POST", `/api/bots/${botId}/messages`, { text }, { authorization: `Bearer ${token}` })).status).toBe(202);
  });
}

function mcpClient(child: ChildProcess) {
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: child.stdout! }).on("line", line => { const msg = JSON.parse(line); replies.get(msg.id)?.(msg); replies.delete(msg.id); });
  let next = 1000;
  const request = (method: string, params: unknown): Promise<any> => new Promise(resolve => {
    const id = ++next; replies.set(id, msg => resolve(msg.result));
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  return { initialize: () => request("initialize", { protocolVersion: "2024-11-05" }), call: (name: string, args: unknown = {}) => request("tools/call", { name, arguments: args }) };
}

async function proxyForTurn(start: () => Promise<void>): Promise<ChildProcess> {
  const dump = join(fixture.info.dataDir, "fake-claude-dump.json");
  rmSync(dump, { force: true });
  await start();
  await vi.waitFor(() => expect(existsSync(dump)).toBe(true), { timeout: 15_000 });
  const agents = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.agents;
  expect(agents.env.OMB_COMMS_TOKEN).toBeTruthy();
  return spawn(agents.command, agents.args, {
    env: { PATH: process.env.PATH, HOME: fixture.info.dataDir, ...agents.env }, stdio: ["pipe", "pipe", "pipe"],
  });
}

afterAll(async () => {
  connector?.close(); proxy?.kill();
  if (fixture) {
    const receipt = `${fixture.info.logPath}.computer-sharing.json`;
    writeFileSync(receipt, JSON.stringify({ fixture: fixture.info, checks: evidence, limitation: "Fake model; real MCP, HTTP pairing and filesystem. OS screen control is tested with a separate transport stand-in, never the user's screen." }, null, 2));
    console.info(`Computer-sharing evidence: ${receipt}`);
    await fixture.close();
  }
});

it("asks only after pairing; Not now remembers the choice and grants nothing", async () => {
  const info = await connector.observe(env);
  expect(info?.environmentId).toBeTruthy(); expect(info?.sessionId).toBe(pairing.session.id);
  connector.decline(env, info!);
  expect(await connector.observe(env)).toBeNull();
  expect(await computers()).toEqual([]);
  expect(connector.state(env.id)).toMatchObject({ enabled: false, folders: [], computer: false, terminal: false });
  evidence.push("post-pair identity and remembered Not now; zero default access");
});

it("executes real read-only folder requests through the real agent MCP and connector", async () => {
  await connector.save(env, { folders: [folder], terminal: false, computer: false }, await connector.identity(env));
  await expect.poll(() => connector.state(env.id).connected, { timeout: 8000 }).toBe(true);
  const available = await computers();
  expect(available).toHaveLength(1);
  expect(available[0].folders[0]).toMatchObject({ id: folder.id, write: false });
  expect(JSON.stringify(available)).not.toContain(folder.path);
  expect(data(await operation("list_files")).entries).toContainEqual({ name: "brief.txt", type: "file" });
  expect(data(await operation("read_file", { path: "brief.txt" })).content).toBe("A real local file. 🌱");
  const refused = await operation("write_file", { path: "brief.txt", content: "not allowed" });
  expect(refused.isError).toBe(true); expect(refused.content[0].text).toContain("read-only");
  expect((await operation("run_command", { command: "echo no" })).isError).toBe(true);
  expect((await operation("computer_tools")).isError).toBe(true);
  expect((await operation("read_file", { path: "../config.json" })).isError).toBe(true);
  evidence.push("real MCP → paired HTTP → local read, with write/terminal/screen/traversal denied");
});

it("explicit edits and terminal work; old credentials and other sessions cannot impersonate the desktop", async () => {
  const old = storedGrant();
  await connector.save(env, { folders: [{ ...folder, write: true }], terminal: true, computer: false }, await connector.identity(env));
  await expect.poll(() => connector.state(env.id).connected, { timeout: 8000 }).toBe(true);
  const before = data(await operation("read_file", { path: "brief.txt" }));
  expect(data(await operation("write_file", { path: "brief.txt", content: "Reviewed", expected_sha256: before.sha256 })).written).toBe(true);
  expect(readFileSync(join(folder.path, "brief.txt"), "utf8")).toBe("Reviewed");
  expect(data(await operation("run_command", { command: "echo shared-desktop-ok" })).output).toContain("shared-desktop-ok");
  const grant = storedGrant();
  const auth = { authorization: `Bearer ${pairing.token}` };
  expect((await api("POST", `/api/shared-computers/${grant.id}/lease`, {}, auth)).status).toBe(403);
  expect((await api("POST", `/api/shared-computers/${old.id}/lease`, {}, { ...auth, "x-omb-computer-secret": old.secret })).status).toBe(403);
  const second = await api("POST", "/api/auth/pairing", { label: "Other desktop" });
  const other = (await api("POST", "/api/auth/pair", { code: second.body.code })).body;
  expect((await api("POST", `/api/shared-computers/${grant.id}/lease`, {}, { authorization: `Bearer ${other.token}`, "x-omb-computer-secret": grant.secret })).status).toBe(403);
  expect((await api("POST", "/api/desktop/shared-computer-control", { id: randomUUID(), action: "acquire" }, { authorization: `Bearer ${other.token}` })).status).toBe(403);
  const cookie = `${sessionCookieName(Number(new URL(env.origin).port), grant.environmentId)}=${pairing.token}`;
  expect((await api("POST", `/api/shared-computers/${grant.id}/lease`, {}, { cookie, origin: "https://evil.invalid", "x-omb-computer-secret": grant.secret })).status).toBe(403);
  evidence.push("explicit hash-guarded edit and real terminal; cross-session, stale-secret, CSRF, local-control gate refusals");
}, 60_000);

it("a second full-access paired device uses the canonical owner in a real agent turn, then loses access on revocation", async () => {
  writeFileSync(join(folder.path, "brief.txt"), "A real local file. 🌱");
  const desktopWindow = await api("POST", "/api/auth/pairing", { label: "Full-access desktop fixture", scopes: ["admin", "client"] });
  expect(desktopWindow.status).toBe(200);
  const desktop = (await api("POST", "/api/auth/pair", { code: desktopWindow.body.code })).body;
  lendingToken = desktop.token;
  await connector.save(env, { folders: [folder], terminal: false, computer: true }, await connector.identity(env));
  await expect.poll(() => connector.state(env.id).connected, { timeout: 8000 }).toBe(true);
  const opened = await api("POST", "/api/auth/pairing", { label: "Android fixture", scopes: ["admin", "client"] }, { authorization: `Bearer ${desktop.token}` });
  expect(opened.status).toBe(200);
  const phone = (await api("POST", "/api/auth/pair", { code: opened.body.code, label: "Android fixture" })).body;
  expect(phone.session.scopes).toEqual(["admin", "client"]);

  const phoneBot = (await api("POST", "/api/bots", { name: "Android agent-turn tester" })).body.bot;
  const child = await agentProxyFor(phoneBot.id, phone.token, "List my shared computers and read the fixture brief.");
  const { initialize, call } = mcpClient(child);
  try {
    await initialize();
    const listed = JSON.parse((await call("list_shared_computers")).content[0].text).computers;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ computer: true, terminal: false, folders: [{ id: folder.id, write: false }] });
    const read = await call("shared_computer", { computer_id: storedGrant().id, folder_id: folder.id, action: "read_file", path: "brief.txt" });
    expect(JSON.parse(read.content[0].text).content).toBe("A real local file. 🌱");

    expect((await api("DELETE", `/api/auth/sessions/${phone.session.id}`, undefined, { authorization: `Bearer ${desktop.token}` })).status).toBe(200);
    const afterRevoke = await call("shared_computer", { computer_id: storedGrant().id, folder_id: folder.id, action: "read_file", path: "brief.txt" });
    expect(afterRevoke.isError).toBe(true);
    expect(JSON.stringify(afterRevoke)).not.toContain("A real local file");
  } finally {
    child.kill();
    // Return the shared fixture to the original client session so later tests retain their own assumptions.
    lendingToken = pairing.token;
    await connector.save(env, { folders: [folder], terminal: false, computer: false }, await connector.identity(env));
    await expect.poll(() => connector.state(env.id).connected, { timeout: 8000 }).toBe(true);
  }
  evidence.push("real second full-access paired-device turn lists and reads the owner's read-only computer; revoking that exact session blocks a subsequent tool action in the still-running turn");
}, 60_000);

it("setup-request turns retain the submitting session through active use and revocation", async () => {
  const desktopWindow = await api("POST", "/api/auth/pairing", { label: "Setup owner desktop", scopes: ["admin", "client"] });
  expect(desktopWindow.status).toBe(200);
  const desktop = (await api("POST", "/api/auth/pair", { code: desktopWindow.body.code })).body;
  lendingToken = desktop.token;
  await connector.save(env, { folders: [folder], terminal: false, computer: true }, await connector.identity(env));
  await expect.poll(() => connector.state(env.id).connected, { timeout: 8000 }).toBe(true);

  const openSession = async (label: string, scopes: string[]) => {
    const opened = await api("POST", "/api/auth/pairing", { label, scopes }, { authorization: `Bearer ${desktop.token}` });
    expect(opened.status).toBe(200);
    return (await api("POST", "/api/auth/pair", { code: opened.body.code, label })).body;
  };
  const first = await openSession("Setup requester one", ["admin", "client"]);
  const second = await openSession("Setup requester two", ["admin", "client"]);
  const restricted = await openSession("Restricted setup requester", ["client"]);
  const invalidBot = (await api("POST", "/api/bots", { name: "Invalid setup provenance" }, { authorization: `Bearer ${desktop.token}` })).body.bot;
  const invalid = await api("POST", `/api/bots/${invalidBot.id}/setup-request`, { threadId: invalidBot.threadId, text: "must not dispatch" }, { authorization: "Bearer omb_sess_invalid" });
  expect(invalid.status).toBe(401);
  const setupTurn = async (label: string, session: any) => {
    const setupBot = (await api("POST", "/api/bots", { name: label }, { authorization: `Bearer ${desktop.token}` })).body.bot;
    const child = await proxyForTurn(async () => {
      const sent = await api("POST", `/api/bots/${setupBot.id}/setup-request`, { threadId: setupBot.threadId, text: `set up ${label}` }, { authorization: `Bearer ${session.token}` });
      expect(sent.status).toBe(200);
    });
    const client = mcpClient(child);
    await client.initialize();
    return { setupBot, child, call: client.call };
  };

  let firstTurn: Awaited<ReturnType<typeof setupTurn>> | undefined;
  let secondTurn: Awaited<ReturnType<typeof setupTurn>> | undefined;
  let restrictedTurn: Awaited<ReturnType<typeof setupTurn>> | undefined;
  try {
    firstTurn = await setupTurn("Setup request active revocation", first);
    const initial = JSON.parse((await firstTurn.call("list_shared_computers")).content[0].text).computers;
    expect(initial.some((computer: any) => computer.id === storedGrant().id)).toBe(true);

    expect((await api("DELETE", `/api/auth/sessions/${first.session.id}`, undefined, { authorization: `Bearer ${desktop.token}` })).status).toBe(200);
    const afterRevoke = await firstTurn.call("list_shared_computers");
    expect(JSON.parse(afterRevoke.content[0].text).computers).toEqual([]);
    const denied = await firstTurn.call("shared_computer", { computer_id: storedGrant().id, folder_id: folder.id, action: "read_file", path: "brief.txt" });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain("A real local file");

    secondTurn = await setupTurn("Setup request independent session", second);
    const secondList = JSON.parse((await secondTurn.call("list_shared_computers")).content[0].text).computers;
    expect(secondList.some((computer: any) => computer.id === storedGrant().id)).toBe(true);

    restrictedTurn = await setupTurn("Setup request restricted session", restricted);
    const restrictedList = JSON.parse((await restrictedTurn.call("list_shared_computers")).content[0].text).computers;
    expect(restrictedList).toEqual([]);
    const restrictedRead = await restrictedTurn.call("shared_computer", { computer_id: storedGrant().id, folder_id: folder.id, action: "read_file", path: "brief.txt" });
    expect(restrictedRead.isError).toBe(true);
    expect(JSON.stringify(restrictedRead)).not.toContain("A real local file");
  } finally {
    firstTurn?.child.kill(); secondTurn?.child.kill(); restrictedTurn?.child.kill();
    for (const session of [first, second, restricted]) {
      await api("DELETE", `/api/auth/sessions/${session.session.id}`, undefined, { authorization: `Bearer ${desktop.token}` });
    }
    lendingToken = pairing.token;
    await connector.save(env, { folders: [folder], terminal: false, computer: false }, await connector.identity(env));
    await expect.poll(() => connector.state(env.id).connected, { timeout: 8000 }).toBe(true);
  }
  evidence.push("setup-request HTTP route starts real agent MCP turns; active session revocation empties inventory and denies read, a separate live full-access session remains authorized, and restricted setup sessions gain no owner access");
}, 90_000);

it("a setup-request queued turn is discarded when its original session is revoked", async () => {
  const dump = join(fixture.info.dataDir, "fake-claude-dump.json");
  expect((await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } })).status).toBe(200);
  const desktopWindow = await api("POST", "/api/auth/pairing", { label: "Setup queue owner", scopes: ["admin", "client"] });
  expect(desktopWindow.status).toBe(200);
  const desktop = (await api("POST", "/api/auth/pair", { code: desktopWindow.body.code })).body;
  const phoneWindow = await api("POST", "/api/auth/pairing", { label: "Setup queue phone", scopes: ["admin", "client"] }, { authorization: `Bearer ${desktop.token}` });
  expect(phoneWindow.status).toBe(200);
  const phone = (await api("POST", "/api/auth/pair", { code: phoneWindow.body.code })).body;
  const setupBot = (await api("POST", "/api/bots", { name: "Queued setup provenance" }, { authorization: `Bearer ${desktop.token}` })).body.bot;
  const holder = (await api("POST", `/api/bots/${setupBot.id}/tasks`, { title: "Hold a separate thread" }, { authorization: `Bearer ${desktop.token}` })).body.task;
  const active = await proxyForTurn(async () => {
    expect((await api("POST", `/api/bots/${setupBot.id}/messages`, { text: "Hold another task until interrupted.", threadId: holder.threadId }, { authorization: `Bearer ${desktop.token}` })).status).toBe(202);
  });
  try {
    rmSync(dump, { force: true });
    const queued = await api("POST", `/api/bots/${setupBot.id}/setup-request`, { threadId: setupBot.threadId, text: "Set up a queued task" }, { authorization: `Bearer ${phone.token}` });
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    expect((await api("DELETE", `/api/auth/sessions/${phone.session.id}`, undefined, { authorization: `Bearer ${desktop.token}` })).status).toBe(200);

    const interrupted = await api("POST", `/api/bots/${setupBot.id}/interrupt`, { threadId: holder.threadId }, { authorization: `Bearer ${desktop.token}` });
    expect(interrupted.status, JSON.stringify(interrupted.body)).toBe(200);
    await vi.waitFor(async () => {
      const current = (await api("GET", "/api/bots", undefined, { authorization: `Bearer ${desktop.token}` })).body.bots.find((candidate: any) => candidate.id === setupBot.id);
      expect(current?.busy).toBe(false);
    }, { timeout: 15_000 });
    expect(existsSync(dump)).toBe(false);
    const messages = (await api("GET", `/api/threads/${setupBot.threadId}/messages?limit=20`, undefined, { authorization: `Bearer ${desktop.token}` })).body.messages;
    expect(messages.some((message: any) => message.role === "user" && message.text === "Set up a queued task")).toBe(false);
  } finally {
    active.kill();
    await api("POST", `/api/bots/${setupBot.id}/interrupt`, { threadId: holder.threadId }, { authorization: `Bearer ${desktop.token}` });
    await api("DELETE", `/api/bots/${setupBot.id}`, undefined, { authorization: `Bearer ${desktop.token}` });
  }
  evidence.push("a paired setup-request submitted while its agent turn is active is not dispatched after that exact submitting session is revoked");
}, 60_000);

it("a queued paired-device turn keeps its session: revocation cancels dispatch and an authorized queue can list the lent computer", async () => {
  const dump = join(fixture.info.dataDir, "fake-claude-dump.json");
  const desktopWindow = await api("POST", "/api/auth/pairing", { label: "Queue owner desktop", scopes: ["admin", "client"] });
  expect(desktopWindow.status).toBe(200);
  const desktop = (await api("POST", "/api/auth/pair", { code: desktopWindow.body.code })).body;
  lendingToken = desktop.token;
  await connector.save(env, { folders: [folder], terminal: false, computer: true }, await connector.identity(env));
  await expect.poll(() => connector.state(env.id).connected, { timeout: 8000 }).toBe(true);

  const queuedTurn = async (label: string, revokeBeforeDrain: boolean, restricted = false) => {
    const opened = await api("POST", "/api/auth/pairing", { label, scopes: restricted ? ["client"] : ["admin", "client"] }, { authorization: `Bearer ${desktop.token}` });
    expect(opened.status).toBe(200);
    const device = (await api("POST", "/api/auth/pair", { code: opened.body.code, label })).body;
    const queuedBot = (await api("POST", "/api/bots", { name: `${label} queued-turn fixture` }, { authorization: `Bearer ${desktop.token}` })).body.bot;
    const activeProxy = await agentProxyFor(queuedBot.id, desktop.token, "Hold this turn until it is interrupted.");
    try {
      const queued = await api("POST", `/api/bots/${queuedBot.id}/messages`, { text: `queued request ${label}`, followUp: "queue" }, { authorization: `Bearer ${device.token}` });
      expect(queued.status).toBe(202);
      expect(queued.body).toMatchObject({ queued: true, queueId: expect.any(String) });
      if (revokeBeforeDrain) {
        expect((await api("DELETE", `/api/auth/sessions/${device.session.id}`, undefined, { authorization: `Bearer ${desktop.token}` })).status).toBe(200);
      }
      // The prior turn's provider dump is not evidence that the queued turn started.
      rmSync(dump, { force: true });
      expect((await api("POST", `/api/bots/${queuedBot.id}/interrupt`, undefined, { authorization: `Bearer ${desktop.token}` })).status).toBe(200);
      const current = async () => (await api("GET", "/api/bots", undefined, { authorization: `Bearer ${desktop.token}` })).body.bots.find((candidate: any) => candidate.id === queuedBot.id);
      if (revokeBeforeDrain) {
        await vi.waitFor(async () => expect((await current()).busy).toBe(false), { timeout: 15_000 });
        expect((await current()).messages.some((message: any) => message.text === `queued request ${label}`)).toBe(false);
        expect(existsSync(dump)).toBe(false);
        return;
      }
      await vi.waitFor(async () => expect(existsSync(dump) && (await current()).busy).toBe(true), { timeout: 15_000 });
      const agents = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.agents;
      const queuedProxy = spawn(agents.command, agents.args, { env: { PATH: process.env.PATH, HOME: fixture.info.dataDir, ...agents.env }, stdio: ["pipe", "pipe", "pipe"] });
      const { initialize, call } = mcpClient(queuedProxy);
      try {
        await initialize();
        const list = JSON.parse((await call("list_shared_computers")).content[0].text).computers;
        if (restricted) {
          expect(list).toEqual([]);
          expect((await call("shared_computer", { computer_id: storedGrant().id, folder_id: folder.id, action: "read_file", path: "brief.txt" })).isError).toBe(true);
        } else {
          expect(list.some((computer: any) => computer.id === storedGrant().id)).toBe(true);
          expect(list.find((computer: any) => computer.id === storedGrant().id)).toMatchObject({ computer: true, terminal: false });
        }
      } finally {
        queuedProxy.kill();
        await api("POST", `/api/bots/${queuedBot.id}/interrupt`, undefined, { authorization: `Bearer ${desktop.token}` });
      }
    } finally {
      activeProxy.kill();
      const current = await api("GET", "/api/bots", undefined, { authorization: `Bearer ${desktop.token}` });
      const live = current.body.bots.find((candidate: any) => candidate.id === queuedBot.id)?.busy;
      if (live) await api("POST", `/api/bots/${queuedBot.id}/interrupt`, undefined, { authorization: `Bearer ${desktop.token}` });
    }
  };

  try {
    await queuedTurn("revoked Android", true);
    await queuedTurn("authorized Android", false);
    await queuedTurn("restricted guest", false, true);
  } finally {
    lendingToken = pairing.token;
    await connector.save(env, { folders: [folder], terminal: false, computer: false }, await connector.identity(env));
    await expect.poll(() => connector.state(env.id).connected, { timeout: 8000 }).toBe(true);
  }
  evidence.push("a real paired-device follow-up retains session provenance through queue drain: revocation prevents dispatch; a live full-access pairing dispatches and lists the lent computer through MCP");
}, 90_000);

it("a restricted pairing cannot steer a privileged direct turn and stays restricted after queue dispatch", async () => {
  const dump = join(fixture.info.dataDir, "fake-claude-dump.json");
  const ownerWindow = await api("POST", "/api/auth/pairing", { label: "Steering owner", scopes: ["admin", "client"] });
  const owner = (await api("POST", "/api/auth/pair", { code: ownerWindow.body.code })).body;
  lendingToken = owner.token;
  await connector.save(env, { folders: [folder], terminal: false, computer: true }, await connector.identity(env));
  await expect.poll(() => connector.state(env.id).connected, { timeout: 8000 }).toBe(true);
  const restrictedWindow = await api("POST", "/api/auth/pairing", { label: "Steering client-only", scopes: ["client"] }, { authorization: `Bearer ${owner.token}` });
  const restricted = (await api("POST", "/api/auth/pair", { code: restrictedWindow.body.code })).body;
  const target = (await api("POST", "/api/bots", { name: "Steering isolation fixture" }, { authorization: `Bearer ${owner.token}` })).body.bot;
  const active = await agentProxyFor(target.id, owner.token, "Hold this owner-authorized turn while another device sends a message.");
  let queuedProxy: ChildProcess | undefined;
  try {
    const incoming = await api("POST", `/api/bots/${target.id}/messages`, { text: "steering restricted request: access the shared computer" }, { authorization: `Bearer ${restricted.token}` });
    expect(incoming.status).toBe(202);
    expect(incoming.body).toMatchObject({ queued: true, queueId: expect.any(String) });
    expect(incoming.body.steered).toBeUndefined();
    const manualJoin = await api("POST", `/api/bots/${target.id}/queue/${incoming.body.queueId}/steer`, { threadId: target.threadId }, { authorization: `Bearer ${owner.token}` });
    expect(manualJoin.status).toBe(403);
    expect(manualJoin.body.code).toBe("session_context");

    // Drain through the actual agent queue, then exercise the native shared-computer tool with that turn's capability.
    rmSync(dump, { force: true });
    expect((await api("POST", `/api/bots/${target.id}/interrupt`, undefined, { authorization: `Bearer ${owner.token}` })).status).toBe(200);
    const current = async () => (await api("GET", "/api/bots", undefined, { authorization: `Bearer ${owner.token}` })).body.bots.find((candidate: any) => candidate.id === target.id);
    await vi.waitFor(async () => expect(existsSync(dump) && (await current()).busy).toBe(true), { timeout: 15_000 });
    const agents = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.agents;
    queuedProxy = spawn(agents.command, agents.args, { env: { PATH: process.env.PATH, HOME: fixture.info.dataDir, ...agents.env }, stdio: ["pipe", "pipe", "pipe"] });
    const { initialize, call } = mcpClient(queuedProxy);
    await initialize();
    expect(JSON.parse((await call("list_shared_computers")).content[0].text).computers).toEqual([]);
    expect((await call("shared_computer", { computer_id: storedGrant().id, folder_id: folder.id, action: "read_file", path: "brief.txt" })).isError).toBe(true);
  } finally {
    queuedProxy?.kill(); active.kill();
    await api("POST", `/api/bots/${target.id}/interrupt`, undefined, { authorization: `Bearer ${owner.token}` });
    await api("DELETE", `/api/auth/sessions/${restricted.session.id}`, undefined, { authorization: `Bearer ${owner.token}` });
    await api("DELETE", `/api/auth/sessions/${owner.session.id}`, undefined, { authorization: `Bearer ${owner.token}` });
    lendingToken = pairing.token;
    await connector.save(env, { folders: [folder], terminal: false, computer: false }, await connector.identity(env));
    await expect.poll(() => connector.state(env.id).connected, { timeout: 8000 }).toBe(true);
  }
  evidence.push("a real authenticated client-only message is queued outside an owner-authorized active turn; after real queue dispatch its native shared-computer inventory remains empty and control is denied");
}, 90_000);

it("same-session direct sends retain live steering while a different full-access session is queued and revocation cancels it", async () => {
  const dump = join(fixture.info.dataDir, "fake-claude-dump.json");
  const firstWindow = await api("POST", "/api/auth/pairing", { label: "Steering full-access A", scopes: ["admin", "client"] });
  const first = (await api("POST", "/api/auth/pair", { code: firstWindow.body.code })).body;
  const secondWindow = await api("POST", "/api/auth/pairing", { label: "Steering full-access B", scopes: ["admin", "client"] }, { authorization: `Bearer ${first.token}` });
  const second = (await api("POST", "/api/auth/pair", { code: secondWindow.body.code })).body;
  const target = (await api("POST", "/api/bots", { name: "Session steering fixture" }, { authorization: `Bearer ${first.token}` })).body.bot;
  const active = await agentProxyFor(target.id, first.token, "Hold session A's turn while testing session-bound steering.");
  try {
    const same = await api("POST", `/api/bots/${target.id}/messages`, { text: "same-session steering control" }, { authorization: `Bearer ${first.token}` });
    expect(same.status).toBe(202);
    expect(same.body.steered).toBe(true);

    const other = await api("POST", `/api/bots/${target.id}/messages`, { text: "different full-access session request" }, { authorization: `Bearer ${second.token}` });
    expect(other.status).toBe(202);
    expect(other.body).toMatchObject({ queued: true, queueId: expect.any(String) });
    expect(other.body.steered).toBeUndefined();
    const manualJoin = await api("POST", `/api/bots/${target.id}/queue/${other.body.queueId}/steer`, { threadId: target.threadId }, { authorization: `Bearer ${first.token}` });
    expect(manualJoin.status).toBe(403);
    expect(manualJoin.body.code).toBe("session_context");
    expect((await api("DELETE", `/api/auth/sessions/${second.session.id}`, undefined, { authorization: `Bearer ${first.token}` })).status).toBe(200);
    expect((await api("POST", `/api/bots/${target.id}/messages`, { text: "revoked session must not steer" }, { authorization: `Bearer ${second.token}` })).status).toBe(401);
    const ownerBots = await api("GET", "/api/bots", undefined, { authorization: `Bearer ${first.token}` });
    expect(ownerBots.body.bots.find((candidate: any) => candidate.id === target.id).busy).toBe(true);

    rmSync(dump, { force: true });
    expect((await api("POST", `/api/bots/${target.id}/interrupt`, undefined, { authorization: `Bearer ${first.token}` })).status).toBe(200);
    const current = async () => (await api("GET", "/api/bots", undefined, { authorization: `Bearer ${first.token}` })).body.bots.find((candidate: any) => candidate.id === target.id);
    await vi.waitFor(async () => expect((await current()).busy).toBe(false), { timeout: 15_000 });
    expect(existsSync(dump)).toBe(false);
    expect((await current()).messages.some((message: any) => message.text === "different full-access session request")).toBe(false);
  } finally {
    active.kill();
    await api("POST", `/api/bots/${target.id}/interrupt`, undefined, { authorization: `Bearer ${first.token}` });
    await api("DELETE", `/api/auth/sessions/${first.session.id}`, undefined, { authorization: `Bearer ${first.token}` });
  }
  evidence.push("same-session direct steering remains available; a second full-access session queues separately and its revoked queued turn is not dispatched");
}, 90_000);

it("a big lent file changes by one passage, gains lines at its end, and is deleted only once read", async () => {
  await connector.save(env, { folders: [{ ...folder, write: true }], terminal: false, computer: false }, await connector.identity(env));
  await expect.poll(() => connector.state(env.id).connected, { timeout: 8000 }).toBe(true);
  const rules = "# Commands\n" + "- an unchanged rule that stays exactly as it is\n".repeat(720) + "- Where commands run: on the Mac\n";
  writeFileSync(join(folder.path, "commands.md"), rules);
  expect(Buffer.byteLength(rules)).toBeGreaterThan(34_000);

  const edit = { path: "commands.md", old_text: "- Where commands run: on the Mac", new_text: "- Where commands run: in the Cloud terminal" };
  const edited = await operation("edit_file", edit);
  expect(edited.isError, JSON.stringify(edited)).toBeFalsy();
  expect(readFileSync(join(folder.path, "commands.md"), "utf8")).toBe(rules.replace(edit.old_text, edit.new_text));
  expect(Buffer.byteLength(JSON.stringify(edit))).toBeLessThan(200);
  expect((await operation("edit_file", { path: "commands.md", old_text: "- an unchanged rule", new_text: "x" })).content[0].text).toContain("more than once");
  expect((await operation("edit_file", { path: "commands.md", old_text: "not there", new_text: "x" })).content[0].text).toContain("not found");

  const appended = await operation("append_file", { path: "data/metrics.jsonl", content: "{\"id\":\"x-0153\"}\n" });
  expect(appended.isError, JSON.stringify(appended)).toBeFalsy();
  await operation("append_file", { path: "data/metrics.jsonl", content: "{\"id\":\"x-0152\"}\n" });
  expect(readFileSync(join(folder.path, "data", "metrics.jsonl"), "utf8")).toBe("{\"id\":\"x-0153\"}\n{\"id\":\"x-0152\"}\n");

  writeFileSync(join(folder.path, "x-cookies.tmp"), "");
  expect((await operation("delete_file", { path: "x-cookies.tmp" })).content[0].text).toContain("expected_sha256");
  const seen = data(await operation("read_file", { path: "x-cookies.tmp" }));
  expect(data(await operation("delete_file", { path: "x-cookies.tmp", expected_sha256: seen.sha256 })).deleted).toBe(true);
  expect(existsSync(join(folder.path, "x-cookies.tmp"))).toBe(false);
  evidence.push("edit_file sends one passage of a 34 KB file; append_file adds lines; delete_file needs the file read first");
}, 60_000);

it("another person's conversation can neither see nor use the lent desktop", async () => {
  const opened = await api("POST", "/api/auth/pairing", { label: "Another person", scopes: ["client"] });
  const intruder = (await api("POST", "/api/auth/pair", { code: opened.body.code })).body;
  const theirs = (await api("POST", "/api/bots", { name: "Their bot" })).body.bot;
  const other = await agentProxyFor(theirs.id, intruder.token, "List the shared computers and read brief.txt from the first one.");
  const { initialize, call } = mcpClient(other);
  try {
    await initialize();
    expect(await computers()).toHaveLength(1);
    expect(JSON.parse((await call("list_shared_computers")).content[0].text).computers).toEqual([]);
    const refused = await call("shared_computer", { computer_id: storedGrant().id, folder_id: folder.id, action: "read_file", path: "brief.txt" });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).not.toContain("Reviewed");
    const noted = await call("memory_update", { action: "append", text: "A note from another person's chat." });
    expect(noted.isError, JSON.stringify(noted)).toBeFalsy();
  } finally { other.kill(); }
  evidence.push("owner partition: another paired person's bot sees no computers and cannot read the owner's file by id");
}, 45_000);

it("a routine acts for nobody, even one the lender created: it sees and uses no computer", async () => {
  const routineBot = (await api("POST", "/api/bots", { name: "Routine bot" })).body.bot;
  const owner = { authorization: `Bearer ${pairing.token}` };
  const routine = await proxyForTurn(async () => {
    const created = await api("POST", "/api/routines", {
      name: "Nightly desktop read", prompt: "Read brief.txt from my shared computer.", botId: routineBot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, owner);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await api("POST", `/api/routines/${created.body.routine.id}/run`, undefined, owner)).status).toBe(201);
  });
  const { initialize, call } = mcpClient(routine);
  try {
    await initialize();
    expect(await computers()).toHaveLength(1);
    expect(JSON.parse((await call("list_shared_computers")).content[0].text).computers).toEqual([]);
    const refused = await call("shared_computer", { computer_id: storedGrant().id, folder_id: folder.id, action: "read_file", path: "brief.txt" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("only a conversation started by the person who shared it");
  } finally { routine.kill(); }
  evidence.push("fail-closed principal: a routine turn (created by the lender) sees no computers");
}, 45_000);

it("a bot whose computer is off cannot drive the lent screen, even when screen control is lent", async () => {
  await connector.save(env, { folders: [{ ...folder, write: true }], terminal: true, computer: true }, await connector.identity(env));
  await expect.poll(() => connector.state(env.id).connected, { timeout: 8000 }).toBe(true);
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(200);
  try {
    const refused = await operation("computer_tools");
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("This bot has no computer");
    expect(data(await operation("list_files")).entries.length).toBeGreaterThan(0);
  } finally {
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: null })).status).toBe(200);
  }
  evidence.push("a bot set to no computer is refused the lent screen before anything reaches the desktop");
}, 30_000);

it("revocation stops a running command, prevents further access and stays off after restart", async () => {
  const pending = operation("run_command", { command: process.platform === "win32" ? "Start-Sleep -Seconds 20" : "sleep 20" });
  await new Promise(resolve => setTimeout(resolve, 150));
  connector.revoke(env);
  expect((await pending).isError).toBe(true);
  await expect.poll(computers).toEqual([]);
  expect((await operation("read_file", { path: "brief.txt" })).isError).toBe(true);
  connector.close();
  connector = createComputerSharing({ file: grantFile, environments: () => [env], fetch, cuaConnection: async () => null, enabled: async () => true });
  connector.start(); expect(connector.state(env.id).enabled).toBe(false);
  expect(await computers()).toEqual([]);
  evidence.push("in-flight cancellation, no further access, durable revocation across connector restart");
});

it("disabling the local gate cancels a live job even while the remote workspace still permits sharing", async () => {
  connector.close();
  connector = createComputerSharing({
    file: grantFile, environments: () => [env], cuaConnection: async () => null,
    enabled: async () => localSharingEnabled,
    fetch: (url: string, init: RequestInit) => fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${pairing.token}` } }),
  });
  await connector.save(env, { folders: [folder], terminal: true, computer: false }, await connector.identity(env));
  await expect.poll(() => connector.state(env.id).connected, { timeout: 8000 }).toBe(true);
  const marker = join(folder.path, "local-gate-command-started");
  const pending = operation("run_command", { command: markedWaitCommand(marker) });
  await expect.poll(() => existsSync(marker), { timeout: 15_000 }).toBe(true);
  expect(commandAlive(marker)).toBe(true);
  localSharingEnabled = false;
  await expect.poll(() => connector.state(env.id).connected, { timeout: 5000 }).toBe(false);
  expect((await pending).isError).toBe(true);
  await expect.poll(() => commandAlive(marker), { timeout: 5000 }).toBe(false);
  expect((await api("GET", "/.well-known/openmausbot/environment")).body.capabilities.sharedComputers).toBe(true);
  await expect(connector.identity(env)).rejects.toThrow("turned off on this computer");
  expect((await operation("read_file", { path: "brief.txt" })).isError).toBe(true);
  evidence.push("local flag withdrawal cancels a live remote command and prevents further access despite remote opt-in");
}, 45_000);

it("withdrawing the workspace flag closes pending jobs and refuses a previously advertised tool", async () => {
  connector.close(); localSharingEnabled = true;
  connector = createComputerSharing({
    file: grantFile, environments: () => [env], cuaConnection: async () => null,
    enabled: async () => localSharingEnabled,
    fetch: (url: string, init: RequestInit) => fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${pairing.token}` } }),
  });
  await connector.save(env, { folders: [folder], terminal: true, computer: false }, await connector.identity(env));
  await expect.poll(() => connector.state(env.id).connected, { timeout: 8000 }).toBe(true);
  const marker = join(folder.path, "workspace-gate-command-started");
  const pending = operation("run_command", { command: markedWaitCommand(marker) });
  await expect.poll(() => existsSync(marker), { timeout: 15_000 }).toBe(true);
  expect(commandAlive(marker)).toBe(true);
  expect((await api("PATCH", "/api/config", { features: { sharedComputers: false } })).status).toBe(200);
  expect((await pending).isError).toBe(true);
  await expect.poll(() => commandAlive(marker), { timeout: 5000 }).toBe(false);
  const staleTool = await tool("list_shared_computers");
  expect(staleTool.isError).toBe(true);
  expect(staleTool.content[0].text).toContain("unknown internal endpoint");
  expect((await api("GET", "/.well-known/openmausbot/environment")).body.capabilities).not.toHaveProperty("sharedComputers");
  evidence.push("workspace flag withdrawal closes in-flight requests and refuses tools advertised to an earlier provider turn");
}, 45_000);
