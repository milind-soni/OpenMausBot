// Edu (https://github.com/EduardoMoraga/edu) is a separate CLI. This module finds it, keeps a brain per bot and builds the
// stdio spec that mounts `edu mcp` in a turn. Nothing here may throw into a turn: a missing or broken Edu means no mount.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import type { EduBrainSetting, EduState } from "../shared/edu-brain.ts";
import { canUseMcpServer } from "../shared/tool-scope.ts";
import { createBriefCache, EDU_BRIEF_TIMEOUT_MS, eduBriefText, eduPromptParts } from "./edu-brief.ts";
import { augmentedPath, findCliCandidates, resolveCliSpawn, userHome } from "./env-path.ts";
import { AGENTS_NODE_FLAG } from "./proxy-paths.ts";
import { isInside, resolveThroughLinks } from "./sentinel/paths.ts";
import type { PromptPart } from "./system-prompt.ts";

export const EDU_MIN_VERSION = "6.0.0";

/** Edu 6.0.0 tools that only read, or write episodic/transitive notes and canonical proposals (never accepted notes). */
export const EDU_PREALLOWED_TOOLS = [
  "edu_brief", "edu_recall", "edu_read", "edu_commitments", "edu_capabilities", "edu_projects",
  "edu_remember", "edu_feedback", "edu_propose_canonical", "edu_session_open", "edu_session_close",
] as const;

export type { EduState };

export interface EduRuntime {
  state: EduState;
  /** The global brain bots read as an overlay. */
  home: string;
  version?: string;
  reason?: string;
  cli?: string;
}

export interface EduBrainStatus extends EduRuntime {
  mode: EduBrainSetting["mode"];
  /** The folder whose `.edu` is this bot's brain. */
  brain?: string;
  /** With `broken`: Edu works, and the brain folder is what it can't use. */
  brokenFolder?: boolean;
}

export interface EduStdioServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface EduBot {
  id: string;
  name?: string;
  eduBrain?: EduBrainSetting;
  toolScope?: unknown;
}

/** `config.json` `edu`. */
export interface EduConfig {
  enabled?: boolean;
  home?: string;
}

type Run = (args: string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string>;

export interface EduBrainDeps {
  dataDir: string;
  config(): EduConfig | undefined;
  /** Whether turns run on this computer at all: not on a cloud home or inside the bot box. */
  hostLocal?(): boolean;
  env?: NodeJS.ProcessEnv;
  /** The CLI's script, or null when none is installed; defaults to a lookup on the app's PATH. */
  locate?(): string | null;
  /** Runs the script with Node; defaults to this process's runtime. */
  run?(cli: string): Run;
  now?(): number;
  /** A turn starting in `threadId` got this bot's brain in `folder` mounted, or none (`null`). */
  mounted?(threadId: string, bot: EduBot, folder: string | null): void;
}

const RECHECK_MS = 30_000;
const VERSION_TIMEOUT_MS = 10_000;
const INIT_TIMEOUT_MS = 30_000;
const BOT_ID = /^[\w-]{1,128}$/;
const SCRIPT = /\.[cm]?js$/i;

/** Where `edu init` registers the bots' own brains, so they never appear in the person's global `projects.json`. */
export function eduRegistryHome(dataDir: string): string {
  return join(dataDir, "edu-registry");
}

export interface EduFolderLimits {
  dataDir: string;
  globalHome: string;
  botId: string;
}

/** Security: a bot's brain folder, symlinks resolved, is never the global brain or inside it, never in Edu Bot's data
 * folder except the bot's own brain, its `.edu` is never a symlink, and its `.edu/brain` never resolves outside the
 * folder (Edu 6.0.0 writes through either link into another brain). */
export function eduFolderRefusal(folder: string, limits: EduFolderLimits): string | null {
  const real = resolveThroughLinks(folder);
  const globalHome = resolveThroughLinks(limits.globalHome);
  if (isInside(real, globalHome) || resolveThroughLinks(join(real, ".edu")) === globalHome) {
    return "This folder is the global Edu brain; a bot needs a brain of its own";
  }
  const dataDir = resolveThroughLinks(limits.dataDir);
  if (isInside(real, dataDir) && real !== join(dataDir, "brains", limits.botId)) {
    return "This folder is inside Edu Bot's data folder; pick a folder outside it";
  }
  if (isSymlink(join(real, ".edu"))) return "This folder's .edu is a link to another place; use a real .edu folder";
  const notes = join(real, ".edu", "brain");
  if (existsSync(notes) && !isInside(resolveThroughLinks(notes), real)) return "This folder's .edu/brain is a link to another place; use a real brain folder";
  return null;
}

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

export function parseEduBrainSetting(value: unknown): { ok: true; value: EduBrainSetting | undefined } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: undefined };
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (record?.mode === "off" || record?.mode === "own") return { ok: true, value: { mode: record.mode } };
  if (record?.mode === "folder") {
    const path = typeof record.path === "string" ? record.path.trim() : "";
    if (!path || path.length > 4096 || path.includes("\0") || !isAbsolute(path)) {
      return { ok: false, error: "eduBrain.path must be an absolute folder path" };
    }
    return { ok: true, value: { mode: "folder", path: normalize(path) } };
  }
  return { ok: false, error: "eduBrain must be {mode: \"off\"}, {mode: \"own\"} or {mode: \"folder\", path}" };
}

