import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { STOPPED_TURN_NAME } from "../shared/client-cancel.ts";
import { unaskedStopMessage } from "./harness/unasked-stop.ts";
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

it("says in words that a turn nobody stopped was cut off, and retries the room request a client abort stopped", async () => {
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
  try {
    await api("PATCH", "/api/config", { openaiCompat: { key: "synthetic-fixture-key", url: `http://127.0.0.1:${address.port}/v1`, model: "fixture-model" } });

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
    expect(direct.filter((message) => message.tool?.name === STOPPED_TURN_NAME)).toHaveLength(0);
    const failed = direct.filter((message) => message.kind === "activity" && message.tool?.ok === false);
    expect(failed.map((message) => message.tool.name)).toEqual([`error: ${unaskedStopMessage(CANCELLED)}`]);
    expect(direct.some((message) => message.kind === "text" && message.text === PARTIAL)).toBe(true);
    expect(direct.some((message) => message.card)).toBe(false);
    expect(digest.digest.reply).toBe(PARTIAL);

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

    const before = requests.length;
    await api("POST", `/api/groups/${group.id}/messages`, { text: retry!.text, threadId: group.threadId, mode: retry!.mode });
    await control(["wait", "--channel", group.id, "--timeout", "30"]);
    const resent = lastUser(requests.slice(before).at(-1)!);
    expect(resent).toContain("Read the brief.");
    expect(resent).toContain("brief.txt");
  } finally {
    await fixture.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 180_000);

