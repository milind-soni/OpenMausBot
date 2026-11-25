import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("tells the bot of a 👎 quietly in its next turn, once, with no new line and no turn of its own", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-reactions-"));
  const promptLog = join(scratch, "prompts.jsonl");
  const fixture = await launchVerificationServer({
    FAKE_CLAUDE_REPLIES: JSON.stringify(["Here is the plan for Friday: email Sam, then book the room.", "Here is a shorter plan.", "Glad it helped."]),
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "reply-state"),
    FAKE_CLAUDE_TOOL_CALLS: "[]",
    FAKE_CLAUDE_PROMPTS: promptLog,
  });
  const evidence: unknown[] = [];
  const api = client(fixture, evidence);
  const prompts = (): string[] => existsSync(promptLog) ? readFileSync(promptLog, "utf8").trim().split("\n").map((line) => {
    const content = JSON.parse(line)?.message?.content;
    return Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? "").join("\n") : String(content ?? "");
  }) : [];
  try {
    const bot = (await api("POST", "/api/bots", { name: "Scout" }, 201)).bot;
    const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${bot.threadId}/messages`)).messages;
    const busy = async () => Boolean((await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === bot.id).busy);
    const settled = (reply: string) => expect.poll(async () => !await busy() && (await transcript()).some((message) => message.role === "bot" && message.text === reply), { timeout: 20_000 }).toBe(true);
    const react = (messageId: string, emoji: string, on?: boolean) =>
      api("POST", `/api/threads/${bot.threadId}/messages/${messageId}/reactions`, { emoji, ...(on === undefined ? {} : { on }) });

    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Plan Friday." }, 202);
    await settled("Here is the plan for Friday: email Sam, then book the room.");
    const plan = (await transcript()).find((message) => message.text?.startsWith("Here is the plan for Friday"));
    const lines = (await transcript()).length;

    expect(await react(plan.id, "👍", true)).toMatchObject({ delivery: "noted", message: { reactions: [{ emoji: "👍", by: "user" }] } });
    expect(await react(plan.id, "👍", false)).toMatchObject({ delivery: "none", message: { id: plan.id } });
    expect(await react(plan.id, "👎", true)).toMatchObject({ delivery: "noted", message: { reactions: [{ emoji: "👎", by: "user", at: expect.any(Number) }] } });
    expect(await busy()).toBe(false);
    expect(await transcript()).toHaveLength(lines);
    expect(prompts()).toHaveLength(1);
    expect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).systemPrompt).toContain(
      "A plain yes or no needs no widget: ask in one short sentence; a word comes back as their reply, and a 👍/👎 on your message reaches you as a note with their next message.");

    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Shorter, please." }, 202);
    await settled("Here is a shorter plan.");
    const next = prompts()[1]!;
    evidence.push({ next });
    expect(next.match(/reacted 👎 to your message “Here is the plan for Friday: email Sam, then book the room\.”\.\)/g)).toHaveLength(1);
    expect(next).toMatch(/\(\S+ reacted 👎 to your message “Here is the plan for Friday: email Sam, then book the room\.”\.\)\n\nShorter, please\./);
    expect(next).not.toContain("reacted 👍");

    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Thanks!" }, 202);
    await settled("Glad it helped.");
    expect(prompts()[2]).not.toContain("reacted 👎");
    expect((await transcript()).filter((message) => message.role === "user").map((message) => message.text)).toEqual(["Plan Friday.", "Shorter, please.", "Thanks!"]);

    const session = await api("GET", "/api/auth/session");
    expect(session).not.toHaveProperty("reactor");
  } finally {
    writeFileSync(`${fixture.info.logPath}.reactions.json`, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ evidencePath: `${fixture.info.logPath}.reactions.json`, logPath: fixture.info.logPath }));
    await fixture.close();
    await removeTempDir(scratch);
  }
}, 90_000);

type Fixture = Awaited<ReturnType<typeof launchVerificationServer>>;

it("starts nothing and leaves the title alone when a 👍 on the greeting is the first thing the person does", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-reaction-title-"));
  const promptLog = join(scratch, "prompts.jsonl");
  const fixture = await launchVerificationServer({
    FAKE_CLAUDE_REPLIES: JSON.stringify(["Happy to help. What first?"]),
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "reply-state"),
    FAKE_CLAUDE_TOOL_CALLS: "[]",
    FAKE_CLAUDE_PROMPTS: promptLog,
  });
  const evidence: unknown[] = [];
  const api = client(fixture, evidence);
  try {
    const bot = (await api("POST", "/api/bots", { name: "Scout" }, 201)).bot;
    const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${bot.threadId}/messages`)).messages;
    const greeting = (await transcript()).find((message) => message.role === "bot" && message.kind === "text");
    expect(await api("POST", `/api/threads/${bot.threadId}/messages/${greeting.id}/reactions`, { emoji: "👍", on: true }))
      .toMatchObject({ delivery: "noted" });
    const listed = (await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === bot.id);
    expect(listed.busy).toBeFalsy();
    expect(listed.tasks.find((candidate: any) => candidate.threadId === bot.threadId).title).toMatch(/^New (thread|task)$/);
    expect((await transcript()).filter((message) => message.role === "user")).toEqual([]);
    expect(existsSync(promptLog)).toBe(false);
  } finally {
    await fixture.close();
    await removeTempDir(scratch);
  }
}, 90_000);

