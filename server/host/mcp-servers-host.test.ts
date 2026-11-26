import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { mcpServerConfigHash } from "../mcp-app-catalog.ts";
import { McpOAuthManager } from "../mcp-oauth.ts";
import { providerToolAllowKey } from "../provider-tool-allow.ts";
import { VaultStore } from "../vault-store.ts";
import { createMcpKeys } from "../vault/mcp-keys.ts";
import { claimedNotice, createMcpServersHost, startCheckTimeout } from "./mcp-servers-host.ts";
import type { BrokerPath } from "../bot-box/broker-probe.ts";
import { notMcpError, type UrlAnswer } from "./mcp-url-checks.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const IRIS = { id: "iris", name: "Iris" }, PAUL = { id: "paul", name: "Paul" }, ROSA = { id: "rosa", name: "Rosa", mcpServers: [] as string[] };
const NOTES_ONLY = { id: "nina", name: "Nina", toolScope: { allow: ["mcp:notes:*"] } }, NO_SERVERS = { id: "otto", name: "Otto" };

function script(data: string, ...parts: string[]): string {
  const path = join(data, ...parts);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "import mcp\n");
  return path;
}

function setup(options: { boxed?: boolean; data?: string; bots?: Array<{ id: string; name: string; mcpServers?: string[]; toolScope?: unknown }>; urls?: Record<string, UrlAnswer>; policy?: <T extends object>(servers: Record<string, T>) => Record<string, T>; botsPath?: () => BrokerPath | null } = {}) {
  const data = options.data ?? mkdtempSync(join(tmpdir(), "omb-mcp-host-"));
  if (!options.data) dirs.push(data);
  const cfg: AppConfig = {
    mcpServers: {
      "sketch-suite": { command: "/usr/bin/python3", args: [script(data, "task-workspaces", "iris", "t1", "native-sketch", "server.py")], enabled: true },
      blender: { command: "/usr/bin/python3", args: [script(data, "task-workspaces", "iris", "t2", "blender-mcp", "server.py")], enabled: true },
      "blender-own": { command: "/usr/bin/python3", args: [script(data, "workspaces", "iris", "tools", "blender-mcp", "server.py")], enabled: true },
      notes: { command: "npx", args: ["-y", "@x/notes-mcp"], enabled: true },
      broken: { command: "/usr/bin/false", args: [], enabled: true },
    },
  } as AppConfig;
  const told: Array<{ text: string; about: string }> = [];
  const started: string[] = [];
  const probed: string[] = [];
  const fetchers: Array<Record<string, string>> = [];
  const host = createMcpServersHost({
    dataDir: data,
    cfg: () => cfg,
    persist: (next) => { cfg.mcpServers = next; },
    bots: () => options.bots ?? [IRIS, PAUL, ROSA, NOTES_ONLY, NO_SERVERS],
    startsServers: (botId) => botId !== NO_SERVERS.id,
    boxed: () => options.boxed ?? true,
    policy: options.policy ?? ((servers) => servers),
    ...(options.botsPath ? { botsPath: options.botsPath } : {}),
    tell: (text, about) => told.push({ text, about: about.id }),
    // The image's python has no `mcp` module: these start only in Iris's own box, where it is installed.
    start: async (name, server, botId) => {
      started.push(`${name}:${botId}`);
      if (name === "broken") return { ok: false, error: "The server stopped before the MCP handshake finished." };
      return server.command === "/usr/bin/python3" && botId !== "iris" ? { ok: false, error: "No module named 'mcp'" } : { ok: true };
    },
    // No network: a URL server answers as `urls` says, else it lists no tools.
    probeUrl: async (server, via) => {
      probed.push(server.url);
      if (via?.fetch) fetchers.push(server.headers);
      return options.urls?.[server.url] ?? { ok: true };
    },
  });
  return { cfg, host, told, started, data, probed, fetchers };
}

