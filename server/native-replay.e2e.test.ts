import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";

it("sends history once through the real OpenAI-compatible server route after a rewind", async () => {
  const requests: any[] = [];
  const upstream = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Fixture reply" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Fixture provider has no port");
  let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  const evidence: unknown[] = [];
  try {
    fixture = await launchVerificationServer();
    const api = fixtureApi(fixture.info.url);
    const cli = async (...args: string[]) => {
      const result = await runControlOmb([...args, "--url", fixture!.info.url]) as any;
      evidence.push({ command: args, result });
      return result;
    };
    await api("PUT", "/api/config", { openaiCompat: {
      url: `http://127.0.0.1:${address.port}/v1`, key: "synthetic-fixture-key", model: "fixture-model",
    } });
    await api("PATCH", "/api/instances/openaiCompat", { tools: false });
    const { bot } = await cli("new-bot", "--name", "Native replay fixture");
    await cli("set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-model");
    const wait = async () => expect((await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20")).status).toBe("settled");
    for (const text of ["NATIVE_REPLAY_SENTINEL", "Second request"]) {
      await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", text);
      await wait();
    }
    const transcript = await cli("messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "30");
    const second = transcript.messages.find((message: any) => message.role === "user" && message.text === "Second request");
    expect(second?.id).toBeTruthy();
    await api("POST", `/api/bots/${bot.id}/messages/${second.id}/edit`, { threadId: bot.activeTaskId, text: "Revised second request" });
    await wait();
    expect(requests).toHaveLength(3);
    const outgoing = JSON.stringify(requests.at(-1).messages);
    expect(outgoing.split("NATIVE_REPLAY_SENTINEL").length - 1).toBe(1);
    expect(outgoing).toContain("Revised second request");
    expect(outgoing).not.toContain("Second request");
    await cli("messages", "--bot", bot.id, "--task", bot.activeTaskId, "--limit", "30");
  } finally {
    if (fixture) {
      const evidencePath = `${fixture.info.logPath}.native-replay.json`;
      writeFileSync(evidencePath, JSON.stringify({ evidence, requests }, null, 2), { mode: 0o600 });
      console.info(`Native replay evidence: ${evidencePath}`);
      await fixture.close();
    }
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}, 60_000);
