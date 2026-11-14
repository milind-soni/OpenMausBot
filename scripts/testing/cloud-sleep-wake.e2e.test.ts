// The page of a Cloud home on a plan that sleeps, against a real Cloud-mode server whose idle windows are a quarter
// second: the home agrees to sleep, the person clicks Wake it now, and the page stays awake and shows the bot's reply.
// A disposable home and a synthetic Claude CLI; nothing leaves loopback.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { cloudPairingSignature, cloudRequestSignature } from "../../server/cloud-home.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { hostTimeout } from "../../server/testing/host-timeout.ts";
import { freePortBlock } from "../../server/testing/ports.ts";
import { openSse } from "../../server/testing/sse.ts";
import { cloudAsleep, markCloudAwake, resetCloudPowerForTests } from "../../src/lib/cloud-power.ts";
import { openLiveEvents, type LiveEventSourceLike, type LiveFrame } from "../../src/lib/live-events.ts";

const SERVER_DIR = fileURLToPath(new URL("../../server/", import.meta.url));
const HOST = "omb-t-7c6b5a4d3e2f.fly.dev";
const MACHINE = "5c9e3d2f-0b8a-4f7e-9d6c-2b3c4d5e6f70";
const EDGE = { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` };
const secret = randomBytes(32).toString("base64url");
const realFetch = globalThis.fetch;
let home = "", base = "", log = "", token = "";
let child: ChildProcess | undefined;

const person = () => ({ ...EDGE, authorization: `Bearer ${token}` });

async function api(method: string, path: string, body?: unknown) {
  const response = await realFetch(`${base}${path}`, {
    method,
    headers: { ...person(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

/** The Admin's signed call: its power read, and its sleep request. */
async function admin(method: "GET" | "POST", path: string, body = "") {
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await realFetch(`${base}${path}`, {
    method,
    body: method === "POST" ? body : undefined,
    headers: {
      ...EDGE, ...(method === "POST" ? { "content-type": "application/json" } : {}),
      "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
      "x-omb-cloud-signature": `v1=${cloudRequestSignature(secret, timestamp, nonce, method, path, body)}`,
    },
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

/** A browser's EventSource over fetch: an `id:` line sets the last event id, which frames without one keep. */
function browserEventSource(url: string) {
  const abort = new AbortController();
  const source: LiveEventSourceLike & { url: string; heard: string[] } = {
    url, heard: [], onopen: null, onerror: null, onmessage: null, close: () => abort.abort(),
  };
  void (async () => {
    let lastEventId = "";
    try {
      const response = await realFetch(`${base}${url}`, { headers: { ...person(), accept: "text/event-stream" }, signal: abort.signal });
      if (!response.ok || !response.body) throw new Error(`events answered ${response.status}`);
      source.onopen?.();
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of response.body) {
        buffered += decoder.decode(chunk, { stream: true });
        for (let end = buffered.indexOf("\n\n"); end !== -1; end = buffered.indexOf("\n\n")) {
          const lines = buffered.slice(0, end).split("\n");
          buffered = buffered.slice(end + 2);
          for (const line of lines) if (line.startsWith("id: ")) lastEventId = line.slice(4);
          const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (!data) continue;
          source.heard.push(String(JSON.parse(data).kind));
          source.onmessage?.({ data, lastEventId });
        }
      }
      throw new Error("events ended");
    } catch {
      if (!abort.signal.aborted) source.onerror?.();
    }
  })();
  return source;
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  home = mkdtempSync(join(tmpdir(), "omb-cloud-sleep-wake-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: { claude: { driver: "claudeAgent", displayName: "Fixture", config: { cli: join(SERVER_DIR, "testing", "fake-claude-cli.ts") } } },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offline, "--import", new URL("../../server/testing/power-clock-hooks.mjs", import.meta.url).href, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMB_DATA_DIR: home, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: MACHINE, OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`, FAKE_CLAUDE_MODE: "happy",
      OMB_TEST_POWER_CLOCK: "1", OMB_SSE_HEARTBEAT_MS: "250",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try { if ((await realFetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the server did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const granted = await (await realFetch(`${base}/api/cloud/pairing`, { method: "POST", body, headers: {
    ...EDGE, "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  } })).json() as { code: string };
  token = (await api("POST", "/api/auth/pair", { code: granted.code })).body.token;
}, hostTimeout(60_000));

afterAll(async () => {
  vi.unstubAllGlobals();
  resetCloudPowerForTests();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
  vi.restoreAllMocks();
});

it("after Wake it now the page stays awake, the home's pending sleep ends, and the bot's reply shows", async () => {
  const bot = (await api("POST", "/api/bots", { name: "Wren", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  expect(bot?.id, log.slice(-2000)).toBeTruthy();

  // The page's own requests go where a browser sends them, with its session.
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => realFetch(
    typeof input === "string" && input.startsWith("/") ? `${base}${input}` : input,
    { ...init, headers: { ...person(), ...Object.fromEntries(new Headers(init?.headers)) } },
  ));
  const sources: ReturnType<typeof browserEventSource>[] = [];
  const frames: LiveFrame[] = [];
  const stop = openLiveEvents({ onFrame: (frame) => frames.push(frame), onSnapshotRequired: async () => true }, {
    createEventSource: (url) => { const source = browserEventSource(url); sources.push(source); return source; },
    isVisible: () => true, isOnline: () => true, now: Date.now,
  });
  try {
    await expect.poll(() => sources[0]?.heard.includes("ping")).toBe(true);
    const before = await openSse(`${base}/api/events`, person());
    const cursor = (await before.until((frame) => frame.kind === "hello")).cursor as string;
    before.close();

    let answer = await admin("POST", "/api/cloud/power/sleep", JSON.stringify({ v: 1 }));
    for (const deadline = Date.now() + 20_000; answer.status !== 200 && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      answer = await admin("POST", "/api/cloud/power/sleep", JSON.stringify({ v: 1 }));
    }
    expect(answer, log.slice(-2000)).toMatchObject({ status: 200, body: { ok: true } });
    await expect.poll(cloudAsleep, { timeout: 5_000 }).toBe(true);
    expect((await admin("GET", "/api/cloud/power")).body.sleeping).toBe(true);

    // The person clicks Wake it now.
    markCloudAwake();
    await expect.poll(() => sources.length).toBe(2);
    await expect.poll(() => cloudAsleep() || sources[1].heard.includes("ping"), { timeout: 5_000 }).toBe(true);
    expect(cloudAsleep(), "the page fell back asleep on waking").toBe(false);
    await expect.poll(async () => (await admin("GET", "/api/cloud/power")).body.sleeping, { timeout: 5_000 }).toBe(false);

    // Any stream resuming from before the sleep gets everything since, with no gap, but not the sleeping frame.
    const resumed = await openSse(`${base}/api/events?since=${encodeURIComponent(cursor)}`, person());
    expect(await resumed.until((frame) => frame.kind === "hello")).toMatchObject({ resumed: true });
    await resumed.until((frame) => frame.kind === "ping");
    resumed.close();
    expect(resumed.frames.filter((frame) => frame.kind === "power"), "a resuming stream was told the home is going to sleep").toEqual([]);

    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Are you there?", threadId: bot.threadId })).status).toBe(202);
    await expect.poll(() => frames.some((frame) => frame.kind === "message" && (frame as { message?: { role?: string } }).message?.role === "bot"), { timeout: 30_000 }).toBe(true);
    expect(cloudAsleep()).toBe(false);
  } finally {
    stop();
  }
}, hostTimeout(90_000));
