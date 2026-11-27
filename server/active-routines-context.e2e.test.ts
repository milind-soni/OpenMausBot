import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("shows a work conversation's interval monitor and stop rule in main chat, then reads back its pause", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const evidence = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.ok, JSON.stringify(value)).toBe(true);
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    const { bot } = await cli("new-bot", "--name", "Payment fixture");
    const main = bot.activeTaskId as string;
    const { task: work } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Payment work" });
    const instructions = "Check the fixture payment. After successful delivery, pause this automation.";
    const turn = async (threadId: string, text: string, plan: unknown) => {
      const before = evidence().length;
      writeFileSync(planPath, JSON.stringify({ [bot.id]: plan }));
      await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
      await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(before + 1);
      await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "20");
      return evidence().at(-1);
    };
    await turn(work.threadId, "Watch the fixture payment hourly until delivery.", {
      steps: [{ tool: "trigger", arguments: { action: "create", when: "schedule", name: "Temporary payment monitor", instructions,
        schedule: { type: "interval", everyMinutes: 60 } } }], reply: "The hourly monitor is ready.",
    });
    const { routines } = await api("GET", "/api/routines");
    expect(routines).toHaveLength(1);
    const monitor = routines[0];
    expect(monitor).toMatchObject({ enabled: true, sourceThreadId: work.threadId });
    writeFileSync(planPath, JSON.stringify({ [bot.id]: { reply: "The fixture payment has not arrived." } }));
    const { run } = await api("POST", `/api/routines/${monitor.id}/run`);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((item: any) => item.id === run.id)?.status,
      { timeout: 20_000 }).toBe("completed");
    const runPrompt = JSON.stringify(evidence().at(-1).prompt);
    const settled = await turn(main, "The fixture payment was delivered. Finish the task.", {
      steps: [
        { tool: "trigger_info", arguments: { action: "list", trigger_id: monitor.id } },
        { tool: "trigger", arguments: { action: "pause", trigger_id: monitor.id } },
        { tool: "trigger_info", arguments: { action: "list", trigger_id: monitor.id } },
      ], reply: "Delivery is complete and the temporary monitor is paused.",
    });
    expect(settled.system).toContain('"id":"' + monitor.id + '"');
    expect(settled.system).toContain('"source":"Payment work"');
    expect(settled.system).toContain(instructions);
    expect(settled.system).toContain('"schedule":"interval"');
    expect(runPrompt).toContain(`Trigger id: ${monitor.id}`);
    const reads = settled.evidence.filter((entry: any) => entry.step?.tool === "trigger_info");
    const readback = reads.at(-1).response.result.content[0].text;
    const state = JSON.parse(readback.slice(readback.indexOf("\n") + 1));
    expect(state).toMatchObject({ id: monitor.id, enabled: false, nextRunAt: null });
    const after = await turn(main, "Confirm the final fixture state.", { reply: "The monitor remains paused." });
    expect(after.system).not.toContain('"id":"' + monitor.id + '"');
  } finally { await fixture.close(); }
}, 90_000);
