import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("answers a bot's yes-or-no question with a 👍, and the bot goes on by itself", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-reactions-"));
  const promptLog = join(scratch, "prompts.jsonl");
  const fixture = await launchVerificationServer({
    FAKE_CLAUDE_REPLIES: JSON.stringify(["I drafted the email to Sam. Shall I send it?", "Sent it to Sam.", "Glad it helped.", "Understood: I'll recall it.", "Then it stays sent."]),
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "reply-state"),
    FAKE_CLAUDE_TOOL_CALLS: "[]",
    FAKE_CLAUDE_PROMPTS: promptLog,
  });
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    evidence.push({ method, path, body, status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(expected);
    return result;
  };
  const prompts = (): string[] => existsSync(promptLog) ? readFileSync(promptLog, "utf8").trim().split("\n").map((line) => {
    const content = JSON.parse(line)?.message?.content;
    return Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? "").join("\n") : String(content ?? "");
  }) : [];
  try {
    const bot = (await api("POST", "/api/bots", { name: "Scout" }, 201)).bot;
    const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${bot.threadId}/messages`)).messages;
    const settled = (reply: string) => expect.poll(async () => {
      const bots = (await api("GET", "/api/bots?messages=0")).bots;
      const busy = bots.find((candidate: any) => candidate.id === bot.id).busy;
      return !busy && (await transcript()).some((message) => message.role === "bot" && message.text === reply);
    }, { timeout: 20_000 }).toBe(true);
    const react = (messageId: string, emoji: string, on?: boolean) =>
      api("POST", `/api/threads/${bot.threadId}/messages/${messageId}/reactions`, { emoji, ...(on === undefined ? {} : { on }) });

    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Draft an email to Sam about Friday." }, 202);
    await settled("I drafted the email to Sam. Shall I send it?");
    const asked = (await transcript()).find((message) => message.text === "I drafted the email to Sam. Shall I send it?");

    const yes = await react(asked.id, "👍", true);
    expect(yes).toMatchObject({ delivery: "started", message: { id: asked.id, reactions: [{ emoji: "👍", by: "user", at: expect.any(Number) }] } });
    await settled("Sent it to Sam.");
    const afterYes = await transcript();
    const line = afterYes.find((message) => message.role === "user" && message.replyToId === asked.id);
    expect(line).toMatchObject({ kind: "text", text: "👍", reaction: "👍", sendId: expect.stringMatching(new RegExp(`^reaction-[0-9a-f]{32}-${yes.message.reactions[0].at}y$`)) });
    const said = afterYes.filter((message) => message.kind === "text").map((message) => [message.role, message.text]);
    expect(said.slice(said.findIndex(([role]) => role === "user"))).toEqual([
      ["user", "Draft an email to Sam about Friday."],
      ["bot", "I drafted the email to Sam. Shall I send it?"],
      ["user", "👍"],
      ["bot", "Sent it to Sam."],
    ]);
    expect(prompts()).toHaveLength(2);
    expect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).systemPrompt).toContain(
      "A plain yes or no, such as whether to go ahead, needs no widget: ask it in one short sentence; the person answers in a word or with 👍 or 👎 on your message, and either comes back to you as their reply.");
    const reactionPrompt = prompts()[1]!;
    evidence.push({ reactionPrompt });
    expect(reactionPrompt).toContain("The current message is the person's reaction: they reacted 👍 to your earlier message instead of typing a reply.");
    expect(reactionPrompt).toContain("👍 means yes, go ahead. If that message asked them something, this is their answer: continue without asking again.");
    expect(reactionPrompt).toContain("--- quoted excerpt ---\nI drafted the email to Sam. Shall I send it?\n--- end quoted excerpt ---\nCurrent message:\n👍");

    expect(await react(asked.id, "👍", true)).toMatchObject({ delivery: "none" });
    expect(await react(asked.id, "👍", false)).toMatchObject({ delivery: "none", message: { id: asked.id } });
    expect(await react(asked.id, "👍", true)).toMatchObject({ delivery: "none", message: { reactions: [{ emoji: "👍", by: "user" }] } });
    expect((await transcript()).filter((message) => message.role === "user")).toHaveLength(2);
    expect(prompts()).toHaveLength(2);

    const sent = afterYes.find((message) => message.text === "Sent it to Sam.");
    expect(await react(sent.id, "❤️")).toMatchObject({ delivery: "noted", message: { reactions: [{ emoji: "❤️", by: "user" }] } });
    expect((await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === bot.id).busy).toBeFalsy();
    expect(prompts()).toHaveLength(2);

    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Thanks!" }, 202);
    await settled("Glad it helped.");
    const thanks = prompts()[2]!;
    evidence.push({ thanks });
    expect(thanks).toMatch(/\(\S+ reacted ❤️ to your message “Sent it to Sam\.”\.\)\n\nThanks!/);
    expect(thanks).not.toContain("reacted 👍");

    expect(await react(asked.id, "👎", true)).toMatchObject({ delivery: "started", message: { reactions: [{ emoji: "👎", by: "user" }] } });
    await settled("Understood: I'll recall it.");
    expect(prompts()[3]).toContain("they reacted 👎 to your earlier message instead of typing a reply.\n👎 means no, not that.");
    expect(await react(asked.id, "👍", true)).toMatchObject({ delivery: "started" });
    await settled("Then it stays sent.");
    expect(prompts()[4]).toContain("they reacted 👍 to your earlier message instead of typing a reply.\n👍 means yes, go ahead.");
    const answers = (await transcript()).filter((message) => message.reaction);
    expect(answers.map((message) => [message.reaction, message.sendId.slice(-1)])).toEqual([["👍", "y"], ["👎", "n"], ["👍", "y"]]);
    expect(new Set(answers.map((message) => message.sendId)).size).toBe(3);

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

it("leaves a conversation's title alone when a 👍 is the first thing the person says in it", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-reaction-title-"));
  const fixture = await launchVerificationServer({
    FAKE_CLAUDE_REPLIES: JSON.stringify(["Happy to help. What first?"]),
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "reply-state"),
    FAKE_CLAUDE_TOOL_CALLS: "[]",
  });
  const evidence: unknown[] = [];
  const api = client(fixture, evidence);
  try {
    const bot = (await api("POST", "/api/bots", { name: "Scout" }, 201)).bot;
    const transcript = async (): Promise<any[]> => (await api("GET", `/api/threads/${bot.threadId}/messages`)).messages;
    const greeting = (await transcript()).find((message) => message.role === "bot" && message.kind === "text");
    expect(await api("POST", `/api/threads/${bot.threadId}/messages/${greeting.id}/reactions`, { emoji: "👍", on: true }))
      .toMatchObject({ delivery: "started" });
    await expect.poll(async () => (await transcript()).some((message) => message.text === "Happy to help. What first?"), { timeout: 20_000 }).toBe(true);
    const task = (await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === bot.id).tasks
      .find((candidate: any) => candidate.threadId === bot.threadId);
    expect(task.title).toMatch(/^New (thread|task)$/);
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

it("in a room, gives the 👍 to the member that asked, by name", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-reaction-room-"));
  const promptLog = join(scratch, "prompts.jsonl");
  const fixture = await launchVerificationServer({
    FAKE_CLAUDE_REPLIES: JSON.stringify(["Shall I post the launch note?", "Posted it.", "Noted."]),
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
    const settled = (reply: string) => expect.poll(async () => {
      const working = (await api("GET", "/api/bots?messages=0")).groups.find((group: any) => group.id === room.id).working;
      return !working && (await transcript()).some((message) => message.role === "bot" && message.text === reply);
    }, { timeout: 20_000 }).toBe(true);

    await api("POST", `/api/groups/${room.id}/messages`, { threadId: room.threadId, text: "Draft the launch note." }, 202);
    await settled("Shall I post the launch note?");
    const asked = (await transcript()).find((message) => message.text === "Shall I post the launch note?");
    expect(asked.from).toMatchObject({ botId: otter.id });

    expect(await api("POST", `/api/threads/${room.threadId}/messages/${asked.id}/reactions`, { emoji: "👍", on: true }))
      .toMatchObject({ delivery: "started" });
    await settled("Posted it.");
    const after = await transcript();
    expect(after.find((message) => message.role === "user" && message.replyToId === asked.id))
      .toMatchObject({ text: "@Otter: 👍", reaction: "👍" });
    expect(after.find((message) => message.text === "Posted it.").from).toMatchObject({ botId: otter.id });
    const answered = prompts()[1]!;
    evidence.push({ answered });
    expect(answered).toContain(": [reacted 👍 to Otter: “Shall I post the launch note?”]");
    expect(answered).not.toContain("@Otter: 👍");
    expect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).systemPrompt)
      .toContain("A \"[reacted 👍 to …]\" line is that person's whole reply to the message it names: 👍 means yes, go ahead, and 👎 means no.");

    const posted = after.find((message) => message.text === "Posted it.");
    expect(await api("POST", `/api/threads/${room.threadId}/messages/${posted.id}/reactions`, { emoji: "🎉", on: true }))
      .toMatchObject({ delivery: "noted" });
    await api("POST", `/api/groups/${room.id}/messages`, { threadId: room.threadId, text: "Thanks, both." }, 202);
    await settled("Noted.");
    const thanked = prompts()[2]!;
    evidence.push({ thanked });
    expect(thanked).toMatch(/Otter: Posted it\.\n\(\S+ reacted 🎉\)/);
  } finally {
    writeFileSync(`${fixture.info.logPath}.reaction-room.json`, JSON.stringify(evidence, null, 2));
    await fixture.close();
    await removeTempDir(scratch);
  }
}, 90_000);
