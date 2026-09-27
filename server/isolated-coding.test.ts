import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { IsolatedCoding, codingSettings, type CodingOwner } from "./isolated-coding.ts";
import { HostedComputerManager } from "./hosted-computers/manager.ts";
import { hostedFixtureConfig } from "./testing/fake-hosted-computers.ts";

const account = (id: string) => ({ id, verified: true });
const payload = (command: string) => JSON.parse(Buffer.from(command.match(/'([A-Za-z0-9+/=]+)'$/)![1], "base64").toString());
async function fixture() {
  const root = mkdtempSync(join(process.env.NATION_TEST_CODEX_BIN ? process.cwd() : tmpdir(), "nation-coding-test-"));
  const pending: Array<{ input: any; command: string; finish: (value: any) => void }> = [];
  const machines = new Map<string, any>();
  const provider = { check: async () => {}, find: async (name: string) => machines.get(name) ?? null,
    get: async (_id: string, name: string) => machines.get(name),
    create: async (name: string) => { const m = { name, id: name, state: "running" }; machines.set(name, m); return m; },
    start: async (m: any) => m, stop: async () => {}, screenshot: async () => ({ png: "", format: "png" as const }),
    execute: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    code: vi.fn(async (_m: any, command: string) => new Promise<any>(finish => pending.push({ input: payload(command), command, finish }))),
  };
  const manager = new HostedComputerManager(root, "workspace-a", () => hostedFixtureConfig, async () => provider);
  const charges: Array<{ settle: ReturnType<typeof vi.fn>; unconfirmed: ReturnType<typeof vi.fn>; reject: ReturnType<typeof vi.fn>; providerId: ReturnType<typeof vi.fn> }> = [];
  const upstream = vi.fn(async (_url: any, _init?: any) => new Response('data: ' + JSON.stringify({ type: "response.completed", response: { id: "resp_fixture", usage: { cost: 0.02 } } }) + '\n\n', { headers: { "content-type": "text/event-stream" } }));
  const env = { NATION_CODING_ENABLED: "1", NATION_CODING_MODEL: "openai/coding-fixture", OPENROUTER_API_KEY: "SERVER_ONLY_KEY", NATION_TEST_CODING: "1", NATION_CODING_PUBLIC_ORIGIN: "" };
  const coding = new IsolatedCoding({ manager, scope: "operator", env, fetcher: upstream,
    spend: () => { const c = { settle: vi.fn(), unconfirmed: vi.fn(), reject: vi.fn(), providerId: vi.fn() }; charges.push(c); return c; } });
  const server = createServer((req, res) => { void coding.handle(req, res, new URL(req.url!, "http://test").pathname).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  env.NATION_CODING_PUBLIC_ORIGIN = `http://127.0.0.1:${(server.address() as any).port}`;
  const owner = (key: string): CodingOwner => ({ key, provider: "daytona", threadId: key, generation: "one", account: account(key), current: () => true });
  const alice = owner("alice"), bob = owner("bob");
  await manager.start("daytona", "alice", true); await manager.start("daytona", "bob", true);
  const start = async (who = alice) => { const task = coding.start(who, "project", "Fix the failing test."); await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0)); return task; };
  const request = (input: any, body: unknown = { input: "hello", tools: [], stream: true }, token = input.token) => fetch(input.url + "/responses", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { root, coding, manager, alice, bob, start, pending, upstream, charges, request, env,
    restartManager: () => new HostedComputerManager(root, "workspace-a", () => hostedFixtureConfig, async () => provider),
    close: async () => { for (const p of pending) p.finish({ exitCode: 0, stdout: JSON.stringify({ status: "cancelled", text: "stopped" }), stderr: "" }); await new Promise(resolve => setTimeout(resolve, 10)); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); } };
}

it("keeps jobs, scoped capabilities and model charges separate for two users", async () => {
  const f = await fixture();
  try {
    const task = await f.start(); const a = f.pending[0].input;
    expect(JSON.stringify(a)).not.toContain("SERVER_ONLY_KEY");
    expect(() => f.coding.status(f.bob, task.taskId)).toThrow();
    expect((await f.request(a, {}, "f".repeat(64))).status).toBe(403);
    expect(f.upstream).not.toHaveBeenCalled();
    expect((await f.request(a, { input: "fix", model: "expensive-override", stream: true })).status).toBe(200);
    expect(JSON.parse(f.upstream.mock.calls[0][1].body).model).toBe("openai/coding-fixture");
    expect(f.upstream.mock.calls[0][1].headers.authorization).toBe("Bearer SERVER_ONLY_KEY");
    expect(f.charges[0].settle).toHaveBeenCalledWith(0.02);
    await expect(f.manager.execute("daytona", "alice", "touch overlapping")).rejects.toMatchObject({ status: 409 });
    // A server restart loses memory locks, but cannot overlap the remote job.
    await expect(f.restartManager().execute("daytona", "alice", "touch after-restart")).rejects.toMatchObject({ status: 409 });
    await f.manager.execute("daytona", "bob", "echo separate");
    f.coding.revoke("alice", "old-generation");
    expect((await f.request(a)).status).toBe(200);
    f.coding.revoke("alice", "one");
    expect((await f.request(a)).status).toBe(403);
    expect((await fetch(a.url + "/lease", { headers: { authorization: `Bearer ${a.token}` } })).status).toBe(403);
  } finally { await f.close(); }
});