it("moves servers in one bot's folders to that bot once, says so once, and keeps them out of every other bot's turns", async () => {
  const { cfg, host, told, started, data } = setup();
  host.boot();
  await host.health.settled();
  expect(told).toEqual([
    { text: "The Blender, Blender-own and Sketch-suite tools only work for Iris, so they're off for your other bots.", about: "iris" },
    { text: "The Broken tool doesn't start, so it's off for now. It comes back on its own once it starts.", about: "iris" },
  ]);
  expect((cfg.mcpServers!.blender as { args: string[] }).args).toEqual([join(data, "workspaces", "iris", "tools", "blender-mcp-2", "server.py")]);
  expect(Object.keys(host.mounted(IRIS)).sort()).toEqual(["blender", "blender-own", "notes", "sketch-suite"]);
  expect(Object.keys(host.mounted(PAUL)).sort()).toEqual(["notes"]);
  expect(host.mounted(ROSA), "a bot given no servers gets none").toEqual({});
  expect(started.sort(), "Iris's own servers are started for Iris only, every bot's once for all").toEqual(["blender-own:iris", "blender:iris", "broken:iris", "notes:iris", "sketch-suite:iris"]);
  expect(host.off(PAUL)).toEqual([{ name: "broken", error: "The server stopped before the MCP handshake finished." }]);
  expect(host.given(PAUL).sort(), "a server that did not start is still set for Paul, so a change to it reaches him").toEqual(["broken", "notes"]);
  expect(host.off(NOTES_ONLY), "a bot whose tool selection never reaches it is not told about it").toEqual([]);
  expect(host.health.offFor("broken"), "nor a bot whose AI starts no servers").toEqual(["iris", "paul"]);

  host.boot();
  await host.health.settled();
  expect(told, "a second start says nothing new").toHaveLength(2);
  host.botDeleted("iris");
  expect(Object.keys(cfg.mcpServers!).sort()).toEqual(["broken", "notes"]);
});

it("where every bot reaches every folder (a desktop), keeps such servers every bot's and says nothing about them", async () => {
  const { cfg, host, told, data } = setup({ boxed: false });
  host.boot();
  await host.health.settled();
  expect(Object.values(cfg.mcpServers!).some((server) => "bot" in (server as object))).toBe(false);
  expect((cfg.mcpServers!.blender as { args: string[] }).args[0], "nothing moved").toBe(join(data, "task-workspaces", "iris", "t2", "blender-mcp", "server.py"));
  expect(told.map((entry) => entry.text)).toEqual(["The Broken tool doesn't start, so it's off for now. It comes back on its own once it starts."]);
  expect(existsSync(join(data, "mcp-bot-servers.json")), "a later boxed start still moves them over").toBe(false);
});

it("moves servers over once: a server added in Settings afterwards stays every bot's across restarts", () => {
  const first = setup();
  first.host.boot();
  first.cfg.mcpServers!.shared = { command: "/usr/bin/python3", args: [script(first.data, "workspaces", "iris", "tools", "shared", "server.py")], enabled: true };
  const again = createMcpServersHost({
    dataDir: first.data, cfg: () => first.cfg, persist: (next) => { first.cfg.mcpServers = next; }, bots: () => [IRIS, PAUL], policy: (servers) => servers,
    tell: () => {}, startsServers: () => true, boxed: () => true, start: async () => ({ ok: true }),
  });
  again.boot();
  expect(first.cfg.mcpServers!.shared).not.toHaveProperty("bot");
  expect(Object.keys(again.mounted(PAUL))).toContain("shared");
});

it("never makes a server the own of a deleted bot whose folder was left behind", () => {
  const { cfg, host } = setup({ bots: [PAUL, ROSA] });
  host.boot();
  expect(Object.values(cfg.mcpServers!).some((server) => "bot" in (server as object)), "Iris is gone").toBe(false);
});

it("says it in one plain line per bot", () => {
  expect(claimedNotice("Iris", ["blender"])).toBe("The Blender tool only works for Iris, so it's off for your other bots.");
});

