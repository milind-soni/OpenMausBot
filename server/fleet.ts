// Many client workspaces on one Linux server: each is its own OS user, its
// own `openmausbot@<slug>` service on its own loopback ports, its own data
// folder, brand, sign-in list and keys, reached at <slug>.<domain> through
// the system Caddy. This module only PLANS: it renders files and fixed
// argument lists as steps, so what the CLI does as root is inspectable and
// testable, and nothing here ever builds a shell command string.
import { posix } from "node:path";

const { join } = posix;

/** A workspace name: DNS label and Unix user suffix at once. */
export const FLEET_SLUG = /^[a-z][a-z0-9-]{1,30}$/;
export const FLEET_USER_PREFIX = "omb-";
export const FLEET_FIRST_PORT = 8810;
export const FLEET_PORT_STRIDE = 10;

export interface FleetLayout {
  etcDir: string;
  registryFile: string;
  instancesDir: string;
  unitFile: string;
  fenceFile: string;
  fenceUnitFile: string;
  caddyDir: string;
  caddyfile: string;
  homesDir: string;
  /** The root-run agent the operator workspace talks to (fleet-agent.ts). */
  agentUnitFile: string;
  socketPath: string;
  auditFile: string;
}

export function fleetLayout(root = "/"): FleetLayout {
  const at = (...parts: string[]) => join(root, ...parts);
  return {
    etcDir: at("etc", "openmausbot"),
    registryFile: at("etc", "openmausbot", "fleet.json"),
    instancesDir: at("etc", "openmausbot", "instances"),
    unitFile: at("etc", "systemd", "system", "openmausbot@.service"),
    fenceFile: at("etc", "openmausbot", "fence.nft"),
    fenceUnitFile: at("etc", "systemd", "system", "openmausbot-fence.service"),
    caddyDir: at("etc", "caddy", "omb.d"),
    caddyfile: at("etc", "caddy", "Caddyfile"),
    homesDir: at("var", "lib", "openmausbot"),
    agentUnitFile: at("etc", "systemd", "system", "openmausbot-fleet.service"),
    socketPath: at("run", "openmausbot", "fleet.sock"),
    auditFile: at("var", "log", "openmausbot", "fleet.jsonl"),
  };
}

