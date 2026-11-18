// A Bot API key the owner marked as acting for them, on a real server with the scripted engine: the thread it opens runs
// at the bot's own level, unconfined and with OpenMausBot's tools, as the owner's request; the never-list still denies
// what it names; once the mark is taken off the key can't go on in that thread; and a second admin switches it off.
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

let fixture: VerificationServer | undefined;
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await fixture?.close();
  fixture = undefined;
});

const call = async (endpoint: string, key: string, body: unknown) => {
  const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};

/** One permission request as the engine's broker client sends it, and the harness's answer. */
async function ask(socketPath: string, command: string): Promise<any> {
  const socket = connect(socketPath);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const id = randomUUID();
  let buffer = "";
  const reply = new Promise<any>((resolve, reject) => {
    socket.once("error", reject);
    socket.setTimeout(15_000, () => socket.destroy(new Error(`no answer to ${command}`)));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("\n")) resolve(JSON.parse(buffer.split("\n")[0]!));
    });
  });
  socket.write(`${JSON.stringify({ t: "ask", id, tool: "Bash", input: { command } })}\n`);
  return reply;
}

it("runs a marked key's thread at the bot's level as the owner's work, keeps the never-list, and stops when the mark comes off", async () => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.284", FAKE_CLAUDE_MODE: "hang" });
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  };
  const bot = (await runControlOmb(["new-bot", "--name", "Trusted", "--url", url]) as any).bot;
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full", applyToAllThreads: true });
  await api("PUT", "/api/config", { safetyFloor: { enabled: true } });
  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });
  expect(on).toMatchObject({ actsAsOwner: false, mayActAsOwner: true });
  expect(await api("POST", `/api/bots/${bot.id}/bot-api/acts-as-owner`, { enabled: true })).toMatchObject({ actsAsOwner: true });

  const dump = join(dataDir, "fake-claude-dump.json");
  rmSync(dump, { force: true });
  const pending = call(on.url, on.key, { message: "Tidy the build folder", wait: 60 }).catch((error: unknown) => ({ status: 0, body: { error: String(error) } }));
  const dumped = () => { try { return JSON.parse(readFileSync(dump, "utf8")); } catch { return null; } };
  await expect.poll(() => JSON.stringify(dumped()?.prompt ?? "").includes("Tidy the build folder"), { timeout: hostTimeout(30_000) }).toBe(true);
  const launch = dumped();
  // The bot's own level, unconfined, with OpenMausBot's tools; the words are the owner's request through the API.
  expect(launch.argv[launch.argv.indexOf("--permission-mode") + 1]).not.toBe("default");
  expect(launch.argv).not.toContain("--restricted");
  expect(Object.keys(launch.mcpConfig.mcpServers).length).toBeGreaterThan(1);
  expect(JSON.stringify(launch.prompt)).toContain("on their behalf at your level");
  expect(JSON.stringify(launch.prompt)).not.toContain("UNTRUSTED BOT API MESSAGE");
  expect(JSON.stringify(launch.systemPrompt)).toContain("marked as acting for them");

  const task = ((await api("GET", "/api/bots")).bots as any[]).find((one) => one.id === bot.id).tasks.find((one: any) => one.botApi);
  expect(task).toMatchObject({ botApi: true, botApiAsOwner: true, approvalMode: "full" });
  expect(task.outside).toBeUndefined();

  // Full access answers an ordinary request; the never-list still denies.
  const socketPath = launch.mcpConfig.mcpServers.ogb.args.at(-1) as string;
  expect(await ask(socketPath, "printf 'as owner'")).toMatchObject({ behavior: "allow" });
  expect(await ask(socketPath, "sudo rm -rf /etc")).toMatchObject({ behavior: "deny", message: expect.stringContaining("Blocked by the safety floor") });

  await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: task.threadId });
  await pending;
  await expect.poll(async () => ((await api("GET", "/api/bots")).bots as any[]).find((one) => one.id === bot.id).tasks.find((one: any) => one.threadId === task.threadId).busy, { timeout: hostTimeout(20_000) }).toBe(false);

  // Off again: the key can't go on in the owner's thread, and the change is in Settings → Activity.
  expect(await api("POST", `/api/bots/${bot.id}/bot-api/acts-as-owner`, { enabled: false })).toMatchObject({ actsAsOwner: false });
  const refused = await call(on.url, on.key, { message: "More", thread: task.threadId });
  expect(refused.status).toBe(403);
  const actions = ((await api("GET", "/api/admin-activity?what=all")).entries as Array<{ action?: string }>).map((entry) => entry.action);
  expect(actions).toEqual(expect.arrayContaining(["bot-api.acts-as-owner.on", "bot-api.acts-as-owner.off"]));

  // Only on one person's server, read live: a second admin, or a whole domain as admin, switches the mark off at once,
  // and it is back when the server is one person's again.
  expect(await api("POST", `/api/bots/${bot.id}/bot-api/acts-as-owner`, { enabled: true })).toMatchObject({ actsAsOwner: true });
  const status = async () => (await api("GET", `/api/bots/${bot.id}/bot-api`)) as { actsAsOwner: boolean; mayActAsOwner: boolean };
  await api("PUT", "/api/config", { signIn: { admins: ["one@example.test"] } });
  expect(await status()).toMatchObject({ actsAsOwner: true });
  await api("PUT", "/api/config", { signIn: { admins: ["one@example.test", "two@example.test"] } });
  expect(await status()).toMatchObject({ actsAsOwner: false, mayActAsOwner: false });
  await api("PUT", "/api/config", { signIn: { admins: ["@example.test"] } });
  expect(await status()).toMatchObject({ actsAsOwner: false, mayActAsOwner: false });
  await api("PUT", "/api/config", { signIn: { admins: [] } });
  expect(await status()).toMatchObject({ actsAsOwner: true });
}, hostTimeout(120_000));
