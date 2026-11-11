// A member that waits its turn in a room round is free for direct work, but still counts as the room's for Stop,
// delete, model switches and busy checks; a member the room has claimed holds handed work until its turn ends.
// Isolated fixture with the scripted engine and the real coordination proxy.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";

async function roomFixture() {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = session.info;
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const file = (name: string) => join(dataDir, name);
  const plan = (value: unknown) => writeFileSync(file("room-plan.json"), JSON.stringify(value));
  return { session, cli, api, file, plan };
}

it("lets a member waiting to speak take a direct handoff before its room turn", async () => {
  const { session, cli, file, plan } = await roomFixture();
  try {
    const first = (await cli("new-bot", "--name", "First")).bot;
    const second = (await cli("new-bot", "--name", "Second")).bot;
    const lead = (await cli("new-bot", "--name", "Lead")).bot;
    const room = (await cli("new-channel", "--name", "Studio", "--members", `${first.id},${second.id}`)).channel;
    const brief = "An independent job for Second";
    plan({
      [first.id]: { reply: "First in the room", gateFile: file("first.gate"), readyFile: file("first.ready") },
      [second.id]: { turns: [
        { reply: "Direct job done", gateFile: file("direct.gate"), readyFile: file("direct.ready") },
        { reply: "Second in the room", readyFile: file("second.ready") },
      ] },
      [lead.id]: { steps: [{ arguments: { bot_ids: [second.id], message: brief } }], reply: "Assigned", resumeReply: "Reviewed" },
    });
    await cli("send-channel", "--channel", room.id, "--text", "@First @Second take turns");
    await expect.poll(() => existsSync(file("first.ready")), { timeout: 15_000 }).toBe(true);
    await cli("send", "--bot", lead.id, "--text", "Assign independent work to Second");
    const job = () => readHandoffs(session.info.dataDir).find(n => n.parentId && n.botId === second.id && n.text === brief);
    await expect.poll(() => job()?.status, { timeout: 15_000 }).toBe("running");
    await expect.poll(() => existsSync(file("direct.ready")), { timeout: 15_000 }).toBe(true);

    writeFileSync(file("first.gate"), "release");
    const messages = () => cli("messages", "--channel", room.id, "--limit", "20");
    await expect.poll(async () => JSON.stringify(await messages()), { timeout: 15_000 }).toContain("Second is finishing another conversation");
    expect(existsSync(file("second.ready"))).toBe(false);

    writeFileSync(file("direct.gate"), "release");
    expect((await cli("wait", "--channel", room.id, "--timeout", "30")).status).toBe("settled");
    expect((await cli("wait", "--bot", lead.id, "--timeout", "30")).status).toBe("settled");
    expect(job()?.status).toBe("completed");
    const transcript = JSON.stringify(await messages());
    expect(transcript).toContain("First in the room");
    expect(transcript).toContain("Second in the room");
  } finally {
    await session.close();
  }
}, 90_000);

it("still counts a member waiting its turn as the room's for delete, model switches, busy checks and Stop", async () => {
  const { session, cli, api, file, plan } = await roomFixture();
  try {
    const first = (await cli("new-bot", "--name", "First")).bot;
    const second = (await cli("new-bot", "--name", "Second")).bot;
    const room = (await cli("new-channel", "--name", "Studio", "--members", `${first.id},${second.id}`)).channel;
    plan({
      [first.id]: { reply: "First in the room", gateFile: file("first.gate"), readyFile: file("first.ready") },
      [second.id]: { reply: "Second in the room", readyFile: file("second.ready") },
    });
    await cli("send-channel", "--channel", room.id, "--text", "@First @Second take turns");
    await expect.poll(() => existsSync(file("first.ready")), { timeout: 15_000 }).toBe(true);
    const otherModel = { modelSelection: { instanceId: second.modelSelection.instanceId, model: "fixture-other-model" } };

    // Second only waits its turn: it is not busy itself, so each refusal here comes from the room.
    const deleted = await api("DELETE", `/api/bots/${second.id}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(409);
    expect(deleted.body.error).toContain("work in channel Studio");
    const switched = await api("PATCH", `/api/bots/${second.id}`, otherModel);
    expect(switched.status, JSON.stringify(switched.body)).toBe(409);
    expect(switched.body.errorKey).toBe("serverError.model.botBusy");
    const memory = await api("PATCH", `/api/bots/${second.id}`, { memoryEnabled: false });
    expect(memory.status, JSON.stringify(memory.body)).toBe(409);
    expect(memory.body.error).toContain("stop this bot's turn");

    // Stop on Second ends the round it waits in, so it never speaks.
    expect((await api("POST", `/api/bots/${second.id}/interrupt`, {})).status).toBe(200);
    writeFileSync(file("first.gate"), "release");
    expect((await cli("wait", "--channel", room.id, "--timeout", "30")).status).toBe("settled");
    expect(existsSync(file("second.ready"))).toBe(false);

    const after = await api("PATCH", `/api/bots/${second.id}`, otherModel);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
  } finally {
    await session.close();
  }
}, 90_000);

it("holds work handed to a member while its room turn has it, and starts it once that turn ends", async () => {
  const { session, cli, file, plan } = await roomFixture();
  try {
    const first = (await cli("new-bot", "--name", "First")).bot;
    const second = (await cli("new-bot", "--name", "Second")).bot;
    const lead = (await cli("new-bot", "--name", "Lead")).bot;
    const room = (await cli("new-channel", "--name", "Studio", "--members", `${first.id},${second.id}`)).channel;
    const brief = "A job for First after its room turn";
    plan({
      [first.id]: { turns: [
        { reply: "First in the room", gateFile: file("first.gate"), readyFile: file("first.ready") },
        { reply: "Direct job done", readyFile: file("direct.ready") },
      ] },
      [second.id]: { reply: "Second here" },
      [lead.id]: { steps: [{ arguments: { bot_ids: [first.id], message: brief } }], reply: "Assigned", resumeReply: "Reviewed" },
    });
    await cli("send-channel", "--channel", room.id, "--text", "@First take a turn");
    await expect.poll(() => existsSync(file("first.ready")), { timeout: 15_000 }).toBe(true);
    await cli("send", "--bot", lead.id, "--text", "Assign work to First");
    const job = () => readHandoffs(session.info.dataDir).find(n => n.parentId && n.botId === first.id && n.text === brief);
    await expect.poll(() => job()?.status, { timeout: 15_000 }).toBe("queued");
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(job()?.status).toBe("queued");
    expect(existsSync(file("direct.ready"))).toBe(false);

    writeFileSync(file("first.gate"), "release");
    expect((await cli("wait", "--channel", room.id, "--timeout", "30")).status).toBe("settled");
    await expect.poll(() => existsSync(file("direct.ready")), { timeout: 15_000 }).toBe(true);
    expect((await cli("wait", "--bot", lead.id, "--timeout", "30")).status).toBe("settled");
    expect(job()?.status).toBe("completed");
  } finally {
    await session.close();
  }
}, 90_000);