/** The agent: root, one socket, reachable by the operator's user only. */
export function agentUnit(spec: { node: string; script: string; operator: string; layout?: FleetLayout }): string {
  const layout = spec.layout ?? fleetLayout();
  const strip = spec.script.endsWith(".ts") ? " --experimental-strip-types" : "";
  return [
    "# Written by `openmausbot fleet init`. The operator workspace creates and manages workspaces through this.",
    "[Unit]",
    "Description=OpenMausBot fleet agent",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${spec.node}${strip} ${spec.script} fleet agent --socket ${layout.socketPath} --group ${spec.operator}`,
    "RuntimeDirectory=openmausbot",
    "RuntimeDirectoryMode=0755",
    "Restart=always",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export interface FleetWorkspace {
  slug: string;
  host: string;
  port: number;
  webhookPort: number;
  status: "running" | "suspended" | "provisioning" | "error" | "retained";
  createdAt: string;
  /** Incomplete provisioning keeps its fence once the Unix account exists. */
  accountCreated?: boolean;
}

export interface FleetRegistry {
  version: 1;
  domain: string;
  nextPort: number;
  /** The Unix user whose workspace may drive the fleet agent. */
  operator?: string;
  workspaces: Record<string, FleetWorkspace>;
}

export function emptyRegistry(domain: string): FleetRegistry {
  return { version: 1, domain, nextPort: FLEET_FIRST_PORT, workspaces: {} };
}

export function parseRegistry(text: string): FleetRegistry {
  const value: unknown = JSON.parse(text);
  const record = value && typeof value === "object" ? (value as Partial<FleetRegistry>) : null;
  if (!record || record.version !== 1 || typeof record.domain !== "string" || typeof record.nextPort !== "number" || !record.workspaces || typeof record.workspaces !== "object") {
    throw new Error("fleet.json is not a fleet registry this version understands");
  }
  return {
    version: 1,
    domain: record.domain,
    nextPort: record.nextPort,
    ...(typeof record.operator === "string" ? { operator: record.operator } : {}),
    workspaces: { ...record.workspaces },
  };
}

export function fleetUser(slug: string): string {
  return `${FLEET_USER_PREFIX}${slug}`;
}

export function workspaceHome(layout: FleetLayout, slug: string): string {
  return join(layout.homesDir, slug);
}

export function workspaceDataDir(layout: FleetLayout, slug: string): string {
  return join(workspaceHome(layout, slug), ".openmausbot");
}

export function assertSlug(slug: string): void {
  if (!FLEET_SLUG.test(slug)) throw new Error(`"${slug}" is not a workspace name: lowercase letters, digits and dashes, 2 to 31 characters, starting with a letter`);
}

export function assertDomain(domain: string): void {
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)) throw new Error(`"${domain}" is not a domain name`);
}

export function assertEmailOrDomain(entry: string): void {
  if (!entry || /\s/.test(entry) || (!entry.startsWith("@") && !entry.includes("@"))) throw new Error(`"${entry}" is not an email address or @domain`);
}

/** One thing the CLI does as root, or prints for the operator to do. */
export type FleetStep =
  | { kind: "mkdir"; path: string; mode: number; owner?: string }
  | { kind: "write"; path: string; content: string; mode: number; owner?: string }
  | { kind: "append-once"; path: string; line: string }
  | { kind: "remove"; path: string }
  | { kind: "run"; argv: string[]; why: string }
  | { kind: "health"; url: string; why: string }
  | { kind: "note"; text: string };

/** The one unit every workspace runs from; `%i` is the slug. */
export function templateUnit(spec: { node: string; script: string; layout?: FleetLayout }): string {
  const layout = spec.layout ?? fleetLayout();
  const strip = spec.script.endsWith(".ts") ? " --experimental-strip-types" : "";
  return [
    "# Written by `openmausbot fleet init`. One unit for every workspace: %i is the slug.",
    "[Unit]",
    "Description=OpenMausBot workspace %i",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `User=${FLEET_USER_PREFIX}%i`,
    `Group=${FLEET_USER_PREFIX}%i`,
    `WorkingDirectory=${layout.homesDir}/%i`,
    `EnvironmentFile=${layout.instancesDir}/%i.env`,
    `Environment=HOME=${layout.homesDir}/%i`,
    "Environment=PATH=/usr/local/bin:/usr/bin:/bin",
    `ExecStart=${spec.node}${strip} ${spec.script} serve --port \${OMB_PORT} --data-dir \${OMB_DATA_DIR} --public-url \${OMB_PUBLIC_URL} --label %i --no-pair`,
    "Restart=always",
    "RestartSec=3",
    "KillMode=mixed",
    "TimeoutStopSec=30",
    "# Each workspace gets its own temp, cannot gain privileges, and writes only its own home.",
    "PrivateTmp=yes",
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    `ReadWritePaths=${layout.homesDir}/%i`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

export function fenceUnit(layout = fleetLayout()): string {
  return [
    "# Written by `openmausbot fleet init`: keeps each workspace's loopback ports to its own user.",
    "[Unit]",
    "Description=OpenMausBot per-workspace loopback fence",
    "Before=openmausbot@.service",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `ExecStart=/usr/sbin/nft -f ${layout.fenceFile}`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** nftables rules: only a workspace's own user, Caddy and root may open its
 * loopback ports, so a shell-capable bot cannot reach a sibling's API.
 * Written whole each time, so `nft -f` is idempotent. */
export function fenceRules(workspaces: FleetWorkspace[]): string {
  const lines = ["#!/usr/sbin/nft -f", "# Written by `openmausbot fleet`; regenerated on every create, suspend, resume and delete.", "add table inet openmausbot", "flush table inet openmausbot", "table inet openmausbot {", "\tchain output {", "\t\ttype filter hook output priority 0; policy accept;"];
  for (const workspace of [...workspaces].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (workspace.status !== "running" && workspace.status !== "suspended" && workspace.status !== "retained" && !workspace.accountCreated) continue;
    lines.push(`\t\toif lo tcp dport { ${workspace.port}, ${workspace.webhookPort} } meta skuid != { ${fleetUser(workspace.slug)}, caddy, root } reject`);
  }
  lines.push("\t}", "}", "");
  return lines.join("\n");
}

export function caddySite(workspace: Pick<FleetWorkspace, "host" | "port" | "webhookPort" | "status">): string {
  if (workspace.status !== "running") {
    const message = workspace.status === "suspended" ? "This workspace is suspended." : "This workspace is not available.";
    return [`${workspace.host} {`, `\trespond "${message}" 503`, "}", ""].join("\n");
  }
  return [
    `${workspace.host} {`,
    "\tencode zstd gzip",
    "\thandle /hooks/* {",
    `\t\treverse_proxy 127.0.0.1:${workspace.webhookPort}`,
    "\t}",
    "\thandle {",
    `\t\treverse_proxy 127.0.0.1:${workspace.port} {`,
    "\t\t\tflush_interval -1",
    "\t\t}",
    "\t}",
    "}",
    "",
  ].join("\n");
}

export function caddyImportLine(layout = fleetLayout()): string {
  return `import ${layout.caddyDir}/*.caddy`;
}

export function instanceEnv(input: { workspace: FleetWorkspace; dataDir: string; licenseKey?: string; portalUrl?: string }): string {
  const lines = [
    `OMB_DATA_DIR=${input.dataDir}`,
    `OMB_PORT=${input.workspace.port}`,
    `OMB_WEBHOOK_PORT=${input.workspace.webhookPort}`,
    `OMB_PUBLIC_URL=https://${input.workspace.host}`,
  ];
  if (input.licenseKey) lines.push(`OMB_LICENSE_KEY=${input.licenseKey}`);
  if (input.portalUrl) lines.push(`OMB_ADMIN_URL=${input.portalUrl}`, `OMB_ADMIN_WORKSPACE=${input.workspace.slug}`);
  return lines.join("\n") + "\n";
}

export interface WorkspaceSeed {
  admins: string[];
  members: string[];
  anthropicKey?: string;
  anthropicUrl?: string;
  openrouterKey?: string;
  openrouterUrl?: string;
  openrouterModels?: string[];
  openrouterDefault?: boolean;
  /** Root-owned hosted portal address; never configurable by a tenant. */
  portalUrl?: string;
  monthlyCapUsd?: number;
  brandJson?: string;
}

export const MANAGED_OPENROUTER = "omb-managed-openrouter";

/** The gateway validates assignments too; keep filesystem seeds bounded and literal. */
export function openRouterModelIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,159}$/.test(id))) {
    throw new Error("OpenRouter models must be an array of at most 100 valid model IDs");
  }
  return [...new Set(value as string[])];
}

