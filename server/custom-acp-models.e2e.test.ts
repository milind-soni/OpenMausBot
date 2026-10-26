import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

type Selection = { instanceId: string; model: string; variant?: string };
type Receipt = { method: string; sessionId?: string; marker?: string; model?: string; variant?: string; configId?: string; value?: string };
const engineId = "custom-model-fixture";
const selection = (model: string, variant?: string): Selection => ({ instanceId: engineId, model, ...(variant ? { variant } : {}) });

it("discovers custom ACP models and preserves independent bot and thread choices through native RPC and restart", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  const nativeDir = join(dataDir, "custom-acp-models");
  mkdirSync(nativeDir);
  const receipts = (): Receipt[] => {
    const path = join(nativeDir, "receipts.jsonl");
    return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  const evidence: unknown[] = [{ fixture: fixture.info, provider: "synthetic custom ACP, no network" }];
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const control = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const restart = async () => {
    await waitForExit(restarted ?? fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 25_000 }).toBe(true);
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const fakeCli = fileURLToPath(new URL("./testing/fake-custom-acp-models.ts", import.meta.url));
    config.instances[engineId] = { driver: "customAcp", displayName: "Custom model fixture",
      config: { cli: `${JSON.stringify(process.execPath)} --experimental-strip-types ${JSON.stringify(fakeCli)}` },
      environment: { FAKE_CUSTOM_ACP_DIRECTORY: nativeDir } };
    writeFileSync(configPath, JSON.stringify(config));
    await restart();
    const refreshed = await api("POST", `/api/instances/${engineId}/refresh-models`, {});
    const engine = refreshed.instances.find((entry: any) => entry.instanceId === engineId);
    expect(engine.snapshot.state).toBe("available");
    expect(engine.capabilities.modelVariants).toBe(true);
    expect(engine.models.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "agent-default" }),
      expect.objectContaining({ id: "glm-5.3", label: "GLM-5.3", variants: expect.arrayContaining([{ id: "max", label: "Max" }]) }),
      expect.objectContaining({ id: "glm-5.3-flash", label: "GLM-5.3-Flash", variants: expect.arrayContaining([{ id: "high", label: "high" }]) }),
    ]));
    expect(receipts().filter((entry) => entry.method === "session/prompt")).toHaveLength(0);
    evidence.push({ discoveredModels: engine.models, capabilities: engine.capabilities });
    const starters = (await api("GET", "/api/bots")).bots;
    for (const starter of starters.filter((bot: any) => bot.chiefOfStaff)) {
      await api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: false });
    }
    const a = (await control("new-bot", "--name", "Custom model A")).bot;
    const b = (await control("new-bot", "--name", "Custom model B")).bot;
    const threadA: string = a.activeTaskId ?? a.threadId;
    const threadB: string = b.activeTaskId ?? b.threadId;
    const sibling: string = (await api("POST", `/api/bots/${a.id}/tasks`, { title: "Explicit sibling" }, 201)).task.threadId;
    const chosen = { a: selection("glm-5.3", "max"), b: selection("glm-5.3-flash", "high"), sibling: selection("glm-5.3", "low") };
    const save = (botId: string, threadId: string, value: Selection, updateBotDefault = true) => api("PATCH", `/api/bots/${botId}/tasks/${threadId}`, {
      modelSelection: value, updateBotDefault, requireAvailableModel: true,
    });
    await save(a.id, threadA, chosen.a);
    await save(b.id, threadB, chosen.b);
    await save(a.id, sibling, chosen.sibling, false);
    const assertSelections = async () => {
      const bots = (await api("GET", "/api/bots")).bots;
      const currentA = bots.find((bot: any) => bot.id === a.id);
      const currentB = bots.find((bot: any) => bot.id === b.id);
      expect(currentA.modelSelection).toEqual(chosen.a);
      expect(currentB.modelSelection).toEqual(chosen.b);
      expect(currentA.tasks.find((task: any) => task.threadId === threadA)).toMatchObject({ modelSelection: chosen.a, followsBotModel: true });
      expect(currentA.tasks.find((task: any) => task.threadId === sibling)).toMatchObject({ modelSelection: chosen.sibling, followsBotModel: false });
      expect(currentB.tasks.find((task: any) => task.threadId === threadB)).toMatchObject({ modelSelection: chosen.b, followsBotModel: true });
      evidence.push({ persisted: structuredClone(chosen) });
    };
    const turn = async (botId: string, threadId: string, marker: string, value: Selection) => {
      const before = receipts().length;
      expect((await control("send", "--bot", botId, "--task", threadId, "--text", `${marker} Reply with the fixture selection without tools.`)).success).toBe(true);
      expect((await control("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).status).toBe("settled");
      const captured = receipts().slice(before).filter((entry) => entry.method === "session/prompt" && entry.marker === marker);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ model: value.model, variant: value.variant });
      const transcript = await control("messages", "--bot", botId, "--task", threadId, "--limit", "20");
      const reply = transcript.messages.filter((message: any) => message.role === "bot" && message.kind === "text").at(-1);
      expect(reply?.text).toBe(`fixture:${marker}:${value.model}:${value.variant}`);
      const sessionCalls = receipts().filter((entry) => entry.sessionId === captured[0].sessionId);
      if (value.variant) expect(sessionCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: "session/set_config_option", configId: "thinking", value: value.variant }),
      ]));
      return captured[0];
    };
    await assertSelections();
    const firstA = await turn(a.id, threadA, "ACP_PICKER_A_1", chosen.a);
    const firstB = await turn(b.id, threadB, "ACP_PICKER_B_1", chosen.b);
    expect(firstA.sessionId).not.toBe(firstB.sessionId);
    await turn(a.id, sibling, "ACP_PICKER_SIBLING_1", chosen.sibling);
    await turn(a.id, threadA, "ACP_PICKER_A_2", chosen.a);
    await assertSelections();
    chosen.a = selection("glm-5.3-flash", "medium");
    await save(a.id, threadA, chosen.a);
    await turn(a.id, threadA, "ACP_PICKER_A_SWITCH", chosen.a);
    await turn(b.id, threadB, "ACP_PICKER_B_UNCHANGED", chosen.b);
    await turn(a.id, sibling, "ACP_PICKER_SIBLING_UNCHANGED", chosen.sibling);
    await assertSelections();
    await restart();
    const cached = (await api("GET", "/api/instances")).instances.find((entry: any) => entry.instanceId === engineId);
    expect(cached.models).toEqual(engine.models);
    expect(cached.capabilities.modelVariants).toBe(true);
    evidence.push({ cachedAfterRestart: cached.models });
    await assertSelections();
    await turn(a.id, threadA, "ACP_PICKER_A_RESTART", chosen.a);
    await turn(b.id, threadB, "ACP_PICKER_B_RESTART", chosen.b);
    await turn(a.id, sibling, "ACP_PICKER_SIBLING_RESTART", chosen.sibling);
    await assertSelections();
  } finally {
    const evidencePath = `${logPath}.custom-acp-models.json`;
    writeFileSync(evidencePath, JSON.stringify({ evidence, receipts: receipts() }, null, 2));
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 180_000);
