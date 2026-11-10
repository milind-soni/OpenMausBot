import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { COMPUTER_HELPER_STOPPED } from "../shared/your-computer.ts";
import { createChildCalls } from "./mcp-bridge.ts";

const STOPPED = "Computer control stopped; try again in a few seconds.";
const homes: string[] = [];
const bridges: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const bridge of bridges.splice(0)) if (bridge.exitCode === null) bridge.kill("SIGKILL");
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function bridgeHome(helperBody: string) {
  const home = mkdtempSync(join(tmpdir(), "omb-bridge-respawn-"));
  homes.push(home);
  const log = join(home, "helper.log");
  const helper = join(home, "fake-helper.mjs");
  writeFileSync(helper, `
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const logFile = ${JSON.stringify(log)};
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
appendFileSync(logFile, "start\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") { appendFileSync(logFile, "initialize " + JSON.stringify(frame.params) + "\\n"); send({ jsonrpc: "2.0", id: frame.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "9.9.9" } } }); return; }
  if (frame.method === "notifications/initialized") { appendFileSync(logFile, "initialized\\n"); return; }
  ${helperBody}
});
`);
  const entry = join(home, "bridge-entry.ts");
  writeFileSync(entry, `
import { runMcpBridge } from ${JSON.stringify(pathToFileURL(resolve("server/mcp-bridge.ts")).href)};
runMcpBridge({ command: process.execPath, args: [${JSON.stringify(helper)}], label: "fake", respawn: { stopped: ${JSON.stringify(STOPPED)} } });
`);
  return { home, log, entry, helper };
}