export function managedOpenRouterModels(models: unknown): Record<string, { name: string }> {
  return Object.fromEntries(openRouterModelIds(models).map((id) => [id, { name: id }]));
}

/** The workspace's first config.json: who may sign in, the key it runs on,
 * and its cap. Everything else stays the server's defaults. */
export function initialConfig(seed: WorkspaceSeed): string {
  const config: Record<string, unknown> = { signIn: { admins: seed.admins, members: seed.members } };
  if (seed.anthropicKey) config.anthropic = { key: seed.anthropicKey, ...(seed.anthropicUrl ? { url: seed.anthropicUrl } : {}) };
  if (seed.openrouterDefault && seed.openrouterModels?.length) config.defaultModelSelection = { instanceId: "opencodeGo", model: `${MANAGED_OPENROUTER}/${seed.openrouterModels[0]}` };
  if (seed.monthlyCapUsd !== undefined) config.budgets = { monthlyUsd: seed.monthlyCapUsd };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function allocatePort(registry: FleetRegistry): { port: number; next: number } {
  const taken = new Set(Object.values(registry.workspaces).map((workspace) => workspace.port));
  let port = registry.nextPort;
  while (taken.has(port)) port += FLEET_PORT_STRIDE;
  return { port, next: port + FLEET_PORT_STRIDE };
}

const argvText = (argv: string[]) => argv.join(" ");

export function assertUnixUser(name: string): void {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name)) throw new Error(`"${name}" is not a Unix user name`);
}

