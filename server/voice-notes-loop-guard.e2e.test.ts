// A voice note on a turn the loop guard stops, through a real harness server and the fake Claude engine: its first
// call holds while this test records a note through the agents server the engine was launched with, then one shell
// command fails the same way ten times in a row and the guard stops the turn. A loopback speech stub stands in for the
// voice provider, so no external service is reached.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { failedTurnCause } from "../shared/failed-turn.ts";
import { lastNonReceipt } from "../src/lib/receipts.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { childEnv } from "./testing/omb-env.ts";

type McpServer = { command: string; args: string[]; env: Record<string, string> };
const STOPPED = "the same call failed the same way 10 times in a row: “Bash: git status” — the turn was stopped";
const MP3 = Buffer.from("ID3 fake mp3 for the loop guard voice fixture");

/** One tools/call to the agents server exactly as the engine was told to start it. */
async function callAgentsTool(server: McpServer, name: string, args: unknown): Promise<{ text: string; isError?: boolean }> {
  const child = spawn(server.command, server.args, { env: childEnv(server.env), stdio: ["pipe", "pipe", "inherit"] });
  try {
    const answer = await new Promise<any>((resolve, reject) => {
      let buffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline !== -1) resolve(JSON.parse(buffer.slice(0, newline)));
      });
      child.on("exit", (code) => reject(new Error(`the agents server exited (${code}) before answering`)));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`);
    });
    return { text: answer.result.content[0].text, isError: answer.result.isError };
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
  }
}

/** The thread as the chat reads it: from its newest line back along each line's parent. */
const inOrder = (messages: any[]) => {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const parents = new Set(messages.map((message) => message.parentId));
  const path: any[] = [];
  for (let at = messages.findLast((message) => !parents.has(message.id)); at; at = byId.get(at.parentId)) path.unshift(at);
  return path;
};
const audioOf = (messages: any[]) => messages.flatMap((message) => (message.attachments ?? []).filter((file: any) => file.kind === "audio").map((file: any) => ({ message, file })));

it("keeps a recorded note when the loop guard stops the turn, and with every reply on, says why it stopped", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-voice-loop-"));
  const release = join(scratch, "release");
  const spoken: string[] = [];
  const speech: Server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    spoken.push(String(JSON.parse(body || "{}").input ?? ""));
    res.writeHead(200, { "content-type": "audio/mpeg", "content-length": String(MP3.byteLength) });
    res.end(MP3);
  });
  await new Promise<void>((resolve) => speech.listen(0, "127.0.0.1", resolve));
  const port = (speech.address() as { port: number }).port;
  const fixture = await launchVerificationServer({
    ...process.env,
    FAKE_CLAUDE_MODE: "slow",
    FAKE_CLAUDE_SLOW_FINISH_GATE: join(scratch, "never"),
    FAKE_CLAUDE_RELEASE: release,
    FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([
      { name: "Bash", input: { command: "sleep 600" }, ok: true, hold: true },
      ...Array.from({ length: 10 }, () => ({ name: "Bash", input: { command: "git status" }, ok: false, output: "fatal: not a git repository" })),
    ]),
  }).catch(async (error) => {
    speech.close();
    rmSync(scratch, { recursive: true, force: true });
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
  const messages = async (threadId: string) => inOrder((await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages);
  const audioFiles = () => {
    const dir = join(fixture.info.dataDir, "attachments");
    return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".mp3")) : [];
  };
  try {
    await api("PUT", "/api/config", { tts: { provider: "chatterbox", baseUrl: `http://127.0.0.1:${port}`, voice: "voice-a" } });
    await api("PATCH", "/api/config", { loopGuard: { enabled: true, stopAt: 10 } });

    const { bot } = await control(["new-bot", "--name", "Looping voice bot"]);
    await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "go"]);
    await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 30_000 }).toBe(true);
    const launched = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { mcpConfig: { mcpServers: Record<string, McpServer> } };
    const recorded = await callAgentsTool(launched.mcpConfig.mcpServers.agents!, "send_voice_note", { text: "Checking the repository now." });
    expect(recorded.isError).toBeFalsy();
    expect(recorded.text).toContain("Voice note recorded");
    writeFileSync(release, "go");
    await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "60"]);
    let rows = await messages(bot.activeTaskId);
    expect(failedTurnCause(lastNonReceipt(rows)?.tool?.name ?? "")).toBe(STOPPED);
    expect(audioOf(rows).map((note) => note.file.text)).toEqual(["Checking the repository now."]);
    expect(audioFiles()).toHaveLength(1);

    const { bot: voiced } = await control(["new-bot", "--name", "Every reply looping bot"]);
    await api("PATCH", `/api/bots/${voiced.id}`, { voiceNoteEveryReply: true });
    await control(["send", "--bot", voiced.id, "--task", voiced.activeTaskId, "--text", "go"]);
    await control(["wait", "--bot", voiced.id, "--task", voiced.activeTaskId, "--timeout", "60"]);
    let notes: ReturnType<typeof audioOf> = [];
    await expect.poll(async () => (notes = audioOf(rows = await messages(voiced.activeTaskId))).length, { timeout: 30_000 }).toBe(1);
    expect(notes[0]!.file.text).toContain("I stopped before finishing: the same call failed the same way 10 times in a row");
    expect(spoken.at(-1)).toBe(notes[0]!.file.text);
    expect(failedTurnCause(lastNonReceipt(rows)?.tool?.name ?? "")).toBe(STOPPED);
  } finally {
    await fixture.close();
    speech.closeAllConnections();
    await new Promise<void>((resolve) => speech.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
}, 240_000);
