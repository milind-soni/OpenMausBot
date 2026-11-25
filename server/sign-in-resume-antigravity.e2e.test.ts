import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { nativeFixture } from "./testing/antigravity-native-fixture.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

type Row = { id: string; parentId?: string | null; role: string; kind: string; text?: string; tool?: { name: string; ok: boolean; setup?: boolean } };

it.skipIf(process.platform === "win32")("a bot on a signed-out Antigravity runs its stuck message again once Antigravity is signed in in the app", async () => {
  const cli = nativeFixture(mkdtempSync(join(tmpdir(), "omb-sign-in-resume-agy-")));
  const fixture = await launchVerificationServer({});
  const { url, dataDir, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  const evidence: unknown[] = [];
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.antigravity = { driver: "antigravityAgent", config: { cli: cli.executable }, environment: { FAKE_AGY_LOG: cli.log } };
    config.automaticRecovery = { enabled: false };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);

    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
      const result = await response.json() as any;
      expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
      return result;
    };
    const control = async (...args: string[]) => await runControlOmb([...args, "--url", url]) as any;
    const antigravity = async () => ((await api("GET", "/api/instances?fresh=1")).instances as any[]).find((instance) => instance.instanceId === "antigravity");
    const activePath = async (threadId: string) => {
      const { messages, activeLeafId } = await api("GET", `/api/threads/${threadId}/messages?limit=500`) as { messages: Row[]; activeLeafId?: string };
      const byId = new Map(messages.map((row) => [row.id, row]));
      const path: Row[] = [];
      for (let row = activeLeafId ? byId.get(activeLeafId) : messages.at(-1); row; row = row.parentId ? byId.get(row.parentId) : undefined) path.unshift(row);
      return path;
    };
    const prompts = () => cli.methods().filter((method) => method === "session/prompt").length;

    await expect.poll(async () => { try { return (await fetch(url + "/api/health")).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
    const { bots } = await api("GET", "/api/bots") as { bots: Array<{ id: string; chiefOfStaff?: boolean }> };
    const starter = bots.find((bot) => bot.chiefOfStaff);
    if (starter) await api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: false });
    await expect.poll(async () => (await antigravity())?.snapshot.authenticated, { timeout: 60_000 }).toBe(false);
    const model = (await antigravity()).models.options[0].id as string;

    const { bot } = await control("new-bot", "--name", "Wren");
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "antigravity", model } });
    await control("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "继续吧");
    expect((await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "60")).status).toBe("failed");
    const stuck = await activePath(bot.activeTaskId);
    evidence.push({ stuck });
    expect(stuck.filter((row) => row.tool?.setup).map((row) => row.tool!.name)).toEqual([
      "error: Antigravity needs a Google account — choose Sign in with Google in engine setup",
      "notice: Google Gemini (Antigravity) is signed out on this computer. Sign in again in Settings → AI to keep using it. Until then Wren can't run: it has no backup.",
    ]);
    expect(prompts()).toBe(0);

    const flow = (await api("POST", "/api/instances/antigravity/auth/start", {})).auth;
    await api("POST", "/api/instances/antigravity/auth/complete", { flowId: flow.flowId, callbackUrl: "fixture-code" });
    await expect.poll(prompts, { timeout: 60_000 }).toBe(1);
    expect((await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "60")).status).toBe("settled");
    const now = await activePath(bot.activeTaskId);
    evidence.push({ now });
    expect(now.filter((row) => row.tool?.setup)).toEqual([]);
    expect(now.filter((row) => row.role === "user").map((row) => row.text)).toEqual(["继续吧"]);
    expect(now.filter((row) => row.role === "bot" && row.kind === "text").at(-1)).toMatchObject({ text: "fixture reply" });
  } finally {
    try {
      writeFileSync(`${logPath}.sign-in-resume-agy.json`, JSON.stringify(evidence, null, 2));
      console.info(JSON.stringify({ logPath, evidence: `${logPath}.sign-in-resume-agy.json` }));
    } finally {
      await waitForExit(server, { signal: "SIGTERM" });
      await fixture.close();
    }
  }
}, hostTimeout(300_000));