it("tests a command server as its bot's turns start it, from that bot's own folder, and any other as any bot's", () => {
  const { host, data } = setup();
  expect(host.probeAs({})).toEqual({});
  expect(host.probeAs({ bot: "paul" })).toEqual({ id: "paul", cwd: data });
  mkdirSync(join(data, "workspaces", "iris"), { recursive: true });
  expect(host.probeAs({ bot: "iris" })).toEqual({ id: "iris", cwd: join(data, "workspaces", "iris") });
});

it("a restart, or turning a server off and on, shows in what the next turn starts, so an engine that kept the old process replaces it", async () => {
  const { cfg, host } = setup({ boxed: false, bots: [PAUL] });
  host.boot();
  await host.health.settled();
  const notes = () => host.mounted(PAUL).notes as { env: Record<string, string> };
  const fresh = JSON.stringify(host.mounted(PAUL).notes);
  expect(notes().env.OMB_MCP_RESTART).toBeUndefined();

  host.health.changed("notes");
  const restarted = JSON.stringify(host.mounted(PAUL).notes);
  expect(restarted).not.toBe(fresh);
  expect(mcpServerConfigHash(JSON.parse(restarted)), "still the server the apps catalog learned").toBe(mcpServerConfigHash(JSON.parse(fresh)));

  const entry = cfg.mcpServers!.notes as { enabled: boolean };
  entry.enabled = false;
  host.health.changed("notes");
  entry.enabled = true;
  host.health.changed("notes");
  expect(JSON.stringify(host.mounted(PAUL).notes), "off and on in one turn leaves the config the same").not.toBe(restarted);
  expect(JSON.stringify(host.mounted(PAUL).blender)).toBe(JSON.stringify(host.mounted(PAUL).blender));
});

it("leaves servers reached by URL alone", async () => {
  const { cfg, host } = setup({ boxed: false, bots: [PAUL] });
  cfg.mcpServers!.linear = { type: "http", url: "https://mcp.linear.app/mcp", headers: {}, enabled: true };
  host.health.changed("linear");
  expect(host.mounted(PAUL).linear).toEqual({ type: "http", url: "https://mcp.linear.app/mcp", headers: {} });
});

it("leaves out a URL server whose address is no MCP endpoint, says so once, and keeps one that timed out or wants a key", async () => {
  const PAGE = "https://docs.example.test/pages/1/", SLOW = "https://slow.example.test/mcp", KEYED = "https://keyed.example.test/mcp";
  const { cfg, host, told, probed } = setup({ boxed: false, bots: [PAUL], urls: {
    [PAGE]: { ok: false, status: 405 },
    [SLOW]: { ok: false },
    [KEYED]: { ok: false, status: 401 },
  } });
  cfg.mcpServers!.wiki = { type: "http", url: PAGE, headers: {}, enabled: true };
  cfg.mcpServers!.slow = { type: "http", url: SLOW, headers: {}, enabled: true };
  cfg.mcpServers!.keyed = { type: "http", url: KEYED, headers: {}, enabled: true };
  expect(Object.keys(host.mounted(PAUL)), "before its check a URL server is mounted as before").toContain("wiki");
  host.boot();
  await host.health.settled();
  expect(probed.sort()).toEqual([PAGE, KEYED, SLOW]);
  expect(Object.keys(host.mounted(PAUL)).sort()).toEqual(["keyed", "notes", "slow"]);
  expect(host.off(PAUL)).toContainEqual({ name: "wiki", error: notMcpError(405) });
  expect(host.off(PAUL).map((off) => off.name)).not.toContain("slow");
  expect(host.listing({ name: "wiki" }).offFor).toEqual(["paul"]);
  expect(told.map((entry) => entry.text)).toContain("The Wiki tool doesn't start, so it's off for now. It comes back on its own once it starts.");

  host.boot();
  host.health.engineFailed(PAUL.id, ["wiki"]);
  await host.health.settled();
  expect(told.filter((entry) => entry.text.startsWith("The Wiki tool")), "said once").toHaveLength(1);

  // The person fixes the address: it is mounted again at once and checked again.
  cfg.mcpServers!.wiki = { type: "http", url: "https://mcp.example.test/wiki", headers: {}, enabled: true };
  expect(Object.keys(host.mounted(PAUL))).toContain("wiki");
  host.health.changed("wiki");
  await host.health.settled();
  expect(Object.keys(host.mounted(PAUL))).toContain("wiki");
  expect(host.off(PAUL).map((off) => off.name)).not.toContain("wiki");
});

