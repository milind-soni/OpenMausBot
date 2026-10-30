import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { customMcpServers, type AppConfig } from "./config.ts";
import { addBotMcpServer, botFolderUse, claimBotMcpServers, keepInBotFolder, withoutBotMcpServers } from "./mcp-bot-servers.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-mcp-bot-servers-"));
  dirs.push(dir);
  return dir;
}

function file(path: string, text = "print('hi')\n"): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const python = (script: string) => ({ command: "/usr/bin/python3", args: [script], env: {} });

describe("whose folders a command server's files are in", () => {
  it("names the bot of a workspace path, and the conversation entry of a task-workspace path", () => {
    const data = resolve("/data"), at = (...parts: string[]) => join(data, ...parts);
    expect(botFolderUse(python(at("workspaces", "iris", "tools", "blender-mcp", "server.py")), data)).toEqual({ botId: "iris", temporary: [] });
    expect(botFolderUse(python(at("task-workspaces", "iris", "t1", "blender-mcp", "server.py")), data))
      .toEqual({ botId: "iris", temporary: [at("task-workspaces", "iris", "t1", "blender-mcp")] });
    expect(botFolderUse({ command: "node", args: [`--root=${at("task-workspaces", "iris", "t2")}`], env: {} }, data))
      .toEqual({ botId: "iris", temporary: [at("task-workspaces", "iris", "t2")] });
    expect(botFolderUse({ command: "python3", args: ["-m", "srv"], env: { PYTHONPATH: at("workspaces", "iris", "tools", "lib") } }, data))
      .toEqual({ botId: "iris", temporary: [] });
  });

  it("is no bot's for a command outside the data folder, and several bots' when it mixes them", () => {
    const data = resolve("/data");
    expect(botFolderUse({ command: "npx", args: ["-y", "@x/notes-mcp"], env: {} }, data)).toBeNull();
    expect(botFolderUse(python(resolve("/elsewhere", "workspaces", "iris", "server.py")), data)).toBeNull();
    expect(botFolderUse({ command: "/usr/bin/python3", args: [join(data, "workspaces", "iris", "a.py"), join(data, "workspaces", "paul", "b.py")], env: {} }, data)).toBe("several");
  });
});

describe("keeping a conversation folder's server in the bot's own folder", () => {
  it("copies the folder under tools/, picks a free name, and points the server there", () => {
    const data = dataDir();
    file(join(data, "workspaces", "iris", "tools", "blender-mcp", "server.py"), "existing\n");
    const script = file(join(data, "task-workspaces", "iris", "t1", "blender-mcp", "server.py"), "made in a chat\n");
    file(join(data, "task-workspaces", "iris", "t1", "blender-mcp", "helper.py"));
    const server = { ...python(script), env: { BLENDER_ADDON: join(data, "task-workspaces", "iris", "t1", "blender-mcp", "addon") }, enabled: true };
    const kept = keepInBotFolder(server, botFolderUse(server, data) as never, data);
    if (!kept.ok) throw new Error(kept.error);
    const target = join(data, "workspaces", "iris", "tools", "blender-mcp-2");
    expect(kept.server.args).toEqual([join(target, "server.py")]);
    expect(kept.server.env.BLENDER_ADDON).toBe(join(target, "addon"));
    expect(readFileSync(join(target, "server.py"), "utf8")).toBe("made in a chat\n");
    expect(existsSync(join(target, "helper.py"))).toBe(true);
    expect(readFileSync(join(data, "workspaces", "iris", "tools", "blender-mcp", "server.py"), "utf8")).toBe("existing\n");
  });

  it("refuses to write through a tools link the bot pointed elsewhere", () => {
    const data = dataDir();
    const elsewhere = join(data, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(data, "workspaces", "iris"), { recursive: true });
    symlinkSync(elsewhere, join(data, "workspaces", "iris", "tools"));
    const server = { ...python(file(join(data, "task-workspaces", "iris", "t1", "srv", "server.py"))), enabled: true };
    const kept = keepInBotFolder(server, botFolderUse(server, data) as never, data);
    expect(kept.ok).toBe(false);
    expect(existsSync(join(elsewhere, "srv"))).toBe(false);
  });

  it("says so when the conversation folder is gone", () => {
    const data = dataDir();
    const server = { ...python(join(data, "task-workspaces", "iris", "gone", "srv", "server.py")), enabled: true };
    expect(keepInBotFolder(server, botFolderUse(server, data) as never, data)).toEqual({ ok: false, error: expect.stringMatching(/folder is gone/) });
  });
});

