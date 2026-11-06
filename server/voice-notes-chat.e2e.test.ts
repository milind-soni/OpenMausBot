// Voice notes on OpenMausBot's own chat runtime (an API-key provider): a loopback provider scripts the model, and a
// loopback speech stub stands in for the voice provider, so no external service is reached.
import { createServer, type Server } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { lastNonReceipt } from "../src/lib/receipts.ts";

const MP3 = Buffer.from("ID3 fake mp3 for the chat voice note fixture");

type ChatMessage = { role: string; content?: unknown; tool_call_id?: string };
type ChatRequest = { messages: ChatMessage[]; tools?: unknown[] };
/** The provider's answer to one request; null holds the response open until the turn is stopped. */
type Script = (request: ChatRequest, user: string) => string | null;

const frame = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const say = (text: string) => frame({ content: text }, "stop") + "data: [DONE]\n\n";
const callTool = (id: string, name: string, args: unknown) =>
  frame({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls") + "data: [DONE]\n\n";
const toolResults = (request: ChatRequest) => request.messages.filter((message) => message.role === "tool").map((message) => String(message.content));
const lastUser = (request: ChatRequest) => {
  const content = request.messages.filter((message) => message.role === "user").at(-1)?.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no loopback port");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function withChatVoice(test: (f: {
  script(next: Script): void;
  requests: ChatRequest[];
  spoken: string[];
  failSpeech(on: boolean): void;
  api(method: string, path: string, body?: unknown): Promise<any>;
  control(args: string[]): Promise<any>;
  messages(threadId: string): Promise<any[]>;
  audioFiles(): string[];
  newBot(name: string): Promise<any>;
  settle(bot: any, text: string): Promise<void>;
}) => Promise<void>) {
  let script: Script = () => say("Done.");
  const requests: ChatRequest[] = [];
  const spoken: string[] = [];
  let speechFails = false;
  const provider = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    if (req.method === "GET") { res.statusCode = 404; res.end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as ChatRequest;
    requests.push(request);
    // A side job (the conversation summary) offers no tools.
    const answer = request.tools?.length ? script(request, lastUser(request)) : say("Earlier the person asked for voice notes.");
    if (answer?.startsWith("HTTP ")) {
      res.writeHead(Number(answer.slice(5, 8)), { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: answer.slice(9) } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (answer === null) { res.write(": held\n\n"); return; }
    res.end(answer);
  });
  const speech = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (!(req.url ?? "").includes("/audio/speech")) { res.writeHead(404); res.end(); return; }
    spoken.push(String(JSON.parse(body).input ?? ""));
    if (speechFails) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "speech stub is down" })); return; }
    res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(MP3.byteLength) });
    res.end(MP3);
  });
  const providerUrl = await listen(provider);
  const speechUrl = await listen(speech);
  const fixture = await launchVerificationServer().catch(async (error) => {
    await close(provider);
    await close(speech);
    throw error;
  });
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const attachments = join(fixture.info.dataDir, "attachments");
  try {
    await api("PATCH", "/api/config", { openaiCompat: { key: "synthetic-fixture-key", url: `${providerUrl}/v1`, model: "fixture-model" } });
    await api("PUT", "/api/config", { tts: { provider: "chatterbox", baseUrl: speechUrl, voice: "voice-a" } });
    await test({
      script: (next) => { script = next; },
      requests,
      spoken,
      failSpeech: (on) => { speechFails = on; },
      api,
      control,
      messages: async (threadId) => inOrder((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages),
      audioFiles: () => existsSync(attachments) ? readdirSync(attachments).filter((name) => name.endsWith(".mp3")) : [],
      newBot: async (name) => {
        const { bot } = await control(["new-bot", "--name", name]);
        await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-model"]);
        return bot;
      },
      settle: async (bot, text) => {
        await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text]);
        await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "40"]);
      },
    });
  } finally {
    await fixture.close();
    await close(provider);
    await close(speech);
  }
}

const audioOf = (messages: any[]) => messages.flatMap((message) => (message.attachments ?? []).filter((file: any) => file.kind === "audio").map((file: any) => ({ message, file })));
/** The thread as the chat reads it: from its newest line back along each line's parent. */
const inOrder = (messages: any[]) => {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const parents = new Set(messages.map((message) => message.parentId));
  const path: any[] = [];
  for (let at = messages.findLast((message) => !parents.has(message.id)); at; at = byId.get(at.parentId)) path.unshift(at);
  return path;
};
const failureRow = (message: any) => message.kind === "activity" && String(message.tool?.name ?? "").startsWith("error:");
const stoppedRow = (message: any) => message.kind === "activity" && String(message.tool?.name ?? "").startsWith("stopped:");

/** One voice note, then a closing reply once the tool's result is back. */
const noteThenReply = (note: string, reply: string): Script => (request) =>
  toolResults(request).length ? say(reply) : callTool("note-1", "agents_send_voice_note", { text: note });

