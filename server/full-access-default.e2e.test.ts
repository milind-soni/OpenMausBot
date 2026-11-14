// Real server, repository-owned fake engines only.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("starts new bots and threads at Full access on each engine family, and keeps a person's Ask", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const { dataDir, url, logPath } = fixture.info;
  const codexDump = join(dataDir, "codex-dump.json");
  const droidDump = join(dataDir, "droid-dump.json");
  let server: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const start = async () => {
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const send = (botId: string, threadId: string) => control("send", "--bot", botId, "--task", threadId, "--text", "Check the fixture report.");
  const wait = (botId: string, threadId: string) => control("wait", "--bot", botId, "--task", threadId, "--timeout", "30");
  const stored = (botId: string) => JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")).find((bot: any) => bot.id === botId);
  const openCard = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=50`)).messages as any[])
    .find((message) => message.card?.requestId && !message.card.answered)?.card;
  try {
    // Add the other engine families to the launcher's own temporary config
    // while it is stopped. Never the person's CLIs or home.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.codex.environment = { FAKE_CODEX_DUMP: codexDump };
    config.instances.droid = {
      driver: "droidAgent", displayName: "Droid fixture",
      config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) },
      environment: { FACTORY_API_KEY: "fixture-only", FAKE_ACP_MODE: "permission", FAKE_ACP_DUMP: droidDump },
    };
    writeFileSync(configPath, JSON.stringify(config));
    await start();
    const instances = (await api("GET", "/api/instances")).instances as any[];
    const model = (instanceId: string) => ({ instanceId, model: instances.find((item) => item.instanceId === instanceId).models.default });

    const bots: Record<string, any> = {};
    for (const instanceId of ["claude", "codex", "droid"]) {
      bots[instanceId] = (await api("POST", "/api/bots", { name: `Default ${instanceId}`, modelSelection: model(instanceId) }, 201)).bot;
      expect(bots[instanceId].approvalMode).toBe("full");
      expect(stored(bots[instanceId].id).approvalMode).toBeUndefined();
    }
    const threads: Record<string, string> = {};
    for (const [instanceId, bot] of Object.entries(bots)) {
      const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: `New ${instanceId} thread` }, 201)).task;
      expect(task.approvalMode).toBe("full");
      threads[instanceId] = task.threadId;
      await send(bot.id, task.threadId);
      expect((await wait(bot.id, task.threadId)).status).toBe("settled");
    }
    const claudeArgv = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).argv as string[];
    expect(claudeArgv[claudeArgv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    const codexTurn = JSON.parse(readFileSync(codexDump, "utf8")).calls.find((call: any) => call.method === "turn/start");
    expect(codexTurn.params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
    expect(JSON.parse(readFileSync(`${droidDump}.config.json`, "utf8"))[0])
      .toMatchObject({ method: "session/set_mode", params: { modeId: "auto-high" } });
    const decisions = (await api("GET", "/api/decisions")).decisions as any[];
    expect(decisions.filter((row) => row.threadId === threads.droid).map((row) => `${row.decision}:${row.source}`))
      .toEqual(["auto-approved:full-access"]);
    expect(await openCard(threads.droid)).toBeUndefined();

    const starter = (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => !Object.values(bots).some((mine: any) => mine.id === bot.id));
    expect(starter.approvalMode).toBe("full");
    expect(stored(starter.id).approvalMode).toBeUndefined();
    await api("PATCH", `/api/bots/${starter.id}`, { modelSelection: model("codex") });
    await send(starter.id, starter.threadId);
    expect((await wait(starter.id, starter.threadId)).status).toBe("settled");
    expect(JSON.parse(readFileSync(codexDump, "utf8")).calls.findLast((call: any) => call.method === "turn/start").params)
      .toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });

    expect((await api("PATCH", `/api/bots/${bots.droid.id}`, { approvalMode: "ask", applyToAllThreads: true })).bot.approvalMode).toBe("ask");
    await waitForExit(server!, { signal: "SIGTERM" });
    await start();
    expect(stored(bots.droid.id).approvalMode).toBe("ask");
    const askThread = (await api("POST", `/api/bots/${bots.droid.id}/tasks`, { title: "Ask thread" }, 201)).task;
    expect(askThread.approvalMode).toBe("ask");
    expect((await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === bots.claude.id).approvalMode).toBe("full");
    await send(bots.droid.id, askThread.threadId);
    await expect.poll(() => openCard(askThread.threadId), { timeout: 20_000 }).toBeTruthy();
    const card = await openCard(askThread.threadId);
    await api("POST", `/api/threads/${askThread.threadId}/respond`, { requestId: card.requestId, behavior: "deny" });
    expect((await wait(bots.droid.id, askThread.threadId)).status).toBe("settled");
    expect(JSON.parse(readFileSync(`${droidDump}.config.json`, "utf8")).findLast((call: any) => call.method === "session/set_mode"))
      .toMatchObject({ params: { modeId: "normal" } });
  } finally {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 120_000);
