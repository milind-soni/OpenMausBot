import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchCloudSendFixture } from "../scripts/testing/cloud-send-fixture.ts";
import type { WireBot, WireMessage } from "../shared/wire.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

it.each(["everyone", "admins"])("projects a room question with audience %s beside another person's private task", async (audienceFloor) => {
  const fx = await launchCloudSendFixture({ onePasswordToken: "ops_fake-room-visibility", team: {
    id: "team-room-visibility", name: "Room visibility", env: { OMB_BOT_BOX: "0" },
    engine: 'process.env.FAKE_CLAUDE_ROOM_PLAN = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/room-plan.json";',
  } });
  try {
    const team = fx.team!;
    const owner = (await team.pair({ email: "owner@example.test", role: "owner" })).token!;
    const member = (await team.pair({ email: "member@example.test", role: "member" })).token!;
    const created = await team.as(owner, "POST", "/api/bots", { name: "Room helper" });
    expect(created.status).toBe(201);
    const bot = created.body.bot as WireBot;
    const privateTask = await team.as(owner, "POST", `/api/bots/${bot.id}/tasks`, { title: "Private plan" });
    expect(privateTask.status).toBe(201);
    if (audienceFloor === "admins") {
      expect((await team.as(owner, "PATCH", `/api/bots/${bot.id}`, { visibility: "admins" })).status).toBe(200);
    }
    const opened = await team.as(owner, "POST", "/api/groups", { name: "Question room", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    expect(opened.status).toBe(201);
    const room = opened.body.group;
    expect((await team.as(owner, "PATCH", `/api/bots/${bot.id}`, { visibility: "everyone" })).status).toBe(200);
    const task = await team.as(owner, "POST", `/api/groups/${room.id}/tasks`, { title: "Question thread" });
    expect(task.status).toBe(201);
    const threadId = task.body.task.threadId as string;
    writeFileSync(join(team.home, "room-plan.json"), JSON.stringify({ [bot.id]: {
      steps: [{ server: "ogb", tool: "ask_user", arguments: { question: "Which footer?", choices: ["Short", "Long"] } }],
      reply: "Footer selected",
    } }));
    const answerer = audienceFloor === "everyone" ? member : owner;
    expect((await team.as(answerer, "POST", `/api/groups/${room.id}/messages`, { threadId, text: "Choose a footer" })).status).toBe(202);
    let card: WireMessage["card"];
    await expect.poll(async () => {
      const messages = (await team.as(owner, "GET", `/api/threads/${threadId}/messages`)).body.messages as WireMessage[];
      card = messages.find(message => message.card?.subtitle === "Which footer?")?.card;
      return card?.requestType;
    }, { timeout: hostTimeout(30_000) }).toBe("question");
    const state = async (token: string) => (await team.as(token, "GET", "/api/bots?messages=0")).body;
    const ownerState = await state(owner);
    expect(ownerState.bots.find((entry: WireBot) => entry.id === bot.id)).toMatchObject({ activity: "waiting-on-you", busy: true });
    const memberState = await state(member);
    const shown = memberState.bots.find((entry: WireBot) => entry.id === bot.id) as WireBot;
    expect(shown.tasks?.some(entry => entry.threadId === privateTask.body.task.threadId)).toBe(false);
    expect(memberState.groups.some((entry: { id: string }) => entry.id === room.id)).toBe(audienceFloor === "everyone");
    expect(shown).toMatchObject(audienceFloor === "everyone" ? { activity: "waiting-on-you", busy: true } : { activity: "idle", busy: false });
    expect((await team.as(answerer, "POST", `/api/threads/${threadId}/respond`, { requestId: card!.requestId, behavior: "answer", message: "Short" })).status).toBe(200);
    await expect.poll(async () => (await state(member)).bots.find((entry: WireBot) => entry.id === bot.id),
      { timeout: hostTimeout(30_000) }).toMatchObject({ activity: "idle", busy: false });
  } catch (error) {
    console.error(fx.logs(), fx.answers.slice(-3));
    throw error;
  } finally {
    await fx.close();
  }
}, hostTimeout(90_000));
