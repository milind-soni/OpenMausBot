// POSIX-gated like the other CLI e2es: the fake is a shebang script.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { antigravityCliTokenPath } from "./drivers/antigravity-acp.ts";
import { workerPort } from "./testing/worker-port.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = workerPort(19900, 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("Antigravity CLI steer through the message route", () => {
  let child: ChildProcess;
  let home: string, tools: string;
  // One Antigravity instance per test, each with its own gates and log.
  const NAMES = ["agy", "agyLate", "agyQueue", "agyQueueFull", "agyRoom"];
  const cli = (name: string) => ({ finishGate: join(tools, `${name}.finish`), rejectGate: join(tools, `${name}.reject`), rpc: join(tools, `${name}.rpc.jsonl`) });
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  // The turn's own CLI (a chat's or a room's folder), not the one the server starts in a scratch folder to read the account's memory model.
  const calls = (name: string, method: string) => existsSync(cli(name).rpc) ? readFileSync(cli(name).rpc, "utf8").split("\n")
    .filter((line) => line.includes(`"${method}"`) && /[/\\](task-)?workspaces[/\\]/.test(line)).length : 0;
  const waitFor = async (predicate: () => Promise<boolean> | boolean, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-agy-steer-"));
    tools = mkdtempSync(join(tmpdir(), "omb-agy-steer-cli-"));
    const data = join(home, ".openmausbot");
    mkdirSync(data, { recursive: true });
    chmodSync(FAKE_ACP, 0o755);
    const executable = join(tools, "antigravity");
    writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_ACP)} "$@"\n`);
    chmodSync(executable, 0o755);
    for (const token of NAMES.map((name) => antigravityCliTokenPath(name, data))) {
      mkdirSync(dirname(token), { recursive: true });
      writeFileSync(token, "{}", { mode: 0o600 });
    }
    const instance = (name: string) => ({
      driver: "antigravityAgent",
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODELS: "gemini-3.8-flash", FAKE_ACP_MODES: "default,plan",
        FAKE_ACP_AGENT_NAME: "Antigravity ACP Server", FAKE_ACP_VERSION: "1.5.15", FAKE_ACP_AGENT_VERSION: "1.5.15",
        FAKE_ACP_MODE: "antigravity-steer", FAKE_ACP_GATE_FILE: cli(name).finishGate, FAKE_ACP_RPC_APPEND_FILE: cli(name).rpc,
        FAKE_ACP_STEER_FAIL: "asking-late", FAKE_ACP_STEER_FAIL_GATE: cli(name).rejectGate,
      },
      config: { cli: executable, fullAuto: true },
    });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: Object.fromEntries(NAMES.map((name) => [name, instance(name)])) }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, OMB_PORT: String(PORT), OMB_ANTIGRAVITY_NATIVE_CLI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      return fetch(`${BASE}/api/health`).then((res) => res.ok, () => false);
    }, "the server", 20_000);
  }, 30_000);

  afterAll(async () => {
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  });

  it("a message the CLI rejects only after a while is queued once, never shown as steered, and runs as the next turn", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "agy", model: "gemini-3.8-flash" } })).status).toBe(200);
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "Build the report." })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true && calls("agy", "session/prompt") === 1, "the turn to start");

    const sent = api("POST", `/api/bots/${created.id}/messages`, { text: "Use pytest." });
    await waitFor(() => calls("agy", "session/prompt.held") === 1, "the CLI to hold the steer");
    // Past the 5 s after which a steer used to be reported as possibly taken in and recorded as steered.
    await new Promise((r) => setTimeout(r, 6_000));
    writeFileSync(cli("agy").rejectGate, "reject");
    const answer = await sent;
    expect(answer.status).toBe(202);
    expect(answer.body).toMatchObject({ ok: true, queued: true, queueId: expect.any(String) });
    expect(answer.body.steered).toBeUndefined();

    writeFileSync(cli("agy").finishGate, "finish");
    await waitFor(async () => {
      const bot = await getBot(created.id);
      return !bot.busy && bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text.includes("done")).length === 2;
    }, "the queued message to run after the first turn");
    const bot = await getBot(created.id);
    const typed = bot.messages.filter((m: any) => m.role === "user" && m.kind === "text");
    expect(typed.map((m: any) => m.text)).toEqual(["Build the report.", "Use pytest."]);
    expect(typed.some((m: any) => m.steered)).toBe(false);
    expect(calls("agy", "session/prompt.rejected")).toBe(1);
    expect(calls("agy", "session/prompt")).toBe(3);
  }, 60_000);

  it("a message taken as steered that the CLI rejects once the turn's own run has ended loses the mark and runs once as the next turn", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "agyLate", model: "gemini-3.8-flash" } })).status).toBe(200);
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "Build the report." })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true && calls("agyLate", "session/prompt") === 1, "the turn to start");

    const sent = api("POST", `/api/bots/${created.id}/messages`, { text: "Use pytest." });
    await waitFor(() => calls("agyLate", "session/prompt.held") === 1, "the CLI to hold the steer");
    writeFileSync(cli("agyLate").finishGate, "finish");
    const answer = await sent;
    expect(answer.status).toBe(202);
    expect(answer.body).toMatchObject({ ok: true, steered: true });
    const steeredRow = (await getBot(created.id)).messages.find((m: any) => m.role === "user" && m.text === "Use pytest.");
    expect(steeredRow.steered).toBe(true);

    writeFileSync(cli("agyLate").rejectGate, "reject");
    await waitFor(async () => {
      const bot = await getBot(created.id);
      return !bot.busy && calls("agyLate", "session/prompt") === 3
        && bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text.includes("done")).length === 2;
    }, "the refused message to run after the first turn");
    const bot = await getBot(created.id);
    const typed = bot.messages.filter((m: any) => m.role === "user" && m.kind === "text");
    expect(typed.map((m: any) => m.text)).toEqual(["Build the report.", "Use pytest."]);
    expect(typed[1].id).toBe(steeredRow.id);
    expect(typed.some((m: any) => m.steered)).toBe(false);
    expect(bot.messages.some((m: any) => m.kind === "error")).toBe(false);
    expect(calls("agyLate", "session/prompt.rejected")).toBe(1);
  }, 60_000);

  it("the queue's Steer button: messages the CLI rejects once the turn's own run has ended lose the mark and run once, in order, as the next turn", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "agyQueue", model: "gemini-3.8-flash" } })).status).toBe(200);
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "Build the report." })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true && calls("agyQueue", "session/prompt") === 1, "the turn to start");
    const first = await api("POST", `/api/bots/${created.id}/messages`, { text: "Use pytest.", followUp: "queue" });
    const second = await api("POST", `/api/bots/${created.id}/messages`, { text: "Add a README.", followUp: "queue" });
    expect([first.body.queued, second.body.queued]).toEqual([true, true]);

    const pressed = api("POST", `/api/bots/${created.id}/queue/${first.body.queueId}/steer`, { threadId: created.threadId });
    await waitFor(() => calls("agyQueue", "session/prompt.held") === 1, "the CLI to hold the steer");
    writeFileSync(cli("agyQueue").finishGate, "finish");
    const answer = await pressed;
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, steered: true, queueIds: [first.body.queueId, second.body.queueId] });
    const rows = answer.body.messages.map((m: any) => m.id);
    expect(answer.body.messages.map((m: any) => [m.text, m.steered])).toEqual([["Use pytest.", true], ["Add a README.", true]]);

    writeFileSync(cli("agyQueue").rejectGate, "reject");
    await waitFor(async () => {
      const bot = await getBot(created.id);
      return !bot.busy && calls("agyQueue", "session/prompt") >= 3
        && bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text.includes("done")).length >= 2;
    }, "the refused messages to run after the first turn");
    const bot = await getBot(created.id);
    const typed = bot.messages.filter((m: any) => m.role === "user" && m.kind === "text");
    expect(typed.map((m: any) => m.text)).toEqual(["Build the report.", "Use pytest.", "Add a README."]);
    expect(typed.slice(1).map((m: any) => m.id)).toEqual(rows);
    expect(typed.some((m: any) => m.steered)).toBe(false);
    expect(bot.messages.some((m: any) => m.kind === "error")).toBe(false);
    expect(calls("agyQueue", "session/prompt.rejected")).toBe(1);
    expect(calls("agyQueue", "session/prompt")).toBe(3);
  }, 60_000);

  it("the queue's Steer button: messages the CLI rejects late that cannot be queued again lose the mark and say so in the thread", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "agyQueueFull", model: "gemini-3.8-flash" } })).status).toBe(200);
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "Build the report." })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true && calls("agyQueueFull", "session/prompt") === 1, "the turn to start");
    const first = await api("POST", `/api/bots/${created.id}/messages`, { text: "Use pytest.", followUp: "queue" });
    const second = await api("POST", `/api/bots/${created.id}/messages`, { text: "Add a README.", followUp: "queue" });
    const pressed = api("POST", `/api/bots/${created.id}/queue/${first.body.queueId}/steer`, { threadId: created.threadId });
    await waitFor(() => calls("agyQueueFull", "session/prompt.held") === 1, "the CLI to hold the steer");
    writeFileSync(cli("agyQueueFull").finishGate, "finish");
    const answer = await pressed;
    expect(answer.body).toMatchObject({ ok: true, steered: true, queueIds: [first.body.queueId, second.body.queueId] });

    const database = new DatabaseSync(join(home, ".openmausbot", "messages.db"));
    database.exec("CREATE TRIGGER disk_full BEFORE INSERT ON chat_followups BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    try {
      writeFileSync(cli("agyQueueFull").rejectGate, "reject");
      await waitFor(async () => {
        const bot = await getBot(created.id);
        return !bot.busy && bot.messages.some((m: any) => m.kind === "activity" && m.tool?.nameCode === "chat.notice.unreadMessage");
      }, "the thread to say the turned-down messages were not delivered");
    } finally { database.exec("DROP TRIGGER disk_full"); database.close(); }
    const bot = await getBot(created.id);
    const typed = bot.messages.filter((m: any) => m.role === "user" && m.kind === "text");
    expect(typed.map((m: any) => m.text)).toEqual(["Build the report.", "Use pytest.", "Add a README."]);
    expect(typed.some((m: any) => m.steered)).toBe(false);
    expect(bot.messages.filter((m: any) => m.tool?.nameCode === "chat.notice.unreadMessage")).toHaveLength(1);
    expect(calls("agyQueueFull", "session/prompt")).toBe(2);
  }, 60_000);

  it("a room's Steer keeps its message queued: the CLI never gets a steer it could turn down after the room counted it in", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "agyRoom", model: "gemini-3.8-flash" } })).status).toBe(200);
    const room = (await api("POST", "/api/groups", {
      name: "Antigravity room", memberIds: [created.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: created.id } },
    })).body.group;
    const getGroup = async () => (await api("GET", "/api/bots?messages=30")).body.groups.find((g: any) => g.id === room.id);
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Build the report." })).status).toBe(202);
    await waitFor(async () => (await getGroup())?.busyBotId === created.id && calls("agyRoom", "session/prompt") === 1, "the room turn to start");
    const queued = await api("POST", `/api/groups/${room.id}/messages`, { text: "Use pytest." });
    expect(queued.body).toMatchObject({ ok: true, queued: true });

    const still = await Promise.race([
      api("POST", `/api/groups/${room.id}/queue/${queued.body.queueId}/steer`, { threadId: room.threadId }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the room steer waited on the CLI")), 10_000)),
    ]);
    expect(still.status).toBe(200);
    expect(still.body).toMatchObject({ ok: true, queued: true });
    expect(calls("agyRoom", "session/prompt")).toBe(1);

    writeFileSync(cli("agyRoom").finishGate, "finish");
    await waitFor(async () => {
      const group = await getGroup();
      return group?.working === false && calls("agyRoom", "session/prompt") === 2
        && group.messages.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text.includes("done")).length === 2;
    }, "the queued room message to run after the first turn");
    const typed = (await getGroup()).messages.filter((m: any) => m.role === "user" && m.kind === "text");
    expect(typed.map((m: any) => m.text)).toEqual(["Build the report.", "Use pytest."]);
    expect(typed.some((m: any) => m.steered)).toBe(false);
    expect(calls("agyRoom", "session/prompt.held")).toBe(0);
  }, 60_000);
});
