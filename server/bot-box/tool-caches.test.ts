import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BotBox, BoxRunner, BOX_EGRESS_PORT } from "./box.ts";
import { visibleInBox } from "./plan.ts";
import { TOOL_CACHES, toolCacheEnvironment, toolCacheRoot, toolCachesOn } from "./tool-caches.ts";
import { engineInstallRoots } from "../engine-roots.ts";
import { memberAudience } from "../audience.ts";
import { audienceHome } from "../engine-homes/layout.ts";

const bridge = { socat: "/usr/bin/socat", bridgeScript: "/app/dist-server/bot-box/box-bridge.js", node: "/usr/local/bin/node" };
const dataDir = "/data/.openmausbot", home = "/data";
const setup = { dataDir, home, codeRoots: ["/app"], engineRoots: engineInstallRoots(dataDir), bridges: [{ name: "egress", port: BOX_EGRESS_PORT, socket: "/data/.openmausbot/box/egress.sock" }] };
const turn = { command: "/usr/local/bin/claude", args: ["-p"], cwd: join(dataDir, "task-workspaces", "b1", "t1"), env: { PATH: "/usr/bin", HOME: home, ANTHROPIC_API_KEY: "k" } };
const runner = (toolCaches?: boolean) => new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge, setup, denyEnv: new Set(), ...(toolCaches === undefined ? {} : { toolCaches }) });
const cacheNames = TOOL_CACHES.map((cache) => cache.name);

describe("the switch", () => {
  it("is on only on a Cloud home that sets it, never on a desktop", () => {
    expect(toolCachesOn({})).toBe(false);
    expect(toolCachesOn({ OMB_CLOUD_ROLE: "home" })).toBe(false);
    for (const value of ["1", "on", "ON", "true", "yes", " on "]) expect(toolCachesOn({ OMB_CLOUD_ROLE: "home", OMB_CACHE_ROOT: value }), value).toBe(true);
    expect(toolCachesOn({ OMB_CLOUD_ROLE: "team", OMB_CACHE_ROOT: "on" })).toBe(true);
    for (const value of ["", "0", "off", "/data/cache", "maybe"]) expect(toolCachesOn({ OMB_CLOUD_ROLE: "home", OMB_CACHE_ROOT: value }), value).toBe(false);
    // A desktop, even one that forces the box on for a test, never moves a tool's cache.
    expect(toolCachesOn({ OMB_CACHE_ROOT: "on", OMB_BOT_BOX: "on" })).toBe(false);
    expect(toolCachesOn({ OMB_CLOUD_ROLE: "desktop", OMB_CACHE_ROOT: "on" })).toBe(false);
  });
});

describe("a box's environment", () => {
  it("off, it is exactly today's: no cache variable is added, with the switch absent or false", () => {
    const today = {
      PATH: "/usr/bin", HOME: home, ANTHROPIC_API_KEY: "k",
      HTTPS_PROXY: `http://127.0.0.1:${BOX_EGRESS_PORT}`, HTTP_PROXY: `http://127.0.0.1:${BOX_EGRESS_PORT}`, https_proxy: `http://127.0.0.1:${BOX_EGRESS_PORT}`, http_proxy: `http://127.0.0.1:${BOX_EGRESS_PORT}`,
      NO_PROXY: "127.0.0.1,localhost,::1,[::1]", no_proxy: "127.0.0.1,localhost,::1,[::1]",
    };
    expect(runner().wrap(turn).env).toEqual(today);
    expect(runner(false).wrap(turn).env).toEqual(today);
    expect(runner(false).wrap(turn).args).toEqual(runner().wrap(turn).args);
  });

  it("on, every cache variable names its folder in the box HOME's cache folder", () => {
    const env = runner(true).wrap(turn).env;
    const root = toolCacheRoot(home);
    expect(root).toBe(join(resolve(home), "cache"));
    expect(env).toMatchObject({
      npm_config_cache: join(root, "npm"), PIP_CACHE_DIR: join(root, "pip"), UV_CACHE_DIR: join(root, "uv"),
      PLAYWRIGHT_BROWSERS_PATH: join(root, "ms-playwright"), PUPPETEER_CACHE_DIR: join(root, "puppeteer"),
      HF_HUB_CACHE: join(root, "huggingface", "hub"), HF_XET_CACHE: join(root, "huggingface", "xet"),
      BUN_INSTALL_CACHE_DIR: join(root, "bun"), COREPACK_HOME: join(root, "corepack"), GOCACHE: join(root, "go-build"), GOMODCACHE: join(root, "go-mod"),
    });
    for (const name of cacheNames) expect(env[name], name).toBeDefined();
    // Nothing that holds a sign-in or installed programs is moved.
    for (const name of ["XDG_CACHE_HOME", "HF_HOME", "CARGO_HOME", "GRADLE_USER_HOME", "PNPM_HOME", "UV_TOOL_DIR", "UV_PYTHON_INSTALL_DIR", "npm_config_store_dir"]) expect(env[name], name).toBeUndefined();
    expect(env.HOME).toBe(home);
  });

  it("on, the person's own value wins: one the engine's saved settings pass in, npm's in any letter case", () => {
    const env = runner(true).wrap({
      ...turn, env: { ...turn.env, UV_CACHE_DIR: "/data/my-uv", NPM_CONFIG_CACHE: "/data/my-npm", PLAYWRIGHT_BROWSERS_PATH: "/data/pw" },
      allowEnv: ["UV_CACHE_DIR", "PLAYWRIGHT_BROWSERS_PATH"],
    }).env;
    expect(env.UV_CACHE_DIR).toBe("/data/my-uv");
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("/data/pw");
    expect(env.NPM_CONFIG_CACHE).toBe("/data/my-npm");
    expect(env.npm_config_cache).toBeUndefined();
    expect(env.PIP_CACHE_DIR).toBe(join(toolCacheRoot(home), "pip"));
  });

  it("on, a variable that already decides a cache's place leaves that cache alone", () => {
    const env = runner(true).wrap({ ...turn, env: { ...turn.env, XDG_CACHE_HOME: "/data/xdg", HF_HOME: "/data/hf", GOPATH: "/data/go", BUN_INSTALL: "/data/.bun" }, allowEnv: ["HF_HOME", "GOPATH", "BUN_INSTALL"] }).env;
    for (const name of ["PIP_CACHE_DIR", "UV_CACHE_DIR", "PLAYWRIGHT_BROWSERS_PATH", "HF_HUB_CACHE", "HF_XET_CACHE", "BUN_INSTALL_CACHE_DIR", "COREPACK_HOME", "GOCACHE", "GOMODCACHE"]) expect(env[name], name).toBeUndefined();
    expect(env.npm_config_cache).toBe(join(toolCacheRoot(home), "npm"));
    expect(env.PUPPETEER_CACHE_DIR).toBe(join(toolCacheRoot(home), "puppeteer"));
  });

  it("on, a value the box would drop is not the person's: ours is set", () => {
    // The server's own environment is not a bot's settings; the allow-list drops it, as it does today.
    const env = runner(true).wrap({ ...turn, env: { ...turn.env, PIP_CACHE_DIR: "/srv/pip" } }).env;
    expect(env.PIP_CACHE_DIR).toBe(join(toolCacheRoot(home), "pip"));
  });

  it("toolCacheEnvironment adds nothing a set name covers and never touches the given environment", () => {
    const given = { npm_config_cache: "/x", HOME: home };
    const added = toolCacheEnvironment(home, given);
    expect(added.npm_config_cache).toBeUndefined();
    expect(given).toEqual({ npm_config_cache: "/x", HOME: home });
    expect(toolCacheEnvironment(home, { npm_config_cache: "" }).npm_config_cache).toBe(join(toolCacheRoot(home), "npm"));
  });
});

