import { z } from "zod";
import { serviceSlugFor, serviceSlugForCandidates } from "./connector-verdict.ts";
import { appLabel } from "./team-connections.ts";

/** Received over Electron's private port, or on a Team Cloud from the Admin (cloud-team-policy.ts), and held in memory:
 * never merged into config.json, and adds no prompts. */
const policySchema = z.object({
  organizationId: z.string().trim().min(1).max(128),
  organizationName: z.string().trim().min(1).max(100),
  /** Null: a Team Cloud's rules, which never lapse; they stay in force until the team changes them. */
  expiresAt: z.number().int().positive().nullable(),
  version: z.number().int().min(0).max(2_147_483_647),
  companyModelsOnly: z.boolean(),
  allowedEngines: z.union([z.literal("all"), z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)).max(64)]),
  mcp: z.object({ allowCustom: z.boolean(), allowlist: z.array(z.string().trim().min(1).max(200)).max(100) }).strict(),
  // "box" is Boat's historical key in the org-policy schema shared with the desktop parent.
  computers: z.object({ thisComputer: z.boolean(), localVm: z.boolean(), box: z.boolean(), vps: z.boolean(), mola: z.boolean() }).strict(),
  remoteAccess: z.boolean(),
  /** Connected apps by service slug. Absent: this policy says nothing about them. */
  apps: z.object({ allowAll: z.boolean(), allowlist: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)).max(200) }).strict().optional(),
  /** Present on a Team Cloud's rules. `requireFresh`: new turns wait while the rules can't be confirmed with the Admin.
   * `ownMcpOnly`: bots get only what the team's admins added; a bot can't add one, and a bot's own doesn't start. */
  team: z.object({ requireFresh: z.boolean(), ownMcpOnly: z.boolean() }).strict().optional(),
}).strict();
export type ManagedPolicy = z.infer<typeof policySchema>;
export type ComputerKind = keyof ManagedPolicy["computers"];
const computerLabels: Record<ComputerKind, string> = { thisComputer: "this computer", localVm: "local virtual machines", box: "cloud computers", vps: "VPS computers", mola: "Mola computers" };
const teamComputerLabels: Record<ComputerKind, string> = { ...computerLabels, thisComputer: "a member's own computer", localVm: "a member's own computer" };
const ASK_ADMIN = "Ask a team admin.";

export function parseManagedPolicy(raw: unknown, now = Date.now()): ManagedPolicy | null {
  if (raw === null) return null;
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid organisation policy from the desktop parent.");
  return parsed.data.expiresAt === null || parsed.data.expiresAt > now ? parsed.data : null;
}

/** `*` stands for one or more whole labels, never part of one. */
function hostMatches(pattern: string[], host: string[]): boolean {
  if (!pattern.length) return !host.length;
  if (pattern[0] === "*") {
    for (let taken = 1; taken <= host.length - (pattern.length - 1); taken++) if (hostMatches(pattern.slice(1), host.slice(taken))) return true;
    return false;
  }
  return host.length > 0 && pattern[0] === host[0] && hostMatches(pattern.slice(1), host.slice(1));
}