function client(fixture: Fixture, evidence: unknown[]) {
  return async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    evidence.push({ method, path, body, status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
}

it("allows an open approval with a 👍 on its card and denies one with a 👎", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-reaction-cards-"));
  const gate = join(scratch, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_FINISH_GATE: gate });
  const evidence: unknown[] = [];
  const api = client(fixture, evidence);
  let broker: Socket | undefined;
  try {
    const bot = (await api("POST", "/api/bots", { name: "Pusher" }, 201)).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Push the branch." }, 202);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
    const socketPath = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.ogb.args[1] as string;
    broker = connect(socketPath);
    await new Promise<void>((resolve, reject) => { broker!.once("connect", resolve); broker!.once("error", reject); });
    const answers: Array<{ id: string; behavior: string }> = [];
    let buffer = "";
    broker.on("data", (chunk) => {
      buffer += chunk.toString();
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const frame = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (frame.t === "answer") answers.push(frame);
      }
    });
    const card = async (requestId: string) => (await api("GET", `/api/threads/${bot.threadId}/messages`)).messages
      .find((message: any) => message.card?.requestId === requestId);

    for (const [requestId, emoji, behavior] of [["push-1", "👍", "allow"], ["push-2", "👎", "deny"]] as const) {
      broker.write(JSON.stringify({ t: "ask", id: requestId, kind: "permission", tool: "Bash", input: { command: "git push origin feature" } }) + "\n");
      await expect.poll(() => card(requestId), { timeout: 10_000 }).toMatchObject({ kind: "options", card: { requestId, tool: "Bash" } });
      const shown = await card(requestId);
      expect(await api("POST", `/api/threads/${bot.threadId}/messages/${shown.id}/reactions`, { emoji, on: true }))
        .toMatchObject({ delivery: "answered", message: { reactions: [{ emoji, by: "user" }] } });
      await expect.poll(() => answers.find((answer) => answer.id === requestId), { timeout: 10_000 }).toMatchObject({ behavior });
      expect((await card(requestId)).card).toMatchObject({ answered: behavior, answeredBy: { kind: "loopback", via: "reaction" } });
    }
    expect((await api("GET", `/api/threads/${bot.threadId}/messages`)).messages.filter((message: any) => message.role === "user")).toHaveLength(1);
    writeFileSync(gate, "finish");
  } finally {
    broker?.destroy();
    writeFileSync(`${fixture.info.logPath}.reaction-cards.json`, JSON.stringify(evidence, null, 2));
    await fixture.close();
    await removeTempDir(scratch);
  }
}, 90_000);

