import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

import { mountChatTools, withHostFileTools, type ChatToolSession } from "./drivers/chat-mcp-tools.ts";
import { gatedLocalComputer, withHostFiles } from "./local-computer.ts";

// A disposable stand-in for this computer's driver: it lists one screen tool (and a read_file of its own, which the
// bridge's must replace) and reports every call it was handed. It never opens a screen.
const FAKE_DRIVER = `
const readline = require("node:readline");
const seen = [];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === "initialize") {
    result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cua-driver", version: "0.41.3" } };
    return setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n"), Number(process.env.FAKE_DELAY_MS ?? 0));
  }
  else if (message.method === "tools/list") result = { tools: [
    { name: "screenshot", description: "Screen", inputSchema: { type: "object", properties: {} } },
    { name: "read_file", description: "driver's own", inputSchema: { type: "object", properties: {} } },
  ] };
  else { seen.push(message.params.name); result = { content: [{ type: "text", text: JSON.stringify(seen) }] }; }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;

const FILE_TOOLS = ["list_files", "read_file", "write_file", "make_folder"];

async function controlServer() {
  const state = { held: false, asked: [] as string[] };
  const server = createServer((request, response) => {
    state.asked.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(state.held ? { held: true, helpOpen: false, blockedReason: "Another thread is using this computer." } : { held: false, helpOpen: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const control = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/control`, token: "fixture-token" };
  return { state, control, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const driver = (env: Record<string, string> = {}) =>
  ({ command: process.execPath, args: ["-e", FAKE_DRIVER], env, platform: process.platform as "darwin" | "linux" | "win32", scope: "local-computer" as const });

async function thisComputer(home: string, files: boolean) {
  const gate = await controlServer();
  const gated = gatedLocalComputer(driver(), gate.control);
  const connection = files ? withHostFiles(gated) : gated;
  const child: ChildProcess = spawn(connection.command, connection.args, {
    env: { ...process.env, ...connection.env, HOME: home, USERPROFILE: home, OMB_EXTRA_PATH: dirname(process.execPath) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (line) => {
    const message = JSON.parse(line);
    replies.get(message.id)?.(message);
    replies.delete(message.id);
  });
  let nextId = 0;
  const rpc = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 20_000);
      replies.set(id, (value) => { clearTimeout(timer); resolve(value.result); });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await rpc("tools/call", { name, arguments: args });
    return { text: result.content.map((part: { text: string }) => part.text).join("\n") as string, error: result.isError === true };
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
  return {
    rpc, call,
    hold(value: boolean) { gate.state.held = value; },
    asked: gate.state.asked,
    async close() {
      child.kill("SIGKILL");
      await gate.close();
    },
  };
}

describe("file tools on this computer, through its bridge", () => {
  it("lists them beside the screen tools, asks the approval gate, and saves on any full path", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-host-files-e2e-"));
    const home = join(root, "home");
    for (const dir of ["OneDrive/Documentos", "Desktop"]) mkdirSync(join(home, dir), { recursive: true });
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(home, "Desktop", "elsewhere"), "junction");
    const computer = await thisComputer(home, true);
    try {
      const real = realpathSync(home);
      const listed = (await computer.rpc("tools/list")).tools;
      expect(listed.map((tool: { name: string }) => tool.name)).toEqual(["screenshot", ...FILE_TOOLS]);
      expect(listed.find((tool: { name: string }) => tool.name === "read_file").description).not.toBe("driver's own");

      const homeListed = await computer.call("list_files");
      expect(computer.asked.at(-1)).toContain("files=1");
      expect(homeListed.text.split("\n")).toEqual(expect.arrayContaining([real, "folder  Desktop", "folder  OneDrive"]));

      const target = join(home, "OneDrive", "Documentos", "My Agents", "Vendas", "resumo.md");
      const saved = await computer.call("write_file", { path: target, content: "# Resumo\nolá" });
      expect(computer.asked.at(-1)).toContain("files=1");
      const written = join(real, "OneDrive", "Documentos", "My Agents", "Vendas", "resumo.md");
      expect(saved).toEqual({ text: `Saved 13 bytes to ${written}.`, error: false });
      expect(readFileSync(written, "utf8")).toBe("# Resumo\nolá");

      const again = await computer.call("write_file", { path: target, content: "other" });
      expect(again.error).toBe(true);
      expect(again.text).toMatch(/already exists.*overwrite: true/);
      expect(readFileSync(written, "utf8")).toBe("# Resumo\nolá");
      expect(await computer.call("write_file", { path: target, content: "novo", overwrite: true }))
        .toEqual({ text: `Saved 4 bytes to ${written} (replaced the file that was there).`, error: false });
      expect(readdirSync(dirname(written))).toEqual(["resumo.md"]);

      expect(await computer.call("read_file", { path: target })).toEqual({ text: `${written} (4 bytes):\nnovo`, error: false });
      expect((await computer.call("read_file", { path: target, encoding: "base64" })).text).toContain(Buffer.from("novo").toString("base64"));
      writeFileSync(join(home, "Desktop", "image.bin"), Buffer.from([0xff, 0xfe, 0x00]));
      expect((await computer.call("read_file", { path: join(home, "Desktop", "image.bin") })).text).toMatch(/encoding base64/);

      expect((await computer.call("make_folder", { path: join(home, "Desktop", "Novo", "Sub") })).text).toBe(`Made the folder ${join(real, "Desktop", "Novo", "Sub")}.`);
      const folder = await computer.call("list_files", { path: join(home, "Desktop") });
      expect(folder.text.split("\n")).toEqual(expect.arrayContaining([join(real, "Desktop"), "folder  Novo", "link    elsewhere", "file    image.bin (3 bytes)"]));

      // No app-side path rules: hidden folders, a link out, outside home and script files all save.
      const realRoot = realpathSync(root);
      for (const [path, at] of [
        [join(home, ".ssh", "config"), join(real, ".ssh", "config")],
        [join(home, "Projects", "site", ".git", "hooks", "pre-commit"), join(real, "Projects", "site", ".git", "hooks", "pre-commit")],
        [join(home, "Desktop", "elsewhere", "x.txt"), join(realRoot, "outside", "x.txt")],
        [join(root, "outside", "run.bat"), join(realRoot, "outside", "run.bat")],
      ] as const) {
        expect(await computer.call("write_file", { path, content: "x" }), path).toEqual({ text: `Saved 1 bytes to ${at}.`, error: false });
      }
      expect(readdirSync(join(root, "outside")).sort()).toEqual(["run.bat", "x.txt"]);
      expect((await computer.call("write_file", { path: "notes.txt", content: "x" })).text).toMatch(/full path/);

      computer.hold(true);
      const gated = await computer.call("write_file", { path: join(home, "Desktop", "while-held.txt"), content: "x" });
      expect(gated).toEqual({ text: "Another thread is using this computer.", error: true });
      expect(readdirSync(join(home, "Desktop"))).not.toContain("while-held.txt");
      computer.hold(false);

      // The driver itself was never handed a file call.
      expect(JSON.parse((await computer.call("screenshot")).text)).toEqual(["screenshot"]);
    } finally {
      await computer.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("reach a chat bot as computer tools, and stay in the list the next turn remembers while the driver starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-host-files-e2e-"));
    const home = join(root, "home");
    mkdirSync(join(home, "Documents"), { recursive: true });
    const gate = await controlServer();
    const controller = new AbortController();
    const sessions: ChatToolSession[] = [];
    // The first start gets the whole start budget, so a slow runner lists the real tools instead of the stand-in
    // (computer_tools_status, chat-host-computer.ts); a later turn waits only briefly and goes on with the list remembered.
    const mount = async (env: Record<string, string>, startupMs: number) => {
      const turn = withHostFileTools({ localComputer: gatedLocalComputer(driver(env), gate.control) });
      const localComputer = { ...turn!.localComputer!, env: { ...turn!.localComputer!.env, HOME: home, USERPROFILE: home } };
      const session = await mountChatTools({ localComputer }, controller.signal, true, undefined, undefined, undefined, undefined, undefined, undefined, { startupMs, hostComputerMs: 20_000 });
      sessions.push(session);
      return session;
    };
    const names = (session: ChatToolSession) => session.definitions.map((definition) => definition.function.name);
    try {
      const cold = await mount({}, 20_000);
      expect(names(cold)).toEqual(["computer_screenshot", ...FILE_TOOLS.map((name) => `computer_${name}`)]);
      const asked = Date.now();
      const warm = await mount({ FAKE_DELAY_MS: "2500" }, 300);
      expect(Date.now() - asked).toBeLessThan(2_000);
      expect(names(warm)).toEqual(names(cold));
      const saved = await warm.execute("computer_write_file", { path: join(home, "Documents", "nota.txt"), content: "oi" }, controller.signal);
      expect(saved).toMatchObject({ ok: true, text: `Saved 2 bytes to ${join(realpathSync(home), "Documents", "nota.txt")}.` });
      expect(readFileSync(join(home, "Documents", "nota.txt"), "utf8")).toBe("oi");
    } finally {
      controller.abort();
      await Promise.all(sessions.map((session) => session.close().catch(() => {})));
      await gate.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("lists no file tools on a bridge that was not given them", async () => {
    const root = mkdtempSync(join(tmpdir(), "omb-host-files-e2e-"));
    const computer = await thisComputer(root, false);
    try {
      expect((await computer.rpc("tools/list")).tools.map((tool: { name: string }) => tool.name)).toEqual(["screenshot", "read_file"]);
    } finally {
      await computer.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
