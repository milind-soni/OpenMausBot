import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("keeps ordinary work out of setup and carries explicit bot defaults and file locations into rooms", async () => {
  const fixture = await launchVerificationServer();
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result });
    return result;
  };
  const api = async (method: string, path: string, body?: unknown, status?: number) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    evidence.push({ method, path, body, status: response.status });
    if (status) expect(response.status, JSON.stringify(result)).toBe(status);
    else expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const receipt = () => {
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    // Never retain the launch environment/MCP config: it holds fixture tokens.
    const result = { model: dump.argv[dump.argv.indexOf("--model") + 1], system: dump.systemPrompt as string, prompt: dump.prompt };
    evidence.push({ receipt: result });
    return result;
  };
  try {
    const catalog = await control(["models"]);
    const [a, b] = catalog.instances.find((item: any) => item.instanceId === "claude").models.options.map((item: any) => item.id);
    const selection = (model: string) => ({ instanceId: "claude", model });
    const { bot } = await api("POST", "/api/bots", { name: "Garden helper", title: "Gardener", modelSelection: selection(a) });
    const direct = async (text: string) => {
      await control(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text]);
      expect((await control(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30"])).status).toBe("settled");
      return receipt();
    };
    const ordinary = await direct("What is 17 + 25? Answer with the number.");
    expect(ordinary.system).not.toContain("Wait for a yes");
    expect(ordinary.system).not.toContain("The user explicitly asked you to set yourself up");
    const oldFile = join(fixture.info.dataDir, "workspaces", bot.id, "garden-plan.txt");
    writeFileSync(oldFile, "Water the garden on Friday. Fixture code: MOSS-42.\n");
    // The prompt JSON-encodes paths, including Windows backslashes.
    expect(ordinary.system).toContain(JSON.stringify(join(fixture.info.dataDir, "workspaces", bot.id)));
    expect(ordinary.system).toContain(JSON.stringify(join(fixture.info.dataDir, "task-workspaces", bot.id, bot.threadId)));

    const setup = await direct("/setup Help me track garden watering");
    expect(setup.system).toContain("The user explicitly asked you to set yourself up");
    expect(setup.system).toContain("Wait for a yes");
    // /setup is not sticky; a subsequent task must not carry its coaching.
    const afterSetup = await direct("Never mind setup. Summarize: the garden needs water Friday.");
    expect(afterSetup.system).not.toContain("Wait for a yes");
    expect(JSON.stringify(afterSetup.prompt)).toContain("Never mind setup");

    await api("PATCH", `/api/bots/${bot.id}`, { soul: "You look after the garden. Keep its watering plan.", description: "Garden helper" });
    const { task: sibling } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Sibling keeps its model" });
    // Change an inactive task, not the newly selected sibling.
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { modelSelection: selection(b), updateBotDefault: true });
    expect((await direct("Tell me your responsibility in one sentence.")).model).toBe(b);
    const { group } = await api("POST", "/api/groups", {
      name: "Garden room", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    });
    const room = async (text: string) => {
      await control(["send-channel", "--channel", group.id, "--text", text]);
      expect((await control(["wait", "--channel", group.id, "--timeout", "30"])).status).toBe("settled");
      return receipt();
    };
    const shared = await room("Read the garden-plan.txt you made earlier and tell me its fixture code.");
    expect(shared.model).toBe(b);
    expect(shared.system).toContain("You look after the garden");
    expect(shared.system).toContain(JSON.stringify(join(fixture.info.dataDir, "task-workspaces", bot.id)));
    expect(shared.system).toContain(JSON.stringify(join(fixture.info.dataDir, "workspaces", bot.id)));
    expect(readFileSync(oldFile, "utf8")).toContain("MOSS-42");
    const state = (await api("GET", "/api/bots")).bots.find((item: any) => item.id === bot.id);
    expect(state.modelSelection).toEqual(selection(b));
    expect(state.tasks.find((task: any) => task.threadId === sibling.threadId).modelSelection).toEqual(selection(a));
    const { task: future } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Future uses default" });
    expect(future.modelSelection).toEqual(selection(b));

    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { modelSelection: selection(a) });
    expect((await direct("Reply once for the thread-only model test.")).model).toBe(a);
    expect((await room("Reply once for the unchanged room default.")).model).toBe(b);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { updateBotDefault: true }, 400);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { modelSelection: selection(a), updateBotDefault: "yes" }, 400);
    await api("PATCH", `/api/bots/${bot.id}/tasks/not-a-thread`, { modelSelection: selection(a), updateBotDefault: true }, 404);
    await control(["messages", "--bot", bot.id, "--task", bot.threadId, "--limit", "20"]);
    await control(["messages", "--channel", group.id, "--limit", "20"]);
  } finally {
    const evidencePath = `${fixture.info.logPath}.bot-continuity.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath }));
    await fixture.close();
  }
}, 90_000);
