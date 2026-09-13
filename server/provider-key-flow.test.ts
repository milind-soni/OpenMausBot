import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { openSse } from "./testing/sse.ts";

it("saving and replacing a workspace key reaches an existing bot's next request without leaking keys", async () => {
  const received: string[] = [];
  let reply = 0;
  const provider = createServer((req, res) => {
    if (req.url === "/v1/models") {
      // Deliberately public: this must never be presented as authenticated.
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    const key = req.headers.authorization ?? "";
    received.push(key);
    req.resume();
    if (!["Bearer fixture-first-key", "Bearer fixture-replacement-key"].includes(key)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid fixture credential" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `fixture reply ${++reply}` } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("fixture provider has no port");
  const fixture = await launchVerificationServer();
  const api = fixtureApi(fixture.info.url);
  const sse = await openSse(`${fixture.info.url}/api/events`);
  try {
    const missing = await fetch(`${fixture.info.url}/api/keys/test`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "openaiCompat" }),
    });
    expect(missing.status).toBe(400);
    const status = await api("PUT", "/api/config", {
      openaiCompat: { url: `http://127.0.0.1:${address.port}/v1`, key: "fixture-first-key" },
      instances: { openaiCompat: { driver: "openai-compat" } },
    });
    expect(status.openaiCompat.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain("fixture-first-key");
    expect(await api("POST", "/api/keys/test", { provider: "openaiCompat" }))
      .toEqual({ ok: true, check: "models", models: ["fixture-model"] });
    for (const key of ["", "   ", 123]) {
      const response = await fetch(`${fixture.info.url}/api/keys/test`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "openaiCompat", key }),
      });
      expect(response.status).toBe(400); // An explicit empty draft must not test the saved key.
    }
    const { bot } = await api("POST", "/api/bots", {
      name: "Sprout fixture", modelSelection: { instanceId: "openaiCompat", model: "fixture-model" },
    });
    const send = async (expectedReply: string) => {
      await api("POST", `/api/bots/${bot.id}/messages`, { text: "Reply briefly for the credential test." });
      await sse.until((frame) => frame.kind === "message" && frame.threadId === bot.threadId
        && frame.message?.role === "bot" && frame.message?.text === expectedReply);
      // Wait for idle after this reply before exercising the next config save.
      const { bots } = await api("GET", "/api/bots?messages=10");
      const current = bots.find((candidate: { id: string }) => candidate.id === bot.id);
      if (current.busy) await sse.until((frame) => frame.kind === "bot" && frame.bot?.id === bot.id && !frame.bot.busy
        && frame.bot.messages?.some((message: { text?: string }) => message.text === expectedReply));
    };
    await send("fixture reply 1");
    // The first save installed an env value and created the runtime. A second
    // save must replace both that env value and the runtime's captured key.
    await api("PUT", "/api/config", { openaiCompat: { key: "fixture-replacement-key" } });
    await send("fixture reply 2");
    expect(received).toEqual(["Bearer fixture-first-key", "Bearer fixture-replacement-key"]);
    const disk = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
    expect(disk.openaiCompat.key).toBe("fixture-replacement-key");
    const cleared = await api("PUT", "/api/config", { openaiCompat: { key: "" } });
    expect(cleared.openaiCompat.configured).toBe(false);
    const { instances } = await api("GET", "/api/instances");
    expect(instances.find((instance: { instanceId: string }) => instance.instanceId === "openaiCompat").snapshot.state).toBe("unavailable");
    const publicState = JSON.stringify([await api("GET", "/api/bots"), await api("GET", "/api/config"), sse.frames]);
    const logs = readFileSync(fixture.info.logPath, "utf8");
    for (const key of ["fixture-first-key", "fixture-replacement-key"]) {
      expect(publicState).not.toContain(key);
      expect(logs).not.toContain(key);
    }
  } finally {
    sse.close();
    await fixture.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
