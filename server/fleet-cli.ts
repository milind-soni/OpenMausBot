// `openmausbot fleet`: many client workspaces on one Linux server. The plans
// come from fleet.ts; this runs them as root with fixed argument lists, or
// prints them for an operator to paste into a root shell, and never builds
// a shell command from user input. The fleet agent (fleet-agent.ts) reuses
// the same planner and executor over a Unix socket.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { unstableInstallWarning } from "./service-unit.ts";
import {
  applySignIn,
  assertSlug,
  createPlan,
  deletePlan,
  describeSteps,
  fleetLayout,
  fleetUser,
  initPlan,
  parseRegistry,
  resumePlan,
  suspendPlan,
  upgradePlan,
  workspaceDataDir,
  type FleetLayout,
  type FleetRegistry,
  type FleetStep,
} from "./fleet.ts";

export interface FleetInput {
  action: "init" | "create" | "list" | "users" | "suspend" | "resume" | "delete" | "upgrade";
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

/** Everything that touches the machine, so tests can run the CLI dry. */
export interface FleetDeps {
  isRoot(): boolean;
  run(argv: string[]): Promise<{ code: number | null; output: string }>;
  readText(path: string): string | null;
  writeText(path: string, content: string, mode: number): void;
  mkdir(path: string, mode: number): void;
  appendOnce(path: string, line: string): void;
  remove(path: string): void;
  health(url: string, timeoutMs: number): Promise<boolean>;
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
    readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
    writeText: (path, content, mode) => writeFileSync(path, content, { mode }),
    mkdir: (path, mode) => mkdirSync(path, { recursive: true, mode }),
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
        deps.mkdir(step.path, step.mode);
        if (step.owner) {
          const chown = await deps.run(["chown", `${step.owner}:${step.owner}`, step.path]);
          if (chown.code !== 0) return failed(io, `chown ${step.path}`, chown.output);
        }
        break;
      case "write":
        deps.writeText(step.path, step.content, step.mode);
        if (step.owner) {
          const chown = await deps.run(["chown", `${step.owner}:${step.owner}`, step.path]);
          if (chown.code !== 0) return failed(io, `chown ${step.path}`, chown.output);
        }
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
      const plan = initPlan({ domain: input.domain, node: input.node, script: input.script, operator: input.operator, layout });
      if (existing) {
        // Keep the workspaces already registered; only the domain and templates are rewritten.
        const kept = parseRegistry(existing);
        plan.registry.workspaces = kept.workspaces;
        plan.registry.nextPort = kept.nextPort;
        return plan.steps.map((step) => (step.kind === "write" && step.path === layout.registryFile ? { ...step, content: `${JSON.stringify(plan.registry, null, 2)}\n` } : step));
      }
      return plan.steps;
    }
    case "create": {
      if (!input.slug) throw new Error("fleet create needs a workspace name");
      const registry = loadRegistry(layout, deps);
      const brandJson = input.brandJson ?? (input.brandFile ? deps.readText(input.brandFile) : undefined);
      if (input.brandFile && brandJson === null) throw new Error(`${input.brandFile} not found`);
      if (brandJson) JSON.parse(brandJson);
      const anthropicKey = input.anthropicKey?.trim() || (input.anthropicKeyFile ? deps.readText(input.anthropicKeyFile)?.trim() : undefined);
      if (input.anthropicKeyFile && !anthropicKey) throw new Error(`${input.anthropicKeyFile} is missing or empty`);
      return createPlan({
        registry,
        slug: input.slug,
        seed: { admins: input.admins, members: input.members, ...(anthropicKey ? { anthropicKey } : {}), ...(input.cap !== undefined ? { monthlyCapUsd: input.cap } : {}), ...(brandJson ? { brandJson } : {}) },
        ...(input.licenseKey ? { licenseKey: input.licenseKey } : {}),
        ...(input.memory ? { memoryMax: input.memory } : {}),
        layout,
      }).steps;
    }
    case "users": {
      if (!input.slug || !input.userAction || !input.email) throw new Error("fleet users needs: NAME add|remove EMAIL [--chat-only]");
      assertSlug(input.slug);
      const registry = loadRegistry(layout, deps);
      if (!registry.workspaces[input.slug]) throw new Error(`no workspace "${input.slug}"`);
      const file = posix.join(workspaceDataDir(layout, input.slug), "config.json");
      const next = applySignIn(deps.readText(file) ?? "{}", input.userAction, input.email, Boolean(input.chatOnly));
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
      if (!input.yes) throw new Error(`fleet delete removes the workspace's account${input.keepData ? "" : " and all of its data"}; pass --yes to confirm${input.keepData ? "" : ", or --keep-data to keep the home folder"}`);
      const registry = loadRegistry(layout, deps);
      return deletePlan({ registry, slug: input.slug, keepData: input.keepData, layout }).steps;
    }
    case "upgrade":
      return upgradePlan({ registry: loadRegistry(layout, deps) });
    case "list":
      return [];
  }
}

function printPlan(steps: FleetStep[], io: FleetIo, reason: string): number {
  io.log(`${reason}; run these as root:`);
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
        const live = asRoot ? (await deps.run(["systemctl", "is-active", `openmausbot@${workspace.slug}.service`])).output.trim() : workspace.status;
        io.log(`${workspace.slug.padEnd(24)} https://${workspace.host.padEnd(40)} :${String(workspace.port).padEnd(6)} ${live}`);
      }
      return 0;
    }
    const steps = planFleetAction(input, deps);
    return asRoot ? await executePlan(steps, deps, io) : printPlan(steps, io, input.dryRun ? "dry run" : "not running as root");
  } catch (error) {
    io.error(`fleet: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}
