import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("does not retarget a deleted room asker's late answer to the current speaker", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang" });
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: fixture.info.url } }) as Promise<any>;
  let socket: Socket | undefined;
  console.log(`late-question source fixture: ${fixture.info.logPath}`);
  try {
    const original = (await cli("new-bot", "--name", "Original asker")).bot;
    const current = (await cli("new-bot", "--name", "Current speaker")).bot;
    const room = (await cli("new-channel", "--name", "Question source", "--members", `${original.id},${current.id}`)).channel;
    const threadId = room.activeTaskId;
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages`)).body.messages as any[];
    const speaker = async () => (await api("GET", "/api/bots?messages=0")).body.groups
      .find((group: any) => group.id === room.id)?.busyBotId;
    const working = async () => Boolean((await api("GET", "/api/bots?messages=0")).body.groups
      .find((group: any) => group.id === room.id)?.working);

    expect((await api("POST", `/api/groups/${room.id}/messages`, {
      text: "@Original asker: Ask a question", threadId,
    })).status).toBe(202);
    await expect.poll(speaker, { timeout: 15_000 }).toBe(original.id);
    await expect.poll(() => {
      try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.ogb?.args[1]; }
      catch { return undefined; }
    }, { timeout: 5_000 }).toEqual(expect.any(String));
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    socket = connect(dump.mcpConfig.mcpServers.ogb.args[1]);
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      socket!.once("connect", resolve);
      socket!.once("error", reject);
    });
    const requestId = randomUUID();
    socket.write(JSON.stringify({
      t: "ask", kind: "question", id: requestId, tool: "AskUserQuestion",
      input: { questions: [{ question: "Which file should I update?", options: [{ label: "README" }, { label: "Guide" }] }] },
    }) + "\n");
    await expect.poll(async () => (await messages()).find(message => message.card?.requestId === requestId),
      { timeout: 5_000 }).toBeTruthy();
    const question = (await messages()).find(message => message.card?.requestId === requestId)!;
    expect(question.from.botId).toBe(original.id);
    expect((await api("POST", `/api/groups/${room.id}/interrupt`, {})).status).toBe(200);
    await expect.poll(working, { timeout: 5_000 }).toBe(false);
    expect((await messages()).find(message => message.id === question.id)?.card.answered).toBeUndefined();
    expect((await api("DELETE", `/api/bots/${original.id}`)).status).toBe(200);

    expect((await api("POST", `/api/groups/${room.id}/messages`, {
      text: "@Current speaker: Work while the earlier question is answered", threadId,
    })).status).toBe(202);
    await expect.poll(speaker, { timeout: 15_000 }).toBe(current.id);
    const answer = await api("POST", `/api/threads/${threadId}/respond`, {
      requestId, behavior: "answer", message: "README",
    });
    expect(answer).toMatchObject({
      status: 409, body: { error: "the bot that asked this question is no longer available" },
    });
    const unchanged = (await messages()).find(message => message.id === question.id);
    expect(unchanged?.from.botId).toBe(original.id);
    expect(unchanged?.card.answered).toBeUndefined();
    expect(unchanged?.card.answeredText).toBeUndefined();
    expect((await api("POST", `/api/groups/${room.id}/interrupt`, {})).status).toBe(200);
    await expect.poll(working, { timeout: 5_000 }).toBe(false);
    expect((await messages()).some(message => message.role === "user" && message.replyToId === question.id)).toBe(false);
  } finally {
    socket?.destroy();
    await fixture.close();
  }
}, 45_000);
