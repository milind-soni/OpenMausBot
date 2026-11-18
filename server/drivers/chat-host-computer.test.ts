import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { joinLateChatTools, mountChatTools, type ChatToolDefinition, type ChatToolSession } from "./chat-mcp-tools.ts";
import type { SendTurnInput } from "../contracts.ts";
import { HOST_COMPUTER_READY, HOST_COMPUTER_STAND_IN, hostComputerKey, hostComputerStartupMs } from "./chat-host-computer.ts";

const FAKE = `
  import { existsSync, writeFileSync } from "node:fs";
  const { MODE, DELAY_MS, ANSWERED, GATE } = process.env;
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
      if (MODE === "exit") process.exit(3);
      const answer = () => setTimeout(() => {
        writeFileSync(ANSWERED, "1");
        reply(message, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
      }, Number(DELAY_MS ?? 0));
      const opened = () => (!GATE || existsSync(GATE) ? answer() : setTimeout(opened, 10));
      if (message.method === "initialize") opened();
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

type Line = { message: string; text: { key: string; params?: Record<string, string | number> } };

async function mount(server: ReturnType<typeof computer>["server"], startupMs: number, hostComputerMs: number, conversation?: string, lines: Line[] = []) {
  const session = await mountChatTools({ localComputer: server }, controller.signal, true, undefined, undefined, undefined, undefined, undefined, undefined,
    { startupMs, hostComputerMs, ...(conversation ? { conversation } : {}), notice: (line) => lines.push(line as Line) });
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
    // A list remembered with the file tools is never offered by a bridge without them, nor the other way round.
    expect(hostComputerKey(one)).not.toBe(hostComputerKey({ ...one, env: { ...one.env, OMB_HOST_FILES: "1" } }));
  });

  it("is not skipped when slow, and the next turn lists its last tools after a short wait and its first call waits for the start", async () => {
    const driver = `slow-${randomUUID()}`;
    const cold = await mount(computer(driver, { DELAY_MS: "1500" }).server, 10_000, 20_000);
    expect(cold.skipped).toEqual([]);
    expect(names(cold)).toEqual(["computer_write"]);

    const second = computer(driver, { DELAY_MS: "6000" });
    const warm = await mount(second.server, 10_000, 20_000);
    expect(existsSync(second.answered)).toBe(false);
    expect(warm.skipped).toEqual([]);
    expect(names(warm)).toEqual(["computer_write"]);
    await expect(warm.execute("computer_write", { value: "x" }, controller.signal)).resolves.toMatchObject({ ok: true, text: "recorded:x" });
    expect(existsSync(second.answered)).toBe(true);
  }, 30_000);

  it("on a first start slower than the turn's wait, goes on with a stand-in that waits for it and then lists the real tools beside the runtime's own", async () => {
    const starting = computer(`first-${randomUUID()}`, { DELAY_MS: "1200" });
    const lines: Line[] = [];
    const session = await mount(starting.server, 150, 20_000, "c-first", lines);
    expect(existsSync(starting.answered)).toBe(false);
    expect(names(session)).toEqual([HOST_COMPUTER_STAND_IN]);
    const described = session.definitions[0]!.function.description;
    expect(described).toContain("still starting");
    expect(described).toContain("If the person's request needs this computer");
    expect(described).not.toContain("already linked");
    expect(session.view(HOST_COMPUTER_STAND_IN, {})).toMatchObject({ ask: false });
    session.definitions.push({ type: "function", function: { name: "ask_user", description: "Ask", parameters: { type: "object" } } });

    await expect(session.execute(HOST_COMPUTER_STAND_IN, {}, controller.signal)).resolves.toEqual({ ok: true, text: HOST_COMPUTER_READY });
    expect(names(session)).toEqual(["computer_write", "ask_user"]);
    await expect(session.execute("computer_write", { value: "y" }, controller.signal)).resolves.toMatchObject({ ok: true, text: "recorded:y" });
    expect(lines).toEqual([]);
  });

  it("says through a tool, never by leaving it out, that it did not start, and tells the person once per conversation", async () => {
    const lines: Line[] = [];
    const driver = `dead-${randomUUID()}`;
    const session = await mount(computer(driver, { MODE: "exit" }).server, 2_000, 4_000, "c-dead", lines);
    expect(session.skipped).toEqual([]);
    expect(names(session)).toEqual([HOST_COMPUTER_STAND_IN]);
    const described = session.definitions[0]!.function.description;
    expect(described).toContain("unavailable this time (MCP server exited before the session closed");
    expect(described).toContain("Only mention it if the person's request needs this computer");
    expect(described).toContain("never ask the person to link or connect this computer");
    const result = await session.execute(HOST_COMPUTER_STAND_IN, {}, controller.signal);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("not a missing link");
    expect(lines).toEqual([{ message: expect.stringContaining("(their helper stopped). Send your message again in a moment."),
      text: { key: "chat.notice.computerToolsDidNotStart", params: { why: "chat.notice.part.computerToolsHelperStopped" } } }]);

    await mount(computer(driver, { MODE: "exit" }).server, 2_000, 4_000, "c-dead", lines);
    expect(lines[1]).toEqual({ message: "The tools for this computer are still not starting.", text: { key: "chat.notice.computerToolsStillNotStarting" } });
    await mount(computer(driver, { MODE: "exit" }).server, 2_000, 4_000, "c-other", lines);
    expect(lines[2]!.text.key).toBe("chat.notice.computerToolsDidNotStart");
  });

  it("answers a call on the last start's tools with why this start failed, tells the person, and the turn goes on", async () => {
    const driver = `lost-${randomUUID()}`;
    await mount(computer(driver).server, 10_000, 20_000);
    const lines: Line[] = [];
    const session = await mount(computer(driver, { MODE: "silent" }).server, 150, 600, "c-lost", lines);
    expect(names(session)).toEqual(["computer_write"]);
    const result = await session.execute("computer_write", { value: "z" }, controller.signal);
    expect(result).toMatchObject({ ok: false, text: expect.stringContaining("did not start this time (MCP startup timed out)") });
    expect(() => session.validate("computer_write", { value: "z" })).not.toThrow();
    await vi.waitFor(() => expect(lines).toEqual([expect.objectContaining({ text: { key: "chat.notice.computerToolsDidNotStart", params: { why: "chat.notice.part.computerToolsTookTooLong" } } })]));
  });

  it("in a background start, keeps its stand-in while a slower server joins, then lists its own tools beside both", async () => {
    // A driver that failed before gets the short wait, so the turn goes on with the stand-in well inside the other
    // servers' startup budget, and the gated server can join after the mount.
    const driver = `background-${randomUUID()}`;
    await mount(computer(driver, { MODE: "exit" }).server, 5_000, 20_000);
    const starting = computer(driver, { DELAY_MS: "2500" });
    const gate = join(dirs[0]!, `gate-${randomUUID()}`);
    const plain = (env: Record<string, string> = {}) => ({ command: process.execPath, args: [script], env: { ANSWERED: join(dirs[0]!, `answered-${randomUUID()}`), ...env } });
    const ask: ChatToolDefinition = { type: "function", function: { name: "ask_user", description: "Ask", parameters: { type: "object" } } };
    const settled: string[] = [];
    const session = await mountChatTools({ localComputer: starting.server, agents: plain(), custom: { notes: plain({ GATE: gate }) } } as SendTurnInput["integrations"],
      controller.signal, true, undefined, undefined, undefined, undefined, undefined, undefined,
      { startupMs: 5_000, hostComputerMs: 20_000, background: true, onSettled: (server) => settled.push(server) });
    sessions.push(session);
    expect(names(session)).toEqual(["agents_write", HOST_COMPUTER_STAND_IN]);
    expect(settled).not.toContain("notes");
    session.definitions.push(ask);

    writeFileSync(gate, "");
    await vi.waitFor(() => expect(settled).toContain("notes"), { timeout: 10_000, interval: 20 });
    expect(await joinLateChatTools(session, [ask])).toEqual([]);
    expect(names(session)).toEqual(["agents_write", HOST_COMPUTER_STAND_IN, "notes_write", "ask_user"]);

    await expect(session.execute(HOST_COMPUTER_STAND_IN, {}, controller.signal)).resolves.toEqual({ ok: true, text: HOST_COMPUTER_READY });
    expect(names(session)).toEqual(["agents_write", "computer_write", "notes_write", "ask_user"]);
    await expect(session.execute("notes_write", { value: "n" }, controller.signal)).resolves.toMatchObject({ ok: true, text: "recorded:n" });
    expect(await joinLateChatTools(session, [ask]), "nothing left to join").toBeUndefined();
  }, 30_000);
});
