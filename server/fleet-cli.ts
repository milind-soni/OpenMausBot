// Runs fleet.ts plans as root with fixed argument lists, or prints them for a root shell; never a shell command from user input.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync } from "node:fs";
import { posix } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import type { BrandField } from "./brand-schema.ts";
import { unstableInstallWarning } from "./service-unit.ts";
import { assertWorkspaceHost, workspaceHostFor } from "./fleet-tenancy.ts";
import { brandCreateNotes, redactPrintedSteps, planCreateBrand, planFleetBrand, resolveCreateBrandJson, smtpLoginNotes } from "./fleet-brand.ts";
import { planFleetRates, runFleetBilling, snapshotBeforeDelete } from "./fleet-billing.ts";
import { meterTenantPeople, tenantIo, type PeopleResult } from "./fleet-tenant-io.ts";
import { TWO_DECIMAL_CURRENCIES, type FleetReseller, type RateSet } from "./fleet-reseller.ts";
import {
  applySignIn,
  assertManagedWorkspace,
  assertSlug,
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

export interface BrandPatch {
  name?: string;
  tagline?: string;
  accent?: string;
  supportUrl?: string;
}

export { BRAND_FIELDS, type BrandField } from "./brand-schema.ts";

/** Rates in minor units, as `fleet rates` flags name them. */
export interface RatesPatch {
  wholesale?: Partial<RateSet>;
  retail?: Partial<RateSet>;
  overrides?: Record<string, Partial<RateSet>>;
  clearOverrides?: string[];
}

export interface FleetInput {
  action: "init" | "create" | "list" | "users" | "providers" | "suspend" | "resume" | "delete" | "upgrade" | "brand" | "billing" | "rates";
  slug?: string;
  domain?: string;
  /** `create --host`: a custom web address instead of `<slug>.<domain>`. */
  host?: string;
  resellerName?: string;
  /** `init` and `rates`: ISO 4217 code. */
  currency?: string;
  /** `brand --default` targets the reseller's default brand; otherwise `slug` names the workspace. */
  brandDefault?: boolean;
  brandPatch?: BrandPatch;
  brandClear?: BrandField[];
  /** A file path or an https URL; an agent request carries a data URI instead. */
  logoSource?: string;
  faviconSource?: string;
  /** `billing`: `YYYY-MM`, UTC. */
  month?: string;
  csv?: boolean;
  detail?: boolean;
  /** `billing`: how many distinct people one workspace may have before its ledger counts as unavailable; 1000 when absent. */
  maxUsers?: number;
  ratesPatch?: RatesPatch;
  licenseKeyFile?: string;
  /** The operator's Unix user: the one workspace allowed to talk to the fleet agent. */
  operator?: string;
  admins: string[];
  members: string[];
  brandFile?: string;
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
  node: string;
  script: string;
  root?: string;
}

export interface FleetIo {
  log(line: string): void;
  error(line: string): void;
}

export interface FleetUsageTotals { turns: number; costUsd: number | null; billableUsd: null }

export type Entitlements = (feature: string) => boolean;

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
  people?(dataDir: string, owner: string, month: string, maxUsers?: number): Promise<PeopleResult>;
  entitlements?(licenseKey: string | undefined): Promise<Entitlements>;
  readBytes?(path: string): Uint8Array | null;
  /** File names in a root-owned directory; none when it does not exist. */
  listDir?(path: string): string[];
}

const MAX_IMAGE_FILE_BYTES = 1024 * 1024;

/** Root opens a path the operator typed: never through a final symbolic link, only a regular file, at most 1 MiB. */
function readImageFile(path: string): Uint8Array | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") throw new Error(`${path} is a symbolic link; pass the image file itself`);
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    if (info.size > MAX_IMAGE_FILE_BYTES) throw new Error(`${path} is larger than 1 MiB`);
    const buffer = Buffer.alloc(MAX_IMAGE_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_IMAGE_FILE_BYTES) throw new Error(`${path} is larger than 1 MiB`);
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
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
    readBytes: readImageFile,
    listDir: (path) => { try { return readdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } },
    entitlements: async (licenseKey) => {
      const { entitled, loadEnterpriseLayer } = await import("./enterprise.ts");
      await loadEnterpriseLayer(licenseKey ? { licenseKey } : {});
      return (feature) => entitled(feature);
    },
    people: (dataDir, owner, month, maxUsers) => meterTenantPeople(dataDir, owner, month, maxUsers),
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
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return false;
    },
  };
}

