// The only provider is the launcher's fake CLI; the teammate waits on a gate.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { appendUsage } from "./usage-ledger.ts";

it("shows coordinate_bots work on the team map while it runs, with ids only", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const api = async (path: string) => (await fetch(`${fixture.info.url}${path}`)).json() as Promise<any>;
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    const sender = (await control(["new-bot", "--name", "Map sender"])).bot;
    const teammate = (await control(["new-bot", "--name", "Map teammate"])).bot;
    const gate = join(fixture.info.dataDir, "map-teammate.gate");
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({
      [sender.id]: {
        steps: [{ arguments: { bot_ids: [teammate.id], request_key: "map-check", message: "PRIVATE_REQUEST_TEXT" } }],
        reply: "Sent.", resumeReply: "The teammate finished.",
      },
      [teammate.id]: { gateFile: gate, reply: "PRIVATE_RESULT_TEXT" },
    }));
    await control(["send", "--bot", sender.id, "--task", sender.activeTaskId, "--text", "Ask the teammate to check the map."]);
    const nodes = () => readHandoffs(fixture.info.dataDir);
    await expect.poll(() => { try { return nodes().find(node => node.botId === teammate.id)?.status; } catch { return undefined; } }, { timeout: 15_000 }).toBe("running");
    const workThread = nodes().find(node => node.botId === teammate.id)!.threadId;

    const live = await api("/api/team-map");
    expect(live.running).toEqual([{ sourceBotId: sender.id, targetBotId: teammate.id, threadId: workThread }]);
    expect(JSON.stringify(live)).not.toContain("PRIVATE_REQUEST_TEXT");
    expect(typeof live.stuckAfterMs).toBe("number");
    expect(typeof live.doneLast24h).toBe("number");
    const session = live.sessions.find((one: any) => one.threadId === workThread);
    expect(session).toMatchObject({ botId: teammate.id, threadId: workThread, state: "running" });
    expect(typeof session.startedAt).toBe("number");

    writeFileSync(gate, "finish the teammate");
    expect((await control(["wait", "--bot", sender.id, "--task", sender.activeTaskId, "--timeout", "15"])).status).toBe("settled");
    await expect.poll(async () => (await api("/api/team-map")).running, { timeout: 15_000 }).toEqual([]);
    const settled = await api("/api/team-map");
    expect(JSON.stringify(settled)).not.toContain("PRIVATE_RESULT_TEXT");
    expect(settled.sessions.find((one: any) => one.threadId === workThread)).toBeUndefined();
  } finally {
    await fixture.close();
  }
}, 45_000);

it("doneLast24h counts a finished turn but not a helper-model row, on a freshly booted ledger", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const api = async (path: string) => (await fetch(`${fixture.info.url}${path}`)).json() as Promise<any>;
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    const bot = (await control(["new-bot", "--name", "Ledger bot"])).bot;
    const row = { botId: bot.id, botName: bot.name as string, instanceId: "inst-1", driverKind: "claude", model: "claude-opus-5-5", input: 10, output: 10, costUsd: 0.01 };
    await appendUsage(fixture.info.dataDir, { ...row, threadId: "turn-thread", turnId: "turn-1", trigger: { kind: "user" } });
    await appendUsage(fixture.info.dataDir, { ...row, threadId: "helper-thread", trigger: { kind: "helper", botId: bot.id } });
    const live = await api("/api/team-map");
    expect(live.doneLast24h).toBe(1);
  } finally {
    await fixture.close();
  }
}, 45_000);
