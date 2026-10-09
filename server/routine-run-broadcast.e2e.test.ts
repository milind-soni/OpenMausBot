// A scheduled run's task, as a phone's event stream sees it, through the real
// server. The frame announcing the run's task used to carry the bot's whole
// active transcript; past the phone sidecar's 4 MiB event ceiling that ended
// the stream, and resuming from the cursor replayed the same frame forever —
// "loses connection about once an hour" with an hourly routine (MOCA-179).
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionRegistry } from "./sessions.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 28800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = "owner@example.test";
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let log = "";
let token = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function waitFor<T>(read: () => Promise<T | null | undefined> | T | null | undefined, ms = 30_000): Promise<T | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** The live event stream, parsed frame by frame. */
function openStream() {
  const controller = new AbortController();
  const frames: any[] = [];
  const state: { hello: any } = { hello: null };
  void (async () => {
    try {
      const res = await fetch(`${BASE}/api/events`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const frame = JSON.parse(line.slice(6));
            if (frame.kind === "hello") state.hello = frame;
            else if (frame.kind !== "ping") frames.push(frame);
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { frames, ready: () => waitFor(() => state.hello, 10_000), close: () => controller.abort() };
}

posixOnly("a routine run's task on the event stream", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-routine-broadcast-"));
    const data = join(home, ".openmausbot");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({
      signIn: { admins: [OWNER], members: [] },
      instances: { grok: { driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: false } } },
    }));
    const registry = new SessionRegistry({ file: join(data, "sessions.json"), emailScopes: () => ["admin", "client"] });
    token = registry.issue({ label: "Owner's laptop", email: OWNER, scopes: ["admin", "client"] }).token;
    registry.close();

    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home, OMB_PORT: String(PORT), OMB_WEBHOOK_PORT: String(PORT + 1),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (c) => (log += c));
    child.stderr!.on("data", (c) => (log += c));
    const up = await waitFor(async () => {
      try {
        return (await fetch(`${BASE}/api/health`)).ok;
      } catch {
        return false;
      }
    }, 20_000);
    if (!up) throw new Error(`server never came up:\n${log}`);
  }, 40_000);

  afterAll(async () => {
    child?.kill();
    if (child) await waitForExit(child);
    if (home) await removeTempDir(home);
  });

  it("announces the run's task without the bot's transcript", async () => {
    const created = await api("POST", "/api/bots", { name: "Report Otter" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "grok", model: "fake-model" } })).status).toBe(200);
    // Something in the active conversation for the frame to have carried.
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Summarise the week", threadId: bot.threadId })).status).toBe(202);
    const replied = await waitFor(async () => {
      const { body } = await api("GET", `/api/threads/${bot.threadId}/messages`);
      return (body.messages ?? []).some((m: any) => m.role === "bot" && m.text) ? true : null;
    });
    expect(replied, log.slice(-2_000)).toBe(true);

    const routine = await api("POST", "/api/routines", {
      name: "Hourly report", botId: bot.id, prompt: "Write the report.", enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 86_400_000 },
    });
    expect(routine.status, JSON.stringify(routine.body)).toBe(201);

    const stream = openStream();
    try {
      expect(await stream.ready()).not.toBeNull();
      expect((await api("POST", `/api/routines/${routine.body.routine.id}/run`)).status).toBeLessThan(300);

      // Once the run has finished, every frame its task produced has been sent.
      const finished = await waitFor(() => stream.frames.find((frame) =>
        frame.kind === "routine.run" && ["completed", "failed"].includes(frame.run?.status)));
      expect(finished, log.slice(-2_000)).not.toBeNull();
      const botFrames = stream.frames.filter((frame) => frame.kind === "bot" && frame.bot?.id === bot.id);
      // The run's task did reach the stream...
      expect(Math.max(...botFrames.map((frame) => (frame.bot.tasks ?? []).length))).toBeGreaterThan(1);
      // ...and no frame for it carried the transcript, which stays where it was.
      expect(botFrames.filter((frame) => "messages" in frame.bot)).toEqual([]);
      expect(botFrames.every((frame) => frame.bot.threadId === bot.threadId)).toBe(true);
    } finally {
      stream.close();
    }
  }, 60_000);
});
