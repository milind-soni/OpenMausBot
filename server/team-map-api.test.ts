// The only provider is the launcher's fake CLI; the teammate waits on a gate.
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
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

{
  const ENGINE = `process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json";
process.env.FAKE_CLAUDE_RELEASE = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/release";`;
  const HOLD = { name: "Bash", input: { command: "sleep forever" }, hold: true };
  const PRIVATE_TITLE = "B_PRIVATE_TITLE_TEXT";

  let fx: CloudSendFixture, team: CloudTeamFixture;
  let admin = "", memberA = "", memberB = "", botId = "";
  const home = (name: string) => join(team.home, name);
  const busy = async (token: string, threadId: string) => {
    const bots = (await team.as(token, "GET", "/api/bots?messages=0")).body.bots as Array<{ id: string; tasks?: Array<{ threadId: string; busy?: boolean }> }>;
    return Boolean(bots.find((one) => one.id === botId)?.tasks?.find((task) => task.threadId === threadId)?.busy);
  };

  beforeAll(async () => {
    fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-teammap-${randomBytes(8).toString("hex")}`,
      team: { id: "team-acme-teammap", name: "Acme", engine: ENGINE, env: { OMB_BOT_BOX: "0" } } });
    team = fx.team!;
    writeFileSync(home("tool-calls.json"), "[]");
    admin = (await team.pair({ email: "admin@acme.test", role: "owner" })).token!;
    memberA = (await team.pair({ email: "a@acme.test", role: "member" })).token!;
    memberB = (await team.pair({ email: "b@acme.test", role: "member" })).token!;
    const created = await team.as(admin, "POST", "/api/bots", { name: "Scout", visibility: "everyone" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    botId = created.body.bot.id;
  }, hostTimeout(120_000));

  afterAll(async () => {
    await fx?.close();
  });

  it("a member's private busy chat on a shared bot is absent from another member's team map, and from the admin's too", async () => {
    const opened = await team.as(memberB, "POST", `/api/bots/${botId}/tasks`, { title: PRIVATE_TITLE });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const mine = opened.body.task.threadId as string;

    rmSync(home("release"), { force: true });
    writeFileSync(home("tool-calls.json"), JSON.stringify([HOLD]));
    const sent = await team.as(memberB, "POST", `/api/bots/${botId}/messages`, { text: "Work on my private thing", threadId: mine });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await expect.poll(() => busy(memberB, mine), { timeout: hostTimeout(30_000), interval: 100 }).toBe(true);

    for (const token of [memberA, admin]) {
      const live = await team.as(token, "GET", "/api/team-map");
      expect(live.status, JSON.stringify(live.body)).toBe(200);
      expect(JSON.stringify(live.body)).not.toContain(PRIVATE_TITLE);
      expect(live.body.sessions.some((session: any) => session.threadId === mine)).toBe(false);
    }

    writeFileSync(home("release"), "");
    await expect.poll(() => busy(memberB, mine), { timeout: hostTimeout(30_000), interval: 100 }).toBe(false);
  }, hostTimeout(120_000));
}
