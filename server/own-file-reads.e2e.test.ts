// Real isolated server + native Claude permission broker, as command-allowlist.e2e.test.ts drives it: a bot on Ask that
// reads its own files (its SOUL.md, a skill revision, its memory) gets no card at all, while a read of anything else,
// or a command that does more than read, still asks. No real model calls, user profiles or shell commands are used.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";

// The reads asked about are a POSIX shell's commands on POSIX paths.
it.skipIf(process.platform === "win32")("answers a bot's plain reads of its own files at Ask with no card, and still asks for anything else", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  const { url, dataDir } = fixture.info;
  const sockets: Socket[] = [];
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const messages = async (thread: string): Promise<any[]> => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).messages;
  const card = async (thread: string, id: string) => (await messages(thread)).find((message) => message.card?.requestId === id)?.card;
  const ask = async (socketPath: string, tool: string, input: Record<string, unknown>) => {
    const socket = connect(socketPath);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const id = randomUUID();
    let buffer = "";
    const reply = new Promise<any>((resolve, reject) => {
      socket.once("error", reject);
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (buffer.includes("\n")) resolve(JSON.parse(buffer.split("\n")[0]!));
      });
    });
    void reply.catch(() => {});
    socket.write(JSON.stringify({ t: "ask", id, tool, input }) + "\n");
    return { id, reply };
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "Own files fixture", soul: "Answer plainly.", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }, 201)).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
    const own = join(dataDir, "workspaces", bot.id);
    const revision = join(own, "skills", ".revisions", "a".repeat(64));
    mkdirSync(revision, { recursive: true });
    writeFileSync(join(revision, "SKILL.md"), "# Morning email\n");
    writeFileSync(join(own, "MEMORY.md"), "notes\n");
    const soul = join(dataDir, "bots", bot.id, "SOUL.md");
    await expect.poll(() => existsSync(soul)).toBe(true);

    const dump = join(dataDir, "fake-claude-dump.json");
    rmSync(dump, { force: true });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Hold this turn while its reads are asked about." }, 202);
    await expect.poll(() => existsSync(dump), { timeout: 15_000 }).toBe(true);
    const socket = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.ogb.args.at(-1) as string;

    for (const [tool, input] of [
      ["Bash", { command: `cat ${soul}` }],
      ["Bash", { command: `head -n 20 ${join(revision, "SKILL.md")}` }],
      ["Bash", { command: `grep -rn "notes" ${own}` }],
      ["Read", { file_path: soul }],
    ] as const) {
      const asked = await ask(socket, tool, input);
      expect(await asked.reply, `${tool} ${JSON.stringify(input)}`).toMatchObject({ id: asked.id, behavior: "allow" });
      expect(await card(bot.threadId, asked.id)).toBeUndefined();
    }
    await expect.poll(async () => (await api("GET", "/api/decisions")).decisions.filter((row: any) => row.source === "own-files").length).toBe(4);

    for (const [tool, input] of [
      ["Bash", { command: `cat ${join(dataDir, "config.json")}` }],
      ["Bash", { command: `cat ${soul} | sh` }],
      ["Read", { file_path: join(dataDir, "config.json") }],
    ] as const) {
      const asked = await ask(socket, tool, input);
      await expect.poll(async () => Boolean(await card(bot.threadId, asked.id)), { timeout: 10_000 }).toBe(true);
    }
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  } finally {
    for (const socket of sockets) socket.destroy();
    await fixture.close();
  }
}, 120_000);