function startBridge(entry: string, env: NodeJS.ProcessEnv = {}) {
  const bridge = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", entry], { stdio: ["pipe", "pipe", "pipe"], cwd: resolve("."), env: { ...process.env, PATH: process.env.PATH ?? "", ...env } });
  bridges.push(bridge);
  let buffered = "";
  const frames: any[] = [];
  const waiters: Array<() => void> = [];
  bridge.stdout.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      frames.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
      for (const wake of waiters.splice(0)) wake();
    }
  });
  const reply = async (id: number, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = frames.find((frame) => frame.id === id);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no reply to ${id}`);
      await new Promise<void>((settle) => {
        const timer = setTimeout(settle, left);
        waiters.push(() => { clearTimeout(timer); settle(); });
      });
    }
  };
  const write = (frame: unknown) => bridge.stdin.write(JSON.stringify(frame) + "\n");
  const initialize = async (id: number) => {
    write({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent", version: "1" } } });
    await reply(id);
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
  };
  const call = (id: number, name: string) => write({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
  return { bridge, reply, call, initialize };
}

const CRASHES = `
  if (frame.method === "tools/call" && ["crash", "click"].includes(frame.params.name)) process.exit(1);
  if (frame.method === "tools/call") send({ jsonrpc: "2.0", id: frame.id, result: { content: [{ type: "text", text: "ok" }] } });
`;

describe("the bridge survives a helper that dies", () => {
  it("answers the call the helper died under, then a new helper serves the next call", async () => {
    const { log, entry } = bridgeHome(CRASHES);
    const { bridge, call, reply, initialize } = startBridge(entry);
    await initialize(1);
    call(2, "echo");
    expect((await reply(2)).result.content[0].text).toBe("ok");

    call(3, "crash");
    const stopped = await reply(3);
    expect(stopped.result.isError).toBe(true);
    expect(JSON.stringify(stopped)).toContain(STOPPED);
    expect(JSON.stringify(stopped)).not.toMatch(/transport closed/i);
    expect(bridge.exitCode).toBeNull();

    call(4, "echo");
    expect((await reply(4)).result.content[0].text).toBe("ok");
    const helperLog = readFileSync(log, "utf8");
    expect(helperLog.match(/^start$/gm)).toHaveLength(2);
    expect(helperLog.match(/^initialize /gm)).toHaveLength(2);
    expect(helperLog.match(/^initialized$/gm)).toHaveLength(2);
    expect(helperLog).toContain('"clientInfo":{"name":"agent"');
    bridge.stdin.end();
    await new Promise((settle) => bridge.once("close", settle));
  }, 30_000);

  it("says the helper stopped when it does not come back, and stays up for the next call", async () => {
    const { helper, entry } = bridgeHome(CRASHES);
    const { bridge, call, reply, initialize } = startBridge(entry);
    await initialize(1);
    call(2, "echo");
    await reply(2);
    call(3, "crash");
    await reply(3);
    writeFileSync(helper, "process.exit(1);\n");
    const asked = Date.now();
    call(4, "echo");
    const answer = await reply(4, 20_000);
    expect(answer.result.isError).toBe(true);
    expect(JSON.stringify(answer)).toContain(STOPPED);
    expect(Date.now() - asked).toBeLessThan(15_000);
    expect(bridge.exitCode).toBeNull();
    bridge.stdin.end();
    await new Promise((settle) => bridge.once("close", settle));
  }, 45_000);

  it("without respawn the bridge still ends with its helper", async () => {
    const { entry, home } = bridgeHome(CRASHES);
    const body = readFileSync(entry, "utf8").replace(/ respawn: \{[^}]*\} /, " ");
    expect(body).not.toContain("respawn:");
    const plain = join(home, "bridge-entry-plain.ts");
    writeFileSync(plain, body);
    const { bridge, call, initialize } = startBridge(plain);
    await initialize(1);
    const closed = new Promise<number | null>((settle) => bridge.once("close", settle));
    call(2, "crash");
    await expect(Promise.race([closed, new Promise((settle) => setTimeout(() => settle("timeout"), 15_000))])).resolves.not.toBe("timeout");
    expect(existsSync(home)).toBe(true);
  }, 30_000);
});

describe("the local computer proxy", () => {
  it.each([
    ["a forwarded call", "darwin", "crash"],
    ["a call the bridge relays itself", "win32", "click"],
  ])("keeps the agent's connection through a driver crash under %s and tells the bot in plain words", async (_label, platform, tool) => {
    const { helper } = bridgeHome(CRASHES);
    const gate = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ held: false, helpOpen: false }));
    });
    await new Promise<void>((settle) => gate.listen(0, "127.0.0.1", settle));
    try {
      const { port } = gate.address() as AddressInfo;
      const { bridge, call, reply, initialize } = startBridge(resolve("server/local-computer-proxy.ts"), {
        OMB_CUA_COMMAND: process.execPath,
        OMB_CUA_ARGS: JSON.stringify([helper]),
        OMB_CUA_PLATFORM: platform,
        OMB_CONTROL_URL: `http://127.0.0.1:${port}/control`,
        OMB_CONTROL_TOKEN: "fixture-token",
        OMB_COMPUTER_JOURNAL: "0",
      });
      await initialize(1);
      call(2, tool);
      const stopped = await reply(2);
      expect(stopped.result).toMatchObject({ isError: true, content: [{ type: "text", text: COMPUTER_HELPER_STOPPED }] });
      expect(JSON.stringify(stopped)).not.toMatch(/transport closed/i);
      call(3, "echo");
      expect((await reply(3)).result.content[0].text).toBe("ok");
      bridge.stdin.end();
      await new Promise((settle) => bridge.once("close", settle));
    } finally {
      await new Promise((settle) => gate.close(settle));
    }
  }, 30_000);
});

describe("createChildCalls", () => {
  it("answers with the plain sentence when given one", async () => {
    const children = createChildCalls(() => {}, STOPPED);
    const waiting = children.forCall(undefined).call("click", {});
    children.close();
    await expect(waiting).resolves.toMatchObject({ isError: true, content: [{ text: STOPPED }] });
  });
});
