// Real harness, real provider/control routes, inert browser executable and
// throwaway home. No browser, VM, device, or user data is opened.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

describe.skipIf(process.platform === "win32")("direct final-screen settlement", () => {
  let session: VerificationServer;
  let fixture: string;
  let botId: string;
  let threadId: string;
  let evidence: unknown[];
  let events: SseRecorder;
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${session.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: session.info.url,
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    if (method !== "GET") evidence.push({ method, path, status: result.status });
    return result;
  };
  const bot = async () => (await api("GET", "/api/bots")).body.bots.find((item: any) => item.id === botId);
  const gate = (name: string) => writeFileSync(join(fixture, name), "ready");
  const beginCapture = async () => {
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "FIRST_SCREEN", threadId })).status).toBe(202);
    await expect.poll(() => existsSync(join(fixture, "provider.json")), { timeout: 10_000 }).toBe(true);
    const dump = JSON.parse(readFileSync(join(fixture, "provider.json"), "utf8"));
    const token = dump.mcpConfig.mcpServers.browser.env.OMB_BROWSER_TOKEN;
    expect((await api("POST", "/api/internal/browser/mcp", {
      method: "tools/call", params: { name: "agent_browser_screenshot", arguments: {} },
    }, token)).status).toBe(200);
    gate("tools.gate");
    await expect.poll(() => existsSync(join(fixture, "capture.entered")), { timeout: 10_000 }).toBe(true);
    gate("finish.gate");
    await expect.poll(async () => (await api("GET", `/api/threads/${threadId}/messages`)).body.messages
      .some((message: any) => message.text === "reply to: FIRST_SCREEN"), { timeout: 5_000 }).toBe(true);
  };

  beforeEach(async () => {
    fixture = mkdtempSync(join(tmpdir(), "omb-screen-settle-"));
    evidence = [];
    const browser = join(fixture, "agent-browser");
    writeFileSync(browser, [
      "#!/usr/bin/env node",
      'import { existsSync, writeFileSync } from "node:fs";',
      'import { createInterface } from "node:readline";',
      `const dir = ${JSON.stringify(fixture)};`,
      'const args = process.argv.slice(2);',
      'if (args[0] === "screenshot") {',
      '  writeFileSync(dir + "/capture.entered", "started");',
      '  while (!existsSync(dir + "/capture.gate")) await new Promise(resolve => setTimeout(resolve, 10));',
      '  writeFileSync(args[1], Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64"));',
      '  writeFileSync(dir + "/capture.finished", "finished");',
      '} else if (args[0] === "mcp") {',
      '  createInterface({ input: process.stdin }).on("line", line => {',
      '    const message = JSON.parse(line); if (message.id === undefined) return;',
      '    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "inert-browser", version: "1" } }',
      '      : message.method === "tools/list" ? { tools: [{ name: "agent_browser_screenshot", inputSchema: { type: "object" } }] }',
      '      : { content: [{ type: "text", text: "inert browser action" }] };',
      '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");',
      '  });',
      '} else if (args[0] === "session") process.stdout.write(JSON.stringify({ success: true, data: { sessions: [] } }));',
      'else process.stdout.write("1.0.0\\n");',
    ].join("\n"), { mode: 0o700 });
    session = await launchVerificationServer(process.env, undefined, undefined, { binaryPath: browser, executablePath: browser });
    evidence.push({ fixture: session.info });
    const wrapper = join(fixture, "screen-claude.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { existsSync } from "node:fs";',
      `const dir = ${JSON.stringify(fixture)};`,
      'process.env.FAKE_CLAUDE_MODE = "slow";',
      'process.env.FAKE_CLAUDE_DUMP = dir + "/provider.json";',
      'process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = dir + "/finish.gate";',
      'if (process.argv.includes("--input-format")) {',
      '  const write = process.stdout.write.bind(process.stdout); let held = false; const buffered = [];',
      '  process.stdout.write = (chunk, ...args) => {',
      '    chunk = String(chunk).replaceAll("\\\"name\\\":\\\"Bash\\\"", "\\\"name\\\":\\\"browser__agent_browser_screenshot\\\"");',
      '    if (held || chunk.includes("\\\"type\\\":\\\"assistant\\\"")) { held = true; buffered.push(chunk); return true; }',
      '    return write(chunk, ...args);',
      '  };',
      '  const timer = setInterval(() => { if (!existsSync(dir + "/tools.gate")) return; clearInterval(timer); process.stdout.write = write; for (const chunk of buffered) write(chunk); }, 10);',
      '}',
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    expect((await api("PATCH", "/api/instances/claude", { cli: wrapper })).status).toBe(200);
    expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
    const created = await api("POST", "/api/bots", { name: "Screen settlement", browser: true, computer: "browser",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    expect(created.status).toBe(201);
    botId = created.body.bot.id;
    threadId = created.body.bot.threadId;
    events = await openSse(`${session.info.url}/api/events`);
  }, 30_000);

  afterEach(async () => {
    events?.close();
    if (fixture) gate("capture.gate");
    if (session) {
      writeFileSync(`${session.info.logPath}.json`, JSON.stringify(evidence, null, 2));
      console.info(JSON.stringify({ ...session.info, evidencePath: `${session.info.logPath}.json` }));
      await session.close();
    }
    if (fixture) await removeTempDir(fixture);
  });

  it("holds admission through the final picture, then runs an immediate queued follow-up", async () => {
    await beginCapture();
    expect((await bot()).tasks.find((task: any) => task.threadId === threadId).busy).toBe(true);
    const sent = await api("POST", `/api/bots/${botId}/messages`, { text: "FOLLOWUP_AFTER_SCREEN", threadId });
    expect(sent.status).toBe(202);
    expect(sent.body.queued).toBe(true);
    gate("capture.gate");
    await expect.poll(async () => (await bot()).busy, { timeout: 15_000 }).toBe(false);
    const messages = (await bot()).messages;
    expect(messages.some((message: any) => message.text?.includes("reply to: FOLLOWUP_AFTER_SCREEN"))).toBe(true);
    expect(messages.some((message: any) => message.tool?.name?.includes("another thread is working"))).toBe(false);
    const screenIndex = messages.findIndex((message: any) => message.kind === "screen");
    expect(screenIndex).toBeGreaterThanOrEqual(0);
    expect(screenIndex).toBeLessThan(
      messages.findIndex((message: any) => message.text === "FOLLOWUP_AFTER_SCREEN"));
  }, 30_000);

  it("bounds capture settlement and discards a late frame after the thread is deleted", async () => {
    const sibling = await api("POST", `/api/bots/${botId}/tasks`, { title: "Keep bot" });
    expect(sibling.status).toBe(201);
    await beginCapture();
    expect((await api("DELETE", `/api/bots/${botId}/tasks/${threadId}`)).status).toBe(409);
    await expect.poll(async () => (await bot()).tasks.find((task: any) => task.threadId === threadId).busy,
      { timeout: 13_000 }).toBe(false);
    expect((await api("DELETE", `/api/bots/${botId}/tasks/${threadId}`)).status).toBe(200);
    gate("capture.gate");
    await expect.poll(() => existsSync(join(fixture, "capture.finished")), { timeout: 3_000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const db = new DatabaseSync(join(session.info.dataDir, "messages.db"), { readOnly: true });
    try {
      expect((db.prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?").get(threadId) as { count: number }).count).toBe(0);
    } finally { db.close(); }
    expect((await api("GET", `/api/threads/${threadId}/messages`)).status).toBe(404);
    expect(events.frames.some((frame) => frame.kind === "screen" && frame.threadId === threadId)).toBe(false);
  }, 30_000);
});
