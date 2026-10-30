import { existsSync, readFileSync } from "node:fs";
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
