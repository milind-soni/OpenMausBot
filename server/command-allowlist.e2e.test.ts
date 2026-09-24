// Real isolated server + native Claude permission broker. No real model calls,
// user profiles, shell commands or live application data are used.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("remembers real permission requests, scopes and revokes grants, and preserves them across restart", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  const { url, dataDir, logPath } = fixture.info;
  const sockets: Socket[] = [];
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200, token?: string) => {
    const response = await fetch(url + path, { method, headers: {
      origin: url, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const messages = async (thread: string): Promise<any[]> => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).messages;
  const card = async (thread: string, id: string) => (await messages(thread)).find(message => message.card?.requestId === id)?.card;
  const start = async (bot: any, thread = bot.threadId) => {
    const dump = join(dataDir, "fake-claude-dump.json");
    rmSync(dump, { force: true });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: thread, text: "Hold this verification task while its native command approvals are exercised." }, 202);
    await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
    return JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.ogb.args.at(-1) as string;
  };
  const ask = async (socketPath: string, command: string, input = {}, tool = "Bash") => {
    const socket = connect(socketPath);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const id = randomUUID();
    let answer: any;
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.includes("\n")) answer = JSON.parse(buffer.split("\n")[0]!);
    });
    socket.write(JSON.stringify({ t: "ask", id, tool, input: { command, ...input } }) + "\n");
    return { id, answer: () => answer };
  };
  const stop = (bot: any, thread = bot.threadId) => api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: thread });
  try {
    const bot = (await api("POST", "/api/bots", { name: "Command rules fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }, 201)).bot;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { approvalMode: "ask" });
    const rulesPath = `/api/bots/${bot.id}/command-allowlist`;
    expect((await api("GET", rulesPath)).rules).toEqual([]);
    const socket = await start(bot);
    const command = "printf 'allowlist fixture'";
    const first = await ask(socket, command);
    await expect.poll(async () => Boolean((await card(bot.threadId, first.id))?.commandAllowlist)).toBe(true);
    const candidate = (await card(bot.threadId, first.id)).commandAllowlist;
    expect(candidate.command).toBe(command);
    expect(candidate.cwd).toBe((await api("GET", rulesPath)).context.cwd);

    // A member can approve once, but cannot change all of this bot's threads.
    const pairing = await api("POST", "/api/auth/pairing", { label: "Member fixture", scopes: ["client"] });
    const paired = await api("POST", "/api/auth/pair", { code: pairing.code });
    await api("GET", rulesPath, undefined, 403, paired.token);
    await api("POST", rulesPath, candidate, 403, paired.token);
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first.id, behavior: "allow", rememberCommand: true }, 403, paired.token);
    expect((await api("GET", rulesPath)).rules).toEqual([]);
    expect((await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: first.id, behavior: "allow", rememberCommand: true })).outcome).toBe("allowed-once");
    await expect.poll(() => first.answer()?.behavior).toBe("allow");
    const saved = (await api("GET", rulesPath)).rules[0];
    expect(saved).toMatchObject(candidate);
    for (const profile of (await api("GET", "/api/bots")).bots) expect(profile).not.toHaveProperty("commandAllowlist");

    const repeated = await ask(socket, command);
    await expect.poll(() => repeated.answer()?.behavior).toBe("allow");
    expect(await card(bot.threadId, repeated.id)).toBeUndefined();
    await expect.poll(async () => (await api("GET", "/api/decisions")).decisions.some((row: any) => row.requestId === repeated.id && row.source === "command-allowlist")).toBe(true);

    // Exact means the whole command, not a prefix, shell wildcard, or title.
    for (const [text, input, tool] of [
      [command + " && pwd", {}, "Bash"],
      [command, { dangerouslyDisableSandbox: true }, "Bash"],
      [command, {}, "mcp__other__shell"],
    ] as const) {
      const different = await ask(socket, text, input, tool);
      await expect.poll(async () => Boolean(await card(bot.threadId, different.id))).toBe(true);
      expect(different.answer()).toBeUndefined();
      await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: different.id, behavior: "deny" });
      await expect.poll(() => different.answer()?.behavior).toBe("deny");
    }
    await api("DELETE", rulesPath + "/" + saved.id);
    const revoked = await ask(socket, command);
    await expect.poll(async () => Boolean(await card(bot.threadId, revoked.id))).toBe(true);
    await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.threadId, requestId: revoked.id, behavior: "allow", rememberCommand: true });
    expect((await api("GET", rulesPath)).rules).toHaveLength(1);
    await stop(bot);
    // A settled/imported/stale card never manufactures another grant.
    await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId: revoked.id, behavior: "allow", rememberCommand: true }, 403);

    const sibling = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Different folder" }, 201)).task;
    const otherSocket = await start(bot, sibling.threadId);
    const other = await ask(otherSocket, command);
    await expect.poll(async () => Boolean(await card(sibling.threadId, other.id))).toBe(true);
    expect((await card(sibling.threadId, other.id)).commandAllowlist.cwd).not.toBe(candidate.cwd);
    await stop(bot, sibling.threadId);

    // The rule is bot-wide, not tied to the approval's original thread.
    await api("PATCH", `/api/bots/${bot.id}`, { cwd: candidate.cwd });
    const shared = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Same project folder" }, 201)).task;
    const sharedSocket = await start(bot, shared.threadId);
    const sharedRequest = await ask(sharedSocket, command);
    await expect.poll(() => sharedRequest.answer()?.behavior).toBe("allow");
    expect(await card(shared.threadId, sharedRequest.id)).toBeUndefined();
    await stop(bot, shared.threadId);

    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({ FAKE_CLAUDE_MODE: "hang" }, dataDir, Number(new URL(url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    expect((await api("GET", rulesPath)).rules).toHaveLength(1);
    const restartedSocket = await start(bot);
    const restored = await ask(restartedSocket, command);
    await expect.poll(() => restored.answer()?.behavior).toBe("allow");
    expect(await card(bot.threadId, restored.id)).toBeUndefined();
    await stop(bot);
    console.info(`Command allowlist real-server verification passed; isolated log: ${logPath}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);
