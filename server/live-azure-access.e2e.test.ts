// The full server in each place a Live call starts from, with Azure chosen: who gets through to Azure, who is refused and
// what they read. A disposable home and a made-up key. The server's fetch is a stub that notes where it would have gone,
// so nothing leaves this machine, and a caller who gets through ends at the stub's 503. A shared company workspace has its
// own case in hosted-access.test.ts.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { cloudPairingSignature } from "./cloud-home.ts";
import { LIVE_AZURE_REFUSAL } from "./live-access.ts";
import { LIVE_NEEDS_AZURE, LIVE_NEEDS_KEY } from "./live-call.ts";
import { LIVE_KEY_NEEDS_ENDPOINT } from "./live-config.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const HOST = "omb-t-0123456789ab.fly.dev";
const REMOTE = { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };
const ENDPOINT = "https://fixture.openai.azure.com";
const SESSIONS = `${ENDPOINT}/openai/v1/live/sessions`;
const TEAM = { id: "team-7f3a", name: "Acme" };
const secret = randomBytes(32).toString("base64url");
const REFUSED = { status: 403, body: { error: LIVE_AZURE_REFUSAL } };
const THROUGH = { status: 502, body: { error: "Azure OpenAI had a problem starting the call. Try again in a moment." } };

type Headers = Record<string, string>;
let stopping: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(stopping.map((stop) => stop()));
  stopping = [];
});