// The box's paths are POSIX paths inside it, which Windows' path module would write with drive letters.
describe.skipIf(process.platform === "win32")("what the box can reach", () => {
  it("a personal Cloud: the cache folder is read-write in every bot's box, the app's own cache folder is hidden", () => {
    const wrapped = runner(true).wrap(turn);
    expect(visibleInBox(wrapped.plan, "/data/cache")).toBe("rw");
    for (const name of cacheNames) expect(visibleInBox(wrapped.plan, wrapped.env[name]!), name).toBe("rw");
    expect(visibleInBox(wrapped.plan, join(dataDir, "cache"))).toBe("none");
    expect(visibleInBox(wrapped.plan, join(dataDir, "cache", "node-compile"))).toBe("none");
  });

  it("a Team Cloud: each audience's box has its own cache folder in its engine home, and no other audience's", () => {
    const member = audienceHome(dataDir, memberAudience("ana@example.com"));
    const other = audienceHome(dataDir, memberAudience("ben@example.com"));
    expect(member).not.toBe(other);
    const wrapped = runner(true).wrap({ ...turn, home: member, env: { ...turn.env, HOME: member } });
    expect(wrapped.env.npm_config_cache).toBe(join(member, "cache", "npm"));
    for (const name of cacheNames) expect(visibleInBox(wrapped.plan, wrapped.env[name]!), name).toBe("rw");
    expect(visibleInBox(wrapped.plan, join(other, "cache"))).toBe("none");
    expect(visibleInBox(wrapped.plan, "/data/cache")).toBe("none");
  });
});

// On, the box's gates listen on unix sockets, which Windows refuses at a file path (box.test.ts says the same).
describe.skipIf(process.platform === "win32")("BotBox.start", () => {
  const boxes: BotBox[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const box of boxes.splice(0)) await box.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const started = async (env: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "omb-tool-caches-"));
    dirs.push(root);
    const lines: string[] = [];
    const box = new BotBox();
    boxes.push(box);
    await box.start({ dataDir: join(root, ".openmausbot"), home: root, port: 8799, denyEnv: new Set(), env, log: (line) => lines.push(line), detect: () => ({ box: "bwrap", reason: null, tools: { bwrap: "/usr/bin/bwrap", socat: null } }) });
    return { box, root, lines, wrapped: box.wrap({ command: "/usr/bin/codex", args: [], env: { PATH: "/usr/bin" } })! };
  };

  it("reads the switch from the server's environment: a Cloud home with it on adds the variables and says so once", async () => {
    const on = await started({ OMB_CLOUD_ROLE: "home", OMB_CACHE_ROOT: "on" });
    expect(on.wrapped.env.npm_config_cache).toBe(join(on.root, "cache", "npm"));
    expect(on.lines).toContain("bot box: tool caches go to the cache folder in each box's HOME (OMB_CACHE_ROOT)");
    for (const env of [{}, { OMB_CLOUD_ROLE: "home" }, { OMB_CACHE_ROOT: "on" }] as Record<string, string>[]) {
      const off = await started(env);
      for (const name of cacheNames) expect(off.wrapped.env[name], `${JSON.stringify(env)} ${name}`).toBeUndefined();
      expect(off.lines.some((line) => line.includes("tool caches"))).toBe(false);
    }
  });
});
