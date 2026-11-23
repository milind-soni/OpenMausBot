import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BotBox, BoxRunner, BOX_EGRESS_PORT } from "./box.ts";
import { visibleInBox } from "./plan.ts";
import { CACHE_TAG, CACHE_TAG_FILE, TOOL_CACHES, ensureToolCacheRoot, hasCacheTag, toolCacheEnvironment, toolCacheRoot, toolCachesOn } from "./tool-caches.ts";
import { engineInstallRoots } from "../engine-roots.ts";
import { memberAudience } from "../audience.ts";
import { audienceHome } from "../engine-homes/layout.ts";

const bridge = { socat: "/usr/bin/socat", bridgeScript: "/app/dist-server/bot-box/box-bridge.js", node: "/usr/local/bin/node" };
const dataDir = "/data/.openmausbot", home = "/data";
const setup = { dataDir, home, codeRoots: ["/app"], engineRoots: engineInstallRoots(dataDir), bridges: [{ name: "egress", port: BOX_EGRESS_PORT, socket: "/data/.openmausbot/box/egress.sock" }] };
const turn = { command: "/usr/local/bin/claude", args: ["-p"], cwd: join(dataDir, "task-workspaces", "b1", "t1"), env: { PATH: "/usr/bin", HOME: home, ANTHROPIC_API_KEY: "k" } };
// The cache folder is made on a real disk only in the BotBox.start tests below; here every HOME's is the server's.
const runner = (toolCaches?: boolean, cacheRoot: (root: string) => boolean | null = () => true) =>
  new BoxRunner({ bwrap: "/usr/bin/bwrap", bridge, setup, denyEnv: new Set(), cacheRoot, ...(toolCaches === undefined ? {} : { toolCaches }) });
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

  it("off, the cache folder is never looked at or made", () => {
    const asked: string[] = [];
    for (const toolCaches of [undefined, false]) runner(toolCaches, (root) => { asked.push(root); return true; }).wrap(turn);
    expect(asked).toEqual([]);
  });

  it("the bubblewrap arguments are the same with the switch on or off: no mount is added, a personal or a Team HOME", () => {
    const member = audienceHome(dataDir, memberAudience("ana@example.com"));
    for (const request of [turn, { ...turn, home: member, env: { ...turn.env, HOME: member } }]) {
      const on = runner(true).wrap(request), off = runner(false).wrap(request);
      expect(on.env.npm_config_cache).toBeDefined();
      expect(on.args).toEqual(off.args);
      expect(on.plan).toEqual(off.plan);
    }
  });

  it("on, a HOME whose cache folder the server did not make keeps every tool's own place; each folder is asked once", () => {
    const asked: string[] = [];
    const theirs = runner(true, (root) => { asked.push(root); return false; });
    for (let i = 0; i < 3; i++) for (const name of cacheNames) expect(theirs.wrap(turn).env[name], name).toBeUndefined();
    expect(asked).toEqual([toolCacheRoot(home)]);
    // A HOME that is not there yet is asked again on the next spawn, not given up on.
    let ready: boolean | null = null;
    const later = runner(true, () => ready);
    expect(later.wrap(turn).env.npm_config_cache).toBeUndefined();
    ready = true;
    expect(later.wrap(turn).env.npm_config_cache).toBe(join(toolCacheRoot(home), "npm"));
  });

  it("on, every cache variable names its folder in the box HOME's cache folder", () => {
    const env = runner(true).wrap(turn).env;
    const root = toolCacheRoot(home);
    expect(root).toBe(join(resolve(home), "cache"));
    expect(env).toMatchObject({
      npm_config_cache: join(root, "npm"), PIP_CACHE_DIR: join(root, "pip"), UV_CACHE_DIR: join(root, "uv"),
      HF_HUB_CACHE: join(root, "huggingface", "hub"), HF_XET_CACHE: join(root, "huggingface", "xet"),
      BUN_INSTALL_CACHE_DIR: join(root, "bun"),
    });
    expect(Object.keys(env).filter((name) => cacheNames.includes(name)).sort()).toEqual([...cacheNames].sort());
    for (const name of cacheNames) expect(env[name], name).toBeDefined();
    // Nothing that holds a sign-in or installed programs is moved.
    // Nor a browser (a Playwright MCP profile may sit beside its builds; a project's .puppeteerrc names its own), nor Go's
    // module cache (a project may build offline from it).
    for (const name of ["XDG_CACHE_HOME", "HF_HOME", "CARGO_HOME", "GRADLE_USER_HOME", "PNPM_HOME", "UV_TOOL_DIR", "UV_PYTHON_INSTALL_DIR", "npm_config_store_dir", "PLAYWRIGHT_BROWSERS_PATH", "PUPPETEER_CACHE_DIR", "GOMODCACHE", "GOPATH", "GOCACHE", "COREPACK_HOME"]) expect(env[name], name).toBeUndefined();
    expect(env.HOME).toBe(home);
  });

  it("on, the person's own value wins: one the engine's saved settings pass in, npm's in any letter case", () => {
    const env = runner(true).wrap({
      ...turn, env: { ...turn.env, UV_CACHE_DIR: "/data/my-uv", NPM_CONFIG_CACHE: "/data/my-npm", HF_HUB_CACHE: "/data/hf-hub" },
      allowEnv: ["UV_CACHE_DIR", "HF_HUB_CACHE"],
    }).env;
    expect(env.UV_CACHE_DIR).toBe("/data/my-uv");
    expect(env.HF_HUB_CACHE).toBe("/data/hf-hub");
    expect(env.NPM_CONFIG_CACHE).toBe("/data/my-npm");
    expect(env.npm_config_cache).toBeUndefined();
    expect(env.PIP_CACHE_DIR).toBe(join(toolCacheRoot(home), "pip"));
  });

  it("on, a variable that already decides a cache's place leaves that cache alone", () => {
    const env = runner(true).wrap({ ...turn, env: { ...turn.env, XDG_CACHE_HOME: "/data/xdg", HF_HOME: "/data/hf", GOPATH: "/data/go", BUN_INSTALL: "/data/.bun" }, allowEnv: ["HF_HOME", "GOPATH", "BUN_INSTALL"] }).env;
    for (const name of ["PIP_CACHE_DIR", "UV_CACHE_DIR", "HF_HUB_CACHE", "HF_XET_CACHE", "BUN_INSTALL_CACHE_DIR"]) expect(env[name], name).toBeUndefined();
    expect(env.npm_config_cache).toBe(join(toolCacheRoot(home), "npm"));
  });

  it("on, a value the spawn was handed wins even where the allow-list would drop it: an engine's own environment that does not vouch", () => {
    // Claude's and Codex's drivers merge the instance's environment into the spawn's without allowEnv; on a Cloud home the
    // server's own environment never carries these names, so one here is the person's or the engine's.
    const env = runner(true).wrap({ ...turn, env: { ...turn.env, PIP_CACHE_DIR: "/data/my-pip", HF_HOME: "/data/hf" } }).env;
    expect(env.PIP_CACHE_DIR).toBe("/data/my-pip");
    // A parent that decides a cache's place is not passed in, but its cache is left to the tool's default under it.
    expect(env.HF_HOME).toBeUndefined();
    expect(env.HF_HUB_CACHE).toBeUndefined();
    expect(env.HF_XET_CACHE).toBeUndefined();
    expect(env.UV_CACHE_DIR).toBe(join(toolCacheRoot(home), "uv"));
  });

  it("toolCacheEnvironment adds nothing a set name covers and never touches the given environment", () => {
    const given = { npm_config_cache: "/x", HOME: home };
    const added = toolCacheEnvironment(home, given);
    expect(added.npm_config_cache).toBeUndefined();
    expect(given).toEqual({ npm_config_cache: "/x", HOME: home });
    expect(toolCacheEnvironment(home, { npm_config_cache: "" }).npm_config_cache).toBe(join(toolCacheRoot(home), "npm"));
    expect(toolCacheEnvironment(home, {}, { PIP_CACHE_DIR: "/data/pp" }).PIP_CACHE_DIR).toBe("/data/pp");
    expect(toolCacheEnvironment(home, { PIP_CACHE_DIR: "/data/kept" }, { PIP_CACHE_DIR: "/data/pp" }).PIP_CACHE_DIR).toBeUndefined();
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
    // The folder is made on the first spawn, with the server's mark.
    expect(readFileSync(join(on.root, "cache", CACHE_TAG_FILE), "utf8")).toBe(CACHE_TAG);
    expect(on.lines).toContain("bot box: tool caches go to the cache folder in each box's HOME (OMB_CACHE_ROOT)");
    for (const env of [{}, { OMB_CLOUD_ROLE: "home" }, { OMB_CACHE_ROOT: "on" }] as Record<string, string>[]) {
      const off = await started(env);
      for (const name of cacheNames) expect(off.wrapped.env[name], `${JSON.stringify(env)} ${name}`).toBeUndefined();
      expect(off.lines.some((line) => line.includes("tool caches"))).toBe(false);
      expect(existsSync(join(off.root, "cache"))).toBe(false);
    }
  });
});