/** Whether `next` gives a bot an Edu brain it did not have, or points it at another folder. */
export function eduBrainWidens(before: EduBrainSetting | undefined, next: EduBrainSetting | undefined): boolean {
  const mode = (setting: EduBrainSetting | undefined) => setting?.mode ?? "own";
  if (mode(next) === "off") return false;
  if (mode(before) === "off") return true;
  return next?.mode === "folder" && (before?.mode !== "folder" || before.path !== next.path);
}

export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
  return 0;
}

function isNodeScript(file: string): boolean {
  if (SCRIPT.test(file)) return true;
  try {
    return /^#!.*\bnode\b/.test(readFileSync(file, "utf8").slice(0, 200).split("\n")[0] ?? "");
  } catch {
    return false;
  }
}

/** The JS entry of an installed `edu`: npm links its bin to `dist/cli.js` on POSIX and writes a `.cmd` shim on Windows. */
export function locateEduCli(env: NodeJS.ProcessEnv = process.env, path: string = augmentedPath(), platform: NodeJS.Platform = process.platform): string | null {
  const explicit = env.OMB_EDU_CLI?.trim();
  if (explicit) return isAbsolute(explicit) && existsSync(explicit) ? explicit : null;
  for (const candidate of findCliCandidates("edu", path)) {
    const packaged = platform === "win32"
      ? join(dirname(candidate), "node_modules", "edu-agent", "dist", "cli.js")
      : join(dirname(candidate), "..", "lib", "node_modules", "edu-agent", "dist", "cli.js");
    if (platform === "win32") {
      const viaShim = resolveCliSpawn(candidate, [], env).args[0];
      if (viaShim && SCRIPT.test(viaShim) && existsSync(viaShim)) return viaShim;
    } else {
      try {
        const real = realpathSync(candidate);
        if (isNodeScript(real)) return real;
      } catch {}
    }
    if (existsSync(packaged)) return packaged;
  }
  return null;
}

