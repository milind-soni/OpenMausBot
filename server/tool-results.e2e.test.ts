// Actual mounted agents MCP -> live capability -> bounded cache -> paged read.
// All profiles, turns and transcripts belong to the shared disposable fixture.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("bounds a real roster, retrieves its tail, isolates owners and expires stopped capabilities", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  const proxies: ChildProcess[] = [];
  const evidence: unknown[] = [];
  const cli = async (...args: string[]) => {
    const result = await runControlOmb(args, { env: { OPENMAUSBOT_URL: fixture.info.url } }) as any;
    evidence.push({ args: args.map(arg => arg.length > 200 ? `${arg.slice(0, 200)}…` : arg), result });
    return result;
  };
  const api = async (path: string, body?: unknown, token?: string, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { origin: fixture.info.url, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as any };
  };
  const dumpFile = join(fixture.info.dataDir, "fake-claude-dump.json");
  const held = async (bot: any, threadId = bot.activeTaskId) => {
    rmSync(dumpFile, { force: true });
    await cli("send", "--bot", bot.id, "--task", threadId, "--text", "Hold this isolated verification turn open.");
    await expect.poll(() => existsSync(dumpFile), { timeout: 15_000 }).toBe(true);
    const mounted = JSON.parse(readFileSync(dumpFile, "utf8")).mcpConfig.mcpServers.agents;
    expect(mounted.env.OMB_THREAD_ID).toBe(threadId);
    const proxy = spawn(mounted.command, mounted.args, { cwd: process.cwd(),
      env: { ...mounted.env, PATH: process.env.PATH, HOME: fixture.info.dataDir }, stdio: ["pipe", "pipe", "pipe"] });
    proxies.push(proxy);
    proxy.stderr!.resume();
    let sequence = 0;
    const pending = new Map<number, (value: any) => void>();
    createInterface({ input: proxy.stdout! }).on("line", line => {
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    });
    const rpc = (method: string, params?: unknown): Promise<any> => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Fixture MCP ${method} timed out`)); }, 10_000);
      pending.set(id, result => { clearTimeout(timer); resolve(result); });
      proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    await rpc("initialize", { protocolVersion: "2024-11-05" });
    return { token: mounted.env.OMB_COMMS_TOKEN as string,
      tool: async (name: string, args = {}) => (await rpc("tools/call", { name, arguments: args })).result };
  };
  try {
    expect((await cli("doctor")).ok).toBe(true);
    const record = (await cli("new-bot", "--name", "Roster reader")).bot;
    const bot = { ...record, threadId: record.activeTaskId };
    // A sufficiently large real roster, not a fake HTTP response. No turns
    // are launched on these profiles, so this consumes no model capacity.
    for (let i = 0; i < 70; i++) {
      expect((await api("/api/bots", { name: `Roster-${String(i).padStart(2, "0")} ${"n".repeat(80)}`,
        title: "t".repeat(190), description: "d".repeat(150), computer: "off" })).status).toBe(201);
    }
    const first = await held(bot);
    const result = await first.tool("list_bots");
    expect(result.isError).toBeFalsy();
    const preview = result.content[0].text as string;
    expect(preview.length).toBeLessThan(17_000);
    const id = /id "(r-[0-9a-f-]{36})"/.exec(preview)?.[1];
    expect(id).toBeTruthy();
    const read = await first.tool("tool_result_read", { id, offset: 16_000 });
    expect(read.isError).toBeFalsy();
    expect(read.content[0].text.length).toBeLessThan(17_000);
    let tail = "";
    let offset = 16_000;
    while (true) {
      const page = await api(`/api/internal/tool-result?id=${id}&offset=${offset}`, undefined, first.token);
      expect(page.status).toBe(200);
      expect(Buffer.from(page.body.text).toString()).toBe(page.body.text);
      tail += page.body.text;
      if (page.body.nextOffset === page.body.length) break;
      expect(page.body.nextOffset).toBeGreaterThan(offset);
      offset = page.body.nextOffset;
    }
    expect(tail).toMatch(/Roster-\d+/);
    for (let i = 0; i < 70; i++) expect(preview.slice(0, 16_000) + tail).toContain(`Roster-${String(i).padStart(2, "0")}`);
    evidence.push({ preview, read, tailIncludesLastBot: true });
    expect((await api(`/api/internal/tool-result?id=${id}`)).status).toBe(401);
    const sibling = (await api(`/api/bots/${bot.id}/tasks`, { title: "Sibling scope" })).body.task;
    const second = await held(bot, sibling.threadId);
    expect((await second.tool("tool_result_read", { id })).isError).toBe(true);
    expect((await api(`/api/internal/tool-result?id=${id}&fromThreadId=${bot.threadId}`, undefined, second.token)).status).toBe(403);
    const other = (await cli("new-bot", "--name", "Other owner")).bot;
    const third = await held(other);
    expect((await third.tool("tool_result_read", { id })).isError).toBe(true);
    expect((await api("/api/internal/tool-result", { text: "x".repeat(128 * 1024 + 1) }, first.token)).status).toBe(400);
    expect((await first.tool("tool_result_read", { id, offset: -1 })).isError).toBe(true);
    await cli("messages", "--bot", bot.id, "--task", bot.threadId);
    await cli("interrupt", "--bot", bot.id, "--task", bot.threadId);
    await expect.poll(async () => (await api(`/api/internal/tool-result?id=${id}`, undefined, first.token)).status).toBe(401);
    // New live authority on the SAME conversation can still page its own
    // retained result. It does not inherit the stopped turn's authority.
    await expect.poll(async () => (await api("/api/bots")).body.bots.find((b: any) => b.id === bot.id)
      .tasks.find((t: any) => t.threadId === bot.threadId).busy).toBe(false);
    const resumed = await held(bot);
    expect((await resumed.tool("tool_result_read", { id, offset: 16_000 })).isError).toBeFalsy();
    evidence.push({ checks: ["real roster capped", "tail retrievable", "unauthenticated refused", "sibling thread refused",
      "other bot refused", "spoofed thread refused", "oversize save refused", "stopped capability revoked", "next turn can read own result"] });
  } finally {
    try {
      await Promise.all(proxies.map((proxy) => waitForExit(proxy, { signal: "SIGTERM" })));
      const path = `${fixture.info.logPath}.tool-results.json`;
      // Never retain the provider launch dump or its short-lived capability.
      writeFileSync(path, JSON.stringify({ url: fixture.info.url, log: fixture.info.logPath, evidence }, null, 2), { mode: 0o600 });
      console.info(`Tool-result fixture evidence: ${path}`);
    } finally { await fixture.close(); }
  }
}, 90_000);
