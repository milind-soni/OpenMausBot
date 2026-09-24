import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { InstanceConfigMap, ModelCatalog, ProviderInstance } from "./contracts.ts";
import type { ProviderRegistry } from "./harness/registry.ts";

const uuid = z.string().uuid();
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,199}$/).refine(value => !value.includes("::"));
const connectionSchema = z.object({
  portalOrigin: z.string().max(2048), organizationId: uuid, organizationName: z.string().trim().min(1).max(100),
  email: z.string().email().max(320), deviceId: uuid, token: z.string().regex(/^omg_[A-Za-z0-9_-]{43}$/),
  expiresAt: z.number().finite().int().positive(),
  providers: z.array(z.object({ id: z.enum(["anthropic", "openai", "openrouter"]), configured: z.boolean(), models: z.array(model).max(500) }).strict()).max(3),
  /** The Admin is up but its operator licence lapsed: keep the instances
   * listed as unavailable instead of treating it as a revocation. */
  suspended: z.literal("license-expired").optional(),
}).strict();
export type ManagedDesktopConnection = z.infer<typeof connectionSchema>;
/** The saved enrollment's identity (never its token), sent before it is
 * cleared or when it has already expired, so references to its old
 * device-scoped ids still move to the stable ids. */
const identitySchema = z.object({ portalOrigin: z.string().max(2048), organizationId: uuid, email: z.string().email().max(320), deviceId: uuid }).strict();
const PROVIDER_IDS = ["anthropic", "openai", "openrouter"] as const;
export interface ManagedDesktopInfo { organizationId: string; organizationName: string }
interface ManagedDesktopOptions {
  registry: ProviderRegistry; dataDirectory: string; now?: () => number;
  beforeReplace?: (ids: string[]) => void | Promise<void>;
  afterReplace?: (ids: string[]) => void;
  /** Saved selections, cursors and native homes still using a device-scoped
   * id from before ids became stable across re-enrolment. */
  migrate?: (aliases: { from: string; to: string }[]) => void | Promise<void>;
  /** Availability changed without replacing instances (licence lapse or renewal). */
  onAvailability?: () => void;
}
const signature = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const expiredMessage = "Company access has ended. Reconnect your organization or explicitly choose a personal model; personal billing will not be used automatically.";
export const LICENSE_EXPIRED_MESSAGE = "Your organisation's OpenMaus Admin licence has expired. Contact your admin.";

/** Validate only messages received over Electron's private utility-parent port.
 * Never expose this input to renderer HTTP or merge it into saved AppConfig.
 */
export function parseManagedDesktopConnection(raw: unknown, now = Date.now()): ManagedDesktopConnection | null {
  if (raw === null) return null;
  const parsed = connectionSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid Company connection from the desktop parent.");
  const value = parsed.data, url = new URL(value.portalOrigin);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("Company connection must use an HTTPS origin or loopback fixture.");
  }
  if (value.expiresAt <= now) throw new Error("Company connection expired. Reconnect your organization.");
  if (new Set(value.providers.map(provider => provider.id)).size !== value.providers.length) throw new Error("Duplicate Company provider configuration.");
  return { ...value, portalOrigin: url.origin, email: value.email.toLowerCase(), providers: value.providers.map(provider => ({ ...provider, models: [...new Set(provider.models)] })).sort((a, b) => a.id.localeCompare(b.id)) };
}

export function companyInstanceId(connection: Pick<ManagedDesktopConnection, "portalOrigin" | "organizationId" | "email">, provider: string): string {
  // Stable for one person in one organisation, so re-enrolling this computer
  // keeps bots' Company model choices and native resume. Another account or
  // organisation still gets separate ids, homes and cursors.
  return `company.${signature([connection.portalOrigin, connection.organizationId, connection.email.toLowerCase()]).slice(0, 24)}.${provider}`;
}

/** The pre-0.1.86 id, which also hashed the enrollment's deviceId. */
export function legacyCompanyInstanceId(connection: Pick<ManagedDesktopConnection, "portalOrigin" | "organizationId" | "deviceId">, provider: string): string {
  return `company.${signature([connection.portalOrigin, connection.organizationId, connection.deviceId]).slice(0, 24)}.${provider}`;
}
/** Everything that decides which native instances exist and what they hold.
 * Expiry and licence suspension change availability only, never a process. */
const instanceSignature = (connection: ManagedDesktopConnection | null) =>
  signature(connection && (({ expiresAt: _expiresAt, suspended: _suspended, ...identity }) => identity)(connection));

