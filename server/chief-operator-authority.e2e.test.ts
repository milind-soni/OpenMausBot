import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";

import { launchCloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { ownMcpOverHttp } from "./drivers/turn-mcp.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

type Mount = { command: string; args: string[]; env: Record<string, string> };

function connect(mounted: Mount, transport: string, home: string, proxies: ChildProcess[]) {
  let nextId = 0;
  const pending = new Map<number, (result: any) => void>();
  const endpoint = transport === "http" ? ownMcpOverHttp({ name: "agents", ...mounted }) : null;
  const proxy = transport === "stdio" ? spawn(mounted.command, mounted.args, { cwd: process.cwd(), env: { ...mounted.env, HOME: home, USERPROFILE: home }, stdio: ["pipe", "pipe", "pipe"] }) : null;
  if (proxy) {
    proxies.push(proxy);
    createInterface({ input: proxy.stdout! }).on("line", line => {
      const response = JSON.parse(line) as { id: number; result: unknown };
      pending.get(response.id)?.(response.result);
    });
  } else expect(endpoint).not.toBeNull();
  return async (args: Record<string, unknown>) => {
    const request = { jsonrpc: "2.0", id: ++nextId, method: "tools/call", params: { name: "operator_settings", arguments: args } };
    const result = endpoint ? await fetch(endpoint.url, { method: "POST", headers: { "content-type": "application/json", ...endpoint.headers }, body: JSON.stringify(request) }).then(async response => {
      expect(response.status).toBe(200);
      return (await response.json() as { result: any }).result;
    }) : await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(request.id); reject(new Error("operator_settings did not answer")); }, 10_000);
      pending.set(request.id, value => { clearTimeout(timer); pending.delete(request.id); resolve(value); });
      proxy!.stdin!.write(`${JSON.stringify(request)}\n`);
    });
    return { error: result.isError === true, body: result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text) as any };
  };
}