const HEALTH_TIMEOUT_MS = 60_000;

/** Stops at the first failed step, showing only the tool's last lines, never a secret from the plan. */
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

/** Throws on anything invalid before a single step runs. */
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
      const reseller = resellerFor(input, kept?.reseller);
      const plan = initPlan({ domain: input.domain, node: input.node, script: input.script, operator: input.operator ?? kept?.operator, ...(reseller ? { reseller } : {}), layout });
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
      assertWorkspaceHost({ registry, slug: input.slug, host: input.host, portalUrl: input.portalUrl });
      for (const path of [workspaceHome(layout, input.slug), posix.join(layout.instancesDir, `${input.slug}.env`), posix.join(layout.caddyDir, `${input.slug}.caddy`), posix.join(posix.dirname(layout.unitFile), `openmausbot@${input.slug}.service.d`)]) {
        if (deps.pathExists(path)) throw new Error(`workspace path already exists: ${path}; recover or remove it explicitly before provisioning a fresh workspace`);
      }
      const brandInput = { registry, brandFile: input.brandFile, brandJson: input.brandJson };
      const brandJson = resolveCreateBrandJson(brandInput, deps);
      const brand = planCreateBrand({ ...brandInput, layout, slug: input.slug }, deps);
      const anthropicKey = input.anthropicKey?.trim() || (input.anthropicKeyFile ? deps.readText(input.anthropicKeyFile)?.trim() : undefined);
      if (input.anthropicKeyFile && !anthropicKey) throw new Error(`${input.anthropicKeyFile} is missing or empty`);
      const plan = createPlan({
        registry,
        slug: input.slug,
        host: workspaceHostFor(registry, input.slug, input.host),
        brand,
        seed: { admins: input.admins, members: input.members, ...(anthropicKey ? { anthropicKey } : {}), ...(input.anthropicUrl ? { anthropicUrl: input.anthropicUrl } : {}), ...(input.portalUrl ? { portalUrl: input.portalUrl } : {}), ...(input.cap !== undefined ? { monthlyCapUsd: input.cap } : {}), ...(brandJson ? { brandJson } : {}), openrouterKey: input.openrouterKey, openrouterUrl: input.openrouterUrl, openrouterModels: input.openrouterModels, openrouterDefault: input.openrouterDefault },
        ...(input.licenseKey ? { licenseKey: input.licenseKey } : {}),
        ...(input.memory ? { memoryMax: input.memory } : {}),
        layout,
      });
      return [...plan.steps, ...[...brandCreateNotes({ registry, licenseKey: input.licenseKey }), ...smtpLoginNotes(registry.reseller, deps)].map((text): FleetStep => ({ kind: "note", text }))];
    }
    case "brand":
      return planFleetBrand(input, deps);
    case "rates":
      return planFleetRates(input, deps);
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
    case "billing":
      return [];
  }
}

function resellerFor(input: Pick<FleetInput, "resellerName" | "currency">, kept: FleetReseller | undefined): FleetReseller | undefined {
  if (input.resellerName === undefined && input.currency === undefined) return kept;
  const name = input.resellerName ?? kept?.name;
  if (!name) throw new Error("--currency needs --reseller-name the first time");
  const currency = input.currency ?? kept?.currency ?? "USD";
  if (!TWO_DECIMAL_CURRENCIES.has(currency)) throw new Error(`--currency ${currency} is not supported; use a currency with two decimals, such as USD, EUR or GBP`);
  const zero: RateSet = { workspaceMonthMinor: 0, userMonthMinor: 0 };
  return { ...kept, name, currency, wholesale: kept?.wholesale ?? zero, retail: kept?.retail ?? zero };
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
  for (const line of describeSteps(redactPrintedSteps(steps))) io.log(line);
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
    if (input.action === "billing") return await runFleetBilling(input, io, deps);
    if (input.action === "delete" && input.yes && asRoot) await snapshotBeforeDelete(input, deps, new Date());
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
