import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

const POLL = { timeout: 30_000, interval: 100 };
const NOTE = "The person typed this in the chat";
/** Every decision the server recorded: a card closed by a typed line is none. */
/** The verdicts recorded for one request; showing its card is not one. */
const verdicts = (dataDir: string, requestId: string): string[] => (existsSync(join(dataDir, "decisions"))
  ? readdirSync(join(dataDir, "decisions")).flatMap((file) => readFileSync(join(dataDir, "decisions", file), "utf8").split("\n").filter(Boolean)) : [])
  .map((line) => JSON.parse(line) as { requestId?: string; decision?: string })
  .filter((row) => row.requestId === requestId && row.decision !== "card-shown").map((row) => row.decision ?? "");
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

it("in the bot's own chat, a line typed while its ask_user card waits answers the card, only the engine reads the note, and a retry changes nothing", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const { api, messages, openCard, control } = client(url);
  const events = await openSse(`${url}/api/events`, { origin: url });
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

    const send = { text: "what time is it?", threadId, sendId: randomUUID() };
    const typed = await api("POST", `/api/bots/${bot.id}/messages`, send);
    expect(typed.status).toBe(202);
    expect(typed.body.steered).toBeUndefined();
    expect(typed.body.message).toMatchObject({ role: "user", text: "what time is it?", replyToId: card.id });

    await expect.poll(async () => (await messages(threadId)).some((row) => row.role === "bot" && row.text === "Q: answered"), POLL).toBe(true);
    expect((await messages(threadId)).find((row) => row.id === card.id)?.card).toMatchObject({ answered: "answer", answeredText: "what time is it?" });
    // The engine's side of the call, outside the transcript: the scripted turn's record of its ask_user step.
    const asked = readFileSync(join(dataDir, "room-plan.json.evidence.jsonl"), "utf8");
    expect(asked).toContain(`${NOTE} instead of picking an option. Reply to it, and ask again if you still need an answer.] what time is it?`);

    const again = await api("POST", `/api/bots/${bot.id}/messages`, send);
    expect(again).toMatchObject({ status: 202, body: { message: { id: typed.body.message.id } } });
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { ...send, text: "something else" })).status).toBe(409);
    const rows = await messages(threadId);
    expect(rows.filter((row) => row.role === "user" && row.text === "what time is it?")).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(NOTE);
    expect(JSON.stringify(events.frames), "no frame any client got carries the note").not.toContain(NOTE);
  } finally {
    events.close();
    await fixture.close();
  }
}, 120_000);

it("in the bot's own chat, a line typed while an ACP card of set options waits closes it without an error, and runs as the next turn", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  const { api, messages, openCard, control } = client(url);
  const dump = join(dataDir, "acp-dump");
  const rpcFile = join(dataDir, "rpc.jsonl");
  let server: ChildProcess | undefined;
  try {
    // Only the repository's fake ACP CLI, added while the fixture is stopped; never the person's CLI or home.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.opencodeGo = {
      driver: "opencodeGo", displayName: "Set options fixture",
      config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) },
      environment: { FAKE_ACP_MODE: "question", FAKE_ACP_HOLD_ON_CANCELLED: "1", FAKE_ACP_MODELS: "fixture/question",
        FAKE_ACP_DUMP: dump, FAKE_ACP_DUMP_PROMPT: "1", FAKE_ACP_RPC_APPEND_FILE: rpcFile },
    };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);

    const { bot } = await control("new-bot", "--name", "Picker");
    const threadId = bot.activeTaskId as string;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: { instanceId: "opencodeGo", model: "fixture/question" } });
    const prompted = () => existsSync(`${dump}.prompt.json`) ? readFileSync(`${dump}.prompt.json`, "utf8") : "";
    const calls = () => existsSync(rpcFile) ? readFileSync(rpcFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).method as string) : [];

    await control("send", "--bot", bot.id, "--task", threadId, "--text", "pick a color");
    await expect.poll(async () => Boolean(await openCard(threadId)), POLL).toBe(true);
    const card = (await openCard(threadId))!;

    const send = { text: "what time is it?", threadId, sendId: randomUUID() };
    const typed = await api("POST", `/api/bots/${bot.id}/messages`, send);
    expect(typed.status).toBe(202);
    await expect.poll(() => prompted().includes("what time is it?"), POLL).toBe(true);
    expect(calls()).toContain("session/cancel");
    const rows = await messages(threadId);
    expect(rows.find((row) => row.id === card.id)?.card, "closed without an answer, not denied").toMatchObject({ answered: "unavailable", dismissed: true });
    expect(JSON.stringify(rows)).not.toContain("isn't one of the choices");
    expect(verdicts(dataDir, card.card!.requestId!)).toEqual([]);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, send)).status).toBe(202);
    expect((await messages(threadId)).filter((row) => row.role === "user" && row.text === "what time is it?")).toHaveLength(1);
  } finally {
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);

it("in the bot's own chat, a line typed while Claude's own question of several parts waits closes it, and is steered into the turn", async () => {
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

    const typed = await api("POST", `/api/bots/${bot.id}/messages`, { text: "what time is it?", threadId, sendId: randomUUID() });
    expect(typed).toMatchObject({ status: 202, body: { steered: true } });
    await expect.poll(() => replies.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((reply) => reply.id === requestId), POLL)
      .toMatchObject({ behavior: "deny", message: expect.stringContaining("typed in the chat") });
    await expect.poll(() => existsSync(steerLog) ? readFileSync(steerLog, "utf8") : "", POLL).toContain("what time is it?");
    expect((await messages(threadId)).find((row) => row.id === card.id)?.card, "closed without an answer, not denied").toMatchObject({ answered: "unavailable", dismissed: true });
    expect(verdicts(fixture.info.dataDir, requestId)).toEqual([]);
  } finally {
    socket?.destroy();
    await fixture.close();
    rmSync(logs, { recursive: true, force: true });
  }
}, 120_000);
