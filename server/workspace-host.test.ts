// The workspace host: what a workspace server inherits, what crosses the
// forwarding boundary in each direction, and its lifecycle (one start for
// concurrent callers, streaming, idle stop, crash recovery) against a
// stand-in server.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  forwardedRequestHeaders,
  ownServerCommand,
  returnedResponseHeaders,
  ensurePrivateDirectory,
  tearDownWorkspaceRuntime,
  workspaceConfig,
  workspaceProcesses,
  workspaceRuntimeDir,
  workspaceServerEnvironment,
  workspaceTools,
  WorkspaceHost,
  type WorkspaceTools,
} from "./workspace-host.ts";
import type { WorkspaceRef } from "./accounts.ts";

const FAKE = fileURLToPath(new URL("./testing/fake-workspace-server.ts", import.meta.url));
const REF: WorkspaceRef = { id: "ws_AAAAAAAAAAAAAAAAAAAAAA", userId: "usr_1", email: "alice@example.test" };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("what a workspace server inherits", () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-nation", NATION_MODEL_FAST: "fast/model", NATION_TREASURY_ROBINHOOD: "0xabc",
    COMPOSIO_API_KEY: "ak_x", NATION_PUBLIC_NAME: "Nation Team Chat",
    // never
    NATION_DATA_DIR: "/root/.nationteamchat", OMB_DATA_DIR: "/root/.nationteamchat", NATION_PRODUCT_OWNER: "1", NATION_PRODUCT_ADMIN: "1",
    OMB_SIGNIN_EMAILS: "founder@example.test", OMB_SIGNIN_MEMBER_EMAILS: "cos@example.test", NATION_ACCOUNT_SERVICE_URL: "https://accounts",
    OMB_CONTROL_PLANE_URL: "https://cp", NATION_SMTP_URL: "smtps://u:p@smtp", NATION_MAIL_FROM: "x", NATION_MAIL_OUTBOX: "1",
    NATION_ADMIN_PIN: "1234", NATION_MEMBER_HOST_ENGINES: "1", NATION_WEB_READER_ALLOW_LOOPBACK: "1", OMB_BOX_API: "https://box",
    CONTAINER_HOST: "ssh://root@vps", CONTAINER_SSHKEY: "/root/.ssh/id", OMB_PUBLIC_URL: "https://thenation.city/swarm",
    NATION_TRUSTED_ORIGINS: "https://thenation.city", OMB_HOSTED_MODEL_TOKEN: "omb_workspace_x", NATION_ACCOUNTS: "1",
    ANTHROPIC_API_KEY: "sk-ant", OPENMAUSBOT_INTERNAL_DATA_DIR_LEASE: "lease", TURNKEY_ORGANIZATION_ID: "org",
    BOX_TOKEN: "box_desk_token", AGENT_BROWSER_EXECUTABLE_PATH: "/opt/chrome/chrome",
  };
  const env = workspaceServerEnvironment(parent, { root: "/data/workspaces/ws_x", port: 41000, workspaceId: REF.id, key: "k".repeat(43), creditsDb: "/data/nation-credits.db", brandFile: "/data/brand.json" });

  it("gets its own data directory and home, and the shared ledger", () => {
    expect(env).toMatchObject({
      HOME: "/data/workspaces/ws_x", NATION_DATA_DIR: "/data/workspaces/ws_x", OMB_DATA_DIR: "/data/workspaces/ws_x",
      OMB_PORT: "41000", OMB_WEBHOOK_PORT: "41001", NATION_CREDITS_DB: "/data/nation-credits.db", NATION_CREDIT_WATCHER: "0",
      NATION_WORKSPACE_ID: REF.id, NATION_BRAND_FILE: "/data/brand.json", NATION_TRUST_PROXY: "1",
    });
  });

  it("is never the product owner, and nothing on this machine is its owner by loopback", () => {
    expect(env.NATION_PRODUCT_OWNER).toBe("0");
    expect(env.NATION_PRODUCT_ADMIN).toBe("0");
    expect(env.NATION_WORKSPACE_LOOPBACK_OWNER).toBe("0");
  });

  it("keeps model, credit, wallet and connected-app settings, and nothing else", () => {
    expect(env).toMatchObject({ PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-nation", NATION_MODEL_FAST: "fast/model", NATION_TREASURY_ROBINHOOD: "0xabc", COMPOSIO_API_KEY: "ak_x", TURNKEY_ORGANIZATION_ID: "org" });
    // cloud computers answer at the same endpoint; Chrome is the one this server runs
    expect(env).toMatchObject({ OMB_BOX_API: "https://box", AGENT_BROWSER_EXECUTABLE_PATH: "/opt/chrome/chrome" });
    for (const name of ["OMB_SIGNIN_EMAILS", "OMB_SIGNIN_MEMBER_EMAILS", "NATION_ACCOUNT_SERVICE_URL", "OMB_CONTROL_PLANE_URL", "NATION_SMTP_URL",
      "NATION_MAIL_FROM", "NATION_MAIL_OUTBOX", "NATION_ADMIN_PIN", "NATION_MEMBER_HOST_ENGINES", "NATION_WEB_READER_ALLOW_LOOPBACK",
      "CONTAINER_HOST", "CONTAINER_SSHKEY", "OMB_PUBLIC_URL", "NATION_TRUSTED_ORIGINS", "OMB_HOSTED_MODEL_TOKEN", "NATION_ACCOUNTS",
      "ANTHROPIC_API_KEY", "OPENMAUSBOT_INTERNAL_DATA_DIR_LEASE",
      // the cloud computer credential only ever arrives through workspaceTools
      "BOX_TOKEN", "OMB_AGENT_BROWSER_PATH", "AGENT_BROWSER_SOCKET_DIR"]) {
      expect(env[name], name).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toContain("/root/");
  });
});

describe("a workspace's own config", () => {
  it("allows only its account, runs NATION API only, and drops every desk and key", () => {
    const next = workspaceConfig({
      profile: { name: "Alice" }, onboarding: { completedAt: "2026-09-26T00:00:00Z", version: 1 },
      signIn: { admins: ["mallory@example.test"], members: ["mallory@example.test"] },
      instances: { claude: { driver: "claudeAgent" } }, defaultModelSelection: { instanceId: "claude", model: "x" },
      box: { token: "t" }, vps: { sshAlias: "a" }, localVm: { mode: "shared" }, anthropic: { key: "k" }, composio: { apiKey: "k", userId: "u", sessionId: "s" },
      features: { browser: true, computers: true, sharedComputers: true, showToolCalls: true },
    }, "alice@example.test", { modelRouting: { enabled: true } });
    expect(next).toEqual({
      profile: { name: "Alice" }, onboarding: { completedAt: "2026-09-26T00:00:00Z", version: 1 },
      signIn: { admins: [], members: ["alice@example.test"] },
      instances: { nationApi: { driver: "nation-openrouter", displayName: "NATION API" } },
      features: { browser: false, computers: false, sharedComputers: false, showToolCalls: true },
      // its own connected-apps session ids stay; a key never does
      composio: { userId: "u", sessionId: "s" },
      modelRouting: { enabled: true },
    });
  });

  it("keeps a NATION API model choice and follows the founder's settings when they change", () => {
    const first = workspaceConfig({ defaultModelSelection: { instanceId: "nationApi", model: "moonshotai/kimi-k2" } }, "a@example.test", { webSearch: { provider: "brave" } });
    expect(first.defaultModelSelection).toEqual({ instanceId: "nationApi", model: "moonshotai/kimi-k2" });
    expect(first.webSearch).toEqual({ provider: "brave" });
    expect(workspaceConfig(first, "a@example.test", {}).webSearch).toBeUndefined();
  });
});

describe("a workspace's computers and browser", () => {
  it("uses only enabled managed providers and keeps their credentials out of workspace files", () => {
    const hostedComputers = { defaultProvider: "orgo" as const, orgo: { enabled: true, workspaceId: "ws", apiKey: "orgo-secret" } };
    expect(workspaceTools({}, { hostedComputers }).computers).toBe(true);
    expect(workspaceTools({}, { hostedComputers: { orgo: { ...hostedComputers.orgo, enabled: false } } }).computers).toBe(false);
    const env = workspaceServerEnvironment({}, { root: "/data/ws", port: 41000, workspaceId: REF.id, key: "k".repeat(43),
      creditsDb: "/data/credits.db", tools: workspaceTools({}, { hostedComputers }) });
    expect(JSON.parse(env.NATION_HOSTED_COMPUTERS_CONFIG!)).toEqual(hostedComputers);
    expect(JSON.stringify(workspaceConfig({ hostedComputers }, "a@example.test", {}))).not.toContain("orgo-secret");
  });
  it("are on when this server has NATION's cloud computer credential and a browser engine, unless switched off", () => {
    const available = { boxToken: "box_desk_token", browserEngine: "/data/tools/agent-browser/0.37.0/agent-browser" };
    expect(workspaceTools({}, available)).toEqual({ computers: true, browser: true, ...available });
    expect(workspaceTools({ NATION_WORKSPACE_COMPUTERS: "0", NATION_WORKSPACE_BROWSER: "0" }, available)).toMatchObject({ computers: false, browser: false });
    expect(workspaceTools({}, { boxToken: " ", browserEngine: null })).toMatchObject({ computers: false, browser: false });
  });

  it("reach a workspace server through its environment only, each with its own short private directory", () => {
    const runtimeDir = "/tmp/nw-0123456789ab";
    const tools: WorkspaceTools = { computers: true, browser: true, boxToken: "box_desk_token", browserEngine: "/opt/agent-browser" };
    const base = { root: "/data/workspaces/ws_x", port: 41000, workspaceId: REF.id, key: "k".repeat(43), creditsDb: "/data/nation-credits.db" };
    expect(workspaceServerEnvironment({}, { ...base, runtimeDir, tools })).toMatchObject({
      TMPDIR: "/tmp/nw-0123456789ab/t", TEMP: "/tmp/nw-0123456789ab/t", TMP: "/tmp/nw-0123456789ab/t",
      AGENT_BROWSER_SOCKET_DIR: "/tmp/nw-0123456789ab/s", XDG_RUNTIME_DIR: "/tmp/nw-0123456789ab/r",
      BOX_TOKEN: "box_desk_token", OMB_AGENT_BROWSER_PATH: "/opt/agent-browser", HOME: "/data/workspaces/ws_x",
    });
    const off = workspaceServerEnvironment({}, { ...base, runtimeDir: null, tools: { ...tools, computers: false, browser: false } });
    expect(off.TMPDIR).toBe("/data/workspaces/ws_x/tmp");
    for (const name of ["BOX_TOKEN", "OMB_AGENT_BROWSER_PATH", "AGENT_BROWSER_SOCKET_DIR", "XDG_RUNTIME_DIR"]) expect(off[name], name).toBeUndefined();
  });

  it("are the config's cloud computers and browser, never sharing, and never a credential or another Chrome", () => {
    const next = workspaceConfig({
      box: { token: "box_in_file" }, browserEngine: { attachCdpUrl: "9222" }, localVm: { mode: "per-bot" }, vps: { sshAlias: "a" },
      features: { sharedComputers: true, showToolCalls: true },
    }, "alice@example.test", {}, { computers: true, browser: true });
    expect(next.features).toEqual({ computers: true, browser: true, sharedComputers: false, showToolCalls: true });
    for (const key of ["box", "browserEngine", "localVm", "vps"]) expect(next[key], key).toBeUndefined();
    expect(JSON.stringify(next)).not.toContain("box_in_file");
  });

  it("keep sockets and temp files in a short directory named for the workspace", () => {
    const one = workspaceRuntimeDir(REF.id);
    expect(one).toMatch(/^\/tmp\/nw-[0-9a-f]{12}$/);
    expect(workspaceRuntimeDir(REF.id)).toBe(one);
    expect(workspaceRuntimeDir("ws_BBBBBBBBBBBBBBBBBBBBBB")).not.toBe(one);
    // agent-browser's socket for a member's per-account session fits under the 104-byte limit
    expect(`${one}/s/bot-${"b".repeat(36)}--u-${"c".repeat(24)}.sock`.length).toBeLessThan(104);
    expect(() => workspaceRuntimeDir("../../etc")).toThrow();
  });

  it("refuse a private directory someone else prepared", () => {
    const base = mkdtempSync(join(tmpdir(), "nation-runtime-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const mine = join(base, "nw-mine");
    ensurePrivateDirectory(mine);
    expect(statSync(mine).mode & 0o777).toBe(0o700);
    for (const name of ["t", "s", "r"]) expect(statSync(join(mine, name)).isDirectory()).toBe(true);
    ensurePrivateDirectory(mine);
    const open = join(base, "nw-open");
    mkdirSync(open, { mode: 0o755 });
    chmodSync(open, 0o755);
    expect(() => ensurePrivateDirectory(open)).toThrow(/not a private directory/);
    const link = join(base, "nw-link");
    symlinkSync(mine, link);
    expect(() => ensurePrivateDirectory(link)).toThrow(/not a private directory/);
  });

  it.skipIf(process.platform !== "linux")("end with the workspace: what it left running stops and its directory goes", async () => {
    const base = mkdtempSync(join(tmpdir(), "nation-runtime-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const runtime = join(base, "nw-left");
    ensurePrivateDirectory(runtime);
    const leftover = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { PATH: process.env.PATH, TMPDIR: join(runtime, "t") }, stdio: "ignore" });
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { PATH: process.env.PATH, TMPDIR: base }, stdio: "ignore" });
    cleanups.push(() => { bystander.kill("SIGKILL"); leftover.kill("SIGKILL"); });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const found = workspaceProcesses(runtime);
    expect(found).toContain(leftover.pid);
    expect(found).not.toContain(bystander.pid);
    const gone = new Promise((resolve) => leftover.once("exit", resolve));
    tearDownWorkspaceRuntime(runtime);
    await gone;
    expect(existsSync(runtime)).toBe(false);
    expect(bystander.exitCode).toBeNull();
  });
});

describe("the workspace server's entry point", () => {
  it("is this server's own entry, or the one a process manager or the operator names", () => {
    expect(ownServerCommand({}).args.at(-1)).toBe(process.argv[1]);
    expect(ownServerCommand({ pm_exec_path: "/srv/nation/dist-server/index.js" }).args.at(-1)).toBe("/srv/nation/dist-server/index.js");
    expect(ownServerCommand({ pm_exec_path: "/srv/pm2.js", NATION_WORKSPACE_SERVER_ENTRY: "/srv/nation/server/index.ts" }).args.at(-1)).toBe("/srv/nation/server/index.ts");
    expect(ownServerCommand({}).file).toBe(process.execPath);
  });
});

describe("the forwarding boundary", () => {
  it("sends the workspace bearer and the caller's address, never the browser's credentials or proxy claims", () => {
    const out = forwardedRequestHeaders({
      host: "thenation.city", origin: "https://thenation.city", referer: "https://thenation.city/swarm/",
      cookie: "nation_account=nas_x; omb_session_8799_abc=omb_sess_founder; nation_device=11111111-2222-4333-8444-555555555555",
      authorization: "Bearer omb_sess_forged", "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "https", forwarded: "for=127.0.0.1",
      "x-real-ip": "127.0.0.1", "x-openmausbot-desktop-owner": "1", "x-nation-workspace-key": "forged", connection: "keep-alive",
      "content-type": "application/json", "content-length": "12", accept: "text/event-stream", "user-agent": "Safari",
    }, { token: "omb_sess_workspace", port: 41000, clientIp: "203.0.113.9" });
    expect(out).toEqual({
      "content-type": "application/json", "content-length": "12", accept: "text/event-stream", "user-agent": "Safari",
      cookie: "nation_device=11111111-2222-4333-8444-555555555555",
      authorization: "Bearer omb_sess_workspace", host: "127.0.0.1:41000", "x-real-ip": "203.0.113.9",
    });
  });

  it("returns no cookie but the device id", () => {
    expect(returnedResponseHeaders({
      "content-type": "application/json", "set-cookie": ["nation_device=abc; Path=/", "omb_session_1=x; Path=/"], connection: "close",
    })).toEqual({ "content-type": "application/json", "set-cookie": ["nation_device=abc; Path=/"] });
    expect(returnedResponseHeaders({ "set-cookie": ["omb_session_1=x"] })["set-cookie"]).toBeUndefined();
  });
});

describe("workspace lifecycle", () => {
  async function setup(options: { idleMs?: number; maxRunning?: number; tools?: WorkspaceTools } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "nation-host-"));
    const lines: string[] = [];
    const host = new WorkspaceHost({
      dataDir, creditsDb: join(dataDir, "nation-credits.db"), env: { PATH: process.env.PATH },
      command: { file: process.execPath, args: ["--experimental-strip-types", "--no-warnings", FAKE] },
      idleMs: options.idleMs ?? 60_000, maxRunning: options.maxRunning, startTimeoutMs: 15_000, log: (line) => lines.push(line),
      runtimeBase: dataDir, ...(options.tools ? { tools: () => options.tools! } : {}),
    });
    const front: Server = createServer((req, res) => {
      const ref = req.headers["x-test-workspace"] === "b" ? { ...REF, id: "ws_BBBBBBBBBBBBBBBBBBBBBB", email: "bob@example.test" } : REF;
      void host.forward(req, res, ref, "203.0.113.9");
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(front.address() as { port: number }).port}`;
    cleanups.push(async () => {
      await host.close();
      await new Promise((resolve) => front.close(resolve));
      rmSync(dataDir, { recursive: true, force: true });
    });
    return { host, base, dataDir, lines };
  }

  it("gives a workspace its computers, browser and private directory for as long as it runs", async () => {
    const tools: WorkspaceTools = { computers: true, browser: true, boxToken: "box_desk_token", browserEngine: "/opt/agent-browser" };
    const { host, dataDir } = await setup({ tools });
    await host.ensure(REF);
    const config = JSON.parse(readFileSync(join(host.rootOf(REF.id), "config.json"), "utf8"));
    expect(config.features).toMatchObject({ computers: true, browser: true, sharedComputers: false });
    expect(JSON.stringify(config)).not.toContain("box_desk_token");
    const runtime = workspaceRuntimeDir(REF.id, dataDir);
    expect(statSync(runtime).mode & 0o777).toBe(0o700);
    await host.stop(REF.id, "test");
    expect(existsSync(runtime)).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("clears what an earlier run left before it starts again", async () => {
    const tools: WorkspaceTools = { computers: false, browser: true, browserEngine: "/opt/agent-browser" };
    const { host, dataDir } = await setup({ tools });
    // A browser left from a run whose server was killed with this one.
    const runtime = workspaceRuntimeDir(REF.id, dataDir);
    ensurePrivateDirectory(runtime);
    writeFileSync(join(runtime, "s", "stale.sock"), "");
    const leftover = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { PATH: process.env.PATH, TMPDIR: join(runtime, "t") }, stdio: "ignore" });
    cleanups.push(() => { leftover.kill("SIGKILL"); });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const gone = new Promise((resolve) => leftover.once("exit", resolve));
    await host.ensure(REF);
    await gone;
    expect(existsSync(join(runtime, "s", "stale.sock"))).toBe(false);
    expect(statSync(runtime).mode & 0o777).toBe(0o700);
    expect(host.isRunning(REF.id)).toBe(true);
  });

  it("starts a stopping workspace again only once the old server has exited and cleared its directory", async () => {
    const tools: WorkspaceTools = { computers: false, browser: true, browserEngine: "/opt/agent-browser" };
    const { host, dataDir } = await setup({ tools });
    const first = await host.ensure(REF) as unknown as { port: number; child: ChildProcess };
    writeFileSync(join(host.rootOf(REF.id), "fake-state.json"), JSON.stringify({ slowExitMs: 800 }));
    const stopping = host.stop(REF.id, "test");
    const again = await host.ensure(REF) as unknown as { port: number; child: ChildProcess };
    await stopping;
    expect(first.child.exitCode ?? first.child.signalCode).not.toBeNull();
    expect(again.port).not.toBe(first.port);
    // The old server's teardown ran before this start: it neither removed the
    // new server's directory nor stopped the new server.
    expect(existsSync(workspaceRuntimeDir(REF.id, dataDir))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(again.child.exitCode).toBeNull();
    expect(again.child.signalCode).toBeNull();
    expect(host.isRunning(REF.id)).toBe(true);
  });

  it("starts once for concurrent requests and forwards through the boundary", async () => {
    const { host, base } = await setup();
    const [a, b] = await Promise.all([host.ensure(REF), host.ensure(REF)]);
    expect(a.port).toBe(b.port);
    const response = await fetch(`${base}/api/echo`, { headers: { cookie: "nation_account=nas_x; nation_device=11111111-2222-4333-8444-555555555555", origin: "https://thenation.city" } });
    const echo = await response.json() as any;
    expect(echo.minted).toBe(1);
    expect(echo.headers.authorization).toBe(`Bearer ${a.token}`);
    expect(echo.headers.cookie).toBe("nation_device=11111111-2222-4333-8444-555555555555");
    expect(echo.headers["x-real-ip"]).toBe("203.0.113.9");
    expect(echo.headers.origin).toBeUndefined();
    expect(echo.env).toMatchObject({ owner: "0", watcher: "0" });
    expect(echo.env.dataDir).toBe(host.rootOf(REF.id));
    expect(response.headers.getSetCookie()).toEqual(["nation_device=11111111-2222-4333-8444-555555555555; Path=/"]);
  });

  it("streams events as they happen and lets go when the browser leaves", async () => {
    const { host, base } = await setup();
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    let text = "";
    while ((text.match(/ping/g) ?? []).length < 3) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    await expect.poll(() => (host as any).running.get(REF.id)?.inflight, { timeout: 5_000 }).toBe(0);
  });

  it("stops an idle workspace, but not a busy one or one a routine keeps awake", async () => {
    const { host, base } = await setup({ idleMs: 1 });
    await fetch(`${base}/api/echo`);
    const root = host.rootOf(REF.id);
    writeFileSync(join(root, "fake-state.json"), JSON.stringify({ busy: true }));
    await host.sweep(Date.now() + 10_000);
    expect(host.isRunning(REF.id)).toBe(true);
    writeFileSync(join(root, "fake-state.json"), JSON.stringify({ keepAlive: true }));
    await host.sweep(Date.now() + 10_000);
    expect(host.isRunning(REF.id)).toBe(true);
    writeFileSync(join(root, "fake-state.json"), JSON.stringify({}));
    await host.sweep(Date.now() + 10_000);
    expect(host.isRunning(REF.id)).toBe(false);
    // …and it comes back on the next request.
    expect((await fetch(`${base}/api/echo`)).status).toBe(200);
    expect(host.isRunning(REF.id)).toBe(true);
  });

  it("makes room by stopping the least recently used idle workspace", async () => {
    const { host, base } = await setup({ maxRunning: 1 });
    await fetch(`${base}/api/echo`);
    expect((await fetch(`${base}/api/echo`, { headers: { "x-test-workspace": "b" } })).status).toBe(200);
    expect(host.runningCount()).toBe(1);
    expect(host.isRunning(REF.id)).toBe(false);
  });

  it("answers busy when every running workspace is working", async () => {
    const { host, base } = await setup({ maxRunning: 1 });
    await fetch(`${base}/api/echo`);
    writeFileSync(join(host.rootOf(REF.id), "fake-state.json"), JSON.stringify({ busy: true }));
    const refused = await fetch(`${base}/api/echo`, { headers: { "x-test-workspace": "b" } });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "Nation Team Chat is busy right now. Try again in a minute." });
    expect(host.isRunning(REF.id)).toBe(true);
  });

  it("starts again after a crash", async () => {
    const { host, base, lines } = await setup();
    const first = await host.ensure(REF);
    await fetch(`${base}/api/exit`);
    await expect.poll(() => host.isRunning(REF.id), { timeout: 5_000 }).toBe(false);
    expect(lines.join("\n")).toMatch(/stopped unexpectedly/);
    expect((await fetch(`${base}/api/echo`)).status).toBe(200);
    expect((await host.ensure(REF)).port).not.toBe(first.port);
  });

  it("never shows the browser a sign-in error for its own refused credential", async () => {
    const { host, base } = await setup();
    await fetch(`${base}/api/echo`);
    await fetch(`${base}/api/revoke`);
    const refused = await fetch(`${base}/api/echo`);
    expect(refused.status).toBe(503);
    await expect.poll(async () => (await fetch(`${base}/api/echo`)).status, { timeout: 5_000 }).toBe(200);
    expect(host.isRunning(REF.id)).toBe(true);
  });
});