it("never contacts a URL server the organisation's policy blocks", async () => {
  const { cfg, host, probed } = setup({ boxed: false, bots: [PAUL], policy: (servers) => Object.fromEntries(Object.entries(servers).filter(([name]) => name !== "blocked")) });
  cfg.mcpServers!.blocked = { type: "http", url: "https://blocked.example.test/mcp", headers: {}, enabled: true };
  host.boot();
  host.health.changed("blocked");
  host.health.engineFailed(PAUL.id, ["blocked"]);
  await host.health.settled();
  expect(probed).toEqual([]);
});

it("where turns are boxed, checks a URL server through the credential broker as turns reach it, with no headers of its own", async () => {
  const minted: Array<{ threadId: string; grants: Record<string, { upstream: string; headers: Record<string, string> }> }> = [], revoked: string[] = [];
  const path: BrokerPath = { socketPath: "/nonexistent/broker.sock", broker: {
    port: 4567,
    mintForThread: (grant: { threadId: string; grants: Record<string, { upstream: string; headers: Record<string, string> }> }) => { minted.push(grant); return { token: "tok" }; },
    revokeThread: (threadId: string) => { revoked.push(threadId); },
  } as unknown as BrokerPath["broker"] };
  const { cfg, host, probed, fetchers } = setup({ boxed: true, bots: [PAUL], botsPath: () => path });
  cfg.mcpServers!.wiki = { type: "http", url: "https://wiki.example.test/mcp", headers: { "x-api-key": "key-1" }, enabled: true };
  host.health.changed("wiki");
  await host.health.settled();
  expect(probed).toEqual(["http://127.0.0.1:4567/b/tok/mcp-wiki"]);
  expect(fetchers).toEqual([{}]);
  expect(minted[0]!.grants["mcp-wiki"]).toMatchObject({ upstream: "https://wiki.example.test/mcp", headers: { "x-api-key": "key-1" } });
  expect(revoked).toEqual([minted[0]!.threadId]);
});

it("a package runner's first check waits for its download; any other program's keeps the short wait", () => {
  for (const command of ["uvx", "npx", "/opt/homebrew/bin/uvx", "npx.cmd"]) expect(startCheckTimeout(command), command).toBe(120_000);
  for (const command of ["node", "python3", "/usr/local/bin/my-server"]) expect(startCheckTimeout(command), command).toBeUndefined();
});

