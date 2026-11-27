// Real server, the repository's fake ACP engine answering Stop the way OpenCode does (end_turn, no reply).
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { PERSON_STOPPED_TURN_NAME } from "../shared/client-cancel.ts";
import { failedTurnCause } from "../shared/failed-turn.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

it("ends a stopped turn with one quiet stop, keeps what it said, and a second Stop on it leaves the queued message running", async () => {
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
    // Says half an answer, then goes silent until stopped.
    config.instances["droid-partial"] = {
      ...config.instances.droid,
      environment: { FACTORY_API_KEY: "fixture-only", FAKE_ACP_MODE: "stall-after-text", FAKE_ACP_CANCEL_STOP_REASON: "end_turn" },
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
    const threadId = bot.threadId;
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "Hold this one, please." }, 202);
    await expect.poll(() => existsSync(held), { timeout: 20_000 }).toBe(true);
    const first = (await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.started" && frame.event.threadId === threadId)).event.turnId;
    const queued = await api("POST", `/api/bots/${bot.id}/messages`, { threadId, text: "Second message" }, 202);
    expect(queued).toMatchObject({ queued: true });

    // The first Stop names the turn the person saw.
    await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId, turnId: first });
    await expect.poll(() => existsSync(secondStarted), { timeout: 20_000 }).toBe(true);
    const second = (await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.started"
      && frame.event.threadId === threadId && frame.event.turnId !== first)).event.turnId;
    // The double click's second Stop names the same, finished turn: the queued message must keep running.
    expect(await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId, turnId: first })).toEqual({ ok: true, outcome: "already-stopped" });
    writeFileSync(gate, "go");
    await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "turn.completed" && frame.event.turnId === second);
    await expect.poll(async () => (await messages(threadId)).some((message) => message.kind === "text" && /^echo: .*Second message/s.test(message.text ?? "")), { timeout: 20_000 }).toBe(true);

    const rows = await messages(threadId);
    const stops = rows.filter((message) => message.kind === "activity" && message.tool?.name?.startsWith("stopped:"));
    expect(stops).toEqual([expect.objectContaining({ turnId: first, tool: { name: PERSON_STOPPED_TURN_NAME, ok: true } })]);
    expect(rows.filter((message) => message.tool && failedTurnCause(message.tool.name) !== null)).toEqual([]);
    expect(rows.find((message) => message.role === "user" && message.text === "Second message")?.requestCancelled).toBeUndefined();

    // A Stop after half an answer: the chat keeps the words, and so does the turn's digest.
    const partial = (await api("POST", "/api/bots", { name: "Halfway", modelSelection: { instanceId: "droid-partial", model: droid.models.default } }, 201)).bot;
    await api("POST", `/api/bots/${partial.id}/messages`, { threadId: partial.threadId, text: "Start, then stall." }, 202);
    const halfway = (await stream.until((frame) => frame.kind === "runtime" && frame.event?.type === "content.delta"
      && frame.event.threadId === partial.threadId)).event.turnId;
    await api("POST", `/api/bots/${partial.id}/interrupt`, { threadId: partial.threadId, turnId: halfway });
    const digest = await expect.poll(async () => (await messages(partial.threadId)).find((message) => message.kind === "digest"), { timeout: 20_000 }).toBeTruthy()
      .then(async () => (await messages(partial.threadId)).find((message) => message.kind === "digest"));
    expect(JSON.stringify(digest.digest)).toContain("half an answer, then silence");
    const after = await messages(partial.threadId);
    expect(after.filter((message) => message.tool?.name === PERSON_STOPPED_TURN_NAME)).toHaveLength(1);
    expect(after.some((message) => message.kind === "text" && message.text === "half an answer, then silence")).toBe(true);
  } finally {
    stream?.close();
    if (server) await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);