export function initPlan(input: { domain: string; node: string; script: string; operator?: string; layout?: FleetLayout }): { steps: FleetStep[]; registry: FleetRegistry } {
  assertDomain(input.domain);
  if (input.operator) assertUnixUser(input.operator);
  const layout = input.layout ?? fleetLayout();
  const registry: FleetRegistry = { ...emptyRegistry(input.domain.toLowerCase()), ...(input.operator ? { operator: input.operator } : {}) };
  const steps: FleetStep[] = [
    { kind: "mkdir", path: layout.etcDir, mode: 0o755 },
    { kind: "mkdir", path: layout.instancesDir, mode: 0o700 },
    { kind: "mkdir", path: layout.homesDir, mode: 0o755 },
    { kind: "mkdir", path: layout.caddyDir, mode: 0o755 },
    { kind: "mkdir", path: layout.auditFile.replace(/\/[^/]+$/, ""), mode: 0o750 },
    { kind: "write", path: layout.registryFile, content: `${JSON.stringify(registry, null, 2)}\n`, mode: 0o600 },
    { kind: "write", path: layout.unitFile, content: templateUnit({ node: input.node, script: input.script, layout }), mode: 0o644 },
    { kind: "write", path: layout.fenceFile, content: fenceRules([]), mode: 0o600 },
    { kind: "write", path: layout.fenceUnitFile, content: fenceUnit(layout), mode: 0o644 },
    ...(input.operator ? [{ kind: "write" as const, path: layout.agentUnitFile, content: agentUnit({ node: input.node, script: input.script, operator: input.operator, layout }), mode: 0o644 }] : []),
    { kind: "append-once", path: layout.caddyfile, line: caddyImportLine(layout) },
    { kind: "run", argv: ["systemctl", "daemon-reload"], why: "load the workspace template and the fence unit" },
    { kind: "run", argv: ["systemctl", "enable", "--now", "openmausbot-fence.service"], why: "apply the loopback fence now and at boot" },
    ...(input.operator ? [{ kind: "run" as const, argv: ["systemctl", "enable", "--now", "openmausbot-fleet.service"], why: `start the fleet agent for ${input.operator}` }] : []),
    { kind: "run", argv: ["systemctl", "reload", "caddy"], why: "start serving the workspaces folder" },
    { kind: "note", text: `point *.${registry.domain} at this server (a wildcard A/AAAA record); each workspace gets its own certificate when created` },
    ...(input.operator ? [{ kind: "note" as const, text: `the workspace running as ${input.operator} can now manage workspaces from Settings → Workspaces` }] : []),
  ];
  return { steps, registry };
}

