import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { claudeEduMount, compareVersions, EDU_PREALLOWED_TOOLS, createEduBrains, eduAreaFolder, eduBrainWidens, eduNoPersonalHome, eduRegistryHome, locateEduCli, parseEduBrainSetting, type EduBrainDeps, type EduConfig } from "./edu-brain.ts";
import { createEduCloud, EDU_CLOUD_NO_TOKEN, EDU_CLOUD_RELAY_PATH } from "./edu-cloud.ts";
import { parseStoredConfig } from "./config.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const temps: string[] = [];
const temp = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "edu-brain-"))); temps.push(dir); return dir; };
afterEach(async () => { await Promise.all(temps.splice(0).map((dir) => removeTempDir(dir))); vi.restoreAllMocks(); });

describe("eduBrain setting", () => {
  it("accepts off, own and an absolute folder, and null as the default", () => {
    expect(parseEduBrainSetting({ mode: "off" })).toEqual({ ok: true, value: { mode: "off" } });
    expect(parseEduBrainSetting({ mode: "own", extra: 1 })).toEqual({ ok: true, value: { mode: "own" } });
    expect(parseEduBrainSetting(null)).toEqual({ ok: true, value: undefined });
    const folder = join(tmpdir(), "area", "..", "bi");
    expect(parseEduBrainSetting({ mode: "folder", path: ` ${folder} ` })).toEqual({ ok: true, value: { mode: "folder", path: join(tmpdir(), "bi") } });
  });

  it("refuses a relative or empty folder and unknown modes", () => {
    for (const value of [{ mode: "folder", path: "brains/bi" }, { mode: "folder", path: "" }, { mode: "folder" }, { mode: "global" }, "own", []]) {
      expect(parseEduBrainSetting(value).ok, JSON.stringify(value)).toBe(false);
    }
  });

  it("counts giving a brain or another folder as widening, never turning it off", () => {
    const folder = (path: string) => ({ mode: "folder" as const, path });
    expect(eduBrainWidens({ mode: "off" }, { mode: "own" })).toBe(true);
    expect(eduBrainWidens({ mode: "off" }, undefined)).toBe(true);
    expect(eduBrainWidens(undefined, folder("/a"))).toBe(true);
    expect(eduBrainWidens(folder("/a"), folder("/b"))).toBe(true);
    expect(eduBrainWidens(folder("/a"), folder("/a"))).toBe(false);
    expect(eduBrainWidens(folder("/a"), { mode: "own" })).toBe(false);
    expect(eduBrainWidens(undefined, { mode: "off" })).toBe(false);
  });

  it("accepts an area brain by key and a cloud brain with an address and a token's name, never the token", () => {
    expect(parseEduBrainSetting({ mode: "area", area: "bi" })).toEqual({ ok: true, value: { mode: "area", area: "bi" } });
    expect(parseEduBrainSetting({ mode: "area", area: "bi", personalBrain: false })).toEqual({ ok: true, value: { mode: "area", area: "bi", personalBrain: false } });
    expect(parseEduBrainSetting({ mode: "cloud", url: "https://brain.example/mcp", token: { secret: "EDU_CLOUD_BI" } }))
      .toEqual({ ok: true, value: { mode: "cloud", url: "https://brain.example/mcp", token: { secret: "EDU_CLOUD_BI" } } });
    expect(parseEduBrainSetting({ mode: "cloud", url: "http://127.0.0.1:8787/mcp", token: { env: "EDU_CLOUD_TOKEN" } }).ok).toBe(true);
    for (const value of [
      { mode: "area" }, { mode: "area", area: "../bi" }, { mode: "area", area: "BI" }, { mode: "area", area: "bi", personalBrain: true },
      { mode: "cloud", url: "http://brain.example/mcp", token: { secret: "T" } }, { mode: "cloud", url: "https://u:p@brain.example/mcp", token: { secret: "T" } },
      { mode: "cloud", url: "https://brain.example/mcp?x=1", token: { secret: "T" } }, { mode: "cloud", url: "https://brain.example/mcp", token: "a".repeat(64) },
      { mode: "cloud", url: "https://brain.example/mcp", token: { secret: "T", env: "E" } }, { mode: "cloud", url: "https://brain.example/mcp" },
    ]) expect(parseEduBrainSetting(value).ok, JSON.stringify(value)).toBe(false);
  });

  it("counts joining an area or a cloud brain, another one, or the personal brain beside an area as widening", () => {
    const area = (key: string, personalBrain?: false) => ({ mode: "area" as const, area: key, ...(personalBrain === false ? { personalBrain } : {}) });
    const cloud = (url: string, secret = "T") => ({ mode: "cloud" as const, url, token: { secret } });
    expect(eduBrainWidens(undefined, area("bi"))).toBe(true);
    expect(eduBrainWidens(area("bi"), area("sales"))).toBe(true);
    expect(eduBrainWidens(area("bi"), area("bi"))).toBe(false);
    expect(eduBrainWidens(area("bi"), area("bi", false))).toBe(false);
    expect(eduBrainWidens(area("bi", false), area("bi"))).toBe(true);
    expect(eduBrainWidens(area("bi"), { mode: "own" })).toBe(false);
    expect(eduBrainWidens(undefined, cloud("https://a/mcp"))).toBe(true);
    expect(eduBrainWidens(cloud("https://a/mcp"), cloud("https://a/mcp"))).toBe(false);
    expect(eduBrainWidens(cloud("https://a/mcp"), cloud("https://b/mcp"))).toBe(true);
    expect(eduBrainWidens(cloud("https://a/mcp"), cloud("https://a/mcp", "OTHER"))).toBe(true);
    expect(eduBrainWidens(cloud("https://a/mcp"), { mode: "off" })).toBe(false);
  });

  it("compares versions numerically", () => {
    expect(compareVersions("6.0.0", "6.0.0")).toBe(0);
    expect(compareVersions("10.0.0", "6.0.0")).toBeGreaterThan(0);
    expect(compareVersions("5.9.12", "6.0.0")).toBeLessThan(0);
  });
});