it("starts a server with its key read from the Vault, tells a bot the item keeps out, and says when the key is gone", async () => {
  const data = mkdtempSync(join(tmpdir(), "omb-mcp-host-"));
  dirs.push(data);
  const vault = new VaultStore({ dataDir: data });
  const secret = vault.saveSecret({ name: "Stripe secret key", value: "sk_fake-mounted", source: "card", bots: ["iris"] });
  vault.grantMcpKeys("stripe", [secret.id]);
  const keys = createMcpKeys({ store: vault, linked: { fresh: async () => {}, byId: () => null } });
  const cfg = { mcpServers: { stripe: { command: "npx", args: ["stripe-mcp"], env: { STRIPE_KEY: `vault:${secret.id}` }, enabled: true }, plain: { command: "npx", args: ["plain-mcp"], env: { TOKEN: "plain-value" }, enabled: true } } } as unknown as AppConfig;
  const started: string[] = [];
  const told: string[] = [];
  const host = createMcpServersHost({
    dataDir: data, cfg: () => cfg, persist: (next) => { cfg.mcpServers = next; }, bots: () => [IRIS, PAUL], startsServers: () => true, boxed: () => false, policy: (servers) => servers,
    tell: (text) => told.push(text), keys,
    start: async (name, server) => { started.push(`${name}:${JSON.stringify(server.env)}`); return { ok: true }; },
  });
  await host.prepare(IRIS);
  const mounted = host.mounted(IRIS);
  expect(mounted.stripe && "env" in mounted.stripe ? mounted.stripe.env.STRIPE_KEY : null).toBe("sk_fake-mounted");
  expect(JSON.stringify(cfg.mcpServers)).not.toContain("sk_fake-mounted");
  expect(started.find((line) => line.startsWith("stripe:"))).toContain(`vault:${secret.id}`);
  expect(host.mounted(IRIS).plain).toEqual({ command: "npx", args: ["plain-mcp"], env: { TOKEN: "plain-value" } });
  expect(Object.keys(host.mounted(PAUL))).toEqual(["plain"]);
  expect(host.off(PAUL)).toEqual([{ name: "stripe", error: expect.stringContaining("kept to other bots"), key: true }]);
  expect(host.listing({ name: "stripe" })).toEqual({ name: "stripe" });
  vault.removeSecret(secret.id);
  expect(host.mounted(IRIS).stripe).toBeUndefined();
  expect(host.off(IRIS)).toEqual([{ name: "stripe", error: expect.stringContaining("no longer in the Vault"), key: true }]);
  expect(host.listing({ name: "stripe" })).toEqual({ name: "stripe", keyOff: true });
  expect(told.join()).not.toContain("doesn't start");
});

