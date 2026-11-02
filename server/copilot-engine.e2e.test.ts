import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("moves one bot and one conversation between Claude, GitHub Copilot and a custom ACP agent through the picker's routes", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["copilot", "customAcp"]);
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const prompts = (file: string) => {
    const path = join(dataDir, `${file}.prompts.jsonl`);
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  const turn = async (botId: string, threadId: string, text: string) => {
    await cli("send", "--bot", botId, "--task", threadId, "--text", text);
    expect((await cli("wait", "--bot", botId, "--task", threadId, "--timeout", "25")).status).toBe("settled");
  };
  try {
    const copilot = (await api("POST", "/api/instances/githubCopilot/refresh-models", {})).instances
      .find((entry: any) => entry.instanceId === "githubCopilot");
    expect(copilot).toMatchObject({ driverKind: "copilotAgent", access: "subscription", snapshot: { state: "available" } });
    expect(copilot.snapshot.authenticated).toBe(true);
    expect(copilot.models.options.map((option: any) => option.id)).toEqual(["auto", "claude-haiku-4.5", "gpt-5.6-luna"]);
    const custom = (await api("POST", "/api/instances/myAgent/refresh-models", {})).instances
      .find((entry: any) => entry.instanceId === "myAgent");
    expect(custom.models.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "agent-default", custom: true }), expect.objectContaining({ id: "fixture-deep", custom: true }),
    ]));
    for (const starter of (await api("GET", "/api/bots")).bots.filter((bot: any) => bot.chiefOfStaff)) {
      await api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: false });
    }
    const bot = (await cli("new-bot", "--name", "Engine hopper")).bot;
    const thread: string = bot.activeTaskId ?? bot.threadId;
    const claude = bot.modelSelection;
    expect(claude.instanceId).toBe("claude");
    await turn(bot.id, thread, "on claude");

    // The bot's own engine, as the picker saves it with no conversation open.
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "githubCopilot", model: "gpt-5.6-luna" } });
    await turn(bot.id, thread, "on copilot");
    expect(prompts("copilot-launch.json").at(-1)).toMatchObject({ model: "gpt-5.6-luna" });
    // The strict route checks the id against the refreshed catalog.
    await api("PATCH", `/api/bots/${bot.id}/model`, { instanceId: "githubCopilot", model: "claude-haiku-4.5" });
    await api("PATCH", `/api/bots/${bot.id}/model`, { instanceId: "githubCopilot", model: "not-offered" }, 400);
    await turn(bot.id, thread, "on haiku");
    expect(prompts("copilot-launch.json").at(-1)).toMatchObject({ model: "claude-haiku-4.5" });

    // One conversation, as the picker saves it with that conversation open.
    await api("PATCH", `/api/bots/${bot.id}/tasks/${thread}`, { modelSelection: { instanceId: "myAgent", model: "fixture-deep" } });
    await turn(bot.id, thread, "on custom");
    expect(prompts("custom-acp-launch.json").at(-1)).toMatchObject({ model: "fixture-deep" });

    await api("PATCH", `/api/bots/${bot.id}/tasks/${thread}`, { modelSelection: claude });
    const copilotTurns = prompts("copilot-launch.json").length, customTurns = prompts("custom-acp-launch.json").length;
    await turn(bot.id, thread, "back on claude");
    expect(prompts("copilot-launch.json")).toHaveLength(copilotTurns);
    expect(prompts("custom-acp-launch.json")).toHaveLength(customTurns);
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: claude });
    const saved = (await api("GET", "/api/bots")).bots.find((row: any) => row.id === bot.id);
    expect(saved.modelSelection).toMatchObject({ instanceId: "claude", model: claude.model });
    const messages = (await api("GET", `/api/threads/${thread}/messages?limit=50`)).messages;
    expect(messages.filter((message: any) => message.role === "bot" && message.text?.includes("hello from fake acp")).length).toBeGreaterThanOrEqual(3);
  } finally {
    await fixture.close();
  }
}, 120_000);

/** Verifies routine create and update calls through Copilot's scoped launcher-owned MCP server. */
async function createAndUpdateRoutineThroughCopilotTools() {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["copilot"]);
  const { url, dataDir, logPath } = fixture.info;
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(200);
    return result;
  };
  const cli = async (...args: string[]) => {
    const result = await runControlOmb([...args, "--url", url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  try {
    expect((await cli("doctor")).ok).toBe(true);
    const calls = join(dataDir, "copilot-calls.json");
    const wrapper = join(dataDir, "copilot-fixture.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'process.env.FAKE_ACP_MODE = "mcp-calls";',
      `process.env.FAKE_ACP_MCP_CALLS_FILE = ${JSON.stringify(calls)};`,
      `await import(${JSON.stringify(new URL("./testing/fake-acp-cli.ts", import.meta.url).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/githubCopilot", { cli: wrapper });
    const bot = (await cli("new-bot", "--name", "Copilot routines")).bot;
    const threadId = bot.activeTaskId;
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "githubCopilot", model: "auto" } });
    const schedule = { type: "cron", expression: "0 9 1 * *", timeZone: "UTC" };
    const turn = async (text: string, args: object) => {
      writeFileSync(calls, JSON.stringify([{ server: "agents", name: "trigger", arguments: args }]));
      await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "25")).status).toBe("settled");
      const messages = await cli("messages", "--bot", bot.id, "--task", threadId);
      const launch = JSON.parse(readFileSync(join(dataDir, "copilot-launch.json"), "utf8"));
      expect(launch.argv).toContain("--additional-mcp-config");
      expect(launch.mcpServers).toEqual([]);
      evidence.push({ messages });
    };
    await turn("Create a monthly report routine.", { action: "create", when: "schedule", name: "Copilot report",
      instructions: "Summarize synthetic fixture activity without external services.", schedule });
    const routine = (await api("GET", "/api/routines")).routines.find((routine: any) => routine.botId === bot.id);
    expect(routine).toMatchObject({ name: "Copilot report", enabled: true, schedule });
    await turn("Rename the report routine.", { action: "update", trigger_id: routine.id, name: "Updated Copilot report" });
    const saved = (await api("GET", "/api/routines")).routines.find((row: any) => row.id === routine.id);
    expect(saved).toMatchObject({ name: "Updated Copilot report", schedule });
    const persisted = JSON.parse(readFileSync(join(dataDir, "routines.json"), "utf8"));
    expect(persisted.routines.find((row: any) => row.id === routine.id)).toMatchObject({ name: "Updated Copilot report", schedule });
    evidence.push({ saved });
  } finally {
    const evidencePath = `${logPath}.copilot-tools.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath, evidencePath }));
    await fixture.close();
  }
}

it("creates and updates a routine through Copilot's launcher-owned tools", createAndUpdateRoutineThroughCopilotTools, 90_000);
