// `openmausbot fleet`: many client workspaces on one Linux server. The plans
// come from fleet.ts; this runs them as root with fixed argument lists, or
// prints them for an operator to paste into a root shell, and never builds
// a shell command from user input. The fleet agent (fleet-agent.ts) reuses
// the same planner and executor over a Unix socket.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { posix } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { unstableInstallWarning } from "./service-unit.ts";
import {
  applySignIn,
  assertManagedWorkspace,
  assertSlug,
  assertUnixUser,
  createPlan,
  deletePlan,
  describeSteps,
  fleetLayout,
  fleetUser,
  fenceRules,
  initPlan,
  MANAGED_OPENROUTER,
  managedOpenRouterModels,
  parseRegistry,
  resumePlan,
  suspendPlan,
  upgradePlan,
  workspaceDataDir,
  workspaceHome,
  type FleetLayout,
  type FleetRegistry,
  type FleetStep,
} from "./fleet.ts";

export interface FleetInput {
  action: "init" | "create" | "list" | "users" | "providers" | "suspend" | "resume" | "delete" | "upgrade";
  slug?: string;
  domain?: string;
  /** The operator's Unix user: the one workspace allowed to talk to the fleet agent. */
  operator?: string;
  admins: string[];
  members: string[];
  brandFile?: string;
  /** Brand JSON given directly (the agent), instead of a file (the CLI). */
  brandJson?: string;
  anthropicKeyFile?: string;
  anthropicKey?: string;
  anthropicUrl?: string;
  openrouterKey?: string;
  openrouterUrl?: string;
  openrouterModels?: string[];
  openrouterDefault?: boolean;
  portalUrl?: string;
  cap?: number;
  licenseKey?: string;
  memory?: string;
  dryRun: boolean;
  yes: boolean;
  keepData: boolean;
  userAction?: "add" | "remove";
  email?: string;
  chatOnly?: boolean;
  /** This CLI's own entry and node, for the template unit. */
  node: string;
  script: string;
  /** Filesystem root for the layout; "/" outside tests. */
  root?: string;
}

export interface FleetIo {
  log(line: string): void;
  error(line: string): void;
}

export interface FleetUsageTotals { turns: number; costUsd: number | null; billableUsd: null }

/** Everything that touches the machine, so tests can run the CLI dry. */
export interface FleetDeps {
  isRoot(): boolean;
  run(argv: string[]): Promise<{ code: number | null; output: string }>;
  pathExists(path: string): boolean;
  readText(path: string, owner?: string): string | null;
  usage(dataDir: string, owner: string, now: Date): FleetUsageTotals;
  writeText(path: string, content: string, mode: number, owner?: string): void;
  mkdir(path: string, mode: number, owner?: string): void;
  appendOnce(path: string, line: string): void;
  remove(path: string): void;
  health(url: string, timeoutMs: number): Promise<boolean>;
}

