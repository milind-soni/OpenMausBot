// The Team map reads live work through the actual route under the disposable
// launcher. The only provider is its fake CLI; the teammate waits on a gate.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

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
    const nodes = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "room-handoffs.json"), "utf8")) as Array<{ botId: string; status: string; threadId: string }>;
    await expect.poll(() => { try { return nodes().find(node => node.botId === teammate.id)?.status; } catch { return undefined; } }, { timeout: 15_000 }).toBe("running");
    const workThread = nodes().find(node => node.botId === teammate.id)!.threadId;

    const live = await api("/api/team-map");
    expect(live.running).toEqual([{ sourceBotId: sender.id, targetBotId: teammate.id, threadId: workThread }]);
    expect(JSON.stringify(live)).not.toContain("PRIVATE_REQUEST_TEXT");

    writeFileSync(gate, "finish the teammate");
    expect((await control(["wait", "--bot", sender.id, "--task", sender.activeTaskId, "--timeout", "15"])).status).toBe("settled");
    await expect.poll(async () => (await api("/api/team-map")).running, { timeout: 15_000 }).toEqual([]);
    expect(JSON.stringify(await api("/api/team-map"))).not.toContain("PRIVATE_RESULT_TEXT");
  } finally {
    await fixture.close();
  }
}, 45_000);