export function companyInstanceConfigs(connection: ManagedDesktopConnection, runtimeDirectory: string): InstanceConfigMap {
  const entries: InstanceConfigMap = {};
  for (const provider of connection.providers) {
    if (!provider.configured || !provider.models.length) continue;
    const id = companyInstanceId(connection, provider.id), base = `${connection.portalOrigin}/api/desktop/gateway/${provider.id}`;
    const displayName = `Company · ${connection.organizationName} · ${provider.id === "anthropic" ? "Claude" : provider.id === "openai" ? "Codex" : "OpenRouter"}`;
    if (provider.id === "anthropic") entries[id] = {
      driver: "claudeAgent", displayName,
      config: { configDir: join(runtimeDirectory, id, "claude"), managed: true },
      environment: { ANTHROPIC_API_KEY: connection.token, ANTHROPIC_AUTH_TOKEN: connection.token, ANTHROPIC_BASE_URL: base, ANTHROPIC_MODEL: provider.models[0] },
    };
    if (provider.id === "openai") entries[id] = {
      driver: "codex", displayName, config: { managed: { url: `${base}/v1`, models: provider.models } },
      environment: { OPENMAUSBOT_COMPANY_API_KEY: connection.token, CODEX_HOME: join(runtimeDirectory, id, "codex") },
    };
    if (provider.id === "openrouter") entries[id] = {
      driver: "openai-compat", displayName, config: { url: `${base}/v1`, apiKeyEnv: "OPENMAUSBOT_COMPANY_API_KEY", model: provider.models[0], provider: "" },
      environment: { OPENMAUSBOT_COMPANY_API_KEY: connection.token },
    };
  }
  return entries;
}

/** One memory-only Company overlay, separate from all personal settings.
 * Revocation fences wrappers synchronously, then stops only their instances.
 */
export class ManagedDesktopProviders {
  private connection: ManagedDesktopConnection | null = null;
  private currentSignature: string | null = signature(null);
  private revision = 0;
  private ids = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly options: ManagedDesktopOptions;
  constructor(options: ManagedDesktopOptions) { this.options = options; this.now = options.now ?? Date.now; }

  info(instanceId: string): ManagedDesktopInfo | undefined {
    if (!this.ids.has(instanceId) || !this.connection || this.connection.expiresAt <= this.now()) return;
    return { organizationId: this.connection.organizationId, organizationName: this.connection.organizationName };
  }
  /** Ids this overlay has ever created in this process, so a personal instance
   * that happens to be named company.* is never treated as managed. */
  private readonly known = new Set<string>();
  owns(instanceId: string): boolean { return this.known.has(instanceId); }

  apply(raw: unknown, force = false): Promise<void> {
    const connection = parseManagedDesktopConnection(raw, this.now()), nextSignature = instanceSignature(connection);
    if (!force && nextSignature === this.currentSignature) {
      // A renewal or licence change: same processes, new availability.
      const previous = this.connection;
      this.connection = connection;
      if (connection && previous && (connection.expiresAt !== previous.expiresAt || connection.suspended !== previous.suspended)) {
        clearTimeout(this.timer);
        this.scheduleExpiry(this.revision);
        this.options.onAvailability?.();
      }
      return this.tail;
    }
    this.currentSignature = nextSignature;
    this.connection = connection;
    const revision = ++this.revision;
    clearTimeout(this.timer);
    const replace = async () => {
      const previous = [...this.ids];
      await this.options.beforeReplace?.(previous);
      for (const id of previous) await this.options.registry.dispose(id);
      this.ids.clear();
      if (revision !== this.revision || !connection || connection.expiresAt <= this.now()) { this.options.afterReplace?.([]); return; }
      // Keep native sessions across server/app restarts, but outside portable
      // workspace backups. Device-scoped ids prevent a new enrollment from
      // inheriting another account's native conversation or credentials.
      const directory = this.ensureDirectory(["providers", "company"]);
      await this.migrateLegacyIds(connection);
      const configs = companyInstanceConfigs(connection, directory);
      for (const [id, entry] of Object.entries(configs)) {
        if (this.options.registry.entries().some(existing => existing.instanceId === id)) throw new Error("Company instance conflicts with an existing account.");
        if (entry.driver === "claudeAgent" || entry.driver === "codex") {
          this.ensureDirectory(["providers", "company", id, entry.driver === "claudeAgent" ? "claude" : "codex"]);
        }
        this.ids.add(id); this.known.add(id);
      }
      // Read the current grant: renewals and licence changes update it in place.
      const active = () => revision === this.revision && Boolean(this.connection && this.connection.expiresAt > this.now() && !this.connection.suspended);
      const unavailable = () => this.connection?.suspended === "license-expired" ? LICENSE_EXPIRED_MESSAGE : expiredMessage;
      await this.options.registry.load(configs, instance => {
        const provider = connection.providers.find(provider => companyInstanceId(connection, provider.id) === instance.instanceId)!;
        const models: ModelCatalog = { default: provider.models[0], options: provider.models.map(id => ({ id, label: `${id} (Company)` })) };
        return {
          ...instance, models,
          refreshModels: async () => {},
          startAuthentication: undefined, getAuthentication: undefined, completeAuthentication: undefined, cancelAuthentication: undefined, signOut: undefined,
          snapshot: async () => {
            if (!active()) return { state: "unavailable", reason: unavailable() };
            const snapshot = await instance.snapshot();
            if (!active()) return { state: "unavailable", reason: unavailable() };
            return { ...snapshot, authenticated: snapshot.state === "available", billing: "metered", account: { email: connection.email, organization: connection.organizationName, method: "api-key" } };
          },
          adapter: {
            ...instance.adapter,
            sendTurn: async input => {
              if (!active()) throw new Error(unavailable());
              if (!input.model || !provider.models.includes(input.model)) throw new Error("This model is not enabled by your Company administrator.");
              return instance.adapter.sendTurn(input);
            },
          },
        } satisfies ProviderInstance;
      });
      if (revision === this.revision) {
        this.options.afterReplace?.([...this.ids]);
        this.scheduleExpiry(revision);
      }
    };
    this.tail = this.tail.catch(() => {}).then(replace).catch(async error => {
      // A partial replacement must neither retain usable Company wrappers
      // nor memoize failure forever. Do not invalidate a newer queued grant.
      if (revision === this.revision) {
        this.revision++;
        this.connection = null;
        this.currentSignature = null;
        clearTimeout(this.timer);
      }
      await Promise.allSettled([...this.ids].map(id => this.options.registry.dispose(id)));
      this.ids.clear();
      this.options.afterReplace?.([]);
      throw error;
    });
    return this.tail;
  }