it("in a room, a 👍 reaches the member that wrote the line in its next turn, with no new line", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-reaction-room-"));
  const promptLog = join(scratch, "prompts.jsonl");
  const fixture = await launchVerificationServer({
    FAKE_CLAUDE_REPLIES: JSON.stringify(["Shall I post the launch note?", "Posted it.", "Noted.", "On the pricing now."]),
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "reply-state"),
    FAKE_CLAUDE_TOOL_CALLS: "[]",
    FAKE_CLAUDE_PROMPTS: promptLog,
  });
  const evidence: unknown[] = [];
  const api = client(fixture, evidence);
  const prompts = (): string[] => existsSync(promptLog) ? readFileSync(promptLog, "utf8").trim().split("\n").map((line) => {
    const content = JSON.parse(line)?.message?.content;
    return Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? "").join("\n") : String(content ?? "");
  }) : [];
  try {
    const scout = (await api("POST", "/api/bots", { name: "Scout" }, 201)).bot;
    const otter = (await api("POST", "/api/bots", { name: "Otter" }, 201)).bot;
    const room = (await api("POST", "/api/groups", {
      name: "Launch", memberIds: [scout.id, otter.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: otter.id } },
    }, 201)).group;
    const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${room.threadId}/messages`)).messages;
    const working = async () => Boolean((await api("GET", "/api/bots?messages=0")).groups.find((group: any) => group.id === room.id).working);
    const settled = (reply: string) => expect.poll(async () => !await working() && (await transcript()).some((message) => message.role === "bot" && message.text === reply), { timeout: 20_000 }).toBe(true);

    await api("POST", `/api/groups/${room.id}/messages`, { threadId: room.threadId, text: "Draft the launch note." }, 202);
    await settled("Shall I post the launch note?");
    const asked = (await transcript()).find((message) => message.text === "Shall I post the launch note?");
    expect(asked.from).toMatchObject({ botId: otter.id });
    const lines = (await transcript()).length;

    expect(await api("POST", `/api/threads/${room.threadId}/messages/${asked.id}/reactions`, { emoji: "👍", on: true }))
      .toMatchObject({ delivery: "noted" });
    expect(await working()).toBe(false);
    expect(await transcript()).toHaveLength(lines);
    expect(prompts()).toHaveLength(1);
    await api("POST", `/api/groups/${room.id}/messages`, { threadId: room.threadId, text: "Go on." }, 202);
    await settled("Posted it.");
    const after = await transcript();
    expect(after.filter((message) => message.reaction)).toEqual([]);
    const answered = prompts()[1]!;
    evidence.push({ answered });
    expect(answered.match(/\(\S+ reacted 👍 to your message “Shall I post the launch note\?”\.\)/g)).toHaveLength(1);
    expect(answered.match(/reacted 👍/g)).toHaveLength(1);
    expect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).systemPrompt)
      .toContain("A \"(… reacted 👍 …)\" note is quiet feedback on the message it names or follows: weigh it, and start no new work for it alone.");

    const posted = after.find((message) => message.text === "Posted it.");
    expect(await api("POST", `/api/threads/${room.threadId}/messages/${posted.id}/reactions`, { emoji: "🎉", on: true }))
      .toMatchObject({ delivery: "noted" });
    await api("POST", `/api/groups/${room.id}/messages`, { threadId: room.threadId, text: "Thanks, both." }, 202);
    await settled("Noted.");
    const thanked = prompts()[2]!;
    evidence.push({ thanked });
    expect(thanked.match(/\(\S+ reacted 🎉 to your message “Posted it\.”\.\)/g)).toHaveLength(1);
    expect(thanked).not.toMatch(/Otter: Posted it\.\n\(/);

    expect(await api("POST", `/api/threads/${room.threadId}/messages/${posted.id}/reactions`, { emoji: "❤️", on: true }))
      .toMatchObject({ delivery: "noted" });
    expect(prompts()).toHaveLength(3);
    const pricing = (await api("POST", `/api/groups/${room.id}/tasks`, { title: "Pricing" }, 201)).task;
    await api("POST", `/api/groups/${room.id}/messages`, { threadId: pricing.threadId, text: "@Otter start on pricing." }, 202);
    await expect.poll(async () => (await api("GET", `/api/threads/${pricing.threadId}/messages`)).messages
      .some((message: any) => message.text === "On the pricing now."), { timeout: 20_000 }).toBe(true);
    const elsewhere = prompts()[3]!;
    evidence.push({ elsewhere });
    expect(elsewhere.match(/reacted ❤️ to your message “Posted it\.”/g)).toHaveLength(1);
  } finally {
    writeFileSync(`${fixture.info.logPath}.reaction-room.json`, JSON.stringify(evidence, null, 2));
    await fixture.close();
    await removeTempDir(scratch);
  }
}, 90_000);
