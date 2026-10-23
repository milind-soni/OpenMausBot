// Files end to end: the full server as a Cloud home over its real HTTP boundary, and the desktop's Files service
// driving it, with the owner's pairing token standing in for the desktop window's Cloud cookie. No network.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCloudFilesService } from "../electron/cloud-sync.mjs";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const PC_ORIGIN = `https://${HOST}`;
const secret = randomBytes(32).toString("base64url");
let home: string;
let base: string;
let child: ChildProcess;
let log = "";
let ownerToken = "";

// Node 24-26's fetch (undici 7-8) does not resend a request whose kept-alive socket the server closed after 5 s idle,
// as the app's Chromium fetch does, and a Windows runner can stall this server past that: no request here reuses one.
const FRESH_CONNECTION = { connection: "close" } as const;
const ownerEdge = () => ({ host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", authorization: `Bearer ${ownerToken}`, ...FRESH_CONNECTION });

async function api(method: string, path: string, options: { body?: unknown; remote?: boolean; headers?: Record<string, string> } = {}) {
  const asOwner = !options.remote && ownerToken !== "";
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...FRESH_CONNECTION,
      ...(options.remote || asOwner ? { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } : {}),
      ...(asOwner ? { authorization: `Bearer ${ownerToken}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function ownerPairing(): Promise<string> {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const granted = await api("POST", "/api/cloud/pairing", { remote: true, headers: {
    "content-type": "application/json", "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
    "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body: JSON.parse(body) });
  return (await api("POST", "/api/auth/pair", { remote: true, body: { code: granted.body.code } })).body.token as string;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cloud-sync-e2e-"));
  const dataDir = join(home, ".openmausbot");
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
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: { driver: "claudeAgent", displayName: "Claude", config: { cli } },
    },
  }));
  mkdirSync(join(home, "web"));
  writeFileSync(join(home, "web", "index.html"), "<!doctype html><title>OpenMausBot</title>");
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH,
      ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: join(home, "web"),
      OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
      OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`, OMB_SYNC_ROOT: join(home, "Synced"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
    try { if ((await api("GET", "/api/health")).body?.pid === child.pid) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  ownerToken = await ownerPairing();
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

// The desktop's fetch, but over the test's loopback edge: the owner's pairing token stands in for the window's cookie.
const desktopFetch = (url: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  fetch(url.replace(PC_ORIGIN, base), { ...init, headers: { ...init.headers, ...ownerEdge() } });

function desktop(pcHome: string) {
  return createCloudFilesService({
    settingsFile: join(pcHome, "user", "settings.json"), stateFile: join(pcHome, "user", "state.db"),
    documentsDir: join(pcHome, "Documents"), localDataDir: join(pcHome, ".openmausbot"), homeDir: pcHome, platform: process.platform, hostname: "Ash-PC",
    cloudOrigin: () => PC_ORIGIN, fetch: desktopFetch as typeof fetch, trashItem: async (file: string) => rmSync(file), markDownloaded: async () => {},
    watch: () => () => {}, now: () => Date.now() + 60_000,
  });
}

it("shares a PC folder as a read-only copy: changes go to My Cloud, a bot's edit there is replaced, a delete goes to the trash", async () => {
  const pcHome = realpathSync(mkdtempSync(join(tmpdir(), "omb-files-pc-")));
  const project = join(pcHome, "Clients");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "brief.md"), "the brief");
  const created = await api("POST", "/api/bots", { body: { name: "Files fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const service = desktop(pcHome);
  try {
    await service.share(project);
    expect(service.state().shared.map((folder) => folder.status), JSON.stringify(service.state())).toEqual(["synced"]);
    const copy = join(home, "Synced", "Ash-PC", "Clients");
    expect(readFileSync(join(copy, "brief.md"), "utf8")).toBe("the brief");
    expect(statSync(join(copy, "brief.md")).mode & 0o222).toBe(0);
    // The Cloud bot is not pointed anywhere: it keeps its own folder.
    const bots = await api("GET", "/api/bots?messages=0");
    expect(bots.body.bots.find((bot: { id: string }) => bot.id === created.body.bot.id).cwd ?? null).toBe(null);

    chmodSync(join(copy, "brief.md"), 0o644);
    writeFileSync(join(copy, "brief.md"), "a bot's edit");
    writeFileSync(join(copy, "notes-by-a-bot.md"), "its own file");
    await service.pass();
    expect(readFileSync(join(copy, "brief.md"), "utf8")).toBe("the brief");
    expect(readFileSync(join(copy, "notes-by-a-bot.md"), "utf8")).toBe("its own file");
    expect(existsSync(join(project, "notes-by-a-bot.md"))).toBe(false);

    writeFileSync(join(project, "brief.md"), "v2");
    utimesSync(join(project, "brief.md"), new Date(Date.now() - 10_000), new Date(Date.now() - 5_000));
    await service.pass();
    expect(readFileSync(join(copy, "brief.md"), "utf8")).toBe("v2");

    rmSync(join(project, "brief.md"));
    await service.pass();
    // The only file gone: the person is asked first.
    expect(service.state().shared[0]!.status).toBe("confirm-deletes");
    await service.answerDeletes(service.state().shared[0]!.id, true);
    expect(existsSync(join(copy, "brief.md"))).toBe(false);
    expect((await api("GET", "/api/sync/trash")).body.entries.map((entry: { path: string }) => entry.path)).toContain("brief.md");
  } finally {
    service.close();
    rmSync(pcHome, { recursive: true, force: true });
  }
}, 60_000);

it("a bot's turn wakes the desktop, and its new work comes down to Documents/MausBot/<bot>/<conversation>", async () => {
  const pcHome = realpathSync(mkdtempSync(join(tmpdir(), "omb-files-pc-")));
  const created = await api("POST", "/api/bots", { body: { name: "Report Owl", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } });
  const bot = created.body.bot as { id: string; threadId: string };
  const service = desktop(pcHome);
  try {
    await service.pass();
    const output = join(home, ".openmausbot", "task-workspaces", bot.id, bot.threadId);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "report.md"), "# Q3");
    const later = new Date(Date.now() + 120_000);
    utimesSync(join(output, "report.md"), later, later);
    // A turn ending on My Cloud is what tells the desktop's long poll.
    const headers = ownerEdge();
    const { cursor } = await (await fetch(`${base}/api/sync/changes?cursor=0&waitMs=0`, { headers })).json() as { cursor: number };
    const woken = fetch(`${base}/api/sync/changes?cursor=${cursor}&waitMs=20000`, { headers }).then((response) => response.json() as Promise<{ folderIds: string[] }>);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { body: { text: "write the report" } })).status).toBe(202);
    expect((await woken).folderIds).toContain(`bot-${bot.id}-${bot.threadId}`);
    await service.pass();
    const owl = join(pcHome, "Documents", "MausBot", "Report Owl");
    const [conversation] = readdirSync(owl);
    expect(readFileSync(join(owl, conversation!, "report.md"), "utf8")).toBe("# Q3");
  } finally {
    service.close();
    rmSync(pcHome, { recursive: true, force: true });
  }
}, 60_000);

it("a desktop's open long poll does not block a backup or a restore on My Cloud", async () => {
  const headers = ownerEdge();
  const { cursor } = await (await fetch(`${base}/api/sync/changes?cursor=0&waitMs=0`, { headers })).json() as { cursor: number };
  const poll = fetch(`${base}/api/sync/changes?cursor=${cursor}&waitMs=5000`, { headers }).then((response) => response.json());
  await new Promise((resolve) => setTimeout(resolve, 200));
  const backup = await api("POST", "/api/workspace-backup/export", { body: { password: "correct horse battery staple" } });
  expect(backup.status, JSON.stringify(backup.body)).not.toBe(409);
  await poll;
}, 30_000);
