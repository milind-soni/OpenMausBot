// Same-room jobs take turns. A requester that sends several members work in
// one room is told they run one at a time and where each one stands, and the
// room itself shows who waits on whom ("Queued · waiting for X (2 of 3)"),
// on an isolated fixture with the real coordination proxy.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";
import { readHandoffs } from "./testing/handoff-rows.ts";
import { openSse } from "./testing/sse.ts";

it("tells the requester and the room that three same-room jobs run in turn", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const env = { OPENMAUSBOT_URL: session.info.url };
  const cli = (...args: string[]) => runControlOmb(args, { env }) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) => handleToolCall(name, args, (path, options) => request(path, options, session.info.url)) as Promise<any>;
  const events = await openSse(`${session.info.url}/api/events`, { Origin: session.info.url });
  try {
    const lead = (await cli("new-bot", "--name", "Lead", "--section", "A")).bot;
    const workers: any[] = [];
    for (const name of ["First", "Second", "Third"]) workers.push((await cli("new-bot", "--name", name, "--section", "A")).bot);
    const room = (await tool("create_channel", { name: "Studio", member_ids: [lead.id, ...workers.map(w => w.id)] })).channel;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const gate = join(session.info.dataDir, "first.gate");
    const ready = join(session.info.dataDir, "first.ready");
    writeFileSync(planPath, JSON.stringify({
      [lead.id]: { steps: [{ arguments: { bot_ids: workers.map(w => w.id), message: "Each of you, cut one part" } }], reply: "Assigned", resumeReply: "All parts reviewed" },
      [workers[0].id]: { reply: "First part cut", gateFile: gate, readyFile: ready },
      [workers[1].id]: { reply: "Second part cut" },
      [workers[2].id]: { reply: "Third part cut" },
    }));
    await cli("send-channel", "--channel", room.id, "--text", "@Lead Split the work");
    await expect.poll(() => existsSync(ready), { timeout: 30_000 }).toBe(true);

    // The requester's receipts: each job's place in the room's line, and a
    // message that says they run in turn, not in parallel.
    const turns = () => readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    await expect.poll(() => existsSync(`${planPath}.evidence.jsonl`) && turns().some((t: any) => t.botId === lead.id), { timeout: 15_000 }).toBe(true);
    const step = turns().find((t: any) => t.botId === lead.id).evidence.find((e: any) => e.step);
    const answer = JSON.parse(step.response.result.content[0].text);
    expect(answer.receipts.map((r: any) => [r.botName, r.queue?.position, r.queue?.of])).toEqual([["First", 1, 3], ["Second", 2, 3], ["Third", 3, 3]]);
    expect(answer.receipts[1].queue.waitingFor).toBe("First");
    expect(answer.receipts[1].detail).toContain("queued 2 of 3 in this room");
    expect(answer.message).toContain("These run one at a time in this room, not in parallel");

    // The room, while the first job runs: the other two wait on it.
    const frame = await events.until(f => f.kind === "group" && f.group?.id === room.id &&
      (f.group.queue ?? []).some((e: any) => e.botId === workers[2].id && e.waitingForBotId === workers[0].id), 15_000);
    expect(frame.group.queue.map((e: any) => [e.botId, e.state, e.position, e.of, e.waitingForBotId ?? null])).toEqual([
      [workers[0].id, "running", 1, 3, null],
      [workers[1].id, "queued", 2, 3, workers[0].id],
      [workers[2].id, "queued", 3, 3, workers[0].id],
    ]);

    writeFileSync(gate, "release");
    expect((await cli("wait", "--channel", room.id, "--timeout", "45")).status).toBe("settled");
    expect(readHandoffs(session.info.dataDir).filter((n: any) => n.parentId).every((n: any) => n.status === "completed")).toBe(true);
    await events.until(f => f.kind === "group" && f.group?.id === room.id && Array.isArray(f.group.queue) && f.group.queue.length === 0, 15_000);
  } finally {
    events.close();
    await session.close();
  }
}, 90_000);

it("shows a round of @mentioned members waiting on the one replying", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const env = { OPENMAUSBOT_URL: session.info.url };
  const cli = (...args: string[]) => runControlOmb(args, { env }) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) => handleToolCall(name, args, (path, options) => request(path, options, session.info.url)) as Promise<any>;
  const events = await openSse(`${session.info.url}/api/events`, { Origin: session.info.url });
  try {
    const first = (await cli("new-bot", "--name", "First", "--section", "A")).bot;
    const second = (await cli("new-bot", "--name", "Second", "--section", "A")).bot;
    const room = (await tool("create_channel", { name: "Studio", member_ids: [first.id, second.id] })).channel;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const gate = join(session.info.dataDir, "first.gate");
    writeFileSync(planPath, JSON.stringify({ [first.id]: { reply: "First here", gateFile: gate }, [second.id]: { reply: "Second here" } }));
    await cli("send-channel", "--channel", room.id, "--text", "@First @Second say hello");
    const frame = await events.until(f => f.kind === "group" && f.group?.id === room.id &&
      (f.group.queue ?? []).some((e: any) => e.botId === first.id && e.state === "running"), 20_000);
    expect(frame.group.queue.map((e: any) => [e.botId, e.state, e.position, e.of, e.waitingForBotId ?? null]))
      .toEqual([[first.id, "running", 1, 2, null], [second.id, "queued", 2, 2, first.id]]);
    writeFileSync(gate, "release");
    expect((await cli("wait", "--channel", room.id, "--timeout", "45")).status).toBe("settled");
    await events.until(f => f.kind === "group" && f.group?.id === room.id && Array.isArray(f.group.queue) && f.group.queue.length === 0, 15_000);
  } finally {
    events.close();
    await session.close();
  }
}, 90_000);

