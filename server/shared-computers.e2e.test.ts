// Real server + pairing + agent MCP process + outbound desktop connector.
// Only the model is fake. Files live in the disposable verification home.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
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
  // A shared terminal operation can legitimately run for 30 seconds, before
  // its result crosses the connector and MCP boundaries (including Windows).
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
  // Computer sharing ships off (features.sharedComputers, config.ts). Turn it
  // on for this fixture before anything is paired or dispatched: the routes,
  // the advertised capability and the agent tools all read the same gate, and
  // the agent process is handed its copy when its turn starts.
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
  connector = createComputerSharing({
    file: grantFile, environments: () => [env], cuaConnection: async () => null,
    enabled: async () => localSharingEnabled,
    fetch: (url: string, init: RequestInit) => fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${pairing.token}` } }),
  });
  bot = (await api("POST", "/api/bots", { name: "Shared desktop tester" })).body.bot;
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Inspect the folder shared by my desktop; do not use files on the server." })).status).toBe(202);
  const dump = join(fixture.info.dataDir, "fake-claude-dump.json");
  await vi.waitFor(() => expect(existsSync(dump)).toBe(true), { timeout: 15_000 });
  const agents = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.agents;
  expect(readFileSync(agents.env.OMB_COMMS_TOKEN_FILE, "utf8")).toBeTruthy();
  proxy = spawn(agents.command, agents.args, {
    env: { PATH: process.env.PATH, HOME: fixture.info.dataDir, ...agents.env }, stdio: ["pipe", "pipe", "pipe"],
  });
  createInterface({ input: proxy.stdout! }).on("line", line => { const msg = JSON.parse(line); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); });
  await rpc("initialize", { protocolVersion: "2024-11-05" });
}, 30_000);

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