describe("locateEduCli", () => {
  it.skipIf(process.platform === "win32")("follows npm's bin link to the script", () => {
    const prefix = temp();
    const script = join(prefix, "lib", "node_modules", "edu-agent", "dist", "cli.js");
    mkdirSync(join(script, ".."), { recursive: true });
    writeFileSync(script, "#!/usr/bin/env node\n");
    mkdirSync(join(prefix, "bin"));
    symlinkSync(script, join(prefix, "bin", "edu"));
    expect(locateEduCli({}, join(prefix, "bin"), "linux")).toBe(script);
  });

  it.skipIf(process.platform === "win32")("finds the package beside a shell wrapper", () => {
    const prefix = temp();
    const script = join(prefix, "lib", "node_modules", "edu-agent", "dist", "cli.js");
    mkdirSync(join(script, ".."), { recursive: true });
    writeFileSync(script, "");
    mkdirSync(join(prefix, "bin"));
    writeFileSync(join(prefix, "bin", "edu"), "#!/bin/sh\nexec mise x -- edu \"$@\"\n");
    chmodSync(join(prefix, "bin", "edu"), 0o755);
    expect(locateEduCli({}, [join(prefix, "missing"), join(prefix, "bin")].join(delimiter), "linux")).toBe(script);
  });

  it.skipIf(process.platform === "win32")("finds the package next to npm's Windows shim", () => {
    const prefix = temp();
    const script = join(prefix, "node_modules", "edu-agent", "dist", "cli.js");
    mkdirSync(join(script, ".."), { recursive: true });
    writeFileSync(script, "");
    writeFileSync(join(prefix, "edu"), "@ECHO off\n");
    expect(locateEduCli({}, prefix, "win32")).toBe(script);
  });

  it("takes OMB_EDU_CLI when it names an existing absolute file, and nothing else then", () => {
    const dir = temp();
    writeFileSync(join(dir, "cli.js"), "");
    expect(locateEduCli({ OMB_EDU_CLI: join(dir, "cli.js") }, "")).toBe(join(dir, "cli.js"));
    expect(locateEduCli({ OMB_EDU_CLI: join(dir, "gone.js") }, "")).toBeNull();
    expect(locateEduCli({ OMB_EDU_CLI: "cli.js" }, "")).toBeNull();
    expect(locateEduCli({}, join(dir, "empty"))).toBeNull();
  });
});

