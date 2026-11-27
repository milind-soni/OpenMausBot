// A chat bot never holds a resume cursor, so engineIsFresh is true on every later turn: the inline replay must not also ride the turn text.
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GroqDriver } from "./drivers/groq.ts";
import { recordEvents } from "./testing/events.ts";
import { buildTurnContext, engineIsFresh, replaysNatively } from "./turn-context.ts";

type Body = { messages: Array<{ role: string; content: unknown }> };
const FIRST = "my dog is named Biscuit, remember it";

describe("chat-completions history is sent once", () => {
  let server: Server;
  let base: string;
  let bodies: Body[];

  beforeEach(async () => {
    bodies = [];
    server = createServer(async (req, res) => {
      if (req.url?.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "openai/gpt-oss-120b" }] })); return; }
      let text = "";
      for await (const chunk of req) text += chunk;
      bodies.push(JSON.parse(text) as Body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "Noted." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture address missing");
    base = `http://127.0.0.1:${address.port}/openai/v1`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("groq: the first user message is in the second request exactly once", async () => {
    const instance = await GroqDriver.create({ instanceId: "groq-1", displayName: "Groq", enabled: true,
      config: GroqDriver.decodeConfig({ url: base }), environment: { GROQ_API_KEY: `gsk_${"a".repeat(48)}` } });
    const recorder = recordEvents(instance.adapter);
    try {
      const transcript = [{ role: "user" as const, text: FIRST }, { role: "assistant" as const, text: "Noted." }];
      const fresh = engineIsFresh({ instanceId: "groq-1", lastInstanceId: "groq-1", resumeCursors: {}, transcript });
      const { turnText } = buildTurnContext({ text: "what is my dog called?", transcript, rewound: false, fresh,
        externallyUpdated: false, replaysNatively: replaysNatively(instance.driverKind) });
      await instance.adapter.sendTurn({ threadId: "t", text: turnText, transcript, model: "openai/gpt-oss-120b" });
      await recorder.until((event) => event.type === "turn.completed");
      const sent = JSON.stringify(bodies.at(-1)!.messages);
      expect(sent.split(FIRST).length - 1).toBe(1);
    } finally { recorder.stop(); await instance.dispose(); }
  });
});