it("records a voice note on the chat runtime only with its audio, and attaches it to the reply, after a compaction too", async () => withChatVoice(async (f) => {
  const bot = await f.newBot("Chat voice bot");
  f.script(noteThenReply("The export finished.", "Here is the summary."));
  await f.settle(bot, "Send me a voice note.");
  expect(toolResults(f.requests.at(-1)!).join("\n")).toContain("Voice note recorded");
  let notes = audioOf(await f.messages(bot.activeTaskId));
  expect(notes.map((note) => [note.message.text, note.file.text])).toEqual([["Here is the summary.", "The export finished."]]);
  expect(f.audioFiles()).toHaveLength(1);

  // Every turn from here folds the conversation before it runs, as a long chat does.
  await f.api("PATCH", "/api/config", { context: { compactAt: 1 } });
  f.script((request) => say(toolResults(request).length ? "unused" : "Noted."));
  for (const line of ["First older request.", "Second older request.", "Third older request."]) await f.settle(bot, line);
  f.script(noteThenReply("Second note after the summary.", "Second reply."));
  await f.settle(bot, "Another voice note, please.");
  const messages = await f.messages(bot.activeTaskId);
  expect(messages.filter((message) => message.kind === "compaction").length).toBeGreaterThan(0);
  expect(toolResults(f.requests.at(-1)!).join("\n")).toContain("Voice note recorded");
  notes = audioOf(messages);
  expect(notes.map((note) => [note.message.text, note.file.text])).toEqual([
    ["Here is the summary.", "The export finished."],
    ["Second reply.", "Second note after the summary."],
  ]);
  expect(f.audioFiles()).toHaveLength(2);
}), 120_000);

it("says the note was not sent, and keeps no file, when the voice provider fails", async () => withChatVoice(async (f) => {
  const bot = await f.newBot("Failing voice bot");
  f.failSpeech(true);
  f.script(noteThenReply("This note cannot be spoken.", "Reply without a note."));
  await f.settle(bot, "Send me a voice note.");
  const result = toolResults(f.requests.at(-1)!).join("\n");
  expect(result).toContain("Voice note not sent");
  expect(result).not.toContain("Voice note recorded");
  expect(JSON.parse(result).ok).toBe(false);
  expect(f.spoken).toEqual(["This note cannot be spoken."]);
  expect(audioOf(await f.messages(bot.activeTaskId))).toEqual([]);
  expect(f.audioFiles()).toEqual([]);
}), 90_000);

it("delivers a recorded note with the error a turn ends on, above that error", async () => withChatVoice(async (f) => {
  const bot = await f.newBot("Erroring voice bot");
  f.script((request) => toolResults(request).length ? "HTTP 400 the provider refused the next step" : callTool("note-1", "agents_send_voice_note", { text: "Half of it is done." }));
  await f.settle(bot, "Do it and tell me by voice.");
  const messages = await f.messages(bot.activeTaskId);
  const notes = audioOf(messages);
  expect(notes.map((note) => note.file.text)).toEqual(["Half of it is done."]);
  const failed = messages.findIndex(failureRow);
  expect(failed).toBeGreaterThan(messages.indexOf(notes[0]!.message));
  expect(messages.slice(failed + 1).filter((message) => message.kind === "text")).toEqual([]);
  expect(f.audioFiles()).toHaveLength(1);
}), 90_000);

it("delivers a recorded note when the person stops the turn after it", async () => withChatVoice(async (f) => {
  const bot = await f.newBot("Stopped voice bot");
  f.script((request) => toolResults(request).length ? null : callTool("note-1", "agents_send_voice_note", { text: "Starting the long job." }));
  await f.control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Start the long job."]);
  await expect.poll(() => f.audioFiles().length, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => f.requests.filter((request) => toolResults(request).length).length, { timeout: 30_000 }).toBe(1);
  await f.api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.activeTaskId });
  await f.control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "40"]);
  const messages = await f.messages(bot.activeTaskId);
  expect(audioOf(messages).map((note) => note.file.text)).toEqual(["Starting the long job."]);
  expect(stoppedRow(lastNonReceipt(messages))).toBe(true);
  expect(f.audioFiles()).toHaveLength(1);
}), 90_000);

it("with a voice note on every reply, says by voice how a failed turn ended", async () => withChatVoice(async (f) => {
  const bot = await f.newBot("Every reply bot");
  await f.api("PATCH", `/api/bots/${bot.id}`, { voiceNoteEveryReply: true });
  f.script(() => "HTTP 400 the model is not available");
  await f.settle(bot, "Try something.");
  let notes: ReturnType<typeof audioOf> = [];
  await expect.poll(async () => (notes = audioOf(await f.messages(bot.activeTaskId))).length, { timeout: 30_000 }).toBe(1);
  expect(notes[0]!.file.text).toContain("the model is not available");
  expect(notes[0]!.message.role).toBe("bot");
  const messages = await f.messages(bot.activeTaskId);
  expect(failureRow(lastNonReceipt(messages))).toBe(true);

  f.script(() => say("All good now."));
  await f.settle(bot, "Again.");
  await expect.poll(async () => audioOf(await f.messages(bot.activeTaskId)).map((note) => note.file.text).at(-1), { timeout: 30_000 }).toBe("All good now.");
}), 90_000);