  /** Called after the ordinary fleet is rebuilt; never add Company to cfg. */
  restore(): Promise<void> { return this.apply(this.connection && this.connection.expiresAt > this.now() ? this.connection : null, true); }
  private ensureDirectory(parts: string[]): string {
    // Only the configured workspace root may already be an operator-chosen
    // alias. None of our owned descendants may redirect into personal homes.
    mkdirSync(this.options.dataDirectory, { recursive: true, mode: 0o700 });
    let directory = this.options.dataDirectory;
    for (const part of parts) {
      directory = join(directory, part);
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Company native storage must be an owned workspace directory.");
    }
    return directory;
  }
  private scheduleExpiry(revision: number) {
    const expiresAt = this.connection?.expiresAt;
    if (expiresAt === undefined) return;
    this.timer = setTimeout(() => {
      if (revision !== this.revision) return;
      if ((this.connection?.expiresAt ?? 0) > this.now()) this.scheduleExpiry(revision);
      else void this.apply(null).catch(() => {});
    }, Math.min(2_147_483_647, Math.max(1, expiresAt - this.now())));
    this.timer.unref?.();
  }
  /** Moves an enrollment's old device-scoped ids to the stable ids: native
   * homes are renamed only when the stable one does not exist yet, then saved
   * references follow. Best effort: a failure is logged and never keeps
   * Company models down. */
  private async migrateLegacyIds(identity: Pick<ManagedDesktopConnection, "portalOrigin" | "organizationId" | "email" | "deviceId">) {
    try {
      const directory = this.ensureDirectory(["providers", "company"]);
      const aliases = PROVIDER_IDS.map(provider => ({ from: legacyCompanyInstanceId(identity, provider), to: companyInstanceId(identity, provider) }));
      for (const { from, to } of aliases) {
        const legacy = join(directory, from), stable = join(directory, to);
        if (!existsSync(legacy) || existsSync(stable)) continue;
        const stat = lstatSync(legacy);
        if (stat.isDirectory() && !stat.isSymbolicLink()) renameSync(legacy, stable);
      }
      await this.options.migrate?.(aliases);
    } catch (error) {
      console.warn(`[company] could not move saved Company model references to their stable ids: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /** Migrates a saved enrollment that is being cleared or has expired. */
  async migrateIdentity(raw: unknown): Promise<void> {
    const parsed = identitySchema.parse(raw), url = new URL(parsed.portalOrigin);
    if (url.origin !== parsed.portalOrigin || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
      throw new Error("Company identity must use an HTTPS origin or loopback fixture.");
    }
    const identity = { ...parsed, email: parsed.email.toLowerCase() };
    const migration = this.tail.catch(() => {}).then(() => this.migrateLegacyIds(identity));
    this.tail = migration;
    return migration;
  }
  async close() {
    await this.apply(null, true);
  }
}
