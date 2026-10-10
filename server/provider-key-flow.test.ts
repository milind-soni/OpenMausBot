import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
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
      const replyFrame = await sse.until((frame) => frame.kind === "message" && frame.threadId === bot.threadId
        && frame.message?.role === "bot" && frame.message?.text === expectedReply);
      // Wait for idle after this reply before exercising the next config save.
      const { bots } = await api("GET", "/api/bots?messages=10");
      const current = bots.find((candidate: { id: string }) => candidate.id === bot.id);
      // Bot SSE updates contain status, not messages. Tool cleanup may keep
      // the turn busy after its reply; await a newer idle status before save.
      if (current.busy) await sse.until((frame) => frame.kind === "bot" && frame.bot?.id === bot.id && !frame.bot.busy
        && frame.seq > replyFrame.seq);
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

it("switching the workspace endpoint moves discovery and existing chats without changing a private connection", async () => {
  const received: Array<{ provider: string; path: string; key: string }> = [];
  const providers = ["first", "second"].map((name) => createServer((req, res) => {
    const key = req.headers.authorization ?? "";
    received.push({ provider: name, path: req.url ?? "", key });
    req.resume();
    const allowed = name === "first"
      ? ["Bearer fixture-first-key", "Bearer fixture-private-key"]
      : ["Bearer fixture-second-key"];
    if (!allowed.includes(key)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid fixture credential" } }));
      return;
    }
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture-shared-model" }, { id: `fixture-${name}-model` }] }));
      return;
    }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `${name} provider reply` } }] })}\n\ndata: [DONE]\n\n`);
  }));
  const urls = await Promise.all(providers.map(async (provider) => {
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("fixture provider has no port");
    return `http://127.0.0.1:${address.port}/v1`;
  }));
  const fixture = await launchVerificationServer();
  const api = fixtureApi(fixture.info.url);
  const sse = await openSse(`${fixture.info.url}/api/events`);
  try {
    const privateConnection = {
      driver: "openai-compat", config: { url: urls[0], key: "fixture-private-key" },
    };
    const configPath = join(fixture.info.dataDir, "config.json");
    const initialConfig = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({
      ...initialConfig,
      openaiCompat: { url: urls[0], key: "fixture-first-key" },
      instances: {
        ...initialConfig.instances,
        // Older config writes could persist the inherited workspace URL here.
        openaiCompat: { driver: "openai-compat", config: { url: urls[0] } },
        privateApi: privateConnection,
      },
    }));
    await api("PUT", "/api/config", { openaiCompat: { key: "fixture-first-key" } });
    await api("POST", "/api/instances/openaiCompat/refresh-models");
    const { bot } = await api("POST", "/api/bots", {
      name: "Endpoint switch fixture", modelSelection: { instanceId: "openaiCompat", model: "fixture-shared-model" },
    });
    const send = async (target: { id: string; threadId: string }, expectedReply: string) => {
      await api("POST", `/api/bots/${target.id}/messages`, { text: "Reply briefly for the endpoint test." });
      const replyFrame = await sse.until((frame) => frame.kind === "message" && frame.threadId === target.threadId
        && frame.message?.role === "bot" && frame.message?.text === expectedReply);
      const { bots } = await api("GET", "/api/bots?messages=10");
      const current = bots.find((candidate: { id: string }) => candidate.id === target.id);
      if (current.busy) await sse.until((frame) => frame.kind === "bot" && frame.bot?.id === target.id && !frame.bot.busy
        && frame.seq > replyFrame.seq);
    };
    await send(bot, "first provider reply");

    // Settings changes the workspace fields, without rewriting instance config.
    await api("PUT", "/api/config", { openaiCompat: { url: urls[1], key: "fixture-second-key" } });
    const { instances } = await api("POST", "/api/instances/openaiCompat/refresh-models");
    expect(received.filter((request) => request.provider === "first").map((request) => request.key))
      .not.toContain("Bearer fixture-second-key");
    expect(instances.find((instance: { instanceId: string }) => instance.instanceId === "openaiCompat").models.options)
      .toEqual([{ id: "fixture-shared-model", label: "fixture-shared-model", custom: true },
        { id: "fixture-second-model", label: "fixture-second-model", custom: true }]);
    await send(bot, "second provider reply");
    expect(received).toContainEqual({ provider: "second", path: "/v1/chat/completions", key: "Bearer fixture-second-key" });

    const { bot: privateBot } = await api("POST", "/api/bots", {
      name: "Private endpoint fixture", modelSelection: { instanceId: "privateApi", model: "fixture-shared-model" },
    });
    await send(privateBot, "first provider reply");
    expect(received).toContainEqual({ provider: "first", path: "/v1/chat/completions", key: "Bearer fixture-private-key" });
    const disk = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
    expect(disk.instances.privateApi).toEqual(privateConnection);
    expect(received.filter((request) => request.provider === "first").map((request) => request.key))
      .not.toContain("Bearer fixture-second-key");
  } finally {
    sse.close();
    await fixture.close();
    await Promise.all(providers.map((provider) => new Promise<void>((resolve) => provider.close(() => resolve()))));
  }
});