export function createPlan(input: {
  registry: FleetRegistry;
  slug: string;
  seed: WorkspaceSeed;
  licenseKey?: string;
  memoryMax?: string;
  now?: Date;
  layout?: FleetLayout;
}): { steps: FleetStep[]; registry: FleetRegistry; workspace: FleetWorkspace } {
  assertSlug(input.slug);
  if (input.seed.portalUrl) {
    const portal = new URL(input.seed.portalUrl);
    if (portal.protocol !== "https:" || portal.origin !== input.seed.portalUrl) throw new Error("portalUrl must be an HTTPS origin without a path or credentials");
    if (portal.hostname === `${input.slug}.${input.registry.domain}`) throw new Error("this workspace name is reserved for the admin portal");
    if (input.seed.anthropicUrl && input.seed.anthropicUrl !== `${portal.origin}/api/gateway/${input.slug}/anthropic`) throw new Error("managed provider URL must belong to this workspace's portal gateway");
  } else if (input.seed.anthropicUrl) throw new Error("a managed provider URL requires portalUrl");
  if (input.seed.openrouterKey !== undefined || input.seed.openrouterUrl !== undefined || input.seed.openrouterModels !== undefined || input.seed.openrouterDefault) {
    if (!input.seed.portalUrl || input.seed.openrouterUrl !== `${input.seed.portalUrl}/api/gateway/${input.slug}/openrouter/v1`) throw new Error("managed OpenRouter URL must belong to this workspace's portal gateway");
    if (!input.seed.openrouterKey || !/^[!-~]+$/.test(input.seed.openrouterKey)) throw new Error("managed OpenRouter requires a non-empty workspace credential without whitespace");
    const models = openRouterModelIds(input.seed.openrouterModels ?? []);
    if (input.seed.openrouterDefault && !models.length) throw new Error("a default OpenRouter model requires a model assignment");
  }
  if (input.registry.workspaces[input.slug]) throw new Error(`workspace "${input.slug}" already exists`);
  if (!input.seed.admins.length) throw new Error("a workspace needs at least one admin email (--admin)");
  for (const entry of [...input.seed.admins, ...input.seed.members]) assertEmailOrDomain(entry);
  if (input.memoryMax !== undefined && !/^\d+[MG]$/.test(input.memoryMax)) throw new Error("--memory takes a size like 1G or 512M");
  const layout = input.layout ?? fleetLayout();
  const { port, next } = allocatePort(input.registry);
  const workspace: FleetWorkspace = {
    slug: input.slug,
    host: `${input.slug}.${input.registry.domain}`,
    port,
    webhookPort: port + 1,
    status: "running",
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  const registry: FleetRegistry = { ...input.registry, nextPort: next, workspaces: { ...input.registry.workspaces, [workspace.slug]: workspace } };
  const reserved = (accountCreated: boolean): FleetRegistry => ({
    ...registry,
    workspaces: { ...registry.workspaces, [workspace.slug]: { ...workspace, status: "provisioning", accountCreated } },
  });
  const user = fleetUser(workspace.slug);
  const home = workspaceHome(layout, workspace.slug);
  const dataDir = workspaceDataDir(layout, workspace.slug);
  const steps: FleetStep[] = [
    // Reserve the identity and ports before any external resource is created.
    // A crash leaves an inspectable reservation, never a silently reusable home.
    { kind: "write", path: layout.registryFile, content: `${JSON.stringify(reserved(false), null, 2)}\n`, mode: 0o600 },
    { kind: "run", argv: ["useradd", "--system", "--create-home", "--home-dir", home, "--shell", "/usr/sbin/nologin", "--user-group", user], why: `the workspace's own account` },
    { kind: "write", path: layout.registryFile, content: `${JSON.stringify(reserved(true), null, 2)}\n`, mode: 0o600 },
    { kind: "mkdir", path: dataDir, mode: 0o700, owner: user },
    { kind: "write", path: join(dataDir, "config.json"), content: initialConfig(input.seed), mode: 0o600, owner: user },
    ...(input.seed.openrouterKey ? [
      { kind: "mkdir" as const, path: join(home, ".config"), mode: 0o700, owner: user },
      { kind: "mkdir" as const, path: join(home, ".config", "opencode"), mode: 0o700, owner: user },
      { kind: "write" as const, path: join(home, ".config", "opencode", "opencode.json"), mode: 0o600, owner: user, content: `${JSON.stringify({ provider: { [MANAGED_OPENROUTER]: {
        npm: "@ai-sdk/openai-compatible", name: "Managed OpenRouter",
        options: { baseURL: input.seed.openrouterUrl, apiKey: input.seed.openrouterKey },
        models: managedOpenRouterModels(input.seed.openrouterModels ?? []),
      } } }, null, 2)}\n` },
    ] : []),
    ...(input.seed.brandJson ? [{ kind: "write" as const, path: join(dataDir, "brand.json"), content: input.seed.brandJson, mode: 0o600, owner: user }] : []),
    { kind: "write", path: join(layout.instancesDir, `${workspace.slug}.env`), content: instanceEnv({ workspace, dataDir, licenseKey: input.licenseKey, portalUrl: input.seed.portalUrl }), mode: 0o600 },
    ...(input.memoryMax
      ? [
          { kind: "mkdir" as const, path: join(layout.unitFile.replace(/openmausbot@\.service$/, ""), `openmausbot@${workspace.slug}.service.d`), mode: 0o755 },
          { kind: "write" as const, path: join(layout.unitFile.replace(/openmausbot@\.service$/, ""), `openmausbot@${workspace.slug}.service.d`, "limits.conf"), content: `[Service]\nMemoryMax=${input.memoryMax}\n`, mode: 0o644 },
        ]
      : []),
    { kind: "write", path: layout.fenceFile, content: fenceRules(Object.values(registry.workspaces)), mode: 0o600 },
    { kind: "run", argv: ["nft", "-f", layout.fenceFile], why: "fence the new ports to their user" },
    { kind: "run", argv: ["systemctl", "daemon-reload"], why: "pick up the workspace's environment and limits" },
    { kind: "run", argv: ["systemctl", "enable", "--now", `openmausbot@${workspace.slug}.service`], why: "start the workspace now and at boot" },
    { kind: "health", url: `http://127.0.0.1:${workspace.port}/api/health`, why: "wait for the workspace to answer" },
    { kind: "write", path: join(layout.caddyDir, `${workspace.slug}.caddy`), content: caddySite(workspace), mode: 0o644 },
    { kind: "run", argv: ["systemctl", "reload", "caddy"], why: `serve https://${workspace.host} and fetch its certificate` },
    { kind: "write", path: layout.registryFile, content: `${JSON.stringify(registry, null, 2)}\n`, mode: 0o600 },
    { kind: "note", text: `https://${workspace.host} is ready; ${input.seed.admins[0]} signs in with an emailed code` },
  ];
  return { steps, registry, workspace };
}

/** Incomplete provisioning and retained homes need explicit operator recovery. */
export function assertManagedWorkspace(workspace: FleetWorkspace): void {
  if (workspace.status !== "running" && workspace.status !== "suspended") throw new Error(`workspace "${workspace.slug}" is ${workspace.status} and requires operator recovery`);
}

function withStatus(registry: FleetRegistry, slug: string, status: "running" | "suspended"): { registry: FleetRegistry; workspace: FleetWorkspace } {
  assertSlug(slug);
  const current = registry.workspaces[slug];
  if (!current) throw new Error(`no workspace "${slug}"`);
  assertManagedWorkspace(current);
  const workspace = { ...current, status };
  return { registry: { ...registry, workspaces: { ...registry.workspaces, [slug]: workspace } }, workspace };
}

export function suspendPlan(input: { registry: FleetRegistry; slug: string; layout?: FleetLayout }): { steps: FleetStep[]; registry: FleetRegistry } {
  const layout = input.layout ?? fleetLayout();
  const { registry, workspace } = withStatus(input.registry, input.slug, "suspended");
  return {
    registry,
    steps: [
      { kind: "run", argv: ["systemctl", "disable", "--now", `openmausbot@${workspace.slug}.service`], why: "stop the workspace and keep it stopped at boot" },
      { kind: "write", path: join(layout.caddyDir, `${workspace.slug}.caddy`), content: caddySite(workspace), mode: 0o644 },
      { kind: "run", argv: ["systemctl", "reload", "caddy"], why: "show the suspended page instead" },
      { kind: "write", path: layout.registryFile, content: `${JSON.stringify(registry, null, 2)}\n`, mode: 0o600 },
    ],
  };
}

export function resumePlan(input: { registry: FleetRegistry; slug: string; layout?: FleetLayout }): { steps: FleetStep[]; registry: FleetRegistry } {
  const layout = input.layout ?? fleetLayout();
  const { registry, workspace } = withStatus(input.registry, input.slug, "running");
  return {
    registry,
    steps: [
      { kind: "run", argv: ["systemctl", "enable", "--now", `openmausbot@${workspace.slug}.service`], why: "start the workspace again" },
      { kind: "health", url: `http://127.0.0.1:${workspace.port}/api/health`, why: "wait for the workspace to answer" },
      { kind: "write", path: join(layout.caddyDir, `${workspace.slug}.caddy`), content: caddySite(workspace), mode: 0o644 },
      { kind: "run", argv: ["systemctl", "reload", "caddy"], why: "serve it again" },
      { kind: "write", path: layout.registryFile, content: `${JSON.stringify(registry, null, 2)}\n`, mode: 0o600 },
    ],
  };
}

export function deletePlan(input: { registry: FleetRegistry; slug: string; keepData: boolean; layout?: FleetLayout }): { steps: FleetStep[]; registry: FleetRegistry } {
  assertSlug(input.slug);
  const layout = input.layout ?? fleetLayout();
  const workspace = input.registry.workspaces[input.slug];
  if (!workspace) throw new Error(`no workspace "${input.slug}"`);
  assertManagedWorkspace(workspace);
  const { [input.slug]: _gone, ...rest } = input.registry.workspaces;
  const registry: FleetRegistry = { ...input.registry, workspaces: input.keepData ? { ...rest, [input.slug]: { ...workspace, status: "retained" } } : rest };
  const unitsDir = layout.unitFile.replace(/openmausbot@\.service$/, "");
  return {
    registry,
    steps: [
      { kind: "run", argv: ["systemctl", "disable", "--now", `openmausbot@${workspace.slug}.service`], why: "stop the workspace" },
      { kind: "remove", path: join(layout.caddyDir, `${workspace.slug}.caddy`) },
      { kind: "run", argv: ["systemctl", "reload", "caddy"], why: "stop serving its address" },
      { kind: "remove", path: join(layout.instancesDir, `${workspace.slug}.env`) },
      { kind: "remove", path: join(unitsDir, `openmausbot@${workspace.slug}.service.d`, "limits.conf") },
      { kind: "write", path: layout.fenceFile, content: fenceRules(Object.values(registry.workspaces)), mode: 0o600 },
      { kind: "run", argv: ["nft", "-f", layout.fenceFile], why: input.keepData ? "keep the retained account's fence" : "drop its fence rule" },
      // Retain the nologin account too: recycling its UID would give a new
      // workspace ownership of the preserved home, even under a different slug.
      ...(input.keepData
        ? [{ kind: "note" as const, text: "keeping the disabled workspace's account, home and name reserved; operator recovery is required before reuse" }]
        : [{ kind: "run" as const, argv: ["userdel", "--remove", fleetUser(workspace.slug)], why: "remove the account and everything it owned" }]),
      { kind: "write", path: layout.registryFile, content: `${JSON.stringify(registry, null, 2)}\n`, mode: 0o600 },
    ],
  };
}

export function upgradePlan(input: { registry: FleetRegistry }): FleetStep[] {
  const running = Object.values(input.registry.workspaces).filter((workspace) => workspace.status === "running").sort((a, b) => a.slug.localeCompare(b.slug));
  return [
    { kind: "run", argv: ["npm", "install", "-g", "openmausbot@latest"], why: "install the release every workspace runs from" },
    ...running.map((workspace) => ({ kind: "run" as const, argv: ["systemctl", "restart", `openmausbot@${workspace.slug}.service`], why: `restart ${workspace.slug} on the new release` })),
    ...running.map((workspace) => ({ kind: "health" as const, url: `http://127.0.0.1:${workspace.port}/api/health`, why: `wait for ${workspace.slug}` })),
  ];
}

/** A workspace's sign-in list edited from outside, the same shape
 * `openmausbot access` writes; the server reads it live. */
export function applySignIn(configText: string, action: "add" | "remove", email: string, chatOnly: boolean): { config: string; summary: string } {
  const entry = email.trim().toLowerCase();
  assertEmailOrDomain(entry);
  let raw: Record<string, unknown> = {};
  const parsed: unknown = JSON.parse(configText || "{}");
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = { ...(parsed as Record<string, unknown>) };
  const current = raw.signIn && typeof raw.signIn === "object" ? (raw.signIn as { admins?: unknown; members?: unknown }) : {};
  const list = (value: unknown) => (Array.isArray(value) ? value.map((item) => String(item).trim().toLowerCase()).filter(Boolean) : []);
  const without = (items: string[]) => items.filter((item) => item !== entry);
  const admins = without(list(current.admins));
  const members = without(list(current.members));
  if (action === "remove") {
    if (admins.length + members.length === list(current.admins).length + list(current.members).length) throw new Error(`${entry} is not on the list`);
    if (!admins.length) throw new Error("a workspace needs at least one admin; add another admin first");
    return { config: `${JSON.stringify({ ...raw, signIn: { admins, members } }, null, 2)}\n`, summary: `${entry} was removed from the allow-list; existing email sessions are rechecked against the remaining entries` };
  }
  const next = chatOnly ? { admins, members: [...members, entry] } : { admins: [...admins, entry], members };
  if (!next.admins.length) throw new Error("a workspace needs at least one admin; add another admin first");
  return { config: `${JSON.stringify({ ...raw, signIn: next }, null, 2)}\n`, summary: `${entry} can sign in with an emailed code (${chatOnly ? "chat and approvals" : "full access"})` };
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Inspectable plan. Tenant I/O must use the executor's privilege drop. */
export function describeSteps(steps: FleetStep[]): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    switch (step.kind) {
      case "mkdir":
        lines.push(step.owner
          ? `# Create ${shellQuote(step.path)} mode ${step.mode.toString(8)} as ${step.owner} (use fleet --yes; never root chown on tenant paths)`
          : `install -d -m ${step.mode.toString(8)} ${shellQuote(step.path)}`);
        break;
      case "write":
        if (step.owner) {
          lines.push(`# Write ${shellQuote(step.path)} mode ${step.mode.toString(8)} as ${step.owner} (use fleet --yes; tenant content omitted)`);
          break;
        }
        lines.push(`cat > ${shellQuote(step.path)} <<'OMB_EOF'`, step.content.replace(/\n$/, ""), "OMB_EOF", `chmod ${step.mode.toString(8)} ${shellQuote(step.path)}`);
        break;
      case "append-once":
        lines.push(`grep -qxF ${shellQuote(step.line)} ${shellQuote(step.path)} || printf '\\n%s\\n' ${shellQuote(step.line)} >> ${shellQuote(step.path)}`);
        break;
      case "remove":
        lines.push(`rm -f ${shellQuote(step.path)}`);
        break;
      case "run":
        lines.push(`${argvText(step.argv.map(shellQuote))}   # ${step.why}`);
        break;
      case "health":
        lines.push(`until curl -sf ${shellQuote(step.url)} >/dev/null; do sleep 1; done   # ${step.why}`);
        break;
      case "note":
        lines.push(`# ${step.text}`);
        break;
    }
  }
  return lines;
}
