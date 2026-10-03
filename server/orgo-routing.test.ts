// Real server + fake engine + owned loopback Orgo. No model or paid VM calls.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const workspaceId = "550e8400-e29b-41d4-a716-446655440000";
const otherWorkspaceId = "550e8400-e29b-41d4-a716-446655440001";
const apiKey = "sk_live_verification_fixture";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

it.each([
  "https://127.0.0.1:12345", "http://localhost:12345", "http://192.0.2.1:12345",
  "http://127.0.0.1:12345/api", "http://127.0.0.1:12345?token=secret", "http://127.0.0.1:12345#fragment",
  "http://user:password@127.0.0.1:12345", "http://127.0.0.1:0", "http://127.0.0.1:65536",
])("refuses unsafe Orgo fixture endpoint before starting a server: %s", async endpoint => {
  await expect(launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, [], undefined, endpoint))
    .rejects.toThrow(/Orgo verification requires/);
});

it("routes direct, group and scheduled Orgo turns through the chosen model with scoped computer control", async () => {
  const gateDir = mkdtempSync(join(tmpdir(), "omb-orgo-routing-"));
  const finish = join(gateDir, "finish");
  type Row = { id: string; name: string; workspace_id: string; os: string; status: string; fly_instance_id: string; vnc_password: string; permissions: { canWrite: boolean } };
  const foreign: Row = { id: randomUUID(), name: "unmanaged-fixture-computer", workspace_id: workspaceId, os: "linux", status: "running", fly_instance_id: "foreigninstance", vnc_password: "foreign-password", permissions: { canWrite: true } };
  const rows: Row[] = [foreign];
  const calls: Array<{ method: string; path: string; body: Record<string, unknown>; authorization?: string }> = [];
  const unexpected: string[] = [];
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ method: req.method!, path: url.pathname, body, authorization: req.headers.authorization });
    const reply = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== `Bearer ${apiKey}` && !url.pathname.endsWith("/proxy/health")) return reply({ error: "Invalid fixture credential" }, 401);
    if (url.pathname === "/workspaces") return reply({ workspaces: [
      { id: workspaceId, name: "Owned verification workspace", desktops: rows.map(({ id, name }) => ({ id, name })) },
      { id: otherWorkspaceId, name: "Other verification workspace", desktops: [] },
    ] });
    if (url.pathname === "/computers" && req.method === "POST") {
      const row: Row = { ...foreign, id: randomUUID(), name: body.name, fly_instance_id: "e784630de969d8", vnc_password: "computer-fixture-password" };
      rows.push(row); return reply(row, 201);
    }
    if (/^\/desktops\/[\w-]+\/proxy\/health$/.test(url.pathname)) return reply({ status: "ok" });
    const match = /^\/computers\/([^/]+)(?:\/(start|stop|restart|screenshot|bash|click|mouse-move|drag|type|key|scroll))?$/.exec(url.pathname);
    if (match) {
      const row = rows.find(row => row.id === match[1]);
      if (!row) return reply({ error: "Computer not found" }, 404);
      if (req.method === "DELETE" && !match[2]) { rows.splice(rows.indexOf(row), 1); return reply({ success: true }); }
      if (match[2] === "start" || match[2] === "restart") { row.status = "running"; return reply({ success: true }); }
      if (match[2] === "stop") { row.status = "frozen"; return reply({ success: true }); }
      if (match[2] === "screenshot") return reply({ success: true, image: png, mime_type: "image/png", width: 1, height: 1 });
      if (match[2] === "bash") return reply({ success: true, output: "Fixture command completed", exit_code: 0 });
      return reply(match[2] ? { success: true } : row);
    }
    unexpected.push(`${req.method} ${url.pathname}`);
    reply({ error: "Unexpected fixture endpoint" }, 500);
  });
  let fixture: VerificationServer | undefined;
  try {
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    fixture = await launchVerificationServer({
      ...process.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_SLOW_FINISH_GATE: finish,
    }, undefined, undefined, undefined, undefined, undefined, [], undefined, origin);
    process.stdout.write(`${JSON.stringify({ orgoFixture: fixture.info })}\n`);
    const base = fixture.info.url;
    const evidence: Array<{ args: string[]; result: unknown }> = [];
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(base + path, { method, headers: { "content-type": "application/json", origin: base }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, ok: response.ok, body: await response.json() as any };
    };
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await request(method, path, body);
      expect(response.ok, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(true);
      return response.body;
    };
    const control = async (args: string[]): Promise<any> => {
      const command = [...args, "--url", base];
      const result = await runControlOmb(command);
      evidence.push({ args: command, result });
      return result;
    };
    const readDump = (): any => {
      try { return JSON.parse(readFileSync(fixture!.fixtureDumpPath, "utf8")); } catch { return undefined; }
    };
    const prepare = () => { rmSync(fixture!.fixtureDumpPath, { force: true }); rmSync(finish, { force: true }); };
    const dump = async () => { await expect.poll(() => Boolean(readDump()?.mcpConfig), { timeout: 15_000 }).toBe(true); return readDump(); };
    const settled = async (destination: string[]) => {
      writeFileSync(finish, "finish");
      expect((await control(["wait", ...destination, "--timeout", "20"])).status).toBe("settled");
      await control(["messages", ...destination, "--limit", "30"]);
    };
    const task = async (botId: string) => (await api("POST", `/api/bots/${botId}/tasks`, { title: "Orgo fixture phase" })).task.threadId;
    const mutations = () => calls.filter(call => call.method !== "GET");
    const creates = () => calls.filter(call => call.method === "POST" && call.path === "/computers");
    const starts = () => calls.filter(call => call.method === "POST" && call.path.endsWith("/start"));
    const gate = (mounted: any) => fetch(mounted.env.OMB_CONTROL_URL, { headers: { authorization: `Bearer ${mounted.env.OMB_CONTROL_TOKEN}` } });
    const assertMounted = (seen: any, botId: string) => {
      const mounted = seen.mcpConfig.mcpServers.computer;
      expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("claude-opus-5-5");
      expect(seen.systemPrompt).toContain("Orgo cloud Linux computer");
      expect(mounted.args.some((arg: string) => /orgo-computer-proxy\.(?:ts|mjs|js)$/.test(arg))).toBe(true);
      expect(mounted.args.join(" ")).not.toContain(apiKey);
      expect(mounted.env).toMatchObject({ ORGO_API_KEY: apiKey, ORGO_WORKSPACE_ID: workspaceId, ORGO_COMPUTER_ID: rows.find(row => row !== foreign)!.id });
      expect(mounted.env.OMB_CONTROL_URL).toContain(`botId=${botId}`);
      expect(mounted.env.OMB_CONTROL_TOKEN).toBeTruthy();
      return mounted;
    };

    const config = await api("GET", "/api/config");
    expect(config.orgo).toEqual({ configured: true, workspaceId });
    expect(JSON.stringify(config)).not.toContain(apiKey);
    expect((await api("GET", "/api/orgo/workspaces")).workspaces).toHaveLength(2);
    const { bot: empty } = await control(["new-bot", "--name", "Empty Orgo Auto fixture"]);
    await api("PATCH", `/api/bots/${empty.id}`, { cloudBackend: "orgo", computer: null, browser: false });
    expect((await request("POST", `/api/bots/${empty.id}/computer/provision`, {})).status).toBe(409);
    const beforeAuto = mutations().length;
    prepare();
    await control(["send", "--bot", empty.id, "--task", empty.activeTaskId, "--text", "Reply from Auto without creating a computer."]);
    expect((await dump()).mcpConfig.mcpServers.computer).toBeUndefined();
    await settled(["--bot", empty.id, "--task", empty.activeTaskId]);
    expect(mutations()).toHaveLength(beforeAuto);

    const { bot } = await control(["new-bot", "--name", "Chosen-model Orgo fixture"]);
    await control(["set-model", "--bot", bot.id, "--instance", "claude", "--model", "claude-opus-5-5"]);
    await api("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "orgo", computer: "cloud", browser: false });
    prepare();
    await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Inspect the assigned Orgo computer."]);
    const mounted = assertMounted(await dump(), bot.id);
    expect(creates()).toHaveLength(1);
    expect(creates()[0].body).toMatchObject({ workspace_id: workspaceId, os: "linux", ram: 4, cpu: 1 });
    expect((await gate(mounted)).status).toBe(200);
    expect(await (await gate(mounted)).json()).toMatchObject({ held: false });
    expect((await fetch(mounted.env.OMB_CONTROL_URL, { headers: { authorization: "Bearer wrong-fixture-token" } })).status).toBe(401);
    const otherBot = new URL(mounted.env.OMB_CONTROL_URL); otherBot.searchParams.set("botId", empty.id);
    expect((await fetch(otherBot, { headers: { authorization: `Bearer ${mounted.env.OMB_CONTROL_TOKEN}` } })).ok).toBe(false);
    await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "take" });
    expect(await (await gate(mounted)).json()).toMatchObject({ held: true });
    expect((await request("PATCH", "/api/config", { orgo: { apiKey: "sk_live_replacement" } })).status).toBe(409);
    await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "release" });
    const viewerJoin = await api("POST", `/api/bots/${bot.id}/computer/join`, {});
    expect(viewerJoin.joinUrl).toMatch(/^\/desktop-viewer#target=orgo%2F/);
    expect(JSON.stringify(viewerJoin)).not.toMatch(/sk_live_|computer-fixture-password|e784630de969d8/);
    expect((await api("POST", `/api/bots/${bot.id}/computer/screenshot`, {})).png).toBe(png);
    expect(JSON.stringify(await api("GET", `/api/bots/${bot.id}/computer`))).not.toMatch(/sk_live_|computer-fixture-password/);
    await settled(["--bot", bot.id, "--task", bot.activeTaskId]);
    expect((await gate(mounted)).status).toBe(401);

    await api("PATCH", `/api/bots/${bot.id}`, { computer: null });
    let threadId = await task(bot.id);
    const beforeReuse = mutations().length;
    prepare();
    await control(["send", "--bot", bot.id, "--task", threadId, "--text", "Reuse the running computer from Auto."]);
    assertMounted(await dump(), bot.id);
    await settled(["--bot", bot.id, "--task", threadId]);
    expect(mutations()).toHaveLength(beforeReuse);
    await api("POST", `/api/bots/${bot.id}/computer/sleep`, {});
    expect(rows.find(row => row !== foreign)!.status).toBe("frozen");
    threadId = await task(bot.id);
    prepare();
    const beforeSleepingAuto = mutations().length;
    await control(["send", "--bot", bot.id, "--task", threadId, "--text", "Reply from Auto while its computer is asleep."]);
    expect((await dump()).mcpConfig.mcpServers.computer).toBeUndefined();
    await settled(["--bot", bot.id, "--task", threadId]);
    expect(mutations()).toHaveLength(beforeSleepingAuto);

    await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud" });
    threadId = await task(bot.id);
    prepare();
    await control(["send", "--bot", bot.id, "--task", threadId, "--text", "Wake and reuse the selected Cloud computer."]);
    assertMounted(await dump(), bot.id);
    await settled(["--bot", bot.id, "--task", threadId]);
    expect(starts()).toHaveLength(1);
    expect(creates()).toHaveLength(1);
    const { group } = await api("POST", "/api/groups", { name: "Orgo fixture room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    prepare();
    await control(["send-channel", "--channel", group.id, "--task", group.threadId, "--text", "Inspect this speaker's Orgo computer."]);
    assertMounted(await dump(), bot.id);
    await settled(["--channel", group.id, "--task", group.threadId]);

    const { routine } = await api("POST", "/api/routines", { name: "Orgo fixture routine", botId: bot.id, prompt: "Inspect the selected Orgo computer.", runOn: "cloud", enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
    prepare();
    const { run } = await api("POST", `/api/routines/${routine.id}/run`, {});
    let routineThread = "";
    await expect.poll(async () => { routineThread = (await api("GET", "/api/routines")).runs.find((item: any) => item.id === run.id)?.threadId ?? ""; return routineThread; }).not.toBe("");
    try { assertMounted(await dump(), bot.id); }
    catch (error) {
      throw new Error(JSON.stringify({ runs: (await api("GET", "/api/routines")).runs,
        messages: (await api("GET", `/api/threads/${routineThread}/messages?limit=30`)).messages }), { cause: error });
    }
    await settled(["--bot", bot.id, "--task", routineThread]);
    expect(creates()).toHaveLength(1);
    expect(starts()).toHaveLength(1);
    expect((await request("PATCH", "/api/config", { orgo: { apiKey: "" } })).ok).toBe(false);
    expect((await request("PATCH", "/api/config", { orgo: { workspaceId: otherWorkspaceId } })).ok).toBe(false);
    expect((await api("GET", "/api/config")).orgo).toEqual({ configured: true, workspaceId });
    const computerId = rows.find(row => row !== foreign)!.id;
    await api("DELETE", `/api/groups/${group.id}`);
    await api("DELETE", `/api/bots/${bot.id}`);
    expect(calls.filter(call => call.method === "DELETE").map(call => call.path)).toEqual([`/computers/${computerId}`]);
    expect(rows).toEqual([foreign]);
    expect((await api("GET", "/api/bots")).bots.some((item: any) => item.id === bot.id)).toBe(false);
    const disconnected = await api("PATCH", "/api/config", { orgo: { apiKey: "" } });
    expect(JSON.stringify(disconnected)).not.toContain(apiKey);
    expect((await api("GET", "/api/config")).orgo.configured).toBe(false);
    await api("PATCH", "/api/config", { orgo: { apiKey: `  ${apiKey}  ` } });
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).orgo).toEqual({ apiKey, workspaceId });
    await api("PATCH", "/api/config?secretStorage=external", { orgo: { apiKey } });
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).orgo).toEqual({ apiKey: "", workspaceId });
    expect((await api("GET", "/api/config")).orgo).toEqual({ configured: true, workspaceId });
    await api("PATCH", "/api/config?secretStorage=external", { orgo: { apiKey: "" } });
    expect((await api("GET", "/api/config")).orgo.configured).toBe(false);
    expect(unexpected).toEqual([]);
    expect(calls.filter(call => !call.path.endsWith("/proxy/health")).every(call => call.authorization === `Bearer ${apiKey}`)).toBe(true);
    const evidencePath = `${fixture.info.logPath}.orgo.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, control: evidence,
      provider: calls.map(({ method, path, body }) => ({ method, path, body })) }, null, 2), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ orgoEvidence: evidencePath })}\n`);
  } finally {
    if (existsSync(gateDir)) writeFileSync(finish, "finish");
    await fixture?.close();
    upstream.closeAllConnections();
    if (upstream.listening) await new Promise<void>(resolve => upstream.close(() => resolve()));
    await removeTempDir(gateDir);
  }
}, 90_000);
