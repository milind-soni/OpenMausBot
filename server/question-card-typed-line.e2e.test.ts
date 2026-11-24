import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { CARD_SETTLE_MS } from "./host/ask-cards.ts";

const POLL = { timeout: 30_000, interval: 100 };
type Row = { id: string; role: string; kind: string; text?: string; replyToId?: string;
  card?: { requestId?: string; answered?: string; answeredText?: string; dismissed?: boolean } };

function client(url: string) {
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, body: await response.json() as any };
  };
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as Row[];
  const openCard = async (threadId: string) => (await messages(threadId)).find((row) => row.card?.requestId && !row.card.answered && !row.card.dismissed);
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  return { api, messages, openCard, control };
}

it("in the bot's own chat, a line typed while its ask_user card waits answers the card with exactly those words, and a retry changes nothing", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const { api, messages, openCard, control } = client(url);
  try {
    const { bot } = await control("new-bot", "--name", "Asker");
    const threadId = bot.activeTaskId as string;
    writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({ [bot.id]: { script: [{
      key: "Q", match: ["ASK-ME"], timeoutMs: 120_000,
      steps: [{ server: "ogb", tool: "ask_user", arguments: { question: "Which color?", choices: ["Blue", "Green"] }, capture: { answer: "([\\s\\S]+)" } }],
      reply: "Q: answered",
    }] } }));
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "ASK-ME");
    await expect.poll(async () => Boolean(await openCard(threadId)), POLL).toBe(true);
    const card = (await openCard(threadId))!;
    // The person reads the card before typing: a card that opened as they typed leaves the line to the usual send.
    await new Promise((resolve) => setTimeout(resolve, CARD_SETTLE_MS + 100));

    const send = { text: "what time is it?", threadId, sendId: randomUUID() };
    const typed = await api("POST", `/api/bots/${bot.id}/messages`, send);
    expect(typed.status).toBe(202);
    expect(typed.body.steered).toBeUndefined();
    expect(typed.body.message).toMatchObject({ role: "user", text: "what time is it?", replyToId: card.id });

    await expect.poll(async () => (await messages(threadId)).some((row) => row.role === "bot" && row.text === "Q: answered"), POLL).toBe(true);
    expect((await messages(threadId)).find((row) => row.id === card.id)?.card).toMatchObject({ answered: "answer", answeredText: "what time is it?" });
    // The engine's side of the call: what the scripted turn's ask_user step got back.
    const steps = readFileSync(join(dataDir, "room-plan.json.evidence.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { planKey?: string; evidence?: Array<{ step?: { tool?: string }; response?: { result?: { content?: Array<{ text?: string }> } } }> })
      .filter((row) => row.planKey === "Q").flatMap((row) => row.evidence ?? []).filter((frame) => frame.step?.tool === "ask_user");
    expect(steps.map((frame) => frame.response?.result?.content?.[0]?.text), "the engine reads the words the chat shows").toEqual(["what time is it?"]);

    const again = await api("POST", `/api/bots/${bot.id}/messages`, send);
    expect(again).toMatchObject({ status: 202, body: { message: { id: typed.body.message.id } } });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { ...send, text: "something else" })).status).toBe(409);
    const rows = await messages(threadId);
    expect(rows.filter((row) => row.role === "user" && row.text === "what time is it?")).toHaveLength(1);
  } finally {
    await fixture.close();
  }
}, 120_000);

it("in the bot's own chat, a line typed while Claude's own question of several parts waits leaves the card open, and is steered into the turn", async () => {
  const logs = mkdtempSync(join(tmpdir(), "typed-line-"));
  const steerLog = join(logs, "steered.jsonl");
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_STEER_LOG: steerLog });
  const { api, messages, openCard, control } = client(fixture.info.url);
  let socket: Socket | undefined;
  try {
    const { bot } = await control("new-bot", "--name", "Several");
    const threadId = bot.activeTaskId as string;
    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Ask me two things");
    await expect.poll(() => {
      try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.ogb?.args[1]; } catch { return undefined; }
    }, POLL).toEqual(expect.any(String));
    // The turn's question broker, as Claude's own AskUserQuestion reaches it through the permission proxy.
    socket = connect(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.ogb.args[1]);
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => { socket!.once("connect", resolve); socket!.once("error", reject); });
    let replies = "";
    socket.on("data", (chunk) => { replies += chunk.toString(); });
    const requestId = randomUUID();
    socket.write(JSON.stringify({ t: "ask", kind: "question", id: requestId, tool: "AskUserQuestion", input: { questions: [
      { question: "Which file?", options: [{ label: "README" }, { label: "Guide" }] },
      { question: "Which tone?", options: [{ label: "Plain" }, { label: "Warm" }] },
    ] } }) + "\n");
    await expect.poll(async () => (await openCard(threadId))?.card?.requestId, POLL).toBe(requestId);
    const card = (await openCard(threadId))!;
    await new Promise((resolve) => setTimeout(resolve, CARD_SETTLE_MS + 100));

    // A card of several parts takes taps, not one line: the line is a message, and the card waits for its taps.
    const typed = await api("POST", `/api/bots/${bot.id}/messages`, { text: "what time is it?", threadId, sendId: randomUUID() });
    expect(typed).toMatchObject({ status: 202, body: { steered: true } });
    await expect.poll(() => existsSync(steerLog) ? readFileSync(steerLog, "utf8") : "", POLL).toContain("what time is it?");
    expect(replies.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((reply) => reply.id === requestId)).toBeUndefined();
    const rows = await messages(threadId);
    expect(rows.find((row) => row.id === card.id)?.card).not.toHaveProperty("answered");
    expect(rows.find((row) => row.role === "user" && row.text === "what time is it?")?.replyToId).toBeUndefined();
  } finally {
    socket?.destroy();
    await fixture.close();
    rmSync(logs, { recursive: true, force: true });
  }
}, 120_000);
