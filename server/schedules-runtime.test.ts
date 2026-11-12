import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = dirname(fileURLToPath(import.meta.url));
const port = 26000 + Math.floor(Math.random() * 10000), base = `http://127.0.0.1:${port}`;
let child: ChildProcess, home: string, stderr = "";
async function api(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }> {
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function until<T>(read: () => Promise<T>, test: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15000;
  for (;;) { const value = await read(); if (test(value)) return value; if (Date.now() > deadline) throw new Error(`State did not arrive: ${stderr.slice(-600)} ${JSON.stringify(value).slice(-1800)}`); await new Promise(resolve => setTimeout(resolve, 30)); }
}
const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
async function makeBot(instanceId: string, model: string, settings: Record<string, unknown> = {}) {
  const { body } = await api("POST", "/api/bots");
  expect((await api("PATCH", `/api/bots/${body.bot.id}`, { modelSelection: { instanceId, model }, onUsageLimit: "stop", ...settings })).status).toBe(200);
  return body.bot.id as string;
}
const future = () => ({ kind: "once", at: new Date(Date.now() + 60_000).toISOString() });
async function schedule(botId: string, prompt: string) {
  const response = await api("POST", "/api/schedules", { target: { botId }, prompt, repeat: future(), timezone: "UTC" });
  expect(response.status).toBe(201); return response.body.schedule;
}

describe.skipIf(process.platform === "win32")("scheduled runs and recovery over HTTP (fake CLIs)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "gbs-scheduled-"));
    mkdirSync(join(home, ".gbs")); mkdirSync(join(home, ".grok")); writeFileSync(join(home, ".grok", "auth.json"), "{}");
    const wrapper = (name: string, file: string, code = "") => {
      const path = join(home, `${name}.mjs`);
      writeFileSync(path, `#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('fake-cli 2.1.312');process.exit(0);}\n${code}\nawait import(${JSON.stringify(pathToFileURL(join(directory, "testing", file)).href)});\n`);
      chmodSync(path, 0o755); return path;
    };
    const failing = wrapper("limited", "fake-codex-app-server.ts", `import {existsSync} from 'node:fs'; process.env.FAKE_CODEX_MODE=existsSync(${JSON.stringify(join(home, "primary-refreshed"))})?'happy':'usage-limit';`);
    const throttle = wrapper("throttle", "fake-claude-cli.ts", `process.env.FAKE_CLAUDE_MODE='usage-limit';process.env.FAKE_CLAUDE_DUMP=${JSON.stringify(join(home, "claude-dump.json"))};`);
    const happy = wrapper("happy", "fake-acp-cli.ts");
    const marker = join(home, "slow-started");
    const slow = wrapper("slow", "fake-acp-cli.ts", `import {existsSync,writeFileSync} from 'node:fs'; if(process.argv.includes('stdio')){if(!existsSync(${JSON.stringify(marker)})){writeFileSync(${JSON.stringify(marker)},'1');process.env.FAKE_ACP_MODE='hang';}else process.env.FAKE_ACP_MODE='happy';}`);
    writeFileSync(join(home, ".gbs", "config.json"), JSON.stringify({ instances: {
      primary: { driver: "codex", config: { cli: failing, fullAuto: true } },
      throttle: { driver: "claudeAgent", config: { cli: throttle, permissionMode: "bypassPermissions" } },
      backup: { driver: "grokAgent", config: { cli: happy, fullAuto: true } },
      slow: { driver: "grokAgent", config: { cli: slow, fullAuto: true } },
    } }));
    child = spawn(process.execPath, [join(directory, "index.ts")], { cwd: join(directory, ".."), env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, GBS_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.on("data", chunk => { stderr += chunk; });
    await until(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, value => value);
  }, 30000);
  afterAll(async () => { child?.kill("SIGTERM"); if (child && child.exitCode === null) await new Promise<void>(resolve => { child.once("close", () => resolve()); setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000).unref(); }); if (home) rmSync(home, { recursive: true, force: true }); });

  it("fires a due alarm on the server with no event-stream or browser client", async () => {
    const id = await makeBot("backup", "grok-4.6");
    const alarm = await api("POST", "/api/schedules", { target: { botId: id }, prompt: "Wake up on time", repeat: { kind: "once", at: new Date(Date.now() + 1000).toISOString() }, timezone: "UTC" });
    expect(alarm.status).toBe(201);
    const bot = await until(() => getBot(id), bot => !bot.busy && bot.messages.some((m: any) => m.text === "Wake up on time"));
    expect(bot.messages.find((m: any) => m.text === "Wake up on time").scheduled.scheduleId).toBe(alarm.body.schedule.id);
  });
  it("queues behind a busy bot and sends one labeled prompt after it finishes, without a browser", async () => {
    const id = await makeBot("slow", "grok-4.6");
    expect((await api("POST", `/api/bots/${id}/messages`, { text: "First task" })).status).toBe(202);
    await until(() => getBot(id), bot => bot.busy);
    await until(async () => existsSync(join(home, "slow-started")), Boolean);
    const alarm = await schedule(id, "Scheduled second task");
    await api("POST", `/api/schedules/${alarm.id}/run-now`);
    await until(() => api("GET", "/api/schedules"), result => result.body.deliveries.some((j: any) => j.scheduleId === alarm.id && j.state === "pending"));
    expect((await getBot(id)).messages.filter((m: any) => m.text === alarm.prompt)).toHaveLength(0);
    await api("POST", `/api/bots/${id}/interrupt`);
    const finished = await until(() => getBot(id), bot => !bot.busy && bot.messages.some((m: any) => m.text === alarm.prompt));
    expect(finished.messages.filter((m: any) => m.text === alarm.prompt)).toHaveLength(1);
    expect(finished.messages.find((m: any) => m.text === alarm.prompt).scheduled.scheduleId).toBe(alarm.id);
  });
  it("retries the failed turn on backup, without duplicating the user message or changing the saved main model", async () => {
    const id = await makeBot("primary", "gpt-new", { backupModelSelection: { instanceId: "backup", model: "grok-4.6" }, onUsageLimit: "backup" });
    await api("POST", `/api/bots/${id}/messages`, { text: "Finish this report" });
    const result = await until(() => getBot(id), bot => !bot.busy && bot.usingBackup && bot.messages.some((m: any) => m.role === "bot" && m.text?.includes("fake acp")));
    expect(result.modelSelection.instanceId).toBe("primary");
    expect(result.messages.filter((m: any) => m.role === "user" && m.text === "Finish this report")).toHaveLength(1);
    expect(result.messages.some((m: any) => m.tool?.name.startsWith("Switched to"))).toBe(true);
    writeFileSync(join(home, "primary-refreshed"), "1");
    const other = await makeBot("primary", "gpt-new");
    await api("POST", `/api/bots/${other}/messages`, { text: "Check a new main-model turn" });
    await until(() => getBot(other), bot => !bot.busy && bot.messages.some((m: any) => m.text?.includes("fake codex")));
    expect((await getBot(id)).usingBackup).toBe(true); // a reading alone never changes this conversation
    await api("POST", `/api/bots/${id}/messages`, { text: "A new request after refresh" });
    const primary = await until(() => getBot(id), bot => !bot.busy && !bot.usingBackup && bot.messages.some((m: any) => m.text?.includes("fake codex")));
    expect(primary.modelSelection.instanceId).toBe("primary");
    rmSync(join(home, "primary-refreshed"));
  });
  it("creates one unknown-time retry at 15 minutes; Resume now backs off to 30 minutes, and Cancel removes it", async () => {
    const id = await makeBot("throttle", "default", { onUsageLimit: "wait" });
    const started = Date.now(); await api("POST", `/api/bots/${id}/messages`, { text: "Try this later" });
    const first = (await until(() => api("GET", "/api/schedules"), r => r.body.schedules.some((s: any) => s.target.botId === id && s.origin === "auto-resume"))).body.schedules.find((s: any) => s.target.botId === id);
    expect(Date.parse(first.nextRunAt) - started).toBeGreaterThanOrEqual(15 * 60_000);
    expect(Date.parse(first.nextRunAt) - started).toBeLessThan(16 * 60_000);
    await api("POST", `/api/schedules/${first.id}/run-now`);
    const next = (await until(() => api("GET", "/api/schedules"), r => r.body.schedules.some((s: any) => s.id === first.id && s.enabled && s.resume?.attempt === 1))).body.schedules.filter((s: any) => s.target.botId === id);
    expect(next).toHaveLength(1); expect(Date.parse(next[0].nextRunAt) - Date.now()).toBeGreaterThan(29 * 60_000);
    await api("DELETE", `/api/schedules/${first.id}`); expect((await api("GET", "/api/schedules")).body.schedules.some((s: any) => s.id === first.id)).toBe(false);
  });
  it("routes a room alarm through the normal room path", async () => {
    const id = await makeBot("backup", "grok-4.6"); const group = (await api("POST", "/api/groups", { name: "Scheduled room", memberIds: [id] })).body.group;
    const alarm = (await api("POST", "/api/schedules", { target: { groupId: group.id }, prompt: "Room check", repeat: future(), timezone: "UTC" })).body.schedule;
    await api("POST", `/api/schedules/${alarm.id}/run-now`);
    const result = await until(() => api("GET", "/api/bots"), r => r.body.groups.find((g: any) => g.id === group.id)?.messages.some((m: any) => m.from?.botId === id && m.kind === "text"));
    expect(result.body.groups.find((g: any) => g.id === group.id).messages.find((m: any) => m.text === "Room check").scheduled).toBeDefined();
  });
  it("guards schedule mutations and scopes bot-created schedules and the 20-schedule cap", async () => {
    const bots = (await api("GET", "/api/bots")).body.bots;
    const dumped = JSON.parse(readFileSync(join(home, "claude-dump.json"), "utf8"));
    const config = JSON.parse(dumped.argv[dumped.argv.indexOf("--mcp-config") + 1]);
    const headers = { authorization: `Bearer ${config.mcpServers.agents.env.GBS_COMMS_TOKEN}`, "x-gbs-bot-id": bots[0].id };
    const create = (target: unknown) => api("POST", "/api/internal/schedules", { target, prompt: "Daily task", repeat: { kind: "daily", time: "09:00" }, timezone: "UTC" }, headers);
    expect((await create({ botId: bots[1].id })).status).toBe(403);
    const made = await create({ botId: bots[0].id }); expect(made.status).toBe(201);
    for (let i = 1; i < 20; i++) expect((await create({ botId: bots[0].id })).status).toBe(201);
    expect((await create({ botId: bots[0].id })).status).toBe(400);
    const visible = (await api("GET", "/api/internal/schedules", undefined, headers)).body;
    expect(visible.schedules.every((s: any) => s.target.botId === bots[0].id || visible.rooms.some((r: any) => r.id === s.target.groupId))).toBe(true);
    expect((await api("DELETE", `/api/internal/schedules/${made.body.schedule.id}`, undefined, { ...headers, "x-gbs-bot-id": bots[1].id })).status).toBe(403);
    expect((await api("POST", "/api/schedules/pause", { paused: true }, { origin: "https://untrusted.example" })).status).toBe(403);
  });
});