describe("the cache folder the server makes", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "omb-cache-root-")); dirs.push(dir); return dir; };

  it("is made and marked when HOME has none, and is the server's on every later start", () => {
    const home = scratch(), root = toolCacheRoot(home);
    expect(ensureToolCacheRoot(root)).toBe(true);
    expect(readFileSync(join(root, CACHE_TAG_FILE), "utf8")).toBe(CACHE_TAG);
    expect(hasCacheTag(root)).toBe(true);
    expect(ensureToolCacheRoot(root)).toBe(true);
  });

  it("an empty cache folder without the mark (a start that stopped before writing it) is marked and the server's", () => {
    const home = scratch(), root = toolCacheRoot(home);
    mkdirSync(root);
    expect(ensureToolCacheRoot(root)).toBe(true);
    expect(readFileSync(join(root, CACHE_TAG_FILE), "utf8")).toBe(CACHE_TAG);
  });

  it("a cache folder the person made stays theirs: nothing is written in it, even a CACHEDIR.TAG of another tool", () => {
    const home = scratch(), root = toolCacheRoot(home);
    mkdirSync(root);
    writeFileSync(join(root, "notes.md"), "mine");
    expect(ensureToolCacheRoot(root)).toBe(false);
    expect(existsSync(join(root, CACHE_TAG_FILE))).toBe(false);
    writeFileSync(join(root, CACHE_TAG_FILE), "Signature: 8a477f597d28d172789f06886806bc55\n");
    expect(ensureToolCacheRoot(root)).toBe(false);
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("mine");
  });

  it("a HOME that is not there yet is neither made nor given up on", () => {
    const missing = join(scratch(), "not-yet");
    expect(ensureToolCacheRoot(toolCacheRoot(missing))).toBeNull();
    expect(existsSync(missing)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("a link named cache is never the server's, wherever it points", () => {
    const home = scratch(), elsewhere = join(home, "elsewhere");
    expect(ensureToolCacheRoot(join(elsewhere))).toBe(true);
    symlinkSync(elsewhere, toolCacheRoot(home));
    expect(ensureToolCacheRoot(toolCacheRoot(home))).toBe(false);
  });
});
