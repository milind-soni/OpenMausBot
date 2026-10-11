// A client abort ends a turn as a quiet stop, end to end through a real
// harness server and a scripted chat-completions provider: the text the turn
// said before the stop is not its reply, the stop never raises an incident,
// and a room's Retry resends the request the stopped turn answered, files
// included.
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { openSse } from "./testing/sse.ts";
import { STOPPED_TURN_NAME } from "../shared/client-cancel.ts";
import { roomRetryRequest } from "../src/lib/room-retry.ts";

const CANCELLED = "The request was cancelled by the client.";
const PARTIAL = "Partial answer before the stop.";

type ChatMessage = { role: string; content?: unknown; tool_call_id?: string };
type ChatRequest = { messages: ChatMessage[]; tools?: Array<{ function: { name: string } }> };

const frame = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const lastUser = (request: ChatRequest) => {
  const content = request.messages.filter((message) => message.role === "user").at(-1)?.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
};

it("keeps a client abort a quiet stop and retries the room request it stopped", async () => {
  const requests: ChatRequest[] = [];
  const upstream = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as ChatRequest;
    requests.push(request);
    const user = lastUser(request);
    res.writeHead(200, { "content-type": "text/event-stream" });
    // A room prompt can quote the bot's other work, so room lines go first.
    if (user.includes("Say hello first.") && !user.includes("Read the brief.")) {
      res.end(frame({ content: "Hello." }, "stop") + "data: [DONE]\n\n");
      return;
    }
    if (user.includes("Read the brief.")) {
      res.end(frame({ content: CANCELLED }, "stop") + "data: [DONE]\n\n");
      return;
    }
    if (user.includes("Use the tool, then stop.")) {
      if (request.messages.some((message) => message.role === "tool")) {
        // The second round is aborted by the client, as some gateways say.
        res.end(`data: ${JSON.stringify({ error: { message: CANCELLED } })}\n\n`);
        return;
      }
      // A harmless read of the harness's own team list: like every agents
      // tool it asks nothing, and the turn goes on.
      res.end(frame({ content: PARTIAL, tool_calls: [{ index: 0, id: "look-1", type: "function", function: { name: "agents_list_bots", arguments: "{}" } }] }, "tool_calls") + "data: [DONE]\n\n");
      return;
    }
    res.end(frame({ content: "Done." }, "stop") + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture provider address missing");
  const fixture = await launchVerificationServer().catch(async (error) => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
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
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const stream = await openSse(`${fixture.info.url}/api/events`, { origin: fixture.info.url });
  try {
    await api("PATCH", "/api/config", { openaiCompat: { key: "synthetic-fixture-key", url: `http://127.0.0.1:${address.port}/v1`, model: "fixture-model" } });

    // ── a direct turn says something, reads its team, then the client aborts ──
    const { bot } = await control(["new-bot", "--name", "Stopper"]);
    await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-model"]);
    await api("PATCH", `/api/bots/${bot.id}`, { notifications: true });
    expect((await control(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Use the tool, then stop."])).success).toBe(true);
    await control(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30"]);
    const digest = await vi.waitFor(async () => {
      const found = (await messages(bot.activeTaskId)).find((message) => message.kind === "digest");
      if (!found) throw new Error("waiting for the turn digest");
      return found;
    }, { timeout: 10_000, interval: 100 });
    const direct = await messages(bot.activeTaskId);
    expect(direct.filter((message) => message.tool?.name === STOPPED_TURN_NAME)).toHaveLength(1);
    expect(direct.some((message) => message.kind === "activity" && /cancelled by the client/i.test(message.tool?.name ?? ""))).toBe(false);
    // The text before the stop stays in the transcript, but it is not the
    // turn's reply: neither the digest nor the finished notification reads it.
    expect(direct.some((message) => message.kind === "text" && message.text === PARTIAL)).toBe(true);
    expect(direct.some((message) => message.card)).toBe(false);
    expect(JSON.stringify(digest.digest)).not.toContain(PARTIAL);
    // "finished" with nothing said stays quiet (server/notify.ts).
    const notices = stream.frames.filter((candidate) => candidate.kind === "notify" && candidate.notification?.botId === bot.id);
    expect(notices.map((candidate) => candidate.notification.kind)).toEqual([]);
    // The provider settled the turn as an error, but it was a stop: no
    // incident buzzes the person or lands in a Chief's incidents thread.
    const bots = (await api("GET", "/api/bots")).bots as any[];
    expect(bots.flatMap((candidate) => candidate.tasks ?? []).some((task: any) => /incident/i.test(task.title ?? ""))).toBe(false);

    // ── a room: a text request settles, then a request with a file stops ──
    const { group } = await api("POST", "/api/groups", {
      name: "Stop room", memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    });
    await control(["send-channel", "--channel", group.id, "--text", "Say hello first."]);
    expect((await control(["wait", "--channel", group.id, "--timeout", "30"])).status).toBe("settled");
    const brief = join(fixture.info.dataDir, "brief.txt");
    writeFileSync(brief, "fixture brief");
    const request = `Read the brief.\n\n<attached-file path="${brief}" name="brief.txt" />`;
    await api("POST", `/api/groups/${group.id}/messages`, { text: request, threadId: group.threadId });
    await control(["wait", "--channel", group.id, "--timeout", "30"]);
    const room = await messages(group.threadId);
    const stoppedIndex = room.findIndex((message) => message.tool?.name === STOPPED_TURN_NAME);
    expect(stoppedIndex).toBeGreaterThan(0);
    expect(room.some((message) => message.kind === "text" && message.text === CANCELLED)).toBe(false);
    const sent = room.find((message) => message.role === "user" && message.text?.includes("Read the brief."));
    const retry = roomRetryRequest(room, stoppedIndex);
    expect(retry).toMatchObject({ messageId: sent.id, mode: "chat" });
    expect(retry!.text).toContain("Read the brief.");
    expect(retry!.text).toContain(`path="${brief}"`);
    expect(retry!.text).not.toContain("Say hello first.");

    // Resending it on the room's own path reaches the model with the file.
    const before = requests.length;
    await api("POST", `/api/groups/${group.id}/messages`, { text: retry!.text, threadId: group.threadId, mode: retry!.mode });
    await control(["wait", "--channel", group.id, "--timeout", "30"]);
    const resent = lastUser(requests.slice(before).at(-1)!);
    expect(resent).toContain("Read the brief.");
    expect(resent).toContain("brief.txt");
  } finally {
    stream.close();
    await fixture.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 180_000);

