// A saved key looks Ready until the provider refuses it. One refused turn
// (or a failed Test) marks it, so Model providers and the picker show it
// needs a new key; a rate limit does not, and saving a key or a later
// success clears it. The key never appears in the snapshot, events or logs.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { openSse } from "./testing/sse.ts";

const BAD = "fixture-revoked-key";
const GOOD = "fixture-working-key";

it("a key the provider rejects stops showing Ready until it changes or works again", async () => {
  let chat: "limit" | "auth" = "auth";
  const accepted = new Set([`Bearer ${GOOD}`]);
  const provider = createServer((req, res) => {
    req.resume();
    const key = req.headers.authorization ?? "";
    if (req.url === "/v1/models") {
      if (!accepted.has(key)) { res.writeHead(401).end(JSON.stringify({ error: { message: "Invalid API key" } })); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
      return;
    }
    if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    if (!accepted.has(key)) {
      const [status, message] = chat === "limit" ? [429, "Rate limit reached"] : [401, "Incorrect API key provided"];
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "fixture reply" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("fixture provider has no port");
  const fixture = await launchVerificationServer();
  const api = fixtureApi(fixture.info.url);
  const sse = await openSse(`${fixture.info.url}/api/events`);
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const snapshot = async () => (await api("GET", "/api/instances")).instances
    .find((instance: { instanceId: string }) => instance.instanceId === "openaiCompat").snapshot;
  try {
    await api("PUT", "/api/config", {
      openaiCompat: { url: `http://127.0.0.1:${address.port}/v1`, key: BAD, model: "fixture-model" },
      instances: { openaiCompat: { driver: "openai-compat" } },
    });
    expect(await snapshot()).toMatchObject({ state: "available", authenticated: true });
    const { bot } = await control(["new-bot", "--name", "Rejected key fixture"]);
    await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "fixture-model"]);
    const turn = async () => {
      await control(["send", "--bot", bot.id, "--text", "Reply briefly."]);
      return control(["wait", "--bot", bot.id, "--timeout", "30"]);
    };

    chat = "limit";
    expect((await turn()).status).toBe("failed");
    expect(await snapshot()).toMatchObject({ state: "available", authenticated: true });
    // Nor is a rate limit a spent budget: no `Continue:` task
    // starts an unattended turn that hits the limit again.
    const afterLimit = await control(["messages", "--bot", bot.id, "--limit", "1"]);
    expect(afterLimit.bot.tasks.map((task: { title: string }) => task.title)).toHaveLength(1);

    chat = "auth";
    const seq = sse.frames.at(-1)?.seq ?? 0;
    expect((await turn()).status).toBe("failed");
    const messages = await control(["messages", "--bot", bot.id, "--limit", "10"]);
    expect(JSON.stringify(messages)).toContain("HTTP 401");
    // The renderer refetches /api/instances on a config event.
    await sse.until((frame) => frame.kind === "config" && frame.seq > seq);
    expect(await snapshot()).toEqual(expect.objectContaining({
      state: "available", authenticated: false, reason: "The provider rejected this key. Change it in Settings → API keys.",
    }));

    // Saving a key, even the same one, starts over; its failed Test marks it again.
    await api("PUT", "/api/config", { openaiCompat: { key: BAD } });
    expect(await snapshot()).toMatchObject({ authenticated: true });
    expect(await api("POST", "/api/keys/test", { provider: "openaiCompat" })).toMatchObject({ ok: false, reason: "rejected" });
    expect(await snapshot()).toMatchObject({ authenticated: false });

    // The provider takes the same key again: a passing Test clears the mark.
    accepted.add(`Bearer ${BAD}`);
    expect(await api("POST", "/api/keys/test", { provider: "openaiCompat" })).toMatchObject({ ok: true });
    expect(await snapshot()).toMatchObject({ authenticated: true });

    // ...and so does a later turn that works.
    accepted.delete(`Bearer ${BAD}`);
    expect((await turn()).status).toBe("failed");
    expect(await snapshot()).toMatchObject({ authenticated: false });
    accepted.add(`Bearer ${BAD}`);
    expect((await turn()).status).toBe("settled");
    expect(await snapshot()).toMatchObject({ authenticated: true });

    // A different key is never shown as rejected.
    accepted.delete(`Bearer ${BAD}`);
    expect((await turn()).status).toBe("failed");
    expect(await snapshot()).toMatchObject({ authenticated: false });
    await api("PUT", "/api/config", { openaiCompat: { key: GOOD } });
    expect(await snapshot()).toMatchObject({ state: "available", authenticated: true });
    expect((await turn()).status).toBe("settled");

    const publicState = JSON.stringify([await api("GET", "/api/instances"), await api("GET", "/api/config"), sse.frames]);
    const logs = readFileSync(fixture.info.logPath, "utf8");
    for (const key of [BAD, GOOD]) {
      expect(publicState).not.toContain(key);
      expect(logs).not.toContain(key);
    }
  } finally {
    sse.close();
    await fixture.close();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 120_000);