function nodeRun(cli: string): Run {
  return (args, { env, timeoutMs }) => new Promise((done, fail) => {
    execFile(process.execPath, [cli, ...args], { env: { ...env, ...AGENTS_NODE_FLAG }, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => error ? fail(new Error(String(stderr || error.message).trim().split("\n").at(-1) || "edu failed")) : done(String(stdout)));
  });
}

function expandHome(path: string, env: NodeJS.ProcessEnv): string {
  return path === "~" || path.startsWith("~/") || path.startsWith("~\\") ? join(userHome(env), path.slice(1)) : path;
}

export function createEduBrains(deps: EduBrainDeps) {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const locate = deps.locate ?? (() => locateEduCli(env));
  const runFor = deps.run ?? nodeRun;
  let cached: { at: number; cli: string | null; mtime: number; runtime: EduRuntime } | null = null;
  const inits = new Map<string, Promise<void>>();
  const briefs = createBriefCache({ now });

  function home(): { ok: true; path: string } | { ok: false; reason: string } {
    const configured = deps.config()?.home?.trim();
    if (configured) {
      const path = expandHome(configured, env);
      return isAbsolute(path) ? { ok: true, path: resolve(path) } : { ok: false, reason: "edu.home in config.json must be an absolute path" };
    }
    return { ok: true, path: resolve(env.EDU_HOME?.trim() || join(userHome(env), ".edu")) };
  }

  function eduEnv(globalHome: string): NodeJS.ProcessEnv {
    return { ...env, EDU_HOME: globalHome };
  }

  function folderRefusal(bot: EduBot, folder: string): string | null {
    const where = home();
    if (!where.ok) return where.reason;
    if (bot.eduBrain?.mode !== "folder" && resolveThroughLinks(folder) !== join(resolveThroughLinks(deps.dataDir), "brains", bot.id)) {
      return "This bot's brain folder is a link to another place";
    }
    return eduFolderRefusal(folder, { dataDir: deps.dataDir, globalHome: where.path, botId: bot.id });
  }

  async function detect(): Promise<EduRuntime> {
    const where = home();
    if (deps.config()?.enabled === false) return { state: "off", home: where.ok ? where.path : "" };
    if (!where.ok) return { state: "broken", home: "", reason: where.reason };
    if (cached && now() - cached.at < RECHECK_MS && cached.runtime.home === where.path) return cached.runtime;
    const cli = locate();
    let mtime = 0;
    try { mtime = cli ? statSync(cli).mtimeMs : 0; } catch {}
    if (cached && cached.cli === cli && cached.mtime === mtime && cached.runtime.home === where.path && cached.runtime.state !== "broken") {
      cached.at = now();
      return cached.runtime;
    }
    let runtime: EduRuntime;
    if (!cli) runtime = { state: "missing", home: where.path, reason: "Edu is not installed" };
    else {
      try {
        const version = /(\d+\.\d+\.\d+)/.exec(await runFor(cli)(["--version"], { env: eduEnv(where.path), timeoutMs: VERSION_TIMEOUT_MS }))?.[1];
        if (!version) runtime = { state: "broken", home: where.path, cli, reason: "edu --version printed no version" };
        else if (compareVersions(version, EDU_MIN_VERSION) < 0) {
          runtime = { state: "old", home: where.path, cli, version, reason: `Edu ${version} is older than ${EDU_MIN_VERSION}` };
        } else runtime = { state: "ready", home: where.path, cli, version };
      } catch (error) {
        runtime = { state: "broken", home: where.path, cli, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    cached = { at: now(), cli, mtime, runtime };
    return runtime;
  }

  function brainFolder(bot: EduBot): string | null {
    const setting = bot.eduBrain ?? { mode: "own" };
    if (setting.mode === "off") return null;
    if (setting.mode === "folder") return setting.path;
    return BOT_ID.test(bot.id) ? join(deps.dataDir, "brains", bot.id) : null;
  }

  const hasBrain = (folder: string) => {
    try { return lstatSync(join(folder, ".edu")).isDirectory(); } catch { return false; }
  };

  /** A brain-less folder would make Edu write to the global brain, so an `own` folder is created first and any other
   * folder must already hold one. The folder is used by its real path, after the refusals. */
  async function ensureBrain(bot: EduBot, runtime: EduRuntime): Promise<{ ok: true; folder: string } | { ok: false; reason: string; folder?: string }> {
    const setting = brainFolder(bot);
    if (!setting) return { ok: false, reason: "Edu brain is off for this bot" };
    const refusal = folderRefusal(bot, setting);
    if (refusal) return { ok: false, folder: setting, reason: refusal };
    const folder = resolveThroughLinks(setting);
    if (hasBrain(folder)) return { ok: true, folder };
    if (bot.eduBrain?.mode === "folder") return { ok: false, folder, reason: "This folder has no Edu brain: run `edu init` in it" };
    let pending = inits.get(folder);
    if (!pending) {
      pending = (async () => {
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const init = ["--cwd", folder, "init", "--name", bot.name?.trim() || "Edu"];
        await runFor(runtime.cli!)(init, { env: eduEnv(eduRegistryHome(deps.dataDir)), timeoutMs: INIT_TIMEOUT_MS });
      })().finally(() => inits.delete(folder));
      inits.set(folder, pending);
    }
    try {
      await pending;
    } catch (error) {
      return { ok: false, folder, reason: error instanceof Error ? error.message : String(error) };
    }
    if (!hasBrain(folder)) return { ok: false, folder, reason: "edu init created no brain" };
    const after = folderRefusal(bot, folder);
    return after ? { ok: false, folder, reason: after } : { ok: true, folder };
  }

  /** This bot's brain folder, created for an `own` brain, with the Edu that serves it; never throws. */
  async function brain(bot: EduBot): Promise<{ ok: true; folder: string; runtime: EduRuntime } | { ok: false; reason: string }> {
    try {
      const runtime = await detect();
      if (runtime.state !== "ready") return { ok: false, reason: runtime.reason ?? `Edu is ${runtime.state}` };
      const ready = await ensureBrain(bot, runtime);
      return ready.ok ? { ok: true, folder: ready.folder, runtime } : { ok: false, reason: ready.reason };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  function server(runtime: EduRuntime, folder: string): EduStdioServer {
    return {
      command: process.execPath,
      args: [runtime.cli!, "--cwd", folder, "mcp", "--profile", "memory"],
      // EDU_LOCK_WORKSPACE refuses edu_project_use; Edu 6.0.0 ignores --project under it, so the brain comes from --cwd.
      env: { ...AGENTS_NODE_FLAG, EDU_LOCK_WORKSPACE: "1", EDU_HOME: runtime.home },
    };
  }

  /** The turn's `edu` server and brain folder, or null whenever Edu cannot serve this bot here. Never throws. */
  async function mount(bot: EduBot, where: { local: boolean }): Promise<{ server: EduStdioServer; folder: string } | null> {
    if (!where.local) return null;
    try {
      const runtime = await detect();
      if (runtime.state !== "ready") return null;
      const brain = await ensureBrain(bot, runtime);
      if (!brain.ok) {
        if (bot.eduBrain?.mode !== "off") console.warn(`edu: no brain for bot ${bot.id}: ${brain.reason}`);
        return null;
      }
      return { server: server(runtime, brain.folder), folder: brain.folder };
    } catch (error) {
      console.warn(`edu: not mounted for bot ${bot.id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function integration(bot: EduBot, where: { local: boolean }): Promise<EduStdioServer | null> {
    return (await mount(bot, where))?.server ?? null;
  }

  return {
    detect,
    brainFolder,
    integration,

    /** Why `folder` may not be this bot's brain, or null. */
    folderRefusal(bot: EduBot, folder: string): string | null {
      return folderRefusal({ ...bot, eduBrain: { mode: "folder", path: folder } }, folder);
    },

    /** Adds the turn's `edu` server when the engine mounts one and the turn runs on this computer. */
    async attach(integrations: { edu?: EduStdioServer }, bot: EduBot, capabilities: { eduMcp?: boolean }, turn: EduTurn): Promise<void> {
      const local = (deps.hostLocal?.() ?? true) && turn.computer !== "box" && turn.computer !== "vps" && !turn.confined;
      const edu = capabilities.eduMcp === true ? await mount(bot, { local }) : null;
      if (turn.threadId) deps.mounted?.(turn.threadId, bot, edu?.folder ?? null);
      if (edu) integrations.edu = edu.server;
    },

    brain,

    /** The turn's Edu parts of the system prompt: the brief whenever this bot's brain is ready here, for any engine, and
     * the rule on what goes where only when `mounted` (the turn's `edu` server) is one the bot's tool selection keeps.
     * Both are empty whenever Edu is missing, off or broken. Never throws. */
    async promptParts(bot: EduBot, turn: EduTurn, mounted: boolean): Promise<PromptPart[]> {
      const where = home();
      const folder = brainFolder(bot);
      if (!(deps.hostLocal?.() ?? true) || turn.confined || deps.config()?.enabled === false || !where.ok || !folder) return eduPromptParts("", false);
      const tools = mounted && canUseMcpServer(bot.toolScope, "edu");
      const stdout = await briefs.get(`${folder}\0${where.path}`, async () => {
        const ready = await brain(bot);
        if (!ready.ok) throw new Error(ready.reason);
        return runFor(ready.runtime.cli!)(["--cwd", ready.folder, "brief", "--json"], { env: eduEnv(ready.runtime.home), timeoutMs: EDU_BRIEF_TIMEOUT_MS });
      });
      return eduPromptParts(stdout ? eduBriefText(stdout, { tools }) : "", tools, { readOnly: Boolean(env.EDU_CREW_JOB?.trim()) });
    },

    async status(bot: EduBot): Promise<EduBrainStatus> {
      const mode = bot.eduBrain?.mode ?? "own";
      const runtime = await detect().catch((error: unknown) => ({ state: "broken" as const, home: "", reason: String(error) }));
      const folder = brainFolder(bot) ?? undefined;
      if (mode === "off") return { ...runtime, state: runtime.state === "ready" ? "off" : runtime.state, mode, ...(folder ? { brain: folder } : {}) };
      if (runtime.state !== "ready" || !folder) return { ...runtime, mode, ...(folder ? { brain: folder } : {}) };
      const refusal = folderRefusal(bot, folder);
      if (refusal) return { ...runtime, state: "broken", brokenFolder: true, mode, brain: folder, reason: refusal };
      if (hasBrain(folder)) return { ...runtime, mode, brain: folder };
      return mode === "own" ? { ...runtime, mode, brain: folder }
        : { ...runtime, state: "broken", brokenFolder: true, mode, brain: folder, reason: "This folder has no Edu brain: run `edu init` in it" };
    },
  };
}

export type EduBrains = ReturnType<typeof createEduBrains>;

export interface EduTurn {
  /** Where the turn's computer runs; `box` and `vps` are not this computer. */
  computer?: string | null;
  /** A turn fenced from the person's own data (a proactive fence, a Bot API thread). */
  confined?: boolean;
  threadId?: string;
}

/** Claude Code 2.1.330 starts an MCP child with its own environment plus the server's `env`, an empty value included, so
 * the engine (and its shell) carries Edu's crew-worker guard while the `edu` server alone has it cleared. A guard Edu Bot
 * inherited is kept for both. */
export function claudeEduMount(edu: EduStdioServer, botId: string | undefined, engineEnv: NodeJS.ProcessEnv): ClaudeEduMount {
  const allowed = EDU_PREALLOWED_TOOLS.map((tool) => `mcp__edu__${tool}`);
  if (engineEnv.EDU_CREW_JOB?.trim()) return { server: edu, engineEnv: {}, allowed };
  return { server: { ...edu, env: { ...edu.env, EDU_CREW_JOB: "" } }, engineEnv: { EDU_CREW_JOB: `edu-bot:${botId ?? "bot"}` }, allowed };
}

export interface ClaudeEduMount {
  server: EduStdioServer;
  engineEnv: Record<string, string>;
  /** Claude's pre-allowed tool names for the server. */
  allowed: string[];
}