describe("createEduBrains", () => {
  const bot = { id: "b1", name: "Luna" };
  const setup = (options: { version?: string; fail?: boolean; cli?: string | null; config?: EduConfig; initMakesBrain?: boolean; hostLocal?: boolean; cloud?: EduBrainDeps["cloud"] } = {}) => {
    const dataDir = temp();
    const calls: string[][] = [];
    const initHomes: Array<string | undefined> = [];
    let config: EduConfig | undefined = options.config;
    const brains = createEduBrains({
      dataDir,
      config: () => config,
      env: { HOME: dataDir },
      hostLocal: () => options.hostLocal ?? true,
      ...(options.cloud ? { cloud: options.cloud } : {}),
      locate: () => options.cli === undefined ? "/opt/edu/cli.js" : options.cli,
      run: () => async (args, { env }) => {
        calls.push(args);
        if (args.includes("init")) initHomes.push(env.EDU_HOME);
        if (options.fail) throw new Error("edu crashed");
        if (args[0] === "--version") return `${options.version ?? "6.0.0"}\n`;
        if (args.includes("init") && options.initMakesBrain !== false) mkdirSync(join(args[1]!, ".edu"), { recursive: true });
        return "";
      },
    });
    return { brains, dataDir, calls, initHomes, setConfig: (next: EduConfig | undefined) => { config = next; } };
  };

  it("creates a bot's own brain once and mounts edu mcp locked to it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { brains, dataDir, calls, initHomes } = setup();
    const [first, second] = await Promise.all([brains.integration(bot, { local: true }), brains.integration(bot, { local: true })]);
    const folder = join(dataDir, "brains", "b1");
    expect(first).toEqual({
      command: process.execPath,
      args: ["/opt/edu/cli.js", "--cwd", folder, "mcp", "--profile", "memory"],
      env: { ELECTRON_RUN_AS_NODE: "1", EDU_LOCK_WORKSPACE: "1", EDU_HOME: join(dataDir, ".edu") },
    });
    expect(second).toEqual(first);
    expect(calls.filter((args) => args.includes("init"))).toEqual([["--cwd", folder, "init", "--name", "Luna"]]);
    expect(initHomes).toEqual([eduRegistryHome(dataDir)]);
    expect(await brains.status(bot)).toMatchObject({ state: "ready", mode: "own", brain: folder, version: "6.0.0" });
  });

  it("shares one area brain between the area's bots, made once, and leaves the person's own brain out when the area says so", async () => {
    const { brains, dataDir, calls } = setup();
    const analyst = { id: "b1", name: "Analyst", eduBrain: { mode: "area" as const, area: "bi" } };
    const reporter = { id: "b2", name: "Reporter", eduBrain: { mode: "area" as const, area: "bi", personalBrain: false as const } };
    const [first, second] = await Promise.all([brains.integration(analyst, { local: true }), brains.integration(reporter, { local: true })]);
    const folder = eduAreaFolder(dataDir, "bi");
    expect(calls.filter((args) => args.includes("init"))).toEqual([["--cwd", folder, "init", "--name", "Area bi"]]);
    expect(first).toMatchObject({ args: ["/opt/edu/cli.js", "--cwd", folder, "mcp", "--profile", "memory"], env: { EDU_HOME: join(dataDir, ".edu") } });
    expect(second).toMatchObject({ args: ["/opt/edu/cli.js", "--cwd", folder, "mcp", "--profile", "memory"], env: { EDU_HOME: eduNoPersonalHome(dataDir) } });
    expect(brains.brainKey(reporter)).toBe(folder);
    expect(await brains.status(analyst)).toMatchObject({ state: "ready", mode: "area", brain: folder, home: join(dataDir, ".edu") });
    expect(await brains.status(reporter)).toMatchObject({ state: "ready", mode: "area", brain: folder, home: "", personalBrain: false });
    const brief = calls.length;
    await brains.promptParts(reporter, {}, true);
    const briefed = calls.slice(brief).find((args) => args.includes("brief"));
    expect(briefed).toEqual(["--cwd", folder, "brief", "--json"]);
  });

  it("never lets an area bot use another area's folder or a link in its place", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { brains, dataDir } = setup();
    const other = eduAreaFolder(dataDir, "sales");
    mkdirSync(join(other, ".edu"), { recursive: true });
    mkdirSync(join(dataDir, "brains", "areas"), { recursive: true });
    symlinkSync(other, eduAreaFolder(dataDir, "bi"));
    expect(await brains.integration({ id: "b1", eduBrain: { mode: "area", area: "bi" } }, { local: true })).toBeNull();
    expect(brains.folderRefusal({ id: "b1" }, other)).toMatch(/inside Edu Bot's data folder/);
  });

  it("mounts a cloud brain as Edu Bot's relay with the turn's capability, never the person's token, and nothing without one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tokens: Record<string, string> = { EDU_CLOUD_BI: "t".repeat(40) };
    const minted: Array<{ id: string; threadId: string; generation: string }> = [];
    const cloud = createEduCloud({ token: (_bot, ref) => "secret" in ref ? tokens[ref.secret] ?? null : null,
      relay: { origin: "http://127.0.0.1:4100", mint: (bot, turn) => (minted.push({ id: bot.id, ...turn }), "c".repeat(48)) } });
    const { brains, calls } = setup({ cli: null, cloud: { ...cloud, brief: async () => JSON.stringify({ text: "## Decisions\n- BI closes on Friday\n" }) } });
    const closer = { id: "b3", name: "Closer", eduBrain: { mode: "cloud" as const, url: "https://brain.example/mcp", token: { secret: "EDU_CLOUD_BI" } } };
    const turn = { threadId: "t-close", generation: "g-1" };
    const server = await brains.integration(closer, { local: true, turn });
    expect(server?.command).toBe(process.execPath);
    expect(server?.args.join(" ")).toMatch(/mcp-remote-proxy/);
    expect(JSON.parse(server!.env.OMB_REMOTE_MCP_SERVER!)).toEqual({ type: "http", url: `http://127.0.0.1:4100${EDU_CLOUD_RELAY_PATH}`, headers: { authorization: `Bearer ${"c".repeat(48)}` } });
    expect(minted).toEqual([{ id: "b3", ...turn }]);
    expect(JSON.stringify(server)).not.toContain(tokens.EDU_CLOUD_BI);
    expect(JSON.stringify(server)).not.toContain("brain.example");
    expect(await brains.integration(closer, { local: true }), "outside a running turn").toBeNull();
    expect(await brains.integration(closer, { local: false, turn })).toBeNull();
    expect(await brains.status(closer)).toEqual({ state: "ready", mode: "cloud", home: "", brain: "https://brain.example/mcp" });
    expect(brains.brainFolder(closer)).toBeNull();
    expect(brains.brainKey(closer)).toBe("https://brain.example/mcp");
    const parts = await brains.promptParts(closer, {}, true);
    expect(parts.find((part) => part.id === "edu-brief")?.text).toContain("BI closes on Friday");
    expect(calls).toEqual([]);

    tokens.EDU_CLOUD_BI = "short";
    expect(await brains.integration(closer, { local: true, turn })).toBeNull();
    expect(await brains.status(closer)).toMatchObject({ state: "broken", reason: EDU_CLOUD_NO_TOKEN });
  });

  it("reads as ready right away only after a check found Edu ready on this computer", async () => {
    const ready = setup();
    expect(ready.brains.readyNow()).toBe(false);
    await ready.brains.detect();
    expect(ready.brains.readyNow()).toBe(true);
    ready.setConfig({ enabled: false });
    expect(ready.brains.readyNow()).toBe(false);
    for (const options of [{ cli: null }, { version: "5.9.0" }, { hostLocal: false }]) {
      const other = setup(options);
      await other.brains.detect();
      expect(other.brains.readyNow(), JSON.stringify(options)).toBe(false);
    }
  });

  it("mounts nothing, and never throws, when Edu is missing, old, broken or off", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const [options, state] of [[{ cli: null }, "missing"], [{ version: "5.0.1" }, "old"], [{ fail: true }, "broken"],
      [{ config: { enabled: false } }, "off"], [{ config: { home: "relative/brain" } }, "broken"]] as const) {
      const { brains } = setup(options);
      expect(await brains.integration(bot, { local: true }), state).toBeNull();
      expect((await brains.status(bot)).state, JSON.stringify(options)).toBe(state);
    }
  });

  it("mounts nothing for a turn that does not run on this computer, or a bot with Edu off", async () => {
    const { brains, calls } = setup();
    expect(await brains.integration(bot, { local: false })).toBeNull();
    expect(await brains.integration({ ...bot, eduBrain: { mode: "off" } }, { local: true })).toBeNull();
    expect(calls.filter((args) => args.includes("init"))).toEqual([]);
    expect(await brains.status({ ...bot, eduBrain: { mode: "off" } })).toMatchObject({ state: "off", mode: "off" });
  });

  it("uses a shared folder only when it already holds a brain", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { brains, calls } = setup();
    const area = temp();
    const shared = { ...bot, eduBrain: { mode: "folder" as const, path: area } };
    expect(await brains.integration(shared, { local: true })).toBeNull();
    expect(await brains.status(shared)).toMatchObject({ state: "broken", mode: "folder", brain: area });
    mkdirSync(join(area, ".edu"));
    expect((await brains.integration(shared, { local: true }))?.args).toEqual(["/opt/edu/cli.js", "--cwd", area, "mcp", "--profile", "memory"]);
    expect(calls.filter((args) => args.includes("init"))).toEqual([]);
  });

  it("does not mount when edu init leaves no brain, which would write to the global one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { brains } = setup({ initMakesBrain: false });
    expect(await brains.integration(bot, { local: true })).toBeNull();
  });

  it("never mounts or inits through a linked .edu, a linked own folder, the global brain or another bot's brain", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { brains, dataDir, calls } = setup();
    const elsewhere = temp();
    mkdirSync(join(elsewhere, ".edu"));
    mkdirSync(join(dataDir, "brains", "b1"), { recursive: true });
    symlinkSync(join(elsewhere, ".edu"), join(dataDir, "brains", "b1", ".edu"));
    expect(await brains.integration(bot, { local: true })).toBeNull();
    expect(await brains.status(bot)).toMatchObject({ state: "broken", reason: expect.stringMatching(/link/) });
    rmSync(join(dataDir, "brains", "b1"), { recursive: true });
    symlinkSync(elsewhere, join(dataDir, "brains", "b1"));
    expect(await brains.integration(bot, { local: true })).toBeNull();
    const globalHome = join(dataDir, ".edu");
    mkdirSync(globalHome);
    mkdirSync(join(dataDir, "brains", "b2", ".edu"), { recursive: true });
    for (const path of [dataDir, globalHome, join(dataDir, "brains", "b2")]) {
      expect(await brains.integration({ ...bot, eduBrain: { mode: "folder", path } }, { local: true }), path).toBeNull();
    }
    expect(calls.filter((args) => args.includes("init"))).toEqual([]);
    expect(brains.folderRefusal(bot, join(dataDir, "brains", "b1"))).toBeNull();
  });

  it("never mounts a brain whose .edu/brain is a link out of the folder, and keeps one that stays inside", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { brains } = setup();
    const folder = temp();
    const victim = temp();
    mkdirSync(join(victim, "brain"), { recursive: true });
    mkdirSync(join(folder, ".edu"), { recursive: true });
    symlinkSync(join(victim, "brain"), join(folder, ".edu", "brain"));
    const linked = { ...bot, eduBrain: { mode: "folder" as const, path: folder } };
    expect(brains.folderRefusal(linked, folder)).toMatch(/\.edu\/brain is a link/);
    expect(await brains.integration(linked, { local: true })).toBeNull();
    expect(await brains.status(linked)).toMatchObject({ state: "broken", reason: expect.stringMatching(/\.edu\/brain is a link/) });
    rmSync(join(folder, ".edu", "brain"));
    mkdirSync(join(folder, "notes"));
    symlinkSync(join(folder, "notes"), join(folder, ".edu", "brain"));
    expect(brains.folderRefusal(linked, folder)).toBeNull();
  });

  it("attaches only for an engine that mounts Edu and a turn on this computer", async () => {
    const { brains } = setup();
    const turn = async (capabilities: { eduMcp?: boolean }, where: { computer?: string | null; confined?: boolean }, hostLocal = brains) => {
      const integrations: Parameters<typeof brains.attach>[0] = {};
      await hostLocal.attach(integrations, bot, capabilities, where);
      return integrations.edu !== undefined;
    };
    expect(await turn({ eduMcp: true }, { computer: "local" })).toBe(true);
    expect(await turn({ eduMcp: true }, { computer: null })).toBe(true);
    expect(await turn({}, { computer: "local" })).toBe(false);
    expect(await turn({ eduMcp: true }, { computer: "box" })).toBe(false);
    expect(await turn({ eduMcp: true }, { computer: "vps" })).toBe(false);
    expect(await turn({ eduMcp: true }, { confined: true })).toBe(false);
    expect(await turn({ eduMcp: true }, {}, setup({ hostLocal: false }).brains)).toBe(false);
  });

  it("follows config.json: enabled false mounts nothing, and home is the global brain", async () => {
    const { brains, calls, dataDir, setConfig } = setup();
    setConfig(parseStoredConfig({ edu: { enabled: false } }).edu);
    expect(await brains.integration(bot, { local: true })).toBeNull();
    expect(calls).toEqual([]);
    setConfig(parseStoredConfig({ edu: { home: join(dataDir, "global") } }).edu);
    expect((await brains.integration(bot, { local: true }))?.env.EDU_HOME).toBe(join(dataDir, "global"));
    expect(await brains.status(bot)).toMatchObject({ state: "ready", home: join(dataDir, "global") });
  });

  it("serves the configured global brain, ~ included", async () => {
    const { brains, dataDir, setConfig } = setup();
    setConfig({ home: "~/brains/global" });
    expect((await brains.integration(bot, { local: true }))?.env.EDU_HOME).toBe(join(dataDir, "brains", "global"));
  });
});

describe("claudeEduMount", () => {
  const edu = { command: "node", args: ["cli.js"], env: { EDU_LOCK_WORKSPACE: "1" } };

  it("guards the engine and clears the guard for the edu server only", () => {
    expect(claudeEduMount(edu, "b1", {})).toEqual({
      server: { ...edu, env: { EDU_LOCK_WORKSPACE: "1", EDU_CREW_JOB: "" } },
      engineEnv: { EDU_CREW_JOB: "edu-bot:b1" },
      allowed: EDU_PREALLOWED_TOOLS.map((tool) => `mcp__edu__${tool}`),
    });
  });

  it("keeps a guard Edu Bot inherited for both", () => {
    expect(claudeEduMount(edu, "b1", { EDU_CREW_JOB: "job-7" })).toEqual({ server: edu, engineEnv: {}, allowed: expect.any(Array) });
  });
});
