// Lent folders while the computer is away, end to end: the full server as a Cloud home over its real HTTP boundary, the
// desktop's lending connector and Files service driving it (the owner's pairing token stands in for the window's Cloud
// cookie), and a bot's real agents MCP tools. The Mac lends a folder with editing, goes away, the bot reads the folder
// from the Cloud's copy and saves changes there, the Mac comes back, and the changes land: one the person also edited
// keeps both versions. No network, a fake model.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createComputerSharing, validateSharedFolders } from "../electron/computer-sharing.mjs";
import { createCloudFilesService } from "../electron/cloud-sync.mjs";
import { lendingForFiles } from "../electron/lent-folders.mjs";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const PC_ORIGIN = `https://${HOST}`;
const secret = randomBytes(32).toString("base64url");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
let home: string;
let base: string;
let child: ChildProcess;
let proxy: ChildProcess | undefined;
let log = "";
let ownerToken = "";

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
  home = mkdtempSync(join(tmpdir(), "omb-lent-e2e-"));
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
      ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
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
      // The bot's turn stays open, so its agents tools stay usable; the dump says how to reach them.
      FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: join(home, "fake-claude-dump.json"),
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
  proxy?.kill();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const desktopFetch = (url: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  fetch(url.replace(PC_ORIGIN, base), { ...init, headers: { ...init.headers, ...ownerEdge() } });

/** The bot's own agents MCP tools, from its live turn. */
async function botTools(botId: string) {
  const dump = join(home, "fake-claude-dump.json");
  expect((await api("POST", `/api/bots/${botId}/messages`, { body: { text: "Work on my Notes folder tonight." } })).status).toBe(202);
  await vi.waitFor(() => expect(existsSync(dump)).toBe(true), { timeout: 15_000 });
  const agents = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.agents;
  proxy = spawn(agents.command, agents.args, { env: { PATH: process.env.PATH, HOME: home, ...agents.env }, stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: proxy.stdout! }).on("line", (line) => { const message = JSON.parse(line); replies.get(message.id)?.(message.result); replies.delete(message.id); });
  let next = 0;
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve) => {
    const id = ++next; replies.set(id, resolve);
    proxy!.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05" });
  const call = async (name: string, args: unknown = {}) => (await request("tools/call", { name, arguments: args }));
  return {
    list: async () => JSON.parse((await call("list_shared_computers")).content[0].text),
    folder: async (args: Record<string, unknown>) => {
      const result = await call("shared_computer", args);
      return { error: result.isError === true, text: result.content[0].text as string, data: (() => { try { return JSON.parse(result.content[0].text); } catch { return null; } })() };
    },
  };
}

it("a lent folder keeps working while the Mac is away: read from the copy, changes saved and applied when it's back, both kept on a conflict", async () => {
  const pc = realpathSync(mkdtempSync(join(tmpdir(), "omb-lent-pc-")));
  const notes = join(pc, "Notes");
  mkdirSync(notes);
  writeFileSync(join(notes, "plan.md"), "the plan");
  writeFileSync(join(notes, "todo.md"), "buy milk");
  const trash = join(pc, ".Trash");
  mkdirSync(trash);
  const env = { id: "my-cloud", name: "My Cloud", origin: PC_ORIGIN };
  const account = { status: "connected", accountId: "acct-1", origin: PC_ORIGIN };
  const connector = createComputerSharing({
    file: join(pc, "user", "computer-sharing.json"), environments: () => [env], cuaConnection: async () => null,
    fetch: desktopFetch as typeof fetch, cloud: () => account, myCloud: () => null,
  });
  const files = createCloudFilesService({
    settingsFile: join(pc, "user", "files.json"), stateFile: join(pc, "user", "state.db"),
    documentsDir: join(pc, "Documents"), localDataDir: join(pc, ".openmausbot"), homeDir: join(pc, "home"), platform: process.platform, hostname: hostname(),
    cloudOrigin: () => PC_ORIGIN, fetch: desktopFetch as typeof fetch, markDownloaded: async () => {}, watch: () => () => {}, now: () => Date.now() + 60_000,
    trashItem: async (file: string) => renameSync(file, join(trash, `${readdirSync(trash).length}-${file.split(/[\\/]/).at(-1)}`)),
    lending: lendingForFiles({ environment: () => env, sharing: () => connector, validate: validateSharedFolders }),
  });
  try {
    // The person lends Notes with editing, as Settings → MausBot Cloud does.
    await connector.saveCloud(env, { folders: [{ id: randomUUID(), path: notes, write: true }], screen: false, internet: false });
    await vi.waitFor(() => expect(connector.cloudState(env).connected).toBe(true), { timeout: 15_000 });
    // Files copies it by itself: nothing to choose.
    await files.pass();
    expect(files.state().shared).toMatchObject([{ name: "Notes", lent: true, status: "synced" }]);
    // The copy is in the data folder, which no bot's box shows: only shared_computer, with lending's rules, reaches it.
    const copy = join(home, ".openmausbot", "sync", "lent");
    const [computerDir] = readdirSync(copy);
    expect(readFileSync(join(copy, computerDir!, "Notes", "plan.md"), "utf8")).toBe("the plan");
    expect(existsSync(join(home, "Synced", computerDir!, "Notes"))).toBe(false);

    const bot = (await api("POST", "/api/bots", { body: { name: "Night Owl", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } } })).body.bot;
    const tools = await botTools(bot.id);
    // The bot is told how lent folders behave while the Mac is away, and is never handed the copy's place on disk.
    const prompt = String(JSON.parse(readFileSync(join(home, "fake-claude-dump.json"), "utf8")).systemPrompt);
    expect(prompt).toContain("each folder it lends that the Cloud keeps a copy of still works from that copy");
    expect(prompt).not.toContain(join("sync", "lent"));
    const live = await tools.list();
    expect(live.computers).toHaveLength(1);
    const lent = live.computers[0].folders[0];
    expect(lent).toMatchObject({ name: "Notes", write: true });

    // The Mac goes away (its app pauses lending, as when it sleeps or loses its Cloud sign-in).
    account.status = "restoring";
    connector.cloudChanged();
    await vi.waitFor(async () => expect((await tools.list()).computers).toEqual([]), { timeout: 10_000 });
    const away = await tools.list();
    expect(away.say).toContain("is away, but the folders it lends still work from the Cloud's copy");
    expect(away.away_computers).toMatchObject([{ name: hostname().slice(0, 120), folders: [{ folder_id: lent.id, name: "Notes", write: true, copy: "from just now" }] }]);
    const computerId = away.away_computers[0].computer_id;

    const plan = await tools.folder({ computer_id: computerId, folder_id: lent.id, action: "read_file", path: "plan.md" });
    expect(plan.data).toMatchObject({ content: "the plan", from: "the Cloud's copy, from just now" });
    const todo = await tools.folder({ computer_id: computerId, folder_id: lent.id, action: "read_file", path: "todo.md" });
    expect((await tools.folder({ computer_id: computerId, folder_id: lent.id, action: "list_files" })).data.entries).toEqual([{ name: "plan.md", type: "file" }, { name: "todo.md", type: "file" }]);

    const saved = await tools.folder({ computer_id: computerId, folder_id: lent.id, action: "write_file", path: "plan.md", content: "the plan, finished overnight", expected_sha256: plan.data.sha256 });
    expect(saved.data).toMatchObject({ written: true, saved: "on the Cloud" });
    expect(saved.data.note).toContain("saved; it'll reach your");
    await tools.folder({ computer_id: computerId, folder_id: lent.id, action: "write_file", path: "drafts/idea.md", content: "a new idea" });
    await tools.folder({ computer_id: computerId, folder_id: lent.id, action: "write_file", path: "todo.md", content: "buy milk\nbook flights", expected_sha256: todo.data.sha256 });
    // The bot reads back what it saved; nothing on the Mac has changed.
    expect((await tools.folder({ computer_id: computerId, folder_id: lent.id, action: "read_file", path: "plan.md" })).data.content).toBe("the plan, finished overnight");
    expect(readFileSync(join(notes, "plan.md"), "utf8")).toBe("the plan");
    expect(existsSync(join(notes, "drafts"))).toBe(false);
    // Mac-only steps still need the Mac.
    expect((await tools.folder({ computer_id: computerId, action: "run_command", command: "ls" })).error).toBe(true);

    // Meanwhile the person edited todo.md on the Mac.
    writeFileSync(join(notes, "todo.md"), "buy oat milk");
    const earlier = new Date(Date.now() - 5_000);
    utimesSync(join(notes, "todo.md"), earlier, earlier);

    // The Mac is back: lending reconnects and Files applies what waited.
    account.status = "connected";
    connector.cloudChanged();
    await vi.waitFor(() => expect(connector.cloudState(env).connected).toBe(true), { timeout: 15_000 });
    await files.pass();
    expect(readFileSync(join(notes, "plan.md"), "utf8")).toBe("the plan, finished overnight");
    expect(readFileSync(join(notes, "drafts", "idea.md"), "utf8")).toBe("a new idea");
    expect(readFileSync(join(notes, "todo.md"), "utf8")).toBe("buy oat milk");
    const beside = readdirSync(notes).find((name) => name.startsWith("todo (new from My Cloud, "));
    expect(beside, readdirSync(notes).join(", ")).toBeTruthy();
    expect(readFileSync(join(notes, beside!), "utf8")).toBe("buy milk\nbook flights");
    // Nothing of the person's was deleted: the plan it replaced is in the Recycle Bin.
    expect(readdirSync(trash).map((name) => readFileSync(join(trash, name), "utf8"))).toEqual(["the plan"]);
    expect(files.state().shared[0]!.kept).toMatchObject([{ path: "todo.md", beside }]);
    expect((await api("GET", `/api/sync/folders/${files.state().shared[0]!.id}/staged`, { headers: ownerEdge() })).body.staged).toEqual([]);
    // Live again: the bot reads the Mac itself.
    const back = await tools.list();
    expect(back.away_computers).toBeUndefined();
    const reread = await tools.folder({ computer_id: back.computers[0].id, folder_id: lent.id, action: "read_file", path: "plan.md" });
    expect(reread.data).toMatchObject({ content: "the plan, finished overnight", sha256: sha("the plan, finished overnight") });
    expect(reread.data.from).toBeUndefined();
  } finally {
    files.close();
    connector.close();
    rmSync(pc, { recursive: true, force: true });
  }
}, 90_000);