it("rejects a task capability in a different workspace and after a restart", async () => {
  const f = await fixture();
  try {
    const task = await f.start(); const a = f.pending[0].input;
    expect((await fetch(a.url.replace('/operator/', '/ws_abcdefghijklmnopqrstuv/') + '/lease', {
      headers: { authorization: `Bearer ${a.token}` },
    })).status).toBe(404);
    const restarted = new IsolatedCoding({ manager: f.restartManager(), scope: "operator", env: f.env });
    expect(() => restarted.status(f.alice, task.taskId)).toThrow();
    expect(f.upstream).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it("blocks further spending when upstream omits cost and withholds provider errors", async () => {
  const f = await fixture();
  try {
    await f.start(); const a = f.pending[0].input;
    f.upstream.mockResolvedValueOnce(new Response('data: {"type":"response.completed","response":{"id":"resp_missing"}}\n\n'));
    const response = await f.request(a);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("SERVER_ONLY_KEY");
    expect(f.charges[0].unconfirmed).toHaveBeenCalledOnce();
    expect((await f.request(a)).status).toBe(403);
  } finally { await f.close(); }
});

it("refuses hosted tools, stored conversations and wrong project paths", async () => {
  const f = await fixture();
  try {
    expect(() => f.coding.start(f.alice, "../../bob", "read secrets")).toThrow();
    await f.start(); const a = f.pending[0].input;
    expect((await f.request(a, { input: "x", previous_response_id: "someone-elses-response" })).status).toBe(502);
    expect(f.upstream).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

it("requires explicit server configuration and an isolated supported provider", () => {
  expect(codingSettings({})).toBeNull();
  expect(codingSettings({ NATION_CODING_ENABLED: "1", NATION_CODING_MODEL: "openai/test", OPENROUTER_API_KEY: "key", NATION_CODING_PUBLIC_ORIGIN: "http://example.com" })).toBeNull();
});

// Optional: install the pinned CLI outside the repository, then point this at
// its executable. Model responses and billing remain entirely offline.
it.skipIf(!process.env.NATION_TEST_CODEX_BIN)("real Codex CLI edits a file through the scoped gateway", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    f.upstream.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      const commandTool = body.tools.find((t: any) => t.name === "exec_command" || t.name === "shell");
      const item = ++calls === 1 ? {
        type: "function_call", id: "fc_1", call_id: "call_1", name: commandTool?.name,
        arguments: JSON.stringify(commandTool?.name === "exec_command" ? { cmd: "printf CODING_SMOKE > coding-smoke.txt" } : { command: ["sh", "-c", "printf CODING_SMOKE > coding-smoke.txt"] }),
      } : { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Completed isolated coding smoke.", annotations: [] }] };
      const response = { id: `resp_${calls}`, object: "response", status: "completed", output: [item], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4, cost: 0.02 } };
      const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }];
      return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { "content-type": "text/event-stream" } });
    });
    const task = await f.start();
    const p = f.pending[0];
    const deadline = setTimeout(() => f.coding.revoke(f.alice.threadId), 50_000);
    const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn("sh", ["-c", p.command], { env: { PATH: dirname(process.env.NATION_TEST_CODEX_BIN!) + ':' + process.env.PATH, HOME: f.root } });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject); child.on("close", code => resolve({ exitCode: code ?? 1, stdout, stderr }));
    }).finally(() => clearTimeout(deadline));
    p.finish(result);
    const log = readFileSync(join(f.root, `.nation-coding/project/.runs/${task.taskId}/events.jsonl`), "utf8");
    await vi.waitFor(() => expect(f.coding.status(f.alice, task.taskId).state, log).toBe("completed"));
    expect(readFileSync(join(f.root, ".nation-coding/project/coding-smoke.txt"), "utf8")).toBe("CODING_SMOKE");
    expect(calls).toBe(2);
    expect(f.charges.every(c => c.settle.mock.calls[0]?.[0] === 0.02)).toBe(true);
  } finally { await f.close(); }
}, 60_000);
