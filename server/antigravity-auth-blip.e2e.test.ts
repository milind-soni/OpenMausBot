import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { antigravityTokenPath } from "./drivers/antigravity-acp.ts";
import { waitForExit } from "./testing/cleanup.ts";

const codex = { instanceId: "codex", model: "gpt-fake-default" };
const antigravity = { instanceId: "antigravity", model: "gemini-3.8-flash" };

it("a sign-in Google cannot confirm for a moment is not a sign-out", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  const runtime = join(dataDir, "fake-antigravity");
  const failureFile = join(dataDir, "authenticate-failure.json");
  const rpcFile = join(dataDir, "antigravity-rpc.jsonl");
  const codexLog = join(dataDir, "codex-launches.jsonl");
  const evidence: unknown[] = [{ url, dataDir }];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(200);
    return value;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const calls = (method: string): Array<{ pid: number }> => existsSync(rpcFile)
    ? readFileSync(rpcFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call.method === method)
    : [];
  const codexTurns = () => existsSync(codexLog)
    ? readFileSync(codexLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.event === "turn/start")
    : [];
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    mkdirSync(runtime, { recursive: true });
    const fakeAcp = fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url));
    for (const name of ["agy.ts", process.platform === "win32" ? "localharness_external.exe" : "localharness_external"]) {
      copyFileSync(fakeAcp, join(runtime, name));
      chmodSync(join(runtime, name), 0o755);
    }
    const token = antigravityTokenPath(antigravity.instanceId, dataDir);
    mkdirSync(dirname(token), { recursive: true });
    writeFileSync(token, "{}", { mode: 0o600 });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.antigravity = {
      driver: "antigravityAgent",
      config: { cli: join(runtime, "agy.ts") },
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODELS: antigravity.model,
        FAKE_ACP_RPC_FAILURE_METHOD: "authenticate", FAKE_ACP_RPC_FAILURE_FILE: failureFile, FAKE_ACP_RPC_APPEND_FILE: rpcFile,
      },
    };
    config.instances.codex = {
      driver: "codex", config: { cli: fileURLToPath(new URL("./testing/fake-codex-app-server.ts", import.meta.url)) },
      environment: { FAKE_CODEX_STARTUP_LOG: codexLog },
    };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    const instance = async (id: string) => ((await api("GET", "/api/instances?fresh=1")).instances as any[]).find((entry) => entry.instanceId === id);
    await expect.poll(async () => (await instance("codex"))?.models.options.some((option: any) => option.id === codex.model), { timeout: 20_000 }).toBe(true);
    expect((await instance("antigravity"))?.snapshot.authenticated).toBe(true);
    expect(existsSync(codexLog), "the backup's launches are recorded").toBe(true);

    const { bots } = await api("GET", "/api/bots") as { bots: Array<{ id: string; chiefOfStaff?: boolean }> };
    const starter = bots.find((bot) => bot.chiefOfStaff);
    if (starter) await api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: false });
    const { bot } = await control("new-bot", "--name", "Kai");
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: antigravity, fallback: [codex] });
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: antigravity });
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
    const lines = (all: any[]) => all.flatMap((message) => message.tool?.name ? [message.tool.name as string] : []);

    writeFileSync(failureFile, JSON.stringify({ code: -32603, message: "Failed to refresh token: network is unreachable" }));
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Draft the launch plan");
    await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "60");
    const first = await messages();
    evidence.push({ first });
    expect(lines(first).filter((line) => /signed out|needs a Google account/i.test(line)), "nothing says it signed out").toEqual([]);
    expect(lines(first).some((line) => line.includes("network is unreachable")), "the reason is shown").toBe(true);
    expect((await instance("antigravity"))?.snapshot.authenticated, "still signed in").toBe(true);
    const notices = ((await api("GET", "/api/notifications")).notifications as any[]).filter((entry) => entry.kind === "notice");
    expect(notices.map((entry) => entry.body).filter((body) => /signed out/i.test(body))).toEqual([]);
    expect(codexTurns(), "the backup did not take the turn").toEqual([]);

    rmSync(failureFile);
    const refused = calls("authenticate").map((call) => call.pid);
    expect(refused, "the runtime was asked to authenticate").not.toEqual([]);
    expect(calls("session/prompt"), "the refused process never got the prompt").toEqual([]);
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await expect.poll(() => refused.some(alive), { timeout: 15_000, message: "the refused process was stopped" }).toBe(false);
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Try again");
    expect((await control("wait", "--bot", bot.id, "--task", threadId, "--timeout", "60")).status).toBe("settled");
    const prompted = calls("session/prompt").map((call) => call.pid);
    expect(prompted, "the next turn ran on Antigravity").toHaveLength(1);
    expect(refused, "on a new process").not.toContain(prompted[0]);
    expect(codexTurns(), "nor the next one").toEqual([]);
    evidence.push({ second: await messages() });
  } finally {
    const evidencePath = `${logPath}.antigravity-auth-blip.json`;
    try {
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    } finally {
      await waitForExit(server, { signal: "SIGTERM" });
      await fixture.close();
      console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
    }
  }
}, 240_000);
