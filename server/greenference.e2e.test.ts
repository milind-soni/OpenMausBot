import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { openSse } from "./testing/sse.ts";

it("Greenference discovers models, runs an existing bot after token rotation, and reports rejected/cleared tokens in an isolated workspace", async () => {
  const received: string[] = [];
  let reply = 0;
  const provider = createServer((req, res) => {
    if (req.url === "/v1/models") {
      // Like Greenference, this public response does not authenticate a key.
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "greenference/fixture", name: "Fixture model", context_length: 131072,
        input_modalities: ["text"], output_modalities: ["text"], is_ready: true }] }));
      return;
    }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    const key = req.headers.authorization ?? "";
    received.push(key); req.resume();
    if (key === "Bearer fixture-rejected") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API key" } })); return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`: ping\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: `Greenference fixture reply ${++reply}` } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("fixture provider has no port");
  const url = `http://127.0.0.1:${address.port}/v1`;
  const fixture = await launchVerificationServer();
  const api = fixtureApi(fixture.info.url);
  const sse = await openSse(`${fixture.info.url}/api/events`);
  const save = (key: string) => {
    // Per-instance endpoints are file configuration, not accepted from the
    // Settings patch route. Only edit the launcher's disposable config.
    const path = join(fixture.info.dataDir, "config.json");
    const disk = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...disk, instances: { ...disk.instances,
      greenference: { driver: "greenference", config: { url }, environment: { GREENFERENCE_TOKEN: key } },
    } }));
    return api("PUT", "/api/config", { greenference: { key } });
  };
  const snapshot = async () => (await api("GET", "/api/instances")).instances
    .find((instance: { instanceId: string }) => instance.instanceId === "greenference");
  try {
    const status = await save("fixture-first");
    expect(status.greenference).toEqual({ configured: true });
    expect((await snapshot()).models.options).toEqual([{ id: "greenference/fixture", label: "Fixture model", contextWindow: 131072 }]);
    expect(await api("POST", "/api/keys/test", { provider: "greenference", url }))
      .toEqual({ ok: true, check: "models", models: ["greenference/fixture"] });
    const { bot } = await api("POST", "/api/bots", { name: "Greenference fixture",
      modelSelection: { instanceId: "greenference", model: "greenference/fixture" } });
    const send = async (expected: string) => {
      await api("POST", `/api/bots/${bot.id}/messages`, { text: "Say hello briefly." });
      const replyFrame = await sse.until(frame => frame.kind === "message" && frame.threadId === bot.threadId
        && frame.message?.role === "bot" && frame.message?.text === expected);
      const { bots } = await api("GET", "/api/bots");
      if (bots.find((candidate: { id: string }) => candidate.id === bot.id).busy) {
        await sse.until(frame => frame.kind === "bot" && frame.bot?.id === bot.id && !frame.bot.busy && frame.seq > replyFrame.seq);
      }
    };
    await send("Greenference fixture reply 1");
    await save("fixture-replacement");
    await send("Greenference fixture reply 2");
    expect(received).toEqual(["Bearer fixture-first", "Bearer fixture-replacement"]);
    await save("fixture-rejected");
    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Test the invalid fixture token." });
    await expect.poll(async () => (await snapshot()).snapshot.authenticated).toBe(false);
    expect(await api("POST", "/api/keys/test", { provider: "greenference", url }))
      .toMatchObject({ ok: true, check: "models" });
    expect((await snapshot()).snapshot.authenticated).toBe(false);
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((candidate: { id: string }) => candidate.id === bot.id).busy).toBe(false);
    const cleared = await save("");
    expect(cleared.greenference.configured).toBe(false);
    expect((await snapshot()).snapshot.state).toBe("unavailable");
    const publicState = JSON.stringify([status, await api("GET", "/api/config"), await api("GET", "/api/bots"), sse.frames]);
    const logs = readFileSync(fixture.info.logPath, "utf8");
    for (const key of ["fixture-first", "fixture-replacement", "fixture-rejected"]) {
      expect(publicState).not.toContain(key); expect(logs).not.toContain(key);
    }
    const evidencePath = fixture.info.logPath.replace(/\.log$/, "-greenference.json");
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info.url, logPath: fixture.info.logPath,
      replies: reply, chatRequests: received.length, tokenRotation: true, rejectedTokenPreserved: true, cleared: true }, null, 2));
    console.log(JSON.stringify({ evidencePath }));
  } finally {
    sse.close(); await fixture.close(); provider.closeAllConnections();
    await new Promise<void>(resolve => provider.close(() => resolve()));
  }
}, 60_000);
