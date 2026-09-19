import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { fixtureApi } from "../scripts/testing/preview-fixture.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

const route = "/api/instances/openai-compatible";
const editRoute = (id: string) => `/api/instances/${id}/openai-compatible`;

async function provider(name: string) {
  const requests: Array<{ path: string; key: string; model?: string }> = [];
  let held: ServerResponse | undefined;
  let holdNext = false;
  const reply = (res: ServerResponse) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `${name} replied` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    requests.push({ path: req.url ?? "", key: req.headers.authorization ?? "", model: body.model });
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "shared-model", name: `${name} model` }] }));
    } else if (req.url === "/v1/chat/completions" && body.stream === false) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }));
    } else if (req.url === "/v1/chat/completions") {
      if (holdNext) { holdNext = false; held = res; }
      else reply(res);
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return {
    url: `http://127.0.0.1:${address.port}/v1`, requests,
    hold: () => { holdNext = true; },
    held: () => !!held,
    release: () => { if (held) { reply(held); held = undefined; } },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

it("routes two bots independently, rotates one key while the other runs, and preserves connection and thread selections after restart", async () => {
  const first = await provider("First");
  onTestFinished(first.close);
  const second = await provider("Second");
  onTestFinished(second.close);
  const fixture = await launchVerificationServer();
  onTestFinished(() => fixture.close());
  const api = fixtureApi(fixture.info.url);
  let sse = await openSse(`${fixture.info.url}/api/events`);
  let restarted: ChildProcess | undefined;
  const status = async (method: string, path: string, body = {}) => (await fetch(`${fixture.info.url}${path}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })).status;
  const idle = async (id: string) => {
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).bots.find((bot: { id: string }) => bot.id === id)?.busy).toBe(false);
  };
  try {
    const a = await api("POST", route, { displayName: "First API", url: first.url, auth: "bearer", key: "fixture-first-key", model: "shared-model", tools: false });
    const b = await api("POST", route, { displayName: "Second API", url: second.url, auth: "bearer", key: "fixture-second-key", model: "shared-model", tools: false });
    const icon = { kind: "preset", preset: "mistral" };
    await api("PATCH", `/api/instances/${a.instanceId}/icon`, { icon });
    const selectionA = { instanceId: a.instanceId, model: "shared-model" };
    const selectionB = { instanceId: b.instanceId, model: "shared-model" };
    const { bot: botA } = await api("POST", "/api/bots", { name: "API bot A", modelSelection: selectionA });
    const { bot: botB } = await api("POST", "/api/bots", { name: "API bot B", modelSelection: selectionB });
    second.hold();
    await api("POST", `/api/bots/${botB.id}/messages`, { text: "Keep this independent request open." });
    await expect.poll(second.held).toBe(true);
    expect(await status("PATCH", editRoute(b.instanceId), { key: "cannot-rotate-busy" })).toBe(409);
    await api("POST", `/api/bots/${botA.id}/messages`, { text: "Reply briefly." });
    await sse.until((frame) => frame.kind === "message" && frame.threadId === botA.threadId && frame.message?.text === "First replied");
    await idle(botA.id);
    await api("PATCH", editRoute(a.instanceId), { key: "fixture-first-rotated" });
    expect((await api("GET", "/api/bots?messages=0")).bots.find((bot: { id: string }) => bot.id === botB.id).busy).toBe(true);
    second.release();
    await sse.until((frame) => frame.kind === "message" && frame.threadId === botB.threadId && frame.message?.text === "Second replied");
    await idle(botB.id);
    const sequence = sse.frames.at(-1)?.seq ?? 0;
    await api("POST", `/api/bots/${botA.id}/messages`, { text: "Use the replacement credential." });
    await sse.until((frame) => frame.seq > sequence && frame.kind === "message" && frame.threadId === botA.threadId && frame.message?.text === "First replied");
    await idle(botA.id);
    expect(first.requests.filter((request) => request.path.endsWith("/chat/completions")).map((request) => request.key))
      .toEqual(["Bearer fixture-first-key", "Bearer fixture-first-rotated"]);
    expect(second.requests.every((request) => request.key === "Bearer fixture-second-key")).toBe(true);
    expect(await status("PATCH", editRoute(a.instanceId), { url: second.url })).toBe(400);
    expect(await status("DELETE", editRoute(a.instanceId))).toBe(409);

    // Change the selected new conversation and bot default; the older thread
    // must retain its original connection, even though the model ID is equal.
    const { task } = await api("POST", `/api/bots/${botA.id}/tasks`, { title: "Other connection" });
    await api("PATCH", `/api/bots/${botA.id}/tasks/${task.threadId}`, { modelSelection: selectionB, updateBotDefault: true });
    const readBot = async () => (await api("GET", "/api/bots?messages=0")).bots.find((bot: { id: string }) => bot.id === botA.id);
    expect((await readBot()).tasks.find((thread: { threadId: string }) => thread.threadId === botA.threadId).modelSelection).toEqual(selectionA);
    sse.close();
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(fixture.info.logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment(process.env, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(`${fixture.info.url}/api/health`)).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    const restored = await readBot();
    expect(JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).instances[a.instanceId].icon).toEqual(icon);
    expect(restored.modelSelection).toEqual(selectionB);
    expect(restored.tasks.find((thread: { threadId: string }) => thread.threadId === botA.threadId).modelSelection).toEqual(selectionA);
    expect((await api("GET", route)).connections.filter((connection: { instanceId: string }) => [a.instanceId, b.instanceId].includes(connection.instanceId))).toHaveLength(2);
    sse = await openSse(`${fixture.info.url}/api/events`);
    await api("POST", `/api/bots/${botA.id}/tasks/${botA.threadId}`);
    await api("POST", `/api/bots/${botA.id}/messages`, { text: "Reply after restart." });
    await sse.until((frame) => frame.kind === "message" && frame.threadId === botA.threadId && frame.message?.text === "First replied");
    await idle(botA.id);
    expect(first.requests.at(-1)?.key).toBe("Bearer fixture-first-rotated");
    const publicState = JSON.stringify([await api("GET", route), await api("GET", "/api/instances"), sse.frames]);
    for (const key of ["fixture-first-key", "fixture-first-rotated", "fixture-second-key"]) {
      expect(publicState).not.toContain(key);
      expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain(key);
    }
  } finally {
    sse.close();
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
  }
}, 60_000);

it("keeps external keys out of stored config and supports explicit keyless connections and safe deletion", async () => {
  const endpoint = await provider("Storage");
  onTestFinished(endpoint.close);
  const fixture = await launchVerificationServer();
  onTestFinished(() => fixture.close());
  const api = fixtureApi(fixture.info.url);
  const external = await api("POST", `${route}?secretStorage=external`, {
    displayName: "Desktop secret", url: endpoint.url, auth: "bearer", key: "fixture-external-key", model: "shared-model",
  });
  const disk = () => JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
  expect(disk().instances[external.instanceId].config).toMatchObject({ secretStorage: "external", auth: "bearer" });
  expect(JSON.stringify(disk())).not.toContain("fixture-external-key");
  const icon = { kind: "preset", preset: "openrouter" };
  await api("PATCH", `/api/instances/${external.instanceId}/icon`, { icon });
  await api("PATCH", `${editRoute(external.instanceId)}?secretStorage=external`, { displayName: "Renamed desktop secret" });
  expect(disk().instances[external.instanceId].icon).toEqual(icon);
  expect(JSON.stringify(disk())).not.toContain("fixture-external-key");
  await api("POST", `${route}/test`, { instanceId: external.instanceId, kind: "response" });
  expect(endpoint.requests.at(-1)?.key).toBe("Bearer fixture-external-key");
  const local = await api("POST", route, { displayName: "No authentication", url: endpoint.url, auth: "none", model: "shared-model" });
  const { connections } = await api("GET", route);
  expect(connections.find((connection: { instanceId: string }) => connection.instanceId === local.instanceId)).toMatchObject({ auth: "none", configured: true });
  await api("POST", `${route}/test`, { instanceId: local.instanceId, kind: "response" });
  expect(endpoint.requests.at(-1)?.key).toBe("");
  await api("DELETE", editRoute(local.instanceId), {});
  await api("DELETE", `${editRoute(external.instanceId)}?secretStorage=external`, {});
  expect(disk().instances[local.instanceId]).toBeUndefined();
  expect(disk().instances[external.instanceId]).toBeUndefined();
});
