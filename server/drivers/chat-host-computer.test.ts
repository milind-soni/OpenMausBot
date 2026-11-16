import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { chatToolNoticeLines, mountChatTools, type ChatToolSession } from "./chat-mcp-tools.ts";
import { HOST_COMPUTER_READY, HOST_COMPUTER_STAND_IN, hostComputerKey, hostComputerStartupMs } from "./chat-host-computer.ts";

const FAKE = `
  import { writeFileSync } from "node:fs";
  const { MODE, DELAY_MS, ANSWERED } = process.env;
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  const reply = (message, result) => send({ jsonrpc: "2.0", id: message.id, result });
  const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\\n")) !== -1) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (MODE === "silent") continue;
      if (message.method === "initialize") setTimeout(() => {
        writeFileSync(ANSWERED, "1");
        reply(message, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
      }, Number(DELAY_MS ?? 0));
      else if (message.method === "tools/list") reply(message, { tools: [{ name: "write", description: "Fixture write", inputSchema: schema }] });
      else if (message.method === "tools/call") reply(message, { content: [{ type: "text", text: "recorded:" + message.params.arguments.value }] });
    }
  });
`;

const dirs: string[] = [];
const sessions: ChatToolSession[] = [];
const controller = new AbortController();
let script = "";

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "omb-host-computer-"));
  dirs.push(dir);
  script = join(dir, "fake-computer.mjs");
  writeFileSync(script, FAKE);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => {})));
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

/** This desktop's computer as the gate hands it over: the driver it reaches is `driver`, the turn's capability its own. */
function computer(driver: string, env: Record<string, string> = {}) {
  const answered = join(dirs[0]!, `answered-${randomUUID()}`);
  return {
    answered,
    server: {
      command: process.execPath, args: [script], scope: "local-computer" as const, platform: "win32" as const,
      env: { OMB_CUA_COMMAND: driver, OMB_CUA_ARGS: '["mcp"]', OMB_CUA_PLATFORM: "win32", OMB_CONTROL_TOKEN: randomUUID(), ANSWERED: answered, ...env },
    },
  };
}

async function mount(server: ReturnType<typeof computer>["server"], startup: { ms: number; hostComputerMs: number }) {
  const session = await mountChatTools({ localComputer: server }, controller.signal, true, undefined, undefined, undefined, undefined, undefined, undefined, startup);
  sessions.push(session);
  return session;
}

const names = (session: ChatToolSession) => session.definitions.map((definition) => definition.function.name);

describe("this desktop's own computer in a chat turn", () => {
  it("gets longer to start on Windows, and its tools are shared by every turn on the same driver", () => {
    expect(hostComputerStartupMs("win32")).toBe(45_000);
    expect(hostComputerStartupMs("darwin")).toBe(20_000);
    expect(hostComputerStartupMs("linux")).toBe(20_000);
    const one = computer("C:\\cua-driver.exe").server, two = computer("C:\\cua-driver.exe").server;
    expect(one.env.OMB_CONTROL_TOKEN).not.toBe(two.env.OMB_CONTROL_TOKEN);
    expect(hostComputerKey(one)).toBe(hostComputerKey(two));
    expect(hostComputerKey(one)).not.toBe(hostComputerKey({ ...one, env: { ...one.env, OMB_CUA_ARGS: '["mcp","--embedded"]' } }));
  });

  it("is not skipped when it starts slower than the turn's budget, and the next turn lists it at once and waits at its first call", async () => {
    const driver = `slow-${randomUUID()}`;
    const first = computer(driver, { DELAY_MS: "1500" });
    const cold = await mount(first.server, { ms: 150, hostComputerMs: 20_000 });
    expect(cold.skipped).toEqual([]);
    expect(names(cold)).toEqual(["computer_write"]);

    const second = computer(driver, { DELAY_MS: "1500" });
    const warm = await mount(second.server, { ms: 150, hostComputerMs: 20_000 });
    expect(existsSync(second.answered)).toBe(false);
    expect(warm.skipped).toEqual([]);
    expect(names(warm)).toEqual(["computer_write"]);
    await expect(warm.execute("computer_write", { value: "x" }, controller.signal)).resolves.toMatchObject({ ok: true, text: "recorded:x" });
    expect(existsSync(second.answered)).toBe(true);
  });

  it("says through a tool, never by leaving it out, that it did not start, and tells the person", async () => {
    const session = await mount(computer(`dead-${randomUUID()}`, { MODE: "silent" }).server, { ms: 150, hostComputerMs: 400 });
    expect(session.skipped).toEqual([]);
    expect(names(session)).toEqual([HOST_COMPUTER_STAND_IN]);
    expect(session.definitions[0]!.function.description).toContain("did not start this time (MCP startup timed out)");
    expect(session.view(HOST_COMPUTER_STAND_IN, {})).toMatchObject({ ask: false });
    const result = await session.execute(HOST_COMPUTER_STAND_IN, {}, controller.signal);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("nothing needs linking or connecting");
    expect(chatToolNoticeLines(session)).toEqual([expect.objectContaining({ text: { key: "chat.notice.computerToolsDidNotStart", params: { reason: "MCP startup timed out" } } })]);
  });

  it("after a failed start, waits for the next one through the stand-in and then lists the real tools beside the runtime's own", async () => {
    const driver = `flaky-${randomUUID()}`;
    await mount(computer(driver, { MODE: "silent" }).server, { ms: 150, hostComputerMs: 400 });
    const starting = computer(driver, { DELAY_MS: "1200" });
    const session = await mount(starting.server, { ms: 150, hostComputerMs: 20_000 });
    expect(existsSync(starting.answered)).toBe(false);
    expect(names(session)).toEqual([HOST_COMPUTER_STAND_IN]);
    expect(session.definitions[0]!.function.description).toContain("still starting");
    expect(session.hostComputerFailure).toBeUndefined();
    const runtime = { type: "function" as const, function: { name: "ask_user", description: "Ask", parameters: { type: "object" } } };
    session.definitions.push(runtime);

    await expect(session.execute(HOST_COMPUTER_STAND_IN, {}, controller.signal)).resolves.toEqual({ ok: true, text: HOST_COMPUTER_READY });
    expect(names(session)).toEqual(["computer_write", "ask_user"]);
    await expect(session.execute("computer_write", { value: "y" }, controller.signal)).resolves.toMatchObject({ ok: true, text: "recorded:y" });
  });

  it("answers a call on the last start's tools with why this start failed, and the turn goes on", async () => {
    const driver = `lost-${randomUUID()}`;
    await mount(computer(driver).server, { ms: 5_000, hostComputerMs: 20_000 });
    const session = await mount(computer(driver, { MODE: "silent" }).server, { ms: 150, hostComputerMs: 600 });
    expect(names(session)).toEqual(["computer_write"]);
    const result = await session.execute("computer_write", { value: "z" }, controller.signal);
    expect(result).toMatchObject({ ok: false, text: expect.stringContaining("did not start this time (MCP startup timed out)") });
    expect(() => session.validate("computer_write", { value: "z" })).not.toThrow();
  });
});
