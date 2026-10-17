import { createServer } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

it("uses a changed compatible capacity for the next compaction decision rather than old turn metadata", async () => {
  const model = "fixture-context-model";
  const capacity = 262144;
  const tokens = 20000;
  const provider = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: model, context_length: capacity }] })); return;
    }
    let body = "";
    req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => {
      const streaming = JSON.parse(body).stream;
      res.setHeader("content-type", streaming ? "text/event-stream" : "application/json");
      res.end(streaming
        ? `data: ${JSON.stringify({ choices: [{ delta: { content: "Acknowledged." }, finish_reason: "stop" }], usage: { prompt_tokens: tokens, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`
        : JSON.stringify({ choices: [{ message: { content: "Keep the original task constraint and continue the work." } }] }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture endpoint");
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  try {
    fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
    const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, fixture!.info.url) as Promise<any>;
    const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture!.info.url]) as Promise<any>;
    const refresh = async () => {
      await expect.poll(async () => {
        const response = await fetch(fixture!.info.url + "/api/instances/openaiCompat/refresh-models", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const body = await response.json();
        if (response.status === 409) {
          expect(body).toMatchObject({ error: "provider settings are already being updated" });
          return false;
        }
        expect(response.ok, JSON.stringify(body)).toBe(true);
        return true;
      }, { timeout: 10_000 }).toBe(true);
    };
    await api("/api/config", { openaiCompat: { key: "fixture-key", url: endpoint, model }, context: { autoCompact: true } }, "PUT");
    await refresh();
    const bot = (await cli("new-bot", "--name", "Context capacity fixture")).bot;
    const thread = bot.activeTaskId;
    await cli("set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", model, "--task", thread);
    const messages = async () => (await api(`/api/threads/${thread}/messages`)).messages as any[];
    const send = async (text: string) => {
      await cli("send", "--bot", bot.id, "--task", thread, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", thread, "--timeout", "30")).status).toBe("settled");
    };
    for (const text of ["Keep the original task constraint.", "Continue the second step.", "Continue the third step."]) await send(text);
    expect((await messages()).filter(message => message.kind === "compaction")).toHaveLength(0);
    const usage = (await api("/api/bots?messages=0")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === thread).usage;
    expect(usage.context).toMatchObject({ tokens: tokens + 2, window: capacity });
    const before = (await api("/api/config", undefined, "GET")).openaiCompat.contextWindows;
    await api("/api/config", { expectedContextWindows: before, openaiCompat: { contextWindows: { [endpoint]: { [model]: 16384 } } } }, "PUT");
    const stale = await fetch(fixture.info.url + "/api/config", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedContextWindows: before, openaiCompat: { contextWindows: { [endpoint]: { other: 32768 } } } }) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: expect.stringContaining("Context limits changed") });
    expect((await api("/api/config", undefined, "GET")).openaiCompat.contextWindows).toEqual({ [endpoint]: { [model]: 16384 } });
    await refresh();
    await send("Continue after the capacity setting changes.");
    await expect.poll(async () => (await messages()).filter(message => message.kind === "compaction")).toHaveLength(1);
    const task = (await api("/api/bots?messages=0")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === thread);
    expect(task.usage.context.window).toBe(16384);
  } finally {
    await fixture?.close();
    provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
}, 120_000);
