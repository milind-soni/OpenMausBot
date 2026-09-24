import { z } from "zod";

/** An organisation's desktop policy, received only over Electron's private
 * utility-parent port while this desktop is enrolled. It lives in memory: it
 * is never merged into config.json, and it adds no prompts or approvals —
 * a disallowed action is simply refused with a sentence saying who manages it. */
const policySchema = z.object({
  organizationId: z.string().uuid(),
  organizationName: z.string().trim().min(1).max(100),
  expiresAt: z.number().int().positive(),
  version: z.number().int().min(0).max(2_147_483_647),
  companyModelsOnly: z.boolean(),
  allowedEngines: z.union([z.literal("all"), z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/)).max(64)]),
  mcp: z.object({ allowCustom: z.boolean(), allowlist: z.array(z.string().trim().min(1).max(200)).max(100) }).strict(),
  computers: z.object({ thisComputer: z.boolean(), localVm: z.boolean(), box: z.boolean(), vps: z.boolean() }).strict(),
  remoteAccess: z.boolean(),
}).strict();
export type ManagedPolicy = z.infer<typeof policySchema>;
export type ComputerKind = keyof ManagedPolicy["computers"];
const computerLabels: Record<ComputerKind, string> = { thisComputer: "this computer", localVm: "local virtual machines", box: "Box cloud computers", vps: "VPS computers" };

export function parseManagedPolicy(raw: unknown, now = Date.now()): ManagedPolicy | null {
  if (raw === null) return null;
  const parsed = policySchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid organisation policy from the desktop parent.");
  return parsed.data.expiresAt > now ? parsed.data : null;
}

/** `*` in a host pattern stands for one or more whole labels, never part of
 * one, so `*.example.com` cannot match `evil.test/x.example.com`. */
function hostMatches(pattern: string[], host: string[]): boolean {
  if (!pattern.length) return !host.length;
  if (pattern[0] === "*") {
    for (let taken = 1; taken <= host.length - (pattern.length - 1); taken++) if (hostMatches(pattern.slice(1), host.slice(taken))) return true;
    return false;
  }
  return host.length > 0 && pattern[0] === host[0] && hostMatches(pattern.slice(1), host.slice(1));
}

/** A name entry matches the configured server name. An address entry
 * (https:// only) is parsed like the server's URL: no credentials, the same
 * port, the host compared label by label, and the path separately (`*` there
 * matches any characters). Anything that does not parse never matches. */
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

/** A resource key claimed by bindTurnComputer, mapped to the policy's kind. */
export function computerKindForResource(resource: string): ComputerKind | undefined {
  if (resource === "computer:host") return "thisComputer";
  if (resource.startsWith("computer:vm:")) return "localVm";
  if (resource.startsWith("computer:box:") || resource.startsWith("computer:box-bot:")) return "box";
  if (resource.startsWith("computer:vps:")) return "vps";
}

export class ManagedDesktopPolicy {
  private policy: ManagedPolicy | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly onChange: () => void;
  constructor(options: { now?: () => number; onChange?: () => void } = {}) {
    this.now = options.now ?? Date.now; this.onChange = options.onChange ?? (() => {});
  }

  apply(raw: unknown): void {
    const next = parseManagedPolicy(raw, this.now());
    const changed = JSON.stringify(next) !== JSON.stringify(this.policy);
    this.policy = next;
    clearTimeout(this.timer);
    // The last applied policy holds only as long as the device credential.
    if (next) {
      this.timer = setTimeout(() => this.apply(null), Math.min(2_147_483_647, Math.max(1, next.expiresAt - this.now())));
      this.timer.unref?.();
    }
    if (changed) this.onChange();
  }
  current(): ManagedPolicy | null {
    return this.policy && this.policy.expiresAt > this.now() ? this.policy : null;
  }
  close() { clearTimeout(this.timer); this.policy = null; }

  /** Why this organisation does not allow an instance to run a turn, or undefined. */
  modelRefusal(instance: { driverKind: string; displayName?: string }, company: boolean): string | undefined {
    const policy = this.current();
    if (!policy) return;
    if (policy.companyModelsOnly && !company) return `${policy.organizationName} allows only company models on this computer. Choose a Company model for this bot.`;
    if (policy.allowedEngines !== "all" && !policy.allowedEngines.includes(instance.driverKind)) {
      return `${policy.organizationName} does not allow the ${instance.displayName ?? instance.driverKind} engine on this computer. Choose another model for this bot.`;
    }
  }

  mcpAllowed(name: string, url?: string): boolean {
    const policy = this.current();
    return !policy || policy.mcp.allowCustom || policy.mcp.allowlist.some(entry => mcpEntryMatches(entry, name, url));
  }
  /** Only approved servers reach engines while custom servers are off. */
  filterMcp<T extends object>(servers: Record<string, T>): Record<string, T> {
    if (!this.restrictsMcp()) return servers;
    return Object.fromEntries(Object.entries(servers).filter(([name, server]) =>
      this.mcpAllowed(name, "url" in server && typeof server.url === "string" ? server.url : undefined)));
  }
  restrictsMcp(): boolean { const policy = this.current(); return Boolean(policy && !policy.mcp.allowCustom); }
  mcpRefusal(name: string, url?: string): string | undefined {
    const policy = this.current();
    if (!policy || this.mcpAllowed(name, url)) return;
    return `${policy.organizationName} allows only MCP servers it has approved. Ask your administrator to add this server to the approved list.`;
  }

  computerAllowed(kind: ComputerKind): boolean { return this.current()?.computers[kind] ?? true; }
  computerRefusal(kind: ComputerKind): string | undefined {
    const policy = this.current();
    if (!policy || policy.computers[kind]) return;
    return `${policy.organizationName} does not allow bots to use ${computerLabels[kind]}.`;
  }

  remoteAccessRefusal(): string | undefined {
    const policy = this.current();
    if (!policy || policy.remoteAccess) return;
    return `${policy.organizationName} does not allow remote access to this computer.`;
  }

  /** Read-only view for the renderer; carries nothing secret. */
  summary() {
    const policy = this.current();
    if (!policy) return null;
    const { organizationId: _id, expiresAt: _expires, ...visible } = policy;
    return visible;
  }
}