async function boot(env: NodeJS.ProcessEnv, config: Record<string, unknown> = {}) {
  chmodSync(FAKE_CLAUDE, 0o755);
  const home = mkdtempSync(join(tmpdir(), "omb-live-azure-"));
  const dataDir = join(home, ".openmausbot");
  const fetches = join(home, "fetches.log");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(home, "web"));
  writeFileSync(join(home, "web", "index.html"), "<!doctype html><title>OpenMausBot</title>");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      ...Object.fromEntries(["codex", "cursor", "githubCopilot", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: { driver: "claudeAgent", config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" } },
    },
    live: { provider: "azure", azureEndpoint: ENDPOINT, azureDeployment: "fixture-dep", key: "fixture-not-a-key", keyFor: "azure:fixture.openai.azure.com" },
    // There to fall back on: a refused caller must not get a call through OpenAI instead.
    openai: { key: "fixture-not-a-key-either" },
    ...config,
  }));
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const prelude = `data:text/javascript,${encodeURIComponent(`import { appendFileSync } from "node:fs"; globalThis.fetch = async (url, init) => { const headers = new Headers(init?.headers); appendFileSync(${JSON.stringify(fetches)}, JSON.stringify({ url: String(url), apiKey: headers.get("api-key"), authorization: headers.get("authorization") }) + "\\n"); return new Response("offline fixture", { status: 503 }); };`)}`;
  const child: ChildProcess = spawn(process.execPath, ["--import", prelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: join(home, "web"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  stopping.push(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });
  const deadline = Date.now() + 45_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error(`the server did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const call = async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  /** A session from a pairing code, as a remote device redeems one. */
  const redeem = async (code: string): Promise<Headers> => {
    const paired = await call("POST", "/api/auth/pair", { code, label: "Fixture device" }, REMOTE);
    expect(paired.status, JSON.stringify(paired.body)).toBe(200);
    return { ...REMOTE, authorization: `Bearer ${paired.body.token as string}` };
  };
  /** A pairing the Admin signs, for a Cloud's owner or a team's member. */
  const signedSession = async (claim: Record<string, unknown> = {}): Promise<Headers> => {
    const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300, ...claim });
    const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
    const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
      ...REMOTE, "content-type": "application/json", "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
    }, body });
    const granted = await response.json() as { code: string };
    return redeem(granted.code);
  };
  const newBot = async (headers: Headers = {}) => {
    const created = await call("POST", "/api/bots", { name: "Ada", modelSelection: { instanceId: "claude", model: "claude-fake" } }, headers);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.bot.id as string;
  };
  /** Each session request the server tried: where it went, and with which key. */
  const sent = () => (existsSync(fetches) ? readFileSync(fetches, "utf8") : "").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { url: string; apiKey: string | null; authorization: string | null }).filter(({ url }) => url.includes("/live/sessions"));
  const liveSessions = () => sent().map(({ url }) => url);
  const savedLive = () => JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).live as Record<string, unknown>;
  const start = (botId: string, headers: Headers = {}) => call("POST", "/api/live/session", { botId, sdp: "v=0\r\n", client: "web" }, headers);
  return { call, redeem, signedSession, newBot, liveSessions, sent, savedLive, start };
}

const CLOUD_ENV = {
  OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
  OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
};

it("on a self-hosted server: the owner and their devices get through; a chat-only device is refused, and from then on a local request is not taken for the owner", async () => {
  const s = await boot({});
  const botId = await s.newBot();
  expect(await s.start(botId)).toEqual(THROUGH);
  const admin = await s.redeem((await s.call("POST", "/api/auth/pairing", { scopes: ["admin", "client"] })).body.code);
  expect(await s.start(botId, admin)).toEqual(THROUGH);
  expect(s.liveSessions()).toEqual([SESSIONS, SESSIONS]);

  const chatOnly = await s.redeem((await s.call("POST", "/api/auth/pairing", { scopes: ["client"] })).body.code);
  expect(await s.start(botId, chatOnly)).toEqual(REFUSED);
  expect(await s.start(botId)).toEqual(REFUSED);
  expect(s.liveSessions()).toHaveLength(2);
  expect(await s.start(botId, admin)).toEqual(THROUGH);

  const seen = (await s.call("GET", "/api/config", undefined, chatOnly)).body.live;
  expect(seen).toMatchObject({ provider: "azure", configured: true });
  expect(seen).not.toHaveProperty("azureEndpoint");
  expect(seen).not.toHaveProperty("azureDeployment");
  expect((await s.call("GET", "/api/config", undefined, admin)).body.live).toMatchObject({ azureEndpoint: ENDPOINT, azureDeployment: "fixture-dep" });

  // With OpenAI chosen nothing here changes: the chat-only device hears the bare scope refusal it always did.
  expect((await s.call("PATCH", "/api/live/settings", { provider: "openai" }, admin)).status).toBe(200);
  expect(await s.start(botId, chatOnly)).toEqual({ status: 403, body: { error: "forbidden: this session lacks the admin scope" } });
}, 90_000);

it("on a self-hosted server with a sign-in list: an admin's session gets through, a local request does not", async () => {
  const s = await boot({}, { signIn: { admins: ["owner@acme.test"], members: ["person@acme.test"] } });
  const botId = await s.newBot();
  expect(await s.start(botId)).toEqual(REFUSED);
  expect(s.liveSessions()).toEqual([]);
  const admin = await s.redeem((await s.call("POST", "/api/auth/pairing", { scopes: ["admin", "client"] })).body.code);
  expect(await s.start(botId, admin)).toEqual(THROUGH);
}, 90_000);

it("on a person's own Cloud: their session gets through, a bot's shell does not", async () => {
  const s = await boot({ OMB_CLOUD_ROLE: "home", ...CLOUD_ENV });
  const owner = await s.signedSession();
  const botId = await s.newBot(owner);
  expect(await s.start(botId, owner)).toEqual(THROUGH);
  expect(s.liveSessions()).toEqual([SESSIONS]);
  expect(await s.start(botId)).toMatchObject({ status: 403, body: { error: expect.stringContaining("may only use the service routes") } });
  expect(s.liveSessions()).toHaveLength(1);
}, 90_000);

it("on a Team Cloud: a Super admin and an Admin get through; a User is refused in plain words, on the app or their phone, and a bot's shell does not get through", async () => {
  const s = await boot({ OMB_CLOUD_ROLE: "team", OMB_CLOUD_TEAM_ID: TEAM.id, OMB_CLOUD_TEAM_NAME: TEAM.name, ...CLOUD_ENV });
  const session = (email: string, role: string) => s.signedSession({ team: TEAM, member: { email, role } });
  const owner = await session("olive@acme.test", "owner");
  const admin = await session("ben@acme.test", "admin");
  const member = await session("ada@acme.test", "member");
  const botId = await s.newBot(owner);

  expect(await s.start(botId, owner)).toEqual(THROUGH);
  expect(await s.start(botId, admin)).toEqual(THROUGH);
  expect(s.liveSessions()).toEqual([SESSIONS, SESSIONS]);

  expect(await s.start(botId, member)).toEqual(REFUSED);
  const made = await s.call("POST", "/api/team/phone-pairing", {}, member);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const phone = await s.redeem(made.body.code);
  expect(await s.start(botId, phone)).toEqual(REFUSED);
  // The companion's header carries no authority.
  expect(await s.start(botId, { ...member, "x-openmausbot-companion": "1", "x-openmausbot-companion-device": "phone-1" })).toEqual(REFUSED);
  expect(await s.start(botId)).toMatchObject({ status: 403, body: { error: expect.stringContaining("may only use the service routes") } });
  expect(s.liveSessions()).toHaveLength(2);

  const seen = (await s.call("GET", "/api/config", undefined, member)).body.live;
  expect(seen).toMatchObject({ provider: "azure" });
  expect(seen).not.toHaveProperty("azureEndpoint");
  expect(seen).not.toHaveProperty("azureDeployment");
}, 90_000);

type Fixture = Awaited<ReturnType<typeof boot>>;
const GATEWAY = "https://gw.azure-api.net/team-a";
const OTHER = "https://other.openai.azure.com";
const OPENAI_SESSIONS = "https://api.openai.com/v1/live/sessions";

/** Asks and checks: a call that reaches `url` with exactly this key, or a call that asks for a key and sends nothing. */
function keyChecks(s: Fixture, botId: string) {
  return {
    reaches: async (url: string, apiKey: string | null, authorization: string | null = null) => {
      const before = s.sent().length;
      expect((await s.start(botId)).status).toBe(502);
      expect(s.sent().slice(before)).toEqual([{ url, apiKey, authorization }]);
    },
    asksForKey: async (error: string) => {
      const before = s.sent().length;
      expect(await s.start(botId)).toEqual({ status: 409, body: { error, needsKey: true } });
      expect(s.sent()).toHaveLength(before);
    },
    saveKey: async (key: string) => {
      const saved = await s.call("PUT", "/api/config", { live: { key } });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    },
  };
}

it.each([
  ["PATCH /api/live/settings", (s: Fixture, settings: Record<string, unknown>) => s.call("PATCH", "/api/live/settings", settings)],
  ["PUT /api/config", (s: Fixture, settings: Record<string, unknown>) => s.call("PUT", "/api/config", { live: settings })],
] as const)("through %s, a saved key goes only to the service and host it was saved for, and changing either asks for it again", async (_route, change) => {
  const s = await boot({}, { live: { provider: "azure", azureEndpoint: ENDPOINT }, openai: {} });
  const botId = await s.newBot();
  const { reaches, asksForKey, saveKey } = keyChecks(s, botId);
  const changed = async (settings: Record<string, unknown>) => {
    const answer = await change(s, settings);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body.live as Record<string, unknown>;
  };

  await asksForKey(LIVE_NEEDS_AZURE);
  await saveKey("key-for-fixture");
  await reaches(SESSIONS, "key-for-fixture");

  // A new path or deployment on the same host keeps it.
  await changed({ azureEndpoint: `${ENDPOINT}/openai/v1`, azureDeployment: "other-dep" });
  await reaches(SESSIONS, "key-for-fixture");

  // Another host does not, and changing back does not bring it back.
  const afterMove = await changed({ azureEndpoint: OTHER });
  expect(afterMove).toMatchObject({ provider: "azure", configured: false });
  expect(afterMove).not.toHaveProperty("keySource");
  await asksForKey(LIVE_NEEDS_AZURE);
  expect(s.savedLive()).toMatchObject({ key: "", keyFor: "nowhere" });
  expect((await s.call("GET", "/api/config")).body.savedKeys.openaiLiveKey.configured).toBe(false);
  await changed({ azureEndpoint: ENDPOINT });
  await asksForKey(LIVE_NEEDS_AZURE);

  // An API Management gateway stays allowed, with a key saved for it.
  await changed({ azureEndpoint: GATEWAY });
  await asksForKey(LIVE_NEEDS_AZURE);
  await saveKey("key-for-gateway");
  await reaches(`${GATEWAY}/openai/v1/live/sessions`, "key-for-gateway");

  // Switching Service: the Azure key never goes to OpenAI.
  await changed({ provider: "openai" });
  await asksForKey(LIVE_NEEDS_KEY);
  await saveKey("key-for-openai");
  await reaches(OPENAI_SESSIONS, null, "Bearer key-for-openai");

  // And an OpenAI key never goes to Azure, even to a host a key was saved for before.
  await changed({ provider: "azure" });
  await asksForKey(LIVE_NEEDS_AZURE);
  await changed({ provider: "openai" });
  await asksForKey(LIVE_NEEDS_KEY);

  // The OpenAI API key is OpenAI's, for a call through OpenAI only.
  expect((await s.call("PUT", "/api/config", { openai: { key: "openai-api-key" } })).status).toBe(200);
  await reaches(OPENAI_SESSIONS, null, "Bearer openai-api-key");
  await changed({ provider: "azure" });
  await asksForKey(LIVE_NEEDS_AZURE);

  const keysAt = (key: string) => [...new Set(s.sent().filter(({ apiKey, authorization }) => apiKey === key || authorization === `Bearer ${key}`).map(({ url }) => url))];
  expect(keysAt("key-for-fixture")).toEqual([SESSIONS]);
  expect(keysAt("key-for-gateway")).toEqual([`${GATEWAY}/openai/v1/live/sessions`]);
  expect(keysAt("key-for-openai")).toEqual([OPENAI_SESSIONS]);
  expect(keysAt("openai-api-key")).toEqual([OPENAI_SESSIONS]);
}, 90_000);

it("takes no keyFor from a request, and refuses a key with Azure chosen and no endpoint to tie it to", async () => {
  const s = await boot({}, { live: { provider: "azure" } });
  const botId = await s.newBot();
  const { reaches, asksForKey, saveKey } = keyChecks(s, botId);
  expect(await s.call("PUT", "/api/config", { live: { key: "too-soon" } })).toEqual({ status: 400, body: { error: LIVE_KEY_NEEDS_ENDPOINT } });
  expect(s.savedLive()).not.toHaveProperty("key");

  expect((await s.call("PUT", "/api/config", { live: { azureEndpoint: ENDPOINT } })).status).toBe(200);
  await saveKey("key-for-fixture");
  await reaches(SESSIONS, "key-for-fixture");

  // Claiming the key is for the new host changes nothing.
  expect((await s.call("PUT", "/api/config", { live: { azureEndpoint: OTHER, keyFor: "azure:other.openai.azure.com", key: "" } })).status).toBe(200);
  await asksForKey(LIVE_NEEDS_AZURE);
  expect((await s.call("PUT", "/api/config", { live: { keyFor: "azure:other.openai.azure.com" } })).status).toBe(200);
  await asksForKey(LIVE_NEEDS_AZURE);
  expect(s.savedLive().keyFor).toBe("nowhere");
  expect((await s.call("PATCH", "/api/live/settings", { keyFor: "azure:other.openai.azure.com" })).status).toBe(400);
}, 60_000);

it("the desktop's way of saving, with the key kept outside the file, ties it just the same", async () => {
  const s = await boot({}, { live: { provider: "azure", azureEndpoint: ENDPOINT } });
  const botId = await s.newBot();
  const { reaches, asksForKey } = keyChecks(s, botId);
  expect((await s.call("PUT", "/api/config?secretStorage=external", { live: { key: "from-the-store" } })).status).toBe(200);
  expect(s.savedLive()).toMatchObject({ key: "", keyFor: "azure:fixture.openai.azure.com" });
  await reaches(SESSIONS, "from-the-store");
  expect((await s.call("PATCH", "/api/live/settings", { azureEndpoint: OTHER })).status).toBe(200);
  await asksForKey(LIVE_NEEDS_AZURE);
  expect((await s.call("PATCH", "/api/live/settings", { azureEndpoint: ENDPOINT })).status).toBe(200);
  await asksForKey(LIVE_NEEDS_AZURE);
}, 60_000);

it("a server set up in the environment: the key goes to the endpoint set beside it, until an admin changes the endpoint", async () => {
  const s = await boot({ OMB_LIVE_PROVIDER: "azure", OMB_AZURE_OPENAI_LIVE_ENDPOINT: ENDPOINT, OMB_OPENAI_LIVE_KEY: "operators-key" }, { live: {} });
  const botId = await s.newBot();
  const { reaches, asksForKey } = keyChecks(s, botId);
  await reaches(SESSIONS, "operators-key");
  expect((await s.call("PATCH", "/api/live/settings", { azureEndpoint: OTHER })).status).toBe(200);
  await asksForKey(LIVE_NEEDS_AZURE);
}, 60_000);

it.each([
  ["the environment", { OMB_LIVE_PROVIDER: "azure", OMB_AZURE_OPENAI_LIVE_ENDPOINT: ENDPOINT }, null],
  ["PUT /api/config", {}, { provider: "azure", azureEndpoint: ENDPOINT }],
] as const)("a provider set by %s gives way to a later PATCH /api/live/settings", async (_from, env, viaConfig) => {
  const s = await boot({ ...env }, { live: {} });
  if (viaConfig) expect((await s.call("PUT", "/api/config", { live: viaConfig })).status).toBe(200);
  expect((await s.call("GET", "/api/config")).body.live.provider).toBe("azure");

  const patched = await s.call("PATCH", "/api/live/settings", { provider: "openai" });
  expect(patched.status).toBe(200);
  expect(patched.body.live).not.toHaveProperty("provider");
  expect((await s.call("GET", "/api/config")).body.live).not.toHaveProperty("provider");
  expect(s.savedLive().provider).toBe("openai");

  expect((await s.call("PATCH", "/api/live/settings", { azureEndpoint: OTHER, provider: "azure" })).body.live).toMatchObject({ provider: "azure", azureEndpoint: OTHER });
}, 60_000);
