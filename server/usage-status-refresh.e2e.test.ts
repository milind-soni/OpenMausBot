import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import type { EngineLimitsReport } from "../shared/limit-reset.ts";
import type { PlanProviderRow } from "./plan-usage.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("forces fresh usage inside the TTL, preserves failed and guessed holds, and persists only an eligible named Codex release", async () => {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  let child: ChildProcess | undefined;
  const evidence: unknown[] = [];
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const now = Date.now();
    const until = now + 86_400_000;
    const holdsPath = join(dataDir, "limit-holds.json");
    const usagePath = join(dataDir, "plan-usage.json");
    const ids = ["codexWork", "codexSibling", "codexGuessed", "codexFailed"];
    const holds = Object.fromEntries(ids.map((id) => [id, { until, heldAt: now - 10_000, guessed: id === "codexGuessed" }]));
    writeFileSync(holdsPath, JSON.stringify(holds));
    const row = (id: string, reset: number, usedPercent = 100): PlanProviderRow => ({
      id, name: id, driver: "codex", plan: "fixture", ok: true, error: null,
      fiveHour: { available: true, remainingPercent: 100 - usedPercent, usedPercent, resetsAt: new Date(reset).toISOString() },
      weekly: { available: false, remainingPercent: null, usedPercent: null, resetsAt: null }, extra: [], models: [],
    });
    const writeUsage = (providers: PlanProviderRow[]) => writeFileSync(usagePath, JSON.stringify({ providers }));
    writeUsage(ids.map((id) => row(id, until)));
    const log = openSync(logPath, "a", 0o600);
    child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), OMB_TEST_PLAN_USAGE_FILE: usagePath },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);
    const read = async (refresh = false): Promise<EngineLimitsReport> => {
      const response = await fetch(url + `/api/limit-resets${refresh ? "?refresh=1" : ""}`, { headers: { origin: url }, signal: AbortSignal.timeout(30_000) });
      expect(response.status).toBe(200);
      const report = await response.json() as EngineLimitsReport;
      evidence.push(report);
      return report;
    };
    const cached = await read(true);
    expect(cached.engines.filter((engine) => engine.blocked)).toHaveLength(4);
    writeUsage([
      row("codexWork", until + 86_400_000, 15), row("codexSibling", until, 25),
      row("codexGuessed", until + 86_400_000, 15),
      { ...row("codexFailed", until + 86_400_000, 15), ok: false, error: "Fixture provider unavailable" },
    ]);
    expect(await read()).toEqual(cached);
    const refreshed = await read(true);
    expect(refreshed.checkedAt - cached.checkedAt).toBeLessThan(5 * 60_000);
    expect(refreshed.engines.find((engine) => engine.engine === "codexWork")).toMatchObject({ blocked: false, usedPercent: 15, resetsAt: until + 86_400_000 });
    for (const id of ids.slice(1)) expect(refreshed.engines.find((engine) => engine.engine === id)).toMatchObject({ blocked: true });
    expect(refreshed.engines.find((engine) => engine.engine === "codexFailed")?.windows).toEqual(cached.engines.find((engine) => engine.engine === "codexFailed")?.windows);
    expect(refreshed.errors).toEqual({ codexFailed: "Fixture provider unavailable" });
    expect(JSON.parse(readFileSync(holdsPath, "utf8"))).toEqual(Object.fromEntries(Object.entries(holds).filter(([id]) => id !== "codexWork")));
  } finally {
    writeFileSync(`${logPath}.usage-refresh.json`, JSON.stringify(evidence, null, 2));
    await waitForExit(child, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath: `${logPath}.usage-refresh.json`, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 90_000);

it("returns the next turn from its backup to Codex after a provider-confirmed status refresh", async () => {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  let child: ChildProcess | undefined;
  const evidence: unknown[] = [];
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const cfgPath = join(dataDir, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.instances.codex = { driver: "codex", config: { cli: fileURLToPath(new URL("./testing/fake-codex-app-server.ts", import.meta.url)) } };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    const now = Date.now(), until = now + 86_400_000;
    writeFileSync(join(dataDir, "limit-holds.json"), JSON.stringify({ codex: { until, heldAt: now - 10_000, guessed: false } }));
    const usagePath = join(dataDir, "plan-usage.json");
    const writeUsage = (usedPercent: number, reset: number) => writeFileSync(usagePath, JSON.stringify({ providers: [{
      id: "codex", name: "Codex", driver: "codex", plan: "fixture", ok: true, error: null,
      fiveHour: { available: true, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: new Date(reset).toISOString() },
      weekly: { available: false, usedPercent: null, remainingPercent: null, resetsAt: null }, extra: [], models: [],
    }] }));
    writeUsage(100, until);
    const log = openSync(logPath, "a", 0o600);
    child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), OMB_TEST_PLAN_USAGE_FILE: usagePath },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    const api = async (method: string, path: string, body?: unknown): Promise<any> => {
      const response = await fetch(url + path, { method, headers: { origin: url, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
      const result = await response.json();
      expect(response.ok, JSON.stringify(result)).toBe(true);
      return result;
    };
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);
    const selection = { instanceId: "codex", model: "gpt-fake-default" };
    await expect.poll(async () => (await api("GET", "/api/instances")).instances
      .find((instance: any) => instance.instanceId === "codex")?.models.options.some((model: any) => model.id === selection.model), { timeout: 20_000 }).toBe(true);
    const { bots } = await api("GET", "/api/bots");
    const chief = bots.find((bot: any) => bot.chiefOfStaff);
    if (chief) await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: false });
    const control = async (...args: string[]) => {
      const result = await runControlOmb([...args, "--url", url]) as any;
      evidence.push({ command: args, result });
      return result;
    };
    const { bot } = await control("new-bot", "--name", "Refresh fixture");
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: selection });
    const task = async () => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === threadId);
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "First fixture request");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    expect((await task()).modelSelection.instanceId).toBe("claude");
    writeUsage(15, until + 86_400_000);
    const refreshed = await api("GET", "/api/limit-resets?refresh=1");
    expect(refreshed.engines).toContainEqual(expect.objectContaining({ engine: "codex", blocked: false, usedPercent: 15 }));
    expect(JSON.parse(readFileSync(join(dataDir, "limit-holds.json"), "utf8"))).not.toHaveProperty("codex");
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Second fixture request");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "30")).status).toBe("settled");
    expect((await task()).modelSelection).toEqual(selection);
    const messages = (await api("GET", `/api/threads/${threadId}/messages`)).messages;
    expect(messages.findLast((message: any) => message.role === "bot" && message.kind === "text")?.text).toBe("done from fake codex");
    evidence.push({ refreshed, messages });
  } finally {
    writeFileSync(`${logPath}.usage-refresh-routing.json`, JSON.stringify(evidence, null, 2));
    await waitForExit(child, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath: `${logPath}.usage-refresh-routing.json`, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 90_000);