it("ties a saved grant to the server as config.json holds it: a restart or a new key value keeps it, a changed server ends it", async () => {
  const data = mkdtempSync(join(tmpdir(), "omb-mcp-host-"));
  dirs.push(data);
  const vault = new VaultStore({ dataDir: data });
  const secret = vault.saveSecret({ name: "Stripe secret key", value: "sk_fake-first", source: "card", bots: "all" });
  vault.grantMcpKeys("stripe", [secret.id]);
  const keys = createMcpKeys({ store: vault, linked: { fresh: async () => {}, byId: () => null } });
  const cfg = { mcpServers: {
    stripe: { command: "npx", args: ["stripe-mcp"], env: { STRIPE_KEY: `vault:${secret.id}` }, enabled: true },
    twin: { command: "npx", args: ["stripe-mcp"], env: { STRIPE_KEY: "plain" }, enabled: true },
  } } as unknown as AppConfig;
  const saved = new Map<string, string[]>();
  const host = createMcpServersHost({
    dataDir: data, cfg: () => cfg, persist: (next) => { cfg.mcpServers = next; }, bots: () => [IRIS, PAUL], startsServers: () => true, boxed: () => false, policy: (servers) => servers,
    tell: () => {}, keys, start: async () => ({ ok: true }),
    moveGrants: (bot, move) => { goneOver.push(bot.id); const next = move(saved.get(bot.id) ?? []); if (next) saved.set(bot.id, next); },
  });
  const goneOver: string[] = [];
  const key = (bot: typeof IRIS, server = "stripe", tool = "list_charges") => providerToolAllowKey("claude", `mcp__${server}__${tool}`, host.grantSpecs(host.mounted(bot))[server]);
  /** What earlier versions saved: the fingerprint of the server as started, key value and restart count included. */
  const earlier = (bot: typeof IRIS) => `provider-tool:claude:stripe:list_charges:${createHash("sha256").update(JSON.stringify(host.mounted(bot).stripe)).digest("hex").slice(0, 16)}`;
  await host.prepare(IRIS);
  const first = key(IRIS)!;
  expect(first).toMatch(/^provider-tool:claude:stripe:list_charges:[a-f0-9]{16}$/);
  expect(JSON.stringify(host.grantSpecs(host.mounted(IRIS)))).not.toContain("sk_fake");
  expect(JSON.stringify(host.grantSpecs(host.mounted(IRIS)))).toContain(`vault:${secret.id}`);
  expect(key(PAUL), "the same server is the same grant key for each bot, which keeps its own list").toBe(first);
  expect(key(IRIS, "twin"), "another server, though started by the same command, has its own").not.toBe(first);
  expect(key(IRIS, "stripe", "list_refunds")).not.toBe(first);

  const beforeRestart = earlier(IRIS);
  expect(beforeRestart).not.toBe(first);
  saved.set(IRIS.id, [beforeRestart, "Bash:git status"]);
  saved.set(PAUL.id, [beforeRestart]);
  host.health.changed("stripe");
  host.health.changed("stripe");
  expect((host.mounted(IRIS).stripe as { env: Record<string, string> }).env.OMB_MCP_RESTART, "the restart still reaches the engine").toBe("2");
  expect(earlier(IRIS), "the old key changed with every restart").not.toBe(beforeRestart);
  expect(key(IRIS)).toBe(first);
  expect(host.grantSpecs(host.mounted(IRIS)).stripe).not.toHaveProperty("env.OMB_MCP_RESTART");

  vault.updateSecret(secret.id, { value: "sk_fake-rotated" });
  host.keyChanged(secret.id);
  expect((host.mounted(IRIS).stripe as { env: Record<string, string> }).env.STRIPE_KEY).toBe("sk_fake-rotated");
  expect(key(IRIS), "a new key value is the same server").toBe(first);
  // A grant saved under the first key value cannot be told apart from one for another server now, so it is left as it is.
  await host.prepare(IRIS);
  expect(saved.get(IRIS.id)).toEqual([beforeRestart, "Bash:git status"]);
  // One saved under today's value, at a restart count from before, moves when the bot's next turn starts: this bot's only.
  vault.updateSecret(secret.id, { value: "sk_fake-first" });
  await host.prepare(IRIS);
  expect(saved.get(IRIS.id)).toEqual([first, "Bash:git status"]);
  expect(saved.get(PAUL.id)).toEqual([beforeRestart]);
  expect(JSON.stringify([...saved])).not.toContain("sk_fake");
  // A turn whose servers are as they were at the bot's last one goes over nothing: no hashing of its keys, no save.
  const before = goneOver.length;
  await host.prepare(IRIS);
  await host.prepare(IRIS);
  expect(goneOver.length).toBe(before);
  host.health.changed("stripe");
  await host.prepare(IRIS);
  expect(goneOver.slice(before), "servers changed: once more, for that bot").toEqual([IRIS.id]);
  await host.prepare(PAUL);
  await host.prepare(PAUL);
  expect(goneOver.slice(before)).toEqual([IRIS.id, PAUL.id]);
  expect(saved.get(PAUL.id), "and Paul's own turn moves Paul's").toEqual([first]);

  (cfg.mcpServers!.stripe as { args: string[] }).args = ["stripe-mcp", "--live"];
  expect(key(IRIS), "changed arguments are another server").not.toBe(first);
  (cfg.mcpServers!.stripe as { args: string[] }).args = ["stripe-mcp"];
  expect(key(IRIS)).toBe(first);
  (cfg.mcpServers!.stripe as { command: string }).command = "node";
  expect(key(IRIS), "so is a changed command").not.toBe(first);
  (cfg.mcpServers!.stripe as { command: string }).command = "npx";
  (cfg.mcpServers!.stripe as { env: Record<string, string> }).env.STRIPE_ACCOUNT = "acct_other";
  expect(key(IRIS), "and a changed variable").not.toBe(first);
});

