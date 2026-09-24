import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

// Phone exclusivity on the real server (issue #1663): trigger-term matching
// may mount the phone tools, but computer:phone is claimed only at the first
// real tool call and released when the turn settles. A concurrent caller
// gets a blocked tool result, never a dead turn.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
let child: ChildProcess;
let fixtureHome = "";
let base = "";
let dumpFile = "";
let finishFile = "";
let stderr = "";
const PHONE_BUSY_ERROR = "another thread is using the phone";
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await r.json() as any;
  expect(r.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
  return result;
};
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}\n${stderr}`);
    await new Promise(r => setTimeout(r, 40));
  }
}
// The fake CLI writes its dump in one go; a poll can land mid-write, so a
// partial file is "not yet", not a failure.
const dump = () => until(() => {
  if (!existsSync(dumpFile)) return null;
  try { return JSON.parse(readFileSync(dumpFile, "utf8")); } catch { return null; }
}, Boolean);
const idle = (botId: string) => until(() => api("GET", "/api/bots?messages=0"), s => !s.bots.find((b: any) => b.id === botId)?.busy);
const busy = (botId: string) => until(() => api("GET", "/api/bots?messages=0"), s => s.bots.find((b: any) => b.id === botId)?.busy === true);
const phoneSpec = (d: any) => {
  expect(d.mcpConfig?.mcpServers?.phone, "phone tools should be mounted").toBeTruthy();
  return d.mcpConfig.mcpServers.phone;
};
const holdDirectTurn = async (botId: string, text: string) => {
  rmSync(dumpFile, { force: true });
  await api("POST", `/api/bots/${botId}/messages`, { text });
  return phoneSpec(await dump());
};
const holdRoomTurn = async (groupId: string, text: string) => {
  rmSync(dumpFile, { force: true });
  await api("POST", `/api/groups/${groupId}/messages`, { text });
  return phoneSpec(await dump());
};
const noPhoneConflict = async (...botIds: string[]) => {
  const state = await api("GET", "/api/bots?messages=50");
  for (const botId of botIds) {
    const bot = state.bots.find((b: any) => b.id === botId);
    expect(JSON.stringify(bot?.messages ?? [])).not.toContain(PHONE_BUSY_ERROR);
  }
};

// Speak enough MCP to one spawned phone proxy for these tests: initialize,
// then tools/call frames, collecting responses by id.
async function withPhoneProxy<T>(spec: any, run: (call: (name: string) => Promise<any>) => Promise<T>): Promise<T> {
  // Node acts as an inert cross-platform ADB: `node devices -l` runs the
  // synthetic script below. Never discover or contact a real attached phone.
  const proxy = spawn(spec.command, spec.args, { cwd: fixtureHome,
    env: { ...process.env, ...spec.env, HOME: fixtureHome, USERPROFILE: fixtureHome, OMB_ADB_PATH: process.execPath },
    stdio: ["pipe", "pipe", "ignore"] });
  try {
    const responses = new Map<number, any>();
    const wakes: Array<() => void> = [];
    let buffer = "";
    proxy.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined) {
            responses.set(message.id, message);
            for (const wake of wakes.splice(0)) wake();
          }
        } catch {}
      }
    });
    const send = (id: number, method: string, params: unknown) =>
      proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const awaitResponse = async (id: number) => until(() => {
      if (responses.has(id)) return responses.get(id);
      if (proxy.exitCode !== null) throw new Error(`phone proxy exited early: ${proxy.exitCode}`);
      return null;
    }, Boolean);
    send(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "phone-claim-test", version: "1" } });
    await awaitResponse(1);
    proxy.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    let nextId = 2;
    return await run(async (name: string) => {
      send(nextId, "tools/call", { name, arguments: {} });
      return awaitResponse(nextId++);
    });
  } finally {
    proxy.kill("SIGKILL");
  }
}

beforeAll(async () => {
  fixtureHome = mkdtempSync(join(tmpdir(), "omb-phone-claim-"));
  writeFileSync(join(fixtureHome, "devices"), 'process.stdout.write("List of devices attached\\n");');
  dumpFile = join(fixtureHome, "dump.json");
  finishFile = join(fixtureHome, "finish");
  const data = join(fixtureHome, "data");
  const ui = join(fixtureHome, "static");
  mkdirSync(data); mkdirSync(join(ui, "assets"), { recursive: true });
  writeFileSync(join(ui, "index.html"), "<title>Phone claim</title>");
  writeFileSync(join(ui, "assets", "test.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: {
    driver: "claudeAgent", config: { cli: join(ROOT, "server/testing/fake-claude-cli.ts") },
    environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_DUMP: dumpFile, FAKE_CLAUDE_SLOW_FINISH_GATE: finishFile },
  } } }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
    cwd: ROOT, env: {
      PATH: process.env.PATH, HOME: fixtureHome, USERPROFILE: fixtureHome, OMB_DATA_DIR: data,
      APPDATA: join(fixtureHome, "appdata"), LOCALAPPDATA: join(fixtureHome, "localappdata"),
      TEMP: fixtureHome, TMP: fixtureHome, TMPDIR: fixtureHome,
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: ui,
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", () => {});
  child.stderr!.on("data", c => { stderr += c; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(stderr);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, Boolean);
});
afterAll(async () => {
  if (finishFile) writeFileSync(finishFile, "finish");
  await waitForExit(child, { signal: "SIGTERM" });
  if (fixtureHome) await removeTempDir(fixtureHome);
});
const bots: string[] = [];
const rooms: string[] = [];
afterEach(async () => {
  writeFileSync(finishFile, "finish");
  for (const id of rooms.splice(0)) await api("POST", `/api/groups/${id}/interrupt`, {});
  for (const id of bots.splice(0)) {
    await api("POST", `/api/bots/${id}/interrupt`, {}).catch(() => undefined);
    await idle(id).catch(() => undefined);
    await api("DELETE", `/api/bots/${id}`).catch(() => undefined);
  }
});
const makeBot = (name: string) => api("POST", "/api/bots", { name }).then(r => {
  bots.push(r.bot.id);
  return r.bot;
});
const makeRoom = async (name: string, botId: string) => {
  const { group } = await api("POST", "/api/groups", { name, memberIds: [botId],
    setup: { bulletin: "", defaultResponder: { kind: "member", botId } } });
  rooms.push(group.id);
  return group;
};
const roomIdle = (groupId: string) => until(() => api("GET", "/api/bots?messages=0"), s => s.groups.find((g: any) => g.id === groupId)?.working !== true);

describe("Lazy phone claim on the real server", () => {
  it("rejects a retained proxy after its turn settles, before and after a new owner claims", async () => {
    rmSync(finishFile, { force: true });
    const holder = await makeBot("Old retained phone caller");
    const spec = await holdDirectTurn(holder.id, "read my phone");
    await withPhoneProxy(spec, async (oldCall) => {
      expect((await oldCall("status")).result.isError).toBeUndefined();
      writeFileSync(finishFile, "finish");
      await idle(holder.id);
      const afterSettlement = await oldCall("status");
      expect(afterSettlement.result.isError).toBe(true);
      expect(afterSettlement.result.content[0].text).toContain("no longer has phone access");
      rmSync(finishFile, { force: true });
      const next = await makeBot("New phone caller");
      const nextSpec = await holdDirectTurn(next.id, "read my phone");
      await withPhoneProxy(nextSpec, async (newCall) => {
        expect((await newCall("status")).result.isError).toBeUndefined();
        const response = await oldCall("status");
        expect(response.result.isError, JSON.stringify(response)).toBe(true);
        expect(response.result.content[0].text).toContain("no longer has phone access");
      });
    });
  });
  it("mounts the phone for trigger words on both turn paths without claiming it", async () => {
    rmSync(finishFile, { force: true });
    const holder = await makeBot("Android words holder");
    const holderSpec = await holdDirectTurn(holder.id, "help me review this android build log");
    expect(holderSpec.env.OMB_PHONE_TOKEN).toBeTruthy();
    await busy(holder.id);

    const roomBot = await makeBot("Room phone words");
    const room = await makeRoom("Phone words room", roomBot.id);
    await holdRoomTurn(room.id, "draft a note about my mobile app plans");
    await until(() => api("GET", "/api/bots?messages=0"), s => s.groups.find((g: any) => g.id === room.id)?.working === true);

    const second = await makeBot("Second phone asker");
    await holdDirectTurn(second.id, "open uber on my phone");
    await busy(second.id);
    // Three concurrent trigger-word turns, all dispatched, zero claims: with
    // the eager claim any turn after the first died at dispatch instead.
    await noPhoneConflict(holder.id, roomBot.id, second.id);
  });

  it("holds no claim when the trigger word only appears in room history", async () => {
    rmSync(finishFile, { force: true });
    // Room turns match trigger terms over the whole room context, so this
    // covers the history case; a direct turn matches its new message only.
    const roomBot = await makeBot("Room history android");
    const room = await makeRoom("Room history phone room", roomBot.id);
    await holdRoomTurn(room.id, "help me fix this android gradle error");
    writeFileSync(finishFile, "finish");
    await roomIdle(room.id);

    rmSync(finishFile, { force: true });
    // The new message has no trigger word; the room context does. The tools
    // stay mounted (follow-up room turns keep them) but nothing is claimed.
    await holdRoomTurn(room.id, "now give a short status update");
    await until(() => api("GET", "/api/bots?messages=0"), s => s.groups.find((g: any) => g.id === room.id)?.working === true);

    const other = await makeBot("Unrelated phone user");
    await holdDirectTurn(other.id, "open uber on my phone");
    await busy(other.id);
    await noPhoneConflict(roomBot.id, other.id);
  });

  it("claims at the first tool call, blocks the concurrent caller, and releases at turn end", async () => {
    rmSync(finishFile, { force: true });
    const holder = await makeBot("First phone caller");
    const holderSpec = await holdDirectTurn(holder.id, "read what is on my phone");
    const other = await makeBot("Concurrent phone caller");
    const otherSpec = await holdDirectTurn(other.id, "open uber on my phone");

    await withPhoneProxy(holderSpec, async (call) => {
      const status = await call("status");
      expect(status.result.isError).toBeUndefined();
      expect(status.result.content[0].text).toContain("available");
    });
    // The proxy's call claimed computer:phone for holder's turn: the same
    // owner may re-claim, a concurrent turn may not.
    const claim = (token: string) => fetch(base + "/api/internal/phone/claim", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}",
    });
    expect((await claim(holderSpec.env.OMB_PHONE_TOKEN)).status).toBe(200);
    expect((await claim(otherSpec.env.OMB_PHONE_TOKEN)).status).toBe(409);

    await withPhoneProxy(otherSpec, async (call) => {
      const blocked = await call("status");
      expect(blocked.result).toMatchObject({ isError: true });
      expect(blocked.result.content[0].text).toBe("Another thread is using the phone. This call was not performed. Pause phone work until that thread finishes, then read the screen again before acting.");
      // The blocked result is an answer inside the turn, not a dispatch
      // failure: the turn stays alive and can try again once the holder ends.
      await busy(other.id);
      await api("POST", `/api/bots/${holder.id}/interrupt`, {});
      await idle(holder.id);
      const retried = await call("status");
      expect(retried.result.isError).toBeUndefined();
      expect(retried.result.content[0].text).toContain("available");
    });
  });
});
