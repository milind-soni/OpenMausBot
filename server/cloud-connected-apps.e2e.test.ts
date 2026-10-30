// The full server as a Cloud home, from boot to Connected apps: it registers its own installation with the connected-apps
// service (a local stand-in), keeps it across a restart, and serves the service's whole catalog. Disposable home; every
// other request is offline.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloudPairingSignature } from "./cloud-home.ts";
import { CLOUD_CONNECTED_APPS_FILE } from "./cloud-connected-apps.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
const brokerToken = randomBytes(32).toString("hex");
const CATALOG = ["outlook", "linkedin", "calendly", "gmail", "slack"];

let broker: Server;
let brokerUrl = "";
const brokerCalls: { method: string; path: string; bearer: string }[] = [];
let registrationOpen = true;
let home: string;
let dataDir: string;
let base: string;
let port: number;
let child: ChildProcess | null = null;
let log = "";
let ownerToken = "";

async function api(method: string, path: string, options: { body?: unknown; remote?: boolean; headers?: Record<string, string> } = {}) {
  const asOwner = !options.remote && ownerToken !== "";
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.remote || asOwner ? { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } : {}),
      ...(asOwner ? { authorization: `Bearer ${ownerToken}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function boot(): Promise<void> {
  // Offline but for the stand-in service, so the server reaches nothing else.
  const prelude = `data:text/javascript,${encodeURIComponent(`const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  return url.startsWith(${JSON.stringify(`${brokerUrl}/`)}) ? real(input, init) : new Response("offline fixture", { status: 503 });
};`)}`;
  child = spawn(process.execPath, ["--import", prelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH,
      ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: join(home, "web"),
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
      // From source the server registers nowhere unless told where, as here.
      OMB_COMPOSIO_BROKER_URL: brokerUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const started = child;
  started.stdout?.on("data", (chunk) => { log += chunk; });
  started.stderr?.on("data", (chunk) => { log += chunk; });
  // A bare local request (no owner yet): health answers it with the pid.
  ownerToken = "";
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (started.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
    try { if ((await api("GET", "/api/health")).body?.pid === started.pid) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const granted = await api("POST", "/api/cloud/pairing", { remote: true, headers: {
    "content-type": "application/json", "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
    "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body: JSON.parse(body) });
  ownerToken = (await api("POST", "/api/auth/pair", { remote: true, body: { code: granted.body.code } })).body.token as string;
}

async function catalog() {
  let reply: Awaited<ReturnType<typeof api>> | undefined;
  await expect.poll(async () => {
    reply = await api("GET", "/api/connectors/catalog");
    return reply.body?.mode;
  }, { timeout: 15_000, interval: 150 }).toBe("managed");
  return reply!.body;
}

beforeAll(async () => {
  broker = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://broker.test");
    const bearer = String(req.headers.authorization ?? "");
    brokerCalls.push({ method: req.method ?? "", path: url.pathname, bearer });
    const send = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
    req.resume();
    req.on("end", () => {
      if (req.method === "POST" && url.pathname === "/v1/installations") {
        return registrationOpen ? send(201, { installationId: "install-cloud", token: brokerToken }) : send(503, { error: "registration is temporarily closed" });
      }
      if (bearer !== `Bearer ${brokerToken}`) return send(401, { error: "unauthorized" });
      if (req.method === "GET" && url.pathname === "/v1/me") return send(200, { installationId: "install-cloud" });
      if (req.method === "GET" && url.pathname === "/v1/catalog") {
        return send(200, {
          items: CATALOG.map((slug) => ({ slug, name: slug, meta: { description: `${slug} tools`, logo: "" } })),
          total_items: CATALOG.length, current_page: 1, total_pages: 1,
        });
      }
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  brokerUrl = `http://127.0.0.1:${(broker.address() as AddressInfo).port}`;

  home = mkdtempSync(join(tmpdir(), "omb-cloud-connected-apps-"));
  dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  const cli = join(home, "fixture-claude.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" }));
  process.exit(0);
}
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
    },
  }));
  mkdirSync(join(home, "web"));
  writeFileSync(join(home, "web", "index.html"), "<!doctype html><title>OpenMausBot</title>");
  port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  await boot();
}, 45_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (broker) await new Promise<void>((resolve) => broker.close(() => resolve()));
  if (home) await removeTempDir(home);
});

describe("connected apps on a Cloud home", { timeout: 90_000 }, () => {
  it("come included: the Cloud registers itself and serves the service's whole catalog, with no key to add", async () => {
    const body = await catalog();
    expect(body).toMatchObject({ configured: true, mode: "managed", setup: "ready", source: "api" });
    expect(body.cards.map((card: { slug: string }) => card.slug)).toEqual(expect.arrayContaining(["outlook", "linkedin", "calendly"]));
    expect((await api("GET", "/api/config")).body.composio).toEqual({ configured: true, mode: "managed" });
    expect(brokerCalls.filter((call) => call.path === "/v1/installations")).toHaveLength(1);
    expect(brokerCalls).toContainEqual({ method: "GET", path: "/v1/catalog", bearer: `Bearer ${brokerToken}` });
  });

  it("keeps the token on the volume only, owner-only, and never in a log, a reply or config.json", async () => {
    const file = join(dataDir, CLOUD_CONNECTED_APPS_FILE);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, brokerUrl, installationId: "install-cloud", token: brokerToken });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dataDir, "config.json"), "utf8")).not.toContain(brokerToken);
    expect(JSON.stringify((await api("GET", "/api/config")).body)).not.toContain(brokerToken);
    expect(log).toContain("connected-apps installation registered");
    expect(log).not.toContain(brokerToken);
  });

  it("after a restart uses the same installation: it checks the token and registers nothing new", async () => {
    await waitForExit(child!, { signal: "SIGTERM" });
    child = null;
    const before = brokerCalls.length;
    await boot();
    const body = await catalog();
    expect(body).toMatchObject({ configured: true, mode: "managed", setup: "ready" });
    const since = brokerCalls.slice(before);
    expect(since).toContainEqual({ method: "GET", path: "/v1/me", bearer: `Bearer ${brokerToken}` });
    expect(since.filter((call) => call.path === "/v1/installations")).toEqual([]);
    expect(brokerCalls.filter((call) => call.path === "/v1/installations")).toHaveLength(1);
  });

  it("while the service will not register it, still starts, and says the included service is unavailable instead of asking for a key", async () => {
    await waitForExit(child!, { signal: "SIGTERM" });
    child = null;
    rmSync(join(dataDir, CLOUD_CONNECTED_APPS_FILE));
    registrationOpen = false;
    const before = brokerCalls.filter((call) => call.path === "/v1/installations").length;
    await boot();
    await expect.poll(() => brokerCalls.filter((call) => call.path === "/v1/installations").length, { timeout: 15_000 }).toBe(before + 1);
    await expect.poll(() => log.includes("connected-apps registration failed: registration is temporarily closed"), { timeout: 15_000 }).toBe(true);
    const reply = await api("GET", "/api/connectors/catalog");
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ configured: false, mode: "unavailable", setup: "service-unavailable" });
  });
});