it("keeps a turn starting when its bot's grants cannot be saved in their new form", async () => {
  const cfg = { mcpServers: { plain: { command: "npx", args: ["plain-mcp"], env: {}, enabled: true } } } as unknown as AppConfig;
  const data = mkdtempSync(join(tmpdir(), "omb-mcp-host-"));
  dirs.push(data);
  const host = createMcpServersHost({
    dataDir: data, cfg: () => cfg, persist: () => {}, bots: () => [IRIS], startsServers: () => true, boxed: () => false, policy: (servers) => servers, tell: () => {},
    start: async () => ({ ok: true }), moveGrants: () => { throw new Error("fixture disk full"); },
  });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(host.prepare(IRIS)).resolves.toBeUndefined();
  expect(logged).toHaveBeenCalledExactlyOnceWith("[mcp] Could not move this bot's saved tool permissions to their new form.");
  await host.prepare(IRIS);
  expect(logged, "a failed move is tried again at the next turn").toHaveBeenCalledTimes(2);
  logged.mockRestore();
});

it("forgets which Vault items a server could read when its bot's own server goes with the bot", () => {
  const data = mkdtempSync(join(tmpdir(), "omb-mcp-host-"));
  dirs.push(data);
  const vault = new VaultStore({ dataDir: data });
  vault.grantMcpKeys("bot-server", ["77777777-7777-4777-8777-777777777777"]);
  const keys = createMcpKeys({ store: vault, linked: { fresh: async () => {}, byId: () => null } });
  const cfg = { mcpServers: { "bot-server": { command: "/bin/x", args: [], env: {}, enabled: true, bot: "iris" } } } as unknown as AppConfig;
  const host = createMcpServersHost({ dataDir: data, cfg: () => cfg, persist: (next) => { cfg.mcpServers = next; }, bots: () => [IRIS], startsServers: () => true, boxed: () => false, policy: (servers) => servers, tell: () => {}, keys });
  host.botDeleted("iris");
  expect(cfg.mcpServers).toEqual({});
  expect(vault.mcpServerKeys("bot-server")).toEqual([]);
});

it("forgets the sign-in of a bot's own web connection when it goes with the bot, so a new one by that name starts signed out", () => {
  const data = mkdtempSync(join(tmpdir(), "omb-mcp-host-"));
  dirs.push(data);
  const url = "https://mcp.linear.app/mcp";
  const oauth = new McpOAuthManager({ file: join(data, "mcp-oauth.json") });
  oauth.adopt("linear_iris", url, { url, state: "signed-in", tokens: { access: "token" } });
  const cfg = { mcpServers: { linear_iris: { type: "http", url, headers: {}, enabled: true, bot: "iris" } } } as unknown as AppConfig;
  const host = createMcpServersHost({ dataDir: data, cfg: () => cfg, persist: (next) => { cfg.mcpServers = next; }, bots: () => [IRIS], startsServers: () => true, boxed: () => false, policy: (servers) => servers, tell: () => {}, forgetSignIn: (name) => oauth.forget(name) });
  host.botDeleted("iris");
  expect(cfg.mcpServers).toEqual({});
  expect(oauth.authState("linear_iris", url)).not.toBe("signed-in");
});

it("still forgets the sign-in when forgetting the server's Vault items fails", () => {
  const data = mkdtempSync(join(tmpdir(), "omb-mcp-host-"));
  dirs.push(data);
  const forgotten: string[] = [];
  const cfg = { mcpServers: { linear_iris: { type: "http", url: "https://mcp.linear.app/mcp", headers: {}, enabled: true, bot: "iris" } } } as unknown as AppConfig;
  const keys = { forgetServer: () => { throw new Error("vault write failed"); } } as unknown as ReturnType<typeof createMcpKeys>;
  const host = createMcpServersHost({ dataDir: data, cfg: () => cfg, persist: (next) => { cfg.mcpServers = next; }, bots: () => [IRIS], startsServers: () => true, boxed: () => false, policy: (servers) => servers, tell: () => {}, keys, forgetSignIn: (name) => forgotten.push(name) });
  expect(() => host.botDeleted("iris")).toThrow("vault write failed");
  expect(forgotten).toEqual(["linear_iris"]);
});
