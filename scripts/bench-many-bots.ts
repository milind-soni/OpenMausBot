// A real server from source in a temporary home, driven by the repository's fake Claude engine: many bots, each with
// many threads, are sent work at once. Reports send-to-start latency, stream volume, health stalls and what the
// server's own diagnostics say. No AI account is used and no user data is touched.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { arch, availableParallelism, platform } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { launchRestartableServer } from "../server/testing/restartable-server.ts";

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
};
const BOTS = Number(arg("bots", "34")), THREADS = Number(arg("threads", "200")), ROUNDS = Number(arg("rounds", "3"));
/** What the measuring client tells the server it understands: "whole" is a client from before thread frames. */
const FRAMES = arg("frames", "whole");
const quantile = (values: number[], q: number): number | null => values.length
  ? Math.round([...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]!) : null;

const WAIT_MS = Number(arg("wait", "90")) * 1_000;

const server = await launchRestartableServer();
for (const signal of ["SIGINT", "SIGTERM", "SIGALRM"] as const) process.once(signal, () => { void server.close().finally(() => process.exit(1)); });
const api = async (method: string, path: string, body?: unknown): Promise<any> => {
  const response = await fetch(`${server.url}${path}`, { method, headers: { "content-type": "application/json", origin: server.url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

try {
  const botIds: string[] = [];
  for (let i = 0; i < BOTS; i++) botIds.push((await api("POST", "/api/bots", { name: `Bench ${i + 1}` })).bot.id);
  for (const botId of botIds) await api("POST", `/api/bots/${botId}/tasks`, { title: "Bench thread" });
  await server.stop();
  const botsFile = join(server.dataDir, "bots.json");
  const bots = JSON.parse(readFileSync(botsFile, "utf8")) as Array<{ id: string; tasks: Array<Record<string, unknown>> }>;
  const targets = new Map<string, string>();
  for (const bot of bots) {
    const template = bot.tasks[0]!;
    targets.set(bot.id, String(template.threadId));
    for (let i = bot.tasks.length; i < THREADS; i++) {
      bot.tasks.push({ ...template, id: randomUUID(), threadId: randomUUID(), title: `Synthetic thread ${i} with a title of ordinary length`,
        usage: { inputTokens: 120_000 + i, outputTokens: 4_000 + i, cachedInputTokens: 90_000, contextTokens: 60_000 } });
    }
  }
  const bytesOnDisk = Buffer.byteLength(JSON.stringify(bots));
  writeFileSync(botsFile, JSON.stringify(bots));
  await server.start();

  const started = new Map<string, number>(), completed = new Set<string>();
  const stream = { bytes: 0, reconnects: 0, snapshots: 0, snapshotBytes: 0, byKind: new Map<string, { frames: number; bytes: number }>() };
  const abort = new AbortController();
  /** Reads the stream as EventSource does: when the server ends it, connect again from the last id, and load everything
   * again when the server says it could not resume. */
  void (async () => {
    const decoder = new TextDecoder();
    let cursor = "";
    while (!abort.signal.aborted) {
      try {
        const query = `window=1${FRAMES === "whole" ? "" : `&frames=${FRAMES}`}${cursor ? `&since=${encodeURIComponent(cursor)}` : ""}`;
        const events = await fetch(`${server.url}/api/events?${query}`, { headers: { origin: server.url }, signal: abort.signal });
        let buffered = "";
        for await (const chunk of events.body as unknown as AsyncIterable<Uint8Array>) {
          stream.bytes += chunk.byteLength;
          buffered += decoder.decode(chunk, { stream: true });
          for (let end = buffered.indexOf("\n\n"); end >= 0; end = buffered.indexOf("\n\n")) {
            const block = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            const lines = block.split("\n");
            const id = lines.find(line => line.startsWith("id: "));
            if (id) cursor = id.slice(4);
            const data = lines.find(line => line.startsWith("data: "));
            if (!data) continue;
            const frame = JSON.parse(data.slice(6)) as { kind?: string; resumed?: boolean; cursor?: string; event?: { type?: string; threadId?: string } };
            const kind = String(frame.kind);
            const tally = stream.byKind.get(kind) ?? { frames: 0, bytes: 0 };
            tally.frames += 1; tally.bytes += Buffer.byteLength(block) + 2;
            stream.byKind.set(kind, tally);
            if (kind === "hello" && frame.cursor) {
              if (cursor && frame.resumed === false) {
                const snapshot = await fetch(`${server.url}/api/bots?messages=0`, { headers: { origin: server.url }, signal: abort.signal });
                const body = await snapshot.arrayBuffer();
                stream.snapshots += 1; stream.snapshotBytes += body.byteLength;
                for (const bot of (JSON.parse(decoder.decode(body)) as { bots: Array<{ tasks?: Array<{ threadId: string; busy?: boolean }> }> }).bots) {
                  for (const task of bot.tasks ?? []) if (started.has(task.threadId) && !task.busy) completed.add(task.threadId);
                }
              }
              if (!cursor || frame.resumed === false) cursor = frame.cursor;
            }
            const threadId = frame.event?.threadId;
            if (kind === "runtime" && threadId && frame.event?.type === "turn.started" && !started.has(threadId)) started.set(threadId, performance.now());
            if (kind === "runtime" && threadId && frame.event?.type === "turn.completed") completed.add(threadId);
          }
        }
      } catch { /* closed: by abort, or by the server */ }
      if (abort.signal.aborted) break;
      stream.reconnects += 1;
      await delay(250);
    }
  })();

  const health: number[] = [];
  let probing = true;
  const probe = (async () => {
    while (probing) {
      const at = performance.now();
      try { await fetch(`${server.url}/api/health`, { signal: AbortSignal.timeout(20_000) }); } catch { /* counted as its duration */ }
      health.push(performance.now() - at);
      await delay(20);
    }
  })();

  await delay(1_000);
  console.log(JSON.stringify({ benchmark: "many-bots", node: process.version, platform: platform(), arch: arch(), cpus: availableParallelism(),
    bots: BOTS, threadsPerBot: THREADS, clientFrames: FRAMES, botsJsonBytes: bytesOnDisk,
    scope: "Real server from source with the fake Claude engine; each round sends one message to every bot at once. Not model throughput." }));
  for (let round = 1; round <= ROUNDS; round++) {
    started.clear(); completed.clear(); health.length = 0;
    const bytesBefore = stream.bytes + stream.snapshotBytes, reconnectsBefore = stream.reconnects, kindsBefore = new Map([...stream.byKind].map(([kind, tally]) => [kind, { ...tally }]));
    const sent = new Map<string, number>();
    const roundStart = performance.now();
    await Promise.all(botIds.map(async (botId) => {
      const threadId = targets.get(botId)!;
      sent.set(threadId, performance.now());
      await api("POST", `/api/bots/${botId}/messages`, { text: `Round ${round}: reply with one line.`, threadId });
    }));
    const deadline = Date.now() + WAIT_MS;
    while (completed.size < BOTS && Date.now() < deadline) await delay(25);
    const roundMs = Math.round(performance.now() - roundStart);
    // A stream the server cut and could not resume misses turn events: ask the server what finished.
    const seenOnStream = completed.size;
    if (seenOnStream < BOTS) {
      const wanted = new Set(targets.values());
      for (const bot of (await api("GET", "/api/bots?messages=0")).bots as Array<{ tasks?: Array<{ threadId: string; busy?: boolean }> }>) {
        for (const task of bot.tasks ?? []) if (wanted.has(task.threadId) && !task.busy) completed.add(task.threadId);
      }
    }
    await delay(1_500);
    const toStart = [...sent].flatMap(([threadId, at]) => started.has(threadId) ? [started.get(threadId)! - at] : []);
    const bot = stream.byKind.get("bot"), botBefore = kindsBefore.get("bot");
    console.log(JSON.stringify({ round, turnsCompleted: completed.size, turnEndsSeenOnStream: seenOnStream, roundMs,
      sendToStartP50Ms: quantile(toStart, .5), sendToStartP95Ms: quantile(toStart, .95), sendToStartMaxMs: quantile(toStart, 1),
      streamKbPerTurn: Math.round((stream.bytes + stream.snapshotBytes - bytesBefore) / 1024 / BOTS), streamCutByServer: stream.reconnects - reconnectsBefore, botFramesPerTurn: Number((((bot?.frames ?? 0) - (botBefore?.frames ?? 0)) / BOTS).toFixed(1)),
      botFrameKbPerTurn: Math.round(((bot?.bytes ?? 0) - (botBefore?.bytes ?? 0)) / 1024 / BOTS),
      healthP95Ms: quantile(health, .95), healthMaxMs: quantile(health, 1) }));
  }
  probing = false;
  await probe;
  const perf = await api("GET", "/api/diagnostics/performance").catch((error) => ({ error: String(error) }));
  console.log(JSON.stringify({ diagnostics: perf }).slice(0, 6_000));
  const botsBody = await fetch(`${server.url}/api/bots`, { headers: { origin: server.url } });
  console.log(JSON.stringify({ getBotsBytes: (await botsBody.arrayBuffer()).byteLength }));
  abort.abort();
} finally {
  await server.close();
}