it("with parallel room jobs on, runs each member's job in its own thread at once and posts the results back into the room", async () => {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const env = { OPENMAUSBOT_URL: session.info.url };
  const cli = (...args: string[]) => runControlOmb(args, { env }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, headers: { Origin: session.info.url }, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) => handleToolCall(name, args, (path, options) => request(path, options, session.info.url)) as Promise<any>;
  try {
    expect((await api("/api/config", { features: { parallelRoomJobs: true } }, "PATCH")).features.parallelRoomJobs).toBe(true);
    const lead = (await cli("new-bot", "--name", "Lead", "--section", "A")).bot;
    const first = (await cli("new-bot", "--name", "First", "--section", "A")).bot;
    const second = (await cli("new-bot", "--name", "Second", "--section", "A")).bot;
    const room = (await tool("create_channel", { name: "Studio", member_ids: [lead.id, first.id, second.id] })).channel;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const file = (name: string) => join(session.info.dataDir, name);
    writeFileSync(planPath, JSON.stringify({
      [lead.id]: {
        steps: [
          { arguments: { bot_ids: [first.id, second.id], message: "Each of you, cut one part" } },
          // More work for a member already busy with a job: it waits in that
          // member's own thread, so one member never runs two jobs at once.
          { arguments: { bot_ids: [first.id], message: "Then cut the trailer" } },
        ],
        reply: "Assigned", resumeReply: "All parts reviewed",
      },
      [first.id]: { turns: [
        { reply: "First part cut", gateFile: file("first.gate"), readyFile: file("first.ready") },
        { reply: "Trailer cut" },
      ] },
      [second.id]: { reply: "Second part cut", gateFile: file("second.gate"), readyFile: file("second.ready") },
    }));
    await cli("send-channel", "--channel", room.id, "--text", "@Lead Split the work");
    // Both members are mid-job at the same moment: neither waits on the other.
    await expect.poll(() => existsSync(file("first.ready")) && existsSync(file("second.ready")), { timeout: 30_000 }).toBe(true);
    const jobs = () => readHandoffs(session.info.dataDir).filter((n: any) => n.parentId);
    const running = jobs().filter((n: any) => n.status === "running");
    expect(running.map((n: any) => n.botId).sort()).toEqual([first.id, second.id].sort());
    // Each job runs in a thread of the member's own, not the room's thread.
    expect(jobs().every((n: any) => n.groupId === undefined && n.threadId !== room.activeTaskId)).toBe(true);
    const trailer = jobs().find((n: any) => n.text === "Then cut the trailer");
    const firstJob: any = jobs().find((n: any) => n.botId === first.id && n.text === "Each of you, cut one part");
    expect(trailer).toMatchObject({ status: "queued", threadId: firstJob.threadId });

    const lines = () => readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const leadTurn = lines().find((t: any) => t.botId === lead.id && !t.resumed);
    const answer = JSON.parse(leadTurn.evidence.find((e: any) => e.step).response.result.content[0].text);
    expect(answer.message).toContain("These run in parallel, each in a thread of its own beside this room");
    expect(answer.receipts.every((r: any) => r.detail.includes("in parallel with the other room jobs") && r.threadId && !r.queue)).toBe(true);

    writeFileSync(file("first.gate"), "release");
    writeFileSync(file("second.gate"), "release");
    expect((await cli("wait", "--channel", room.id, "--timeout", "45")).status).toBe("settled");
    await expect.poll(() => jobs().every((n: any) => n.status === "completed"), { timeout: 20_000 }).toBe(true);
    // The trailer ran after the first job, in the same thread.
    const firstTurns = lines().filter((t: any) => t.botId === first.id);
    expect(firstTurns.map((t: any) => t.threadId)).toEqual([firstJob.threadId, firstJob.threadId]);

    // The room reads coherently: where each job went, each result card, and
    // the requester's one review of all of them.
    const messages = (await api(`/api/threads/${room.activeTaskId}/messages`, undefined, "GET")).messages;
    const results = messages.filter((m: any) => m.roomRequest?.phase === "result");
    expect(results.map((m: any) => m.from?.botId).sort()).toEqual([first.id, first.id, second.id].sort());
    expect(results.every((m: any) => m.threadRef?.threadId && m.tool?.ok === true && m.tool?.output)).toBe(true);
    expect(messages.filter((m: any) => m.tool?.name?.startsWith("Sent to ")).length).toBe(3);
    expect(lines().filter((t: any) => t.botId === lead.id && t.resumed).length).toBe(1);
    expect(JSON.stringify(messages)).toContain("All parts reviewed");
  } finally {
    await session.close();
  }
}, 120_000);
