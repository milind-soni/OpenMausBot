import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { appendUsage, flushUsageLedger } from "./usage-ledger.ts";
import type { WireBot, WireGroup } from "../shared/wire.ts";

it("projects historical usage, clears it on thread switch, and refreshes after a real fixture turn", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir } = fixture.info;
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]);
  const post = async (path: string, body = {}) => {
    const response = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json() as { group: WireGroup };
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result.group;
  };
  try {
    const bot = (await control("new-bot", "--name", "Usage fixture") as { bot: Pick<WireBot, "id" | "name"> & { activeTaskId: string } }).bot;
    const group = (await control("new-channel", "--name", "Usage room", "--members", bot.id) as { channel: Pick<WireGroup, "id" | "name"> & { activeTaskId: string } }).channel;
    const read = async () => {
      const response = await fetch(url + "/api/bots?messages=0");
      const state = await response.json() as { groups: WireGroup[] };
      return state.groups.find(item => item.id === group.id)!;
    };
    expect((await read()).usage).toBeNull();
    const recorded = { botId: bot.id, botName: bot.name, instanceId: "fixture", driverKind: "claude", model: "fixture", input: 100, output: 10, cachedInput: 80, costUsd: 0.01, trigger: { kind: "owner" as const } };
    appendUsage(dataDir, { ...recorded, threadId: group.activeTaskId, at: "2026-01-01T00:00:00.000Z" });
    appendUsage(dataDir, { ...recorded, threadId: bot.activeTaskId, at: "2026-01-01T00:00:00.000Z", input: 9000 });
    await flushUsageLedger(dataDir);
    expect((await read()).usage).toMatchObject({ input: 100, output: 10, cachedInput: 80, turns: 1, lastSpeaker: { botId: bot.id, name: bot.name } });
    const fresh = await post(`/api/groups/${group.id}/tasks`, { title: "Other thread" });
    expect(fresh.threadId).not.toBe(group.activeTaskId);
    expect(fresh.usage).toBeNull();
    const restored = await post(`/api/groups/${group.id}/tasks/${group.activeTaskId}`);
    expect(restored.usage?.input).toBe(100);
    await control("send-channel", "--channel", group.id, "--text", "Reply briefly.");
    expect(await control("wait", "--channel", group.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    await expect.poll(async () => (await read()).usage?.turns, { timeout: 5000 }).toBe(2);
    expect((await read()).usage?.lastSpeaker?.botId).toBe(bot.id);
    expect((await post(`/api/groups/${group.id}/tasks/${fresh.threadId}`)).usage).toBeNull();
  } finally { await fixture.close(); }
}, 60_000);