it.each(["stdio", "http"])("P2 keeps positive desktop owner authority and refuses mixed provenance and ABA over %s", async transport => {
  const fixture = await launchCloudSendFixture({ onePasswordToken: "ops_isolated-operator", desktopEngine:
    'process.env.FAKE_CLAUDE_MODE = "hang"; process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";' });
  const dumpPath = join(fixture.root, "desktop", "dump.json");
  const proxies: ChildProcess[] = [];
  const serverPids: number[] = [];
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${fixture.desktopBase}${path}`, { method, headers: { "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : { "x-openmausbot-desktop-owner": fixture.ownerCapability }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  const bytes = () => ["config.json", "chief-operator.json"].map(file => readFileSync(join(fixture.desktopDataDir, file), "utf8"));
  try {
    serverPids.push((await api("GET", "/api/health")).body.pid, (await fixture.onCloud("GET", "/api/health")).body.pid);
    const bot = (await api("POST", "/api/bots", { name: "Operator" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off" })).status).toBe(200);
    expect((await api("PATCH", "/api/config", { language: "en" })).status).toBe(200);
    expect((await api("PUT", "/api/chief-operator", { botId: bot.id, read: ["language", "computerName"], write: ["language", "computerName"], expectedRevision: "none" })).status).toBe(200);
    const start = async (token?: string) => {
      rmSync(dumpPath, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Change the language." }, token)).status).toBe(202);
      await expect.poll(() => existsSync(dumpPath), { timeout: 15_000 }).toBe(true);
      return connect(JSON.parse(readFileSync(dumpPath, "utf8")).mcpConfig.mcpServers.agents, transport, fixture.desktopDataDir, proxies);
    };
    let call = await start();
    const change = async (setting: string, value: string) => {
      const preview = await call({ action: "preview", setting, value });
      expect(preview.error).toBe(false);
      const applied = await call({ action: "apply", preview_id: preview.body.previewId, expected_revision: preview.body.revision });
      expect(applied.error).toBe(false);
      return applied.body;
    };
    const first = await change("language", "fr");
    const pending = await call({ action: "preview", setting: "language", value: "it" });
    const clients: string[] = [];
    for (let n = 0; n < 2; n++) {
      const code = (await api("POST", "/api/auth/pairing", { scopes: ["client"] })).body.code;
      clients.push((await api("POST", "/api/auth/pair", { code })).body.token);
    }
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Steer from another person.", followUp: "steer" }, clients[0])).status).toBe(202);
    const beforeMixed = bytes();
    expect((await call({ action: "preview", setting: "language", value: "de" })).error).toBe(true);
    expect((await call({ action: "apply", preview_id: pending.body.previewId, expected_revision: pending.body.revision })).error).toBe(true);
    expect(bytes()).toEqual(beforeMixed);
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
    const clientCall = await start(clients[0]);
    expect((await clientCall({ action: "read" })).error).toBe(true);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Second client joins.", followUp: "steer" }, clients[1])).status).toBe(202);
    expect((await clientCall({ action: "preview", setting: "language", value: "de" })).error).toBe(true);
    expect(bytes()).toEqual(beforeMixed);
    expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
    call = await start();
    await change("language", "de");
    const latest = await change("language", "fr");
    const beforeABA = bytes();
    expect((await call({ action: "rollback", receipt_id: first.receiptId, expected_revision: latest.revision })).error).toBe(true);
    expect(bytes()).toEqual(beforeABA);
    await change("computerName", "Fixture Mac");
    const current = await call({ action: "read" });
    expect((await call({ action: "rollback", receipt_id: latest.receiptId, expected_revision: current.body.settings.find((row: any) => row.setting === "language").revision })).body).toMatchObject({ state: "applied", after: "de" });
    expect((await api("GET", "/api/config")).body).toMatchObject({ language: "de", computerName: "Fixture Mac" });
    console.info(JSON.stringify({ operatorP2Evidence: { scenario: "desktop-mixed-ABA", transport, url: fixture.desktopBase, dataDir: fixture.desktopDataDir, normalOwner: true, mixedDenied: true, clientMixedDenied: true, abaDenied: true, refusalsUnchanged: true, unrelatedRollback: true } }));
  } catch (error) { console.error(fixture.logs()); throw error; } finally {
    for (const proxy of proxies) { await waitForExit(proxy, { signal: "SIGTERM" }); expect(proxy.exitCode !== null || proxy.signalCode !== null).toBe(true); }
    await fixture.close();
    const logPath = join(tmpdir(), `p2-desktop-${transport}-${Date.now()}.log`);
    writeFileSync(logPath, fixture.logs());
    for (const pid of serverPids) expect(() => process.kill(pid, 0)).toThrow();
    console.info(JSON.stringify({ operatorP2Cleanup: { scenario: "desktop", transport, fixtureClosed: true, logPath, serverPids, serversExited: true, proxies: proxies.map(proxy => ({ pid: proxy.pid, exit: proxy.exitCode, signal: proxy.signalCode })) } }));
  }
}, hostTimeout(90_000));

it.each(["stdio", "http"])("P2 demotes the appointing owner on signed pairing before redemption over %s", async transport => {
  const fixture = await launchCloudSendFixture({ onePasswordToken: "ops_isolated-operator", team: { id: "p2-team", name: "Operator Team",
    engine: 'process.env.FAKE_CLAUDE_MODE = "hang"; process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";' } });
  const team = fixture.team!;
  const proxies: ChildProcess[] = [];
  const serverPids: number[] = [];
  try {
    const alice = (await team.pair({ email: "alice@acme.test", role: "owner" })).token!;
    const beth = (await team.pair({ email: "beth@acme.test", role: "owner" })).token!;
    serverPids.push((await fixture.local("GET", "/api/health")).body.pid, (await fixture.onCloud("GET", "/api/health")).body.pid, (await team.as(beth, "GET", "/api/health")).body.pid);
    const bot = (await team.as(alice, "POST", "/api/bots", { name: "Operator" })).body.bot;
    const grant = await team.as(alice, "PUT", "/api/chief-operator", { botId: bot.id, read: ["language"], write: ["language"], expectedRevision: "none" });
    expect(grant.status).toBe(200);
    const dumpPath = join(team.home, "dump.json");
    const start = async (token: string) => {
      rmSync(dumpPath, { force: true });
      expect((await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text: "Change the language." })).status).toBe(202);
      await expect.poll(() => existsSync(dumpPath), { timeout: 15_000 }).toBe(true);
      return connect(JSON.parse(readFileSync(dumpPath, "utf8")).mcpConfig.mcpServers.agents, transport, team.home, proxies);
    };
    const call = await start(alice);
    const preview = await call({ action: "preview", setting: "language", value: "fr" });
    expect(preview.error).toBe(false);
    expect((await call({ action: "apply", preview_id: preview.body.previewId, expected_revision: preview.body.revision })).error).toBe(false);
    const pending = await call({ action: "preview", setting: "language", value: "de" });
    expect(pending.error).toBe(false);
    const bytes = () => ["config.json", "chief-operator.json"].map(file => readFileSync(join(team.home, ".openmausbot", file), "utf8"));
    const before = bytes();
    await team.grant({ email: "alice@acme.test", role: "member" });
    expect((await team.as(alice, "GET", "/api/bots")).status).toBe(401);
    expect((await team.as(beth, "GET", "/api/chief-operator")).status).toBe(200);
    expect((await call({ action: "preview", setting: "language", value: "de" })).error).toBe(true);
    expect((await call({ action: "apply", preview_id: pending.body.previewId, expected_revision: pending.body.revision })).error).toBe(true);
    expect(bytes()).toEqual(before);
    const roster = () => JSON.parse(readFileSync(join(team.home, ".openmausbot", "team-people.json"), "utf8")).people;
    expect(roster().find((row: any) => row.email === "alice@acme.test").role).toBe("member");
    expect(roster().find((row: any) => row.email === "beth@acme.test").role).toBe("owner");
    expect((await team.as(beth, "POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
    expect((await team.as(beth, "PUT", "/api/chief-operator", { botId: bot.id, read: ["language"], write: ["language"], expectedRevision: grant.body.revision })).status).toBe(200);
    const bethCall = await start(beth);
    expect((await bethCall({ action: "preview", setting: "language", value: "de" })).error).toBe(false);
    await team.relaunch();
    serverPids.push((await team.as(beth, "GET", "/api/health")).body.pid);
    expect(roster().find((row: any) => row.email === "alice@acme.test").role).toBe("member");
    expect((await team.as(beth, "GET", "/api/chief-operator")).status).toBe(200);
    console.info(JSON.stringify({ operatorP2Evidence: { scenario: "signed-downgrade", transport, url: team.base, dataDir: join(team.home, ".openmausbot"), normalOwner: true, codeRedeemed: false, oldSessionStatus: 401, existingPreviewDenied: true, existingApplyDenied: true, refusalsUnchanged: true, unrelatedOwner: true, restartRole: "member" } }));
  } finally {
    for (const proxy of proxies) { await waitForExit(proxy, { signal: "SIGTERM" }); expect(proxy.exitCode !== null || proxy.signalCode !== null).toBe(true); }
    await fixture.close();
    const logPath = join(tmpdir(), `p2-team-${transport}-${Date.now()}.log`);
    writeFileSync(logPath, fixture.logs());
    for (const pid of serverPids) expect(() => process.kill(pid, 0)).toThrow();
    console.info(JSON.stringify({ operatorP2Cleanup: { scenario: "team", transport, fixtureClosed: true, logPath, serverPids, serversExited: true, proxies: proxies.map(proxy => ({ pid: proxy.pid, exit: proxy.exitCode, signal: proxy.signalCode })) } }));
  }
}, hostTimeout(120_000));
