// Real server, the repository's fake ACP engine holding a room's first turn until it is stopped.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

it("stops a room's turn once per stopId: a resent Stop leaves the turn that started since running", async () => {
  const fixture = await launchVerificationServer();
  const { dataDir, url, logPath } = fixture.info;
  const held = join(dataDir, "first-prompt-held");
  const gate = join(dataDir, "second-prompt-gate");
  const secondStarted = join(dataDir, "second-prompt-started");
  let server: ChildProcess | undefined;
  let stream: Awaited<ReturnType<typeof openSse>> | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.droid = {
      driver: "droidAgent", displayName: "Droid fixture",
      config: { cli: fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)) },
      environment: {
        FACTORY_API_KEY: "fixture-only", FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: gate, FAKE_ACP_STARTED_FILE: secondStarted,
        FAKE_ACP_HANG_ON: "Hold this one", FAKE_ACP_HANG_ONCE_FILE: held, FAKE_ACP_CANCEL_STOP_REASON: "end_turn",
      },
    };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    stream = await openSse(`${url}/api/events`, { origin: url });

    const droid = ((await api("GET", "/api/instances")).instances as any[]).find((instance) => instance.instanceId === "droid");
    const { bot } = await api("POST", "/api/bots", { name: "Stopper", modelSelection: { instanceId: "droid", model: droid.models.default } }, 201);
    const { group } = await api("POST", "/api/groups", { name: "Stop room", memberIds: [bot.id] }, 201);
    await api("PATCH", `/api/groups/${group.id}/setup`, { action: "complete", cwd: null, bulletin: "", defaultResponder: { kind: "member", botId: bot.id } });
    const threadId = group.threadId;
    await api("POST", `/api/groups/${group.id}/messages`, { threadId, text: "Hold this one, please." }, 202);
    await expect.poll(() => existsSync(held), { timeout: 20_000 }).toBe(true);
    const first = (await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.started" && frame.event.threadId === threadId)).event.turnId;

    const stopId = "stop_room_0123456789abcdef";
    await api("POST", `/api/groups/${group.id}/interrupt`, { threadId, stopId });
    await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.completed" && frame.event.turnId === first);
    await expect.poll(async () => (await api("GET", "/api/bots")).groups.find((room: any) => room.id === group.id)?.working ?? false, { timeout: 20_000 }).toBe(false);

    await api("POST", `/api/groups/${group.id}/messages`, { threadId, text: "Second message" }, 202);
    await expect.poll(() => existsSync(secondStarted), { timeout: 20_000 }).toBe(true);
    const second = (await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.started"
      && frame.event.threadId === threadId && frame.event.turnId !== first)).event.turnId;

    // The phone's connection died before it read the answer, so it sends the same Stop again.
    expect(await api("POST", `/api/groups/${group.id}/interrupt`, { threadId, stopId })).toEqual({ ok: true });
    writeFileSync(gate, "go");
    const done = await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.completed" && frame.event.turnId === second);
    expect(done.event.stopReason, "the resent Stop cancelled the second turn").not.toBe("cancelled");
    await expect.poll(async () => (await messages(threadId)).some((message) => message.kind === "text" && /^echo: .*Second message/s.test(message.text ?? "")), { timeout: 20_000 }).toBe(true);

    expect(await api("POST", `/api/groups/${group.id}/interrupt`, { threadId, stopId: "not an id" }, 400)).toEqual({ error: "stopId must be a client-generated id" });
  } finally {
    stream?.close();
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);
