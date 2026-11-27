import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("keeps a question nobody answered on Today after its turn ends, and a late answer wakes the bot and clears it", async () => {
  const gates = mkdtempSync(join(tmpdir(), "omb-late-question-today-"));
  const release = join(gates, "release");
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RELEASE: release });
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
  console.log(`late-question Today fixture: ${fixture.info.logPath}`);
  try {
    const bot = (await cli("new-bot", "--name", "Asker")).bot;
    const threadId = (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === bot.id).threadId as string;
    const messages = async () => (await api("GET", `/api/threads/${threadId}/messages`)).body.messages as any[];
    const busy = async () => Boolean((await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === bot.id)?.busy);
    const questions = async () => (await api("GET", `/api/today?since=${Date.now() - 60_000}`)).body.needsYou
      .filter((item: any) => item.kind === "question");

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Ask me which file to update" })).status).toBeLessThan(300);
    await expect.poll(busy, { timeout: 15_000 }).toBe(true);
    await expect.poll(() => {
      try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.ogb?.args[1]; }
      catch { return undefined; }
    }, { timeout: 5_000 }).toEqual(expect.any(String));
    socket = connect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.ogb.args[1]);
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
    await expect.poll(async () => (await messages()).find((message) => message.card?.requestId === requestId),
      { timeout: 5_000 }).toBeTruthy();
    const question = (await messages()).find((message) => message.card?.requestId === requestId)!;

    writeFileSync(release, "");
    await expect.poll(busy, { timeout: 10_000 }).toBe(false);
    await expect.poll(async () => (await messages()).some((message) => message.kind === "digest" && message.at > question.at),
      { timeout: 5_000 }).toBe(true);
    expect((await messages()).find((message) => message.id === question.id)?.card.answered).toBeUndefined();
    expect(await questions()).toEqual([expect.objectContaining({ id: question.id, threadId, botId: bot.id, text: "Which file should I update?" })]);

    const answer = await api("POST", `/api/threads/${threadId}/respond`, { requestId, behavior: "answer", message: "README" });
    expect(answer, JSON.stringify(answer.body)).toMatchObject({ status: 200, body: { ok: true, outcome: "answered", late: true } });
    await expect.poll(async () => (await messages()).filter((message) => message.kind === "digest").length, { timeout: 10_000 }).toBe(2);
    const after = await messages();
    expect(after).toContainEqual(expect.objectContaining({ role: "user", kind: "text", text: "README", replyToId: question.id }));
    expect(after.find((message) => message.id === question.id)?.card).toMatchObject({ answered: "answer", answeredText: "README" });
    expect(await questions()).toEqual([]);
  } finally {
    socket?.destroy();
    await fixture.close();
    rmSync(gates, { recursive: true, force: true });
  }
}, 60_000);
