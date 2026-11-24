// A self-hosted server of one person's own (`openmausbot serve` on a VPS) with a synthetic engine, and the person's Windows
// PC lent to it by the desktop app (apps and screen, no folder, no terminal). A conversation on Auto, with no Local VM set
// up and no other computer chosen: its turn is told plainly that it has their PC and how to reach it (list_shared_computers,
// then shared_computer), and nothing in the prompt sends it to a Local VM that is not set up. A conversation a bot
// opened is told why it can't use the PC, never an empty list that reads like an offline PC.
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

const PC = { id: randomUUID(), secret: randomBytes(32).toString("hex") };
let fixture: VerificationServer;
let owner = "";
let lending = true;
const proxies: ChildProcess[] = [];

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method, headers: { "content-type": "application/json", origin: fixture.info.url, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}
const asOwner = { authorization: "" };

beforeAll(async () => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang" });
  const opened = await api("POST", "/api/auth/pairing", { label: "Windows desktop", scopes: ["admin", "client"] });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  owner = (await api("POST", "/api/auth/pair", { code: opened.body.code })).body.token;
  asOwner.authorization = `Bearer ${owner}`;
  // The desktop app's own-server check: this pairing is the one owner's.
  expect((await api("GET", "/api/auth/session", undefined, asOwner)).body).toMatchObject({ own: true });
  const environmentId = (await api("GET", "/.well-known/openmausbot/environment")).body.environmentId as string;
  const headers = { ...asOwner, "x-omb-computer-secret": PC.secret };
  const connected = await api("POST", "/api/shared-computers/connect", {
    id: PC.id, name: "OFFICE-PC", environmentId, folders: [], terminal: false, computer: true, platform: "win32",
    commandTimeouts: true, longCommands: true, fileEdits: true,
  }, headers);
  expect(connected.status, JSON.stringify(connected.body)).toBe(200);
  void (async () => {
    while (lending) {
      const polled = await api("POST", `/api/shared-computers/${PC.id}/poll`, {}, headers).catch(() => null);
      const job = polled?.body?.job as { id: string } | null | undefined;
      if (!job) { if (!polled || polled.status !== 200) await new Promise((resolve) => setTimeout(resolve, 200)); continue; }
      await api("POST", `/api/shared-computers/${PC.id}/result`, { jobId: job.id, result: { ok: true, value: { tools: [{ name: "launch_app" }, { name: "click" }] } } }, headers);
    }
  })();
}, 40_000);

afterAll(async () => {
  lending = false;
  for (const proxy of proxies) proxy.kill();
  await fixture?.close();
});

type Turn = { systemPrompt?: string; mcpConfig: { mcpServers: { agents: { command: string; args: string[]; env: Record<string, string> } } } };
const dump = () => join(fixture.info.dataDir, "fake-claude-dump.json");

async function turnFor(start: () => Promise<void>): Promise<Turn> {
  rmSync(dump(), { force: true });
  await start();
  await vi.waitFor(() => expect(existsSync(dump())).toBe(true), { timeout: 15_000 });
  return JSON.parse(readFileSync(dump(), "utf8")) as Turn;
}

async function agentTools(turn: Turn) {
  const agents = turn.mcpConfig.mcpServers.agents;
  const proxy = spawn(agents.command, agents.args, { env: { PATH: process.env.PATH, HOME: fixture.info.dataDir, ...agents.env }, stdio: ["pipe", "pipe", "pipe"] });
  proxies.push(proxy);
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: proxy.stdout! }).on("line", (line) => { const msg = JSON.parse(line); replies.get(msg.id)?.(msg.result ?? msg); replies.delete(msg.id); });
  let next = 0;
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve) => {
    const id = ++next; replies.set(id, resolve);
    proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05" });
  return {
    list: async () => ((await request("tools/list", {})).tools as Array<{ name: string }>).map((tool) => tool.name),
    call: (name: string, args: unknown = {}) => request("tools/call", { name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>,
  };
}

it("tells an Auto turn on the person's own server that it has their lent PC and how to reach it, never a Local VM that isn't set up", async () => {
  const bot = (await api("POST", "/api/bots", { name: "Helper" }, asOwner)).body.bot as { id: string; threadId: string; computer?: string };
  expect(bot.computer).toBeUndefined();
  const turn = await turnFor(async () => {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Open Notepad on my PC.", threadId: bot.threadId }, asOwner)).status).toBe(202);
  });
  const prompt = turn.systemPrompt ?? "";
  expect(prompt).toContain("No other computer is set for this conversation: for desktop apps, use their PC (OFFICE-PC) through shared_computer");
  // No desktop app runs this server, so This computer is never offered as the way to the person's files.
  expect(prompt).not.toContain("switch it to This computer");
  expect(prompt).toContain("Their PC (OFFICE-PC) is reached only through shared_computer, never select_computer");
  expect(prompt).toContain("check list_shared_computers, then use shared_computer on it (computer_tools, then computer_call, for its apps and screen)");
  const tools = await agentTools(turn);
  expect(await tools.list()).toEqual(expect.arrayContaining(["list_shared_computers", "shared_computer"]));
  const listed = JSON.parse((await tools.call("list_shared_computers")).content[0]!.text);
  expect(listed.computers).toEqual([expect.objectContaining({ id: PC.id, name: "OFFICE-PC", computer: true })]);
}, 60_000);

it("tells a conversation a routine started why it can't use the lent PC, instead of an empty list that reads as offline", async () => {
  const bot = (await api("POST", "/api/bots", { name: "Nightly" }, asOwner)).body.bot as { id: string };
  const turn = await turnFor(async () => {
    const created = await api("POST", "/api/routines", {
      name: "Nightly check", prompt: "Open Notepad on my PC.", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, asOwner);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await api("POST", `/api/routines/${created.body.routine.id}/run`, undefined, asOwner)).status).toBe(201);
  });
  const tools = await agentTools(turn);
  const listed = JSON.parse((await tools.call("list_shared_computers")).content[0]!.text);
  expect(listed.computers).toEqual([]);
  expect(listed.unavailable).toContain("This conversation can't use their PC (OFFICE-PC): it is lent, and not offline");
  expect(listed.say).toBe("Only a conversation you start yourself can use your PC. Ask for it in a new conversation with this bot.");
}, 60_000);