// Tenant-controlled ancestors can be renamed between any two filesystem calls.
// The boundary is dropping ALL root authority before I/O, not a preceding lstat.
// The checks additionally reject visible symlinks, shared inodes and special files.
const TENANT_IO = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
const { uid, gid, home, file, action, content, mode } = request;
if (process.getuid() === 0) {
  process.setgroups([]);
  process.setgid(gid);
  process.setuid(uid);
}
if (process.getuid() !== uid || process.getgid() !== gid || uid === 0 || gid === 0) throw Error("could not drop fleet file privileges");
const limit = 4 * 1024 * 1024;
const check = (stat, directory) => {
  if (stat.uid !== uid || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw Error("unsafe workspace file or directory");
};
const totals = { turns: 0, costUsd: null, billableUsd: null };
let cursor = home;
try {
  check(fs.lstatSync(cursor), true);
  for (const part of path.relative(home, path.dirname(file)).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    check(fs.lstatSync(cursor), true);
  }
} catch (error) {
  if (action !== "usage" || error.code !== "ENOENT") throw error;
  process.stdout.write(JSON.stringify(totals));
  process.exit(0);
}
let result = null;
if (action === "mkdir") {
  try { fs.mkdirSync(file, { mode }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  check(fs.lstatSync(file), true);
} else if (action === "read" || action === "usage") {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (fd !== undefined) {
    try {
      const stat = fs.fstatSync(fd);
      check(stat, false);
      if (stat.size > limit) throw Error("workspace file exceeds 4 MiB");
      const data = Buffer.alloc(limit + 1);
      let size = 0;
      while (size < data.length) { const read = fs.readSync(fd, data, size, data.length - size, null); if (!read) break; size += read; }
      if (size > limit) throw Error("workspace file exceeds 4 MiB");
      result = data.subarray(0, size).toString("utf8");
    } finally { fs.closeSync(fd); }
  }
  if (action === "usage") {
    const to = Date.parse(content);
    const date = new Date(to);
    const from = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    // Scan one bounded month's text without retaining rows or allocating groups.
    const text = result || "";
    for (let offset = 0; offset < text.length;) {
      const end = text.indexOf("\n", offset);
      const line = text.slice(offset, end < 0 ? text.length : end);
      offset = end < 0 ? text.length : end + 1;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || typeof row !== "object" || typeof row.at !== "string" || typeof row.botId !== "string" || typeof row.model !== "string" || typeof row.input !== "number" || typeof row.output !== "number" || !row.trigger || typeof row.trigger !== "object" || typeof row.trigger.kind !== "string") continue;
      const at = Date.parse(row.at);
      if (!(at >= from && at <= to)) continue;
      totals.turns++;
      if (typeof row.costUsd === "number" && Number.isFinite(row.costUsd) && row.costUsd >= 0) {
        const sum = (totals.costUsd || 0) + row.costUsd;
        if (!Number.isFinite(sum)) throw Error("workspace usage total exceeds numeric range");
        totals.costUsd = sum;
      }
    }
    result = totals;
  }
} else if (action === "write") {
  if (Buffer.byteLength(content) > limit) throw Error("workspace file exceeds 4 MiB");
  try { check(fs.lstatSync(file), false); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temp = file + ".fleet-" + randomUUID();
  let fd;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
} else throw Error("unknown fleet file operation");
process.stdout.write(JSON.stringify(result));
`;

function tenantIo(owner: string, file: string, action: "read" | "write" | "mkdir" | "usage", content?: string, mode?: number): string | null | FleetUsageTotals {
  assertUnixUser(owner);
  const options = { encoding: "utf8" as const, timeout: 5_000, killSignal: "SIGKILL" as const, cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
  const account = execFileSync("/usr/bin/getent", ["passwd", owner], { ...options, maxBuffer: 8192 }).trim().split(":");
  const uid = Number(account[2]);
  const gid = Number(account[3]);
  const home = account[5];
  if (account.length !== 7 || account[0] !== owner || !Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0 || !home?.startsWith("/") || posix.normalize(home) !== home || !file.startsWith(`${home}/`) || posix.normalize(file) !== file) {
    throw new Error(`unsafe filesystem identity or path for ${owner}`);
  }
  try {
    return JSON.parse(execFileSync(process.execPath, ["--eval", TENANT_IO], { ...options, maxBuffer: action === "usage" ? 8192 : 32 * 1024 * 1024, input: JSON.stringify({ uid, gid, home, file, action, content, mode }) })) as string | null | FleetUsageTotals;
  } catch {
    // Do not repeat helper stderr: tenant-controlled file contents may be secret.
    throw new Error(`could not ${action} workspace file as ${owner}: check ownership, links, file size and permissions`);
  }
}

export function defaultFleetDeps(): FleetDeps {
  return {
    isRoot: () => typeof process.getuid === "function" && process.getuid() === 0,
    run: (argv) =>
      new Promise((resolve) => {
        const [command, ...args] = argv;
        let output = "";
        try {
          const child = spawn(command!, args, { stdio: ["ignore", "pipe", "pipe"] });
          const receive = (chunk: Buffer) => { if (output.length < 16_384) output += chunk.toString("utf8"); };
          child.stdout.on("data", receive);
          child.stderr.on("data", receive);
          child.once("error", (error) => resolve({ code: null, output: `${output}${error.message}` }));
          child.once("close", (code) => resolve({ code, output }));
        } catch (error) {
          resolve({ code: null, output: error instanceof Error ? error.message : String(error) });
        }
      }),
    pathExists: (path) => { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } },
    readText: (path, owner) => owner ? tenantIo(owner, path, "read") as string | null : (existsSync(path) ? readFileSync(path, "utf8") : null),
    usage: (dataDir, owner, now) => {
      const at = now.toISOString();
      return tenantIo(owner, posix.join(dataDir, "usage", `${at.slice(0, 7)}.jsonl`), "usage", at) as FleetUsageTotals;
    },
    writeText: (path, content, mode, owner) => {
      if (owner) { tenantIo(owner, path, "write", content, mode); return; }
      writeFileAtomic(path, content, { mode });
      // Persist the rename before the next external step (notably useradd).
      const directory = openSync(posix.dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    },
    mkdir: (path, mode, owner) => { if (owner) tenantIo(owner, path, "mkdir", undefined, mode); else mkdirSync(path, { recursive: true, mode }); },
    appendOnce: (path, line) => {
      const current = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (!current.split("\n").some((existing) => existing.trim() === line)) appendFileSync(path, `${current.endsWith("\n") || !current ? "" : "\n"}\n${line}\n`);
    },
    remove: (path) => rmSync(path, { force: true }),
    health: async (url, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
          if (response.ok) return true;
        } catch {
          /* not up yet */
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return false;
    },
  };
}

const HEALTH_TIMEOUT_MS = 60_000;

/** Run a plan as root. Stops at the first failed step, naming it and showing
 * only the tool's last lines, never a secret from the plan. */
export async function executePlan(steps: FleetStep[], deps: FleetDeps, io: FleetIo): Promise<number> {
  for (const step of steps) {
    switch (step.kind) {
      case "mkdir":
        deps.mkdir(step.path, step.mode, step.owner);
        break;
      case "write":
        deps.writeText(step.path, step.content, step.mode, step.owner);
        break;
      case "append-once":
        deps.appendOnce(step.path, step.line);
        break;
      case "remove":
        deps.remove(step.path);
        break;
      case "run": {
        const result = await deps.run(step.argv);
        if (result.code !== 0) return failed(io, `${step.why} (${step.argv[0]} exited ${result.code ?? "without a code"})`, result.output);
        break;
      }
      case "health":
        if (!(await deps.health(step.url, HEALTH_TIMEOUT_MS))) return failed(io, step.why, `${step.url} did not answer within ${HEALTH_TIMEOUT_MS / 1000}s; check journalctl -u openmausbot@<slug>`);
        break;
      case "note":
        io.log(step.text);
        break;
    }
  }
  return 0;
}

function failed(io: FleetIo, what: string, output: string): number {
  io.error(`fleet: could not ${what}`);
  const tail = output.trim().split("\n").slice(-6).join("\n");
  if (tail) io.error(tail);
  return 1;
}

export function loadRegistry(layout: FleetLayout, deps: FleetDeps): FleetRegistry {
  const text = deps.readText(layout.registryFile);
  if (text === null) throw new Error(`no fleet on this server yet: run \`openmausbot fleet init --domain your.domain\` first`);
  return parseRegistry(text);
}

/** The steps an action means on this machine. Throws on anything invalid
 * before a single step runs; `list` has no steps and is answered directly. */
export function planFleetAction(input: FleetInput, deps: FleetDeps): FleetStep[] {
  const layout = fleetLayout(input.root ?? "/");
  switch (input.action) {
    case "init": {
      if (!input.domain) throw new Error("fleet init needs --domain, the domain whose subdomains the workspaces live at");
      const warning = unstableInstallWarning(input.script);
      if (warning) throw new Error(warning);
      const existing = deps.readText(layout.registryFile);
      if (existing !== null && !input.yes) throw new Error(`${layout.registryFile} exists; pass --yes to rewrite the template unit and fence (workspaces are kept)`);
      const kept = existing !== null ? parseRegistry(existing) : undefined;
      const plan = initPlan({ domain: input.domain, node: input.node, script: input.script, operator: input.operator ?? kept?.operator, layout });
      if (kept) {
        // Reinitializing templates must not erase reservations or open sibling ports.
        const registry = { ...kept, ...plan.registry, workspaces: kept.workspaces, nextPort: kept.nextPort };
        return plan.steps.flatMap((step): FleetStep[] => {
          if (step.kind === "write" && step.path === layout.registryFile) return [{ ...step, content: `${JSON.stringify(registry, null, 2)}\n` }];
          if (step.kind === "write" && step.path === layout.fenceFile) return [{ ...step, content: fenceRules(Object.values(registry.workspaces)) }];
          if (step.kind === "run" && step.argv.join(" ") === "systemctl enable --now openmausbot-fence.service") return [step, { kind: "run", argv: ["nft", "-f", layout.fenceFile], why: "reapply the preserved workspace fence" }];
          return [step];
        });
      }
      return plan.steps;
    }
    case "create": {
      if (!input.slug) throw new Error("fleet create needs a workspace name");
      assertSlug(input.slug);
      const registry = loadRegistry(layout, deps);
      if (registry.workspaces[input.slug]) throw new Error(`workspace "${input.slug}" already exists`);
      for (const path of [workspaceHome(layout, input.slug), posix.join(layout.instancesDir, `${input.slug}.env`), posix.join(layout.caddyDir, `${input.slug}.caddy`), posix.join(posix.dirname(layout.unitFile), `openmausbot@${input.slug}.service.d`)]) {
        if (deps.pathExists(path)) throw new Error(`workspace path already exists: ${path}; recover or remove it explicitly before provisioning a fresh workspace`);
      }
      const brandJson = input.brandJson ?? (input.brandFile ? deps.readText(input.brandFile) : undefined);
      if (input.brandFile && brandJson === null) throw new Error(`${input.brandFile} not found`);
      if (brandJson) JSON.parse(brandJson);
      const anthropicKey = input.anthropicKey?.trim() || (input.anthropicKeyFile ? deps.readText(input.anthropicKeyFile)?.trim() : undefined);
      if (input.anthropicKeyFile && !anthropicKey) throw new Error(`${input.anthropicKeyFile} is missing or empty`);
      return createPlan({
        registry,
        slug: input.slug,
        seed: { admins: input.admins, members: input.members, ...(anthropicKey ? { anthropicKey } : {}), ...(input.anthropicUrl ? { anthropicUrl: input.anthropicUrl } : {}), ...(input.portalUrl ? { portalUrl: input.portalUrl } : {}), ...(input.cap !== undefined ? { monthlyCapUsd: input.cap } : {}), ...(brandJson ? { brandJson } : {}), openrouterKey: input.openrouterKey, openrouterUrl: input.openrouterUrl, openrouterModels: input.openrouterModels, openrouterDefault: input.openrouterDefault },
        ...(input.licenseKey ? { licenseKey: input.licenseKey } : {}),
        ...(input.memory ? { memoryMax: input.memory } : {}),
        layout,
      }).steps;
    }
    case "providers": {
      if (!input.slug) throw new Error("fleet providers needs a workspace name");
      assertSlug(input.slug);
      const workspace = loadRegistry(layout, deps).workspaces[input.slug];
      if (!workspace) throw new Error(`no workspace "${input.slug}"`);
      assertManagedWorkspace(workspace);
      const models = managedOpenRouterModels(input.openrouterModels);
      const env = deps.readText(posix.join(layout.instancesDir, `${input.slug}.env`)) ?? "";
      const portal = /^OMB_ADMIN_URL=(.+)$/m.exec(env)?.[1];
      if (!portal || !env.split("\n").includes(`OMB_ADMIN_WORKSPACE=${input.slug}`)) throw new Error("workspace has no trusted portal configuration; operator recovery is required");
      try { const url = new URL(portal); if (url.protocol !== "https:" || url.origin !== portal) throw new Error(); }
      catch { throw new Error("workspace portal configuration is invalid; operator recovery is required"); }
      const file = posix.join(workspaceHome(layout, input.slug), ".config", "opencode", "opencode.json");
      const raw = deps.readText(file, fleetUser(input.slug));
      const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
      let config: Record<string, unknown>;
      try { const parsed: unknown = JSON.parse(raw ?? "null"); if (!object(parsed)) throw new Error(); config = parsed; }
      catch { throw new Error("managed OpenRouter configuration is missing or invalid; operator recovery is required"); }
      const providers = config.provider;
      const managed = object(providers) ? providers[MANAGED_OPENROUTER] : undefined;
      const options = object(managed) ? managed.options : undefined;
      if (!object(managed) || managed.npm !== "@ai-sdk/openai-compatible" || !object(options) || options.baseURL !== `${portal}/api/gateway/${input.slug}/openrouter/v1` || typeof options.apiKey !== "string" || !/^[!-~]+$/.test(options.apiKey)) {
        throw new Error("managed OpenRouter configuration does not match the workspace portal; operator recovery is required");
      }
      managed.models = models;
      return [
        { kind: "write", path: file, content: `${JSON.stringify(config, null, 2)}\n`, mode: 0o600, owner: fleetUser(input.slug) },
        { kind: "note", text: "managed OpenRouter models updated; refresh the workspace model picker to load its catalog" },
      ];
    }
    case "users": {
      if (!input.slug || !input.userAction || !input.email) throw new Error("fleet users needs: NAME add|remove EMAIL [--chat-only]");
      assertSlug(input.slug);
      const registry = loadRegistry(layout, deps);
      if (!registry.workspaces[input.slug]) throw new Error(`no workspace "${input.slug}"`);
      assertManagedWorkspace(registry.workspaces[input.slug]!);
      const file = posix.join(workspaceDataDir(layout, input.slug), "config.json");
      const next = applySignIn(deps.readText(file, fleetUser(input.slug)) ?? "{}", input.userAction, input.email, Boolean(input.chatOnly));
      return [
        { kind: "write", path: file, content: next.config, mode: 0o600, owner: fleetUser(input.slug) },
        { kind: "note", text: next.summary },
      ];
    }
    case "suspend":
    case "resume": {
      if (!input.slug) throw new Error(`fleet ${input.action} needs a workspace name`);
      const registry = loadRegistry(layout, deps);
      return (input.action === "suspend" ? suspendPlan({ registry, slug: input.slug, layout }) : resumePlan({ registry, slug: input.slug, layout })).steps;
    }
    case "delete": {
      if (!input.slug) throw new Error("fleet delete needs a workspace name");
      if (!input.yes) throw new Error(`fleet delete ${input.keepData ? "retires the workspace, keeping its data and reserved Unix account" : "removes the workspace's account and all of its data"}; pass --yes to confirm${input.keepData ? "" : ", or --keep-data to keep the home folder and account reserved"}`);
      const registry = loadRegistry(layout, deps);
      return deletePlan({ registry, slug: input.slug, keepData: input.keepData, layout }).steps;
    }
    case "upgrade":
      return upgradePlan({ registry: loadRegistry(layout, deps) });
    case "list":
      return [];
  }
}

/** Preserve the reservation and any account checkpoint after a failed create. */
export function markProvisioningFailed(input: FleetInput, deps: FleetDeps): void {
  if (input.action !== "create" || !input.slug) return;
  const layout = fleetLayout(input.root ?? "/");
  const registry = loadRegistry(layout, deps);
  const workspace = registry.workspaces[input.slug];
  if (workspace?.status !== "provisioning") return;
  registry.workspaces[input.slug] = { ...workspace, status: "error" };
  deps.writeText(layout.registryFile, `${JSON.stringify(registry, null, 2)}\n`, 0o600);
}

function printPlan(steps: FleetStep[], io: FleetIo, reason: string): number {
  io.log(`${reason}; inspect this plan, then rerun the fleet command as root without --dry-run (with --yes where required):`);
  io.log("");
  for (const line of describeSteps(steps)) io.log(line);
  return 0;
}

export async function runFleetCommand(input: FleetInput, io: FleetIo, deps: FleetDeps = defaultFleetDeps()): Promise<number> {
  const layout = fleetLayout(input.root ?? "/");
  const asRoot = deps.isRoot() && !input.dryRun;
  try {
    if (input.action === "list") {
      const registry = loadRegistry(layout, deps);
      const rows = Object.values(registry.workspaces).sort((a, b) => a.slug.localeCompare(b.slug));
      if (!rows.length) {
        io.log(`no workspaces yet on ${registry.domain}; create one with: openmausbot fleet create NAME --admin you@example.com`);
        return 0;
      }
      for (const workspace of rows) {
        const live = asRoot && (workspace.status === "running" || workspace.status === "suspended") ? (await deps.run(["systemctl", "is-active", `openmausbot@${workspace.slug}.service`])).output.trim() : workspace.status;
        io.log(`${workspace.slug.padEnd(24)} https://${workspace.host.padEnd(40)} :${String(workspace.port).padEnd(6)} ${live}`);
      }
      return 0;
    }
    const steps = planFleetAction(input, deps);
    if (!asRoot) return printPlan(steps, io, input.dryRun ? "dry run" : "not running as root");
    try {
      const code = await executePlan(steps, deps, io);
      if (code !== 0) markProvisioningFailed(input, deps);
      return code;
    } catch (error) {
      markProvisioningFailed(input, deps);
      throw error;
    }
  } catch (error) {
    io.error(`fleet: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}