/** An address entry (https:// only) matches without credentials, on the same port, label by label; unparsable never matches. */
export function mcpEntryMatches(entry: string, name: string, url?: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) return entry.toLowerCase() === name.toLowerCase();
  if (!url) return false;
  let pattern: URL, target: URL;
  try { pattern = new URL(entry); target = new URL(url); } catch { return false; }
  if (pattern.protocol !== "https:" || target.protocol !== "https:" || pattern.username || pattern.password || target.username || target.password ||
      pattern.search || pattern.hash || pattern.port !== target.port) return false;
  const labels = pattern.hostname.split(".");
  if (labels.some(label => !label || (label !== "*" && label.includes("*"))) || labels.every(label => label === "*")) return false;
  if (!hostMatches(labels, target.hostname.split("."))) return false;
  const path = pattern.pathname.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${path}$`).test(target.pathname);
}

export function computerKindForResource(resource: string): ComputerKind | undefined {
  if (resource === "computer:host") return "thisComputer";
  if (resource.startsWith("computer:vm:")) return "localVm";
  // computer:box: and computer:box-bot: are Boat's historical resource prefixes.
  if (resource.startsWith("computer:box:") || resource.startsWith("computer:box-bot:")) return "box";
  if (resource.startsWith("computer:vps:")) return "vps";
}

export class ManagedDesktopPolicy {
  private policy: ManagedPolicy | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private fresh: () => boolean = () => true;
  constructor(options: { now?: () => number; onChange?: () => void } = {}) {
    this.now = options.now ?? Date.now; this.onChange = options.onChange ?? (() => {});
  }
  /** Whether a Team Cloud's rules are confirmed with the Admin now; read only for a team that requires it. */
  setFreshness(fresh: () => boolean): void { this.fresh = fresh; }

  apply(raw: unknown): void {
    const next = parseManagedPolicy(raw, this.now());
    const changed = JSON.stringify(next) !== JSON.stringify(this.policy);
    this.policy = next;
    clearTimeout(this.timer);
    // The last applied policy holds only as long as the device credential; a Team Cloud's rules have none to outlive.
    if (next?.expiresAt) {
      this.timer = setTimeout(() => this.apply(null), Math.min(2_147_483_647, Math.max(1, next.expiresAt - this.now())));
      this.timer.unref?.();
    }
    if (changed) this.onChange();
  }
  current(): ManagedPolicy | null {
    return this.policy && (this.policy.expiresAt === null || this.policy.expiresAt > this.now()) ? this.policy : null;
  }
  close() { clearTimeout(this.timer); this.policy = null; }

  modelRefusal(instance: { driverKind: string; displayName?: string }, company: boolean): string | undefined {
    const policy = this.current();
    if (!policy) return;
    if (policy.team?.requireFresh && !this.fresh()) return `${policy.organizationName} requires up-to-date rules, and this Cloud can't confirm them right now. Try again in a few minutes, or ask a team admin.`;
    if (policy.companyModelsOnly && !company) return `${policy.organizationName} allows only company models on this computer. Choose a Company model for this bot.`;
    if (policy.allowedEngines !== "all" && !policy.allowedEngines.includes(instance.driverKind)) {
      if (policy.team) return `${policy.organizationName} does not allow the ${instance.displayName ?? instance.driverKind} engine. Choose another model for this bot, or ask a team admin.`;
      return `${policy.organizationName} does not allow the ${instance.displayName ?? instance.driverKind} engine on this computer. Choose another model for this bot.`;
    }
  }

  mcpAllowed(name: string, url?: string, botOwn = false): boolean {
    const policy = this.current();
    if (botOwn && policy?.team?.ownMcpOnly) return false;
    return !policy || policy.mcp.allowCustom || policy.mcp.allowlist.some(entry => mcpEntryMatches(entry, name, url));
  }
  filterMcp<T extends object>(servers: Record<string, T>): Record<string, T> {
    if (!this.restrictsMcp()) return servers;
    return Object.fromEntries(Object.entries(servers).filter(([name, server]) =>
      this.mcpAllowed(name, "url" in server && typeof server.url === "string" ? server.url : undefined, "bot" in server && Boolean(server.bot))));
  }
  restrictsMcp(): boolean { const policy = this.current(); return Boolean(policy && (!policy.mcp.allowCustom || policy.team?.ownMcpOnly)); }
  /** A bot adding a server of its own. An admin adding one for the team is `mcpRefusal`'s to answer. */
  botMcpRefusal(): string | undefined {
    const policy = this.current();
    if (policy?.team?.ownMcpOnly) return `${policy.organizationName} uses only the MCP servers its admins add. ${ASK_ADMIN}`;
  }
  mcpRefusal(name: string, url?: string): string | undefined {
    const policy = this.current();
    if (!policy || this.mcpAllowed(name, url)) return;
    if (policy.team) return `${policy.organizationName} allows only MCP servers it has approved. Ask a team admin to add this one.`;
    return `${policy.organizationName} allows only MCP servers it has approved. Ask your administrator to add this server to the approved list.`;
  }

  computerAllowed(kind: ComputerKind): boolean { return this.current()?.computers[kind] ?? true; }
  computerRefusal(kind: ComputerKind): string | undefined {
    const policy = this.current();
    if (!policy || policy.computers[kind]) return;
    if (policy.team) return `${policy.organizationName} does not allow bots to use ${teamComputerLabels[kind]}. ${ASK_ADMIN}`;
    return `${policy.organizationName} does not allow bots to use ${computerLabels[kind]}.`;
  }

  remoteAccessRefusal(): string | undefined {
    const policy = this.current();
    if (!policy || policy.remoteAccess) return;
    if (policy.team) return `${policy.organizationName} does not allow opening this Cloud on a phone or with a link. ${ASK_ADMIN}`;
    return `${policy.organizationName} does not allow remote access to this computer.`;
  }

  appAllowed(slug: string): boolean {
    const apps = this.current()?.apps;
    return !apps || apps.allowAll || apps.allowlist.includes(slug);
  }
  appRefusal(slug: string): string | undefined {
    const policy = this.current();
    if (!policy || this.appAllowed(slug)) return;
    return `${policy.organizationName} does not allow bots to use ${appLabel(slug)}. ${ASK_ADMIN}`;
  }
  /** Apps a turn wants to connect: the first one refused. */
  appsConnectRefusal(slugs: readonly string[]): string | undefined {
    for (const slug of slugs) { const refusal = this.appRefusal(slug); if (refusal) return refusal; }
  }
  /** Tools a connected-apps call would run, as shared/outbound.ts names them; `connected`: the service slugs in use, since a
   * slug may hold an underscore. A call that runs code (`COMPOSIO_PROXY_EXECUTE`) could reach any app, so it is refused. */
  appsCallRefusal(calls: ReadonlyArray<{ slug: string }>, connected: readonly string[] = []): string | undefined {
    const policy = this.current(), apps = policy?.apps;
    if (!policy || !apps || apps.allowAll) return;
    for (const { slug } of calls) {
      if (slug === "COMPOSIO_PROXY_EXECUTE") return `${policy.organizationName} allows only the apps it has approved, so bots can't run code against them. ${ASK_ADMIN}`;
      const app = serviceSlugForCandidates(slug, [...apps.allowlist, ...connected]) ?? serviceSlugFor(slug) ?? slug;
      const refusal = this.appRefusal(app);
      if (refusal) return refusal;
    }
  }

  /** Read-only view for the renderer; carries nothing secret. */
  summary() {
    const policy = this.current();
    if (!policy) return null;
    const { organizationId: _id, expiresAt: _expires, team, ...visible } = policy;
    return { ...visible, ...(team ? { team: true as const } : {}) };
  }
}