describe("existing installs", () => {
  it("makes the servers in one bot's folders that bot's own, keeping chat-folder files, and leaves every bot's servers alone", () => {
    const data = dataDir();
    const sketch = file(join(data, "task-workspaces", "iris", "t1", "native-sketch", "server.py"));
    const blender = file(join(data, "task-workspaces", "iris", "t2", "blender-mcp", "server.py"));
    const irisOwn = file(join(data, "workspaces", "iris", "tools", "blender-mcp", "server.py"));
    const raw = {
      "sketch-suite": { ...python(sketch), enabled: true },
      blender: { ...python(blender), enabled: true },
      "blender-own": { ...python(irisOwn), enabled: true },
      notes: { command: "npx", args: ["-y", "@x/notes-mcp"], env: {}, enabled: true },
      docs: { type: "http", url: "https://docs.example/mcp", headers: {}, enabled: true },
    };
    const claimed = claimBotMcpServers(raw, data, (botId) => botId === "iris");
    expect(claimed?.claimed).toEqual({ iris: ["sketch-suite", "blender", "blender-own"] });
    const next = claimed!.next as Record<string, { bot?: string; args?: string[] }>;
    expect(next["sketch-suite"]).toMatchObject({ bot: "iris", args: [join(data, "workspaces", "iris", "tools", "native-sketch", "server.py")] });
    expect(next.blender).toMatchObject({ bot: "iris", args: [join(data, "workspaces", "iris", "tools", "blender-mcp-2", "server.py")] });
    expect(next["blender-own"]).toMatchObject({ bot: "iris", args: [irisOwn] });
    expect(next.notes).toBe(raw.notes);
    expect(next.docs).toBe(raw.docs);
    expect(claimBotMcpServers(claimed!.next, data, () => true), "a second pass changes nothing").toBeNull();

    const cfg = { mcpServers: claimed!.next } as AppConfig;
    expect(Object.keys(customMcpServers(cfg, undefined, "iris")).sort()).toEqual(["blender", "blender-own", "docs", "notes", "sketch-suite"]);
    expect(Object.keys(customMcpServers(cfg, undefined, "paul")).sort(), "another bot never starts them").toEqual(["docs", "notes"]);
    expect(Object.keys(customMcpServers(cfg)).sort(), "nor does a turn of no bot").toEqual(["docs", "notes"]);
  });

  it("still makes it the bot's own when its chat folder is gone", () => {
    const data = dataDir();
    const raw = { lost: { ...python(join(data, "task-workspaces", "iris", "t9", "srv", "server.py")), enabled: true } };
    expect(claimBotMcpServers(raw, data, () => true)?.next.lost).toMatchObject({ bot: "iris", args: [raw.lost.args[0]] });
  });

  it("never makes a server the own of a bot that no longer exists: its leftover folder is nobody's", () => {
    const data = dataDir();
    const raw = { leftover: { ...python(file(join(data, "workspaces", "gone", "tools", "srv", "server.py"))), enabled: true } };
    expect(claimBotMcpServers(raw, data, (botId) => botId === "iris")).toBeNull();
  });

  it("drops a deleted bot's own servers and nothing else", () => {
    const raw = { mine: { ...python("/d/workspaces/iris/s.py"), enabled: true, bot: "iris" }, notes: { command: "npx", args: [], env: {}, enabled: true } };
    expect(withoutBotMcpServers(raw, "iris")).toEqual({ notes: raw.notes });
    expect(withoutBotMcpServers(raw, "paul")).toBeNull();
  });
});

describe("a bot adding a server where bots are boxed", () => {
  it("makes one in its own folder its own, saved off as always", () => {
    const data = dataDir();
    const script = file(join(data, "task-workspaces", "iris", "t1", "srv", "server.py"));
    const added = addBotMcpServer({}, { name: "blender", ...python(script) }, "iris", data, true);
    if (!added.ok) throw new Error(added.error);
    expect(added.server).toMatchObject({ bot: "iris", enabled: false, args: [join(data, "workspaces", "iris", "tools", "srv", "server.py")] });
    expect(added.moved).toEqual([{ from: join(data, "task-workspaces", "iris", "t1", "srv"), to: join(data, "workspaces", "iris", "tools", "srv") }]);
    expect(added.next.blender).toBe(added.server);
  });

  it("refuses one that uses another bot's files, and keeps a plain command every bot's", () => {
    const data = dataDir();
    expect(addBotMcpServer({}, { name: "theirs", ...python(join(data, "workspaces", "paul", "s.py")) }, "iris", data, true))
      .toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/another bot's folder/) });
    const plain = addBotMcpServer({}, { name: "notes", command: "npx", args: ["-y", "@x/notes-mcp"] }, "iris", data, true);
    expect(plain.ok && plain.server).toEqual({ command: "npx", args: ["-y", "@x/notes-mcp"], env: {}, enabled: false });
  });
});

describe("a bot adding a server where every bot reaches every folder (a desktop)", () => {
  it("still keeps files from a conversation folder in its own folder, but the server stays every bot's", () => {
    const data = dataDir();
    const script = file(join(data, "task-workspaces", "iris", "t1", "srv", "server.py"));
    const added = addBotMcpServer({}, { name: "blender", ...python(script) }, "iris", data, false);
    if (!added.ok) throw new Error(added.error);
    expect(added.server).toEqual({ ...python(join(data, "workspaces", "iris", "tools", "srv", "server.py")), enabled: false });
    expect(added.moved).toHaveLength(1);
    const theirs = addBotMcpServer({}, { name: "theirs", ...python(join(data, "workspaces", "paul", "s.py")) }, "iris", data, false);
    expect(theirs.ok && theirs.server, "another bot's files are reachable here").toMatchObject({ args: [join(data, "workspaces", "paul", "s.py")] });
    expect(theirs.ok && "bot" in theirs.server).toBe(false);
  });
});
