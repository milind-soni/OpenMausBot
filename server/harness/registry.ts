// Provider instance registry — port of upstream's ProviderInstanceRegistryLive
// behavior, minus Effect: config map → live instances; unknown driver or
// config-decode failure becomes an UNAVAILABLE SHADOW SNAPSHOT instead of a
// startup failure (that behavior is what makes settings forward/backward
// compatible — do not remove it); dispose tears an instance down without
// touching its siblings.
import type {
  AnyProviderDriver,
  DiscoveredModelCatalog,
  InstanceConfigMap,
  InstanceId,
  ProviderInstance,
  ProviderSnapshot,
} from "../contracts.ts";

export interface ShadowInstance {
  instanceId: InstanceId;
  driverKind: string;
  displayName: string | undefined;
  shadow: true;
  reason: string;
}

export type RegistryEntry =
  | { instanceId: InstanceId; live: ProviderInstance; driver: AnyProviderDriver; config: unknown; shadow?: undefined }
  | { instanceId: InstanceId; live?: undefined; shadow: ShadowInstance };

export class ProviderRegistry {
  private byId = new Map<InstanceId, RegistryEntry>();
  private driversByKind: Map<string, AnyProviderDriver>;
  private catalogs = new Map<InstanceId, { value: DiscoveredModelCatalog; expiresAt: number }>();
  private pendingCatalogs = new Map<InstanceId, Promise<DiscoveredModelCatalog>>();

  constructor(drivers: readonly AnyProviderDriver[]) {
    this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
  }

  async load(configs: InstanceConfigMap) {
    for (const [instanceId, entry] of Object.entries(configs)) {
      this.catalogs.delete(instanceId);
      this.pendingCatalogs.delete(instanceId);
      const driver = this.driversByKind.get(entry.driver);
      if (!driver) {
        this.byId.set(instanceId, {
          instanceId,
          shadow: {
            instanceId,
            driverKind: entry.driver,
            displayName: entry.displayName,
            shadow: true,
            reason: `unknown driver "${entry.driver}" — kept as configured, unavailable here`,
          },
        });
        continue;
      }
      try {
        const config = entry.config === undefined ? driver.defaultConfig() : driver.decodeConfig(entry.config);
        const live = await driver.create({
          instanceId,
          displayName: entry.displayName ?? driver.metadata.displayName,
          environment: entry.environment ?? {},
          enabled: entry.enabled ?? true,
          config,
        });
        this.byId.set(instanceId, { instanceId, live, driver, config });
      } catch (e) {
        this.byId.set(instanceId, {
          instanceId,
          shadow: {
            instanceId,
            driverKind: entry.driver,
            displayName: entry.displayName ?? driver.metadata.displayName,
            shadow: true,
            reason: e instanceof Error ? e.message : String(e),
          },
        });
      }
    }
  }

  get(instanceId: InstanceId): ProviderInstance | null {
    return this.byId.get(instanceId)?.live ?? null;
  }

  /** Driver + decoded config behind a live instance, for permission edits. */
  getDriverConfig(instanceId: InstanceId): { driver: AnyProviderDriver; config: unknown } | null {
    const entry = this.byId.get(instanceId);
    return entry?.live ? { driver: entry.driver, config: entry.config } : null;
  }

  entries(): RegistryEntry[] {
    return [...this.byId.values()];
  }

  instances(): ProviderInstance[] {
    return [...this.byId.values()].flatMap((e) => (e.live ? [e.live] : []));
  }

  /** instance snapshots for the model picker: id, driver, models, health */
  async modelCatalog(instanceId: InstanceId, refresh = false): Promise<DiscoveredModelCatalog> {
    const inst = this.get(instanceId);
    if (!inst) throw new Error(`provider instance ${instanceId} is unavailable`);
    if (!inst.discoverModels) return { ...inst.models, status: "unverified", source: "provider default" };
    const cached = this.catalogs.get(instanceId);
    if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = this.pendingCatalogs.get(instanceId);
    if (pending) return pending;
    const task = inst.discoverModels().then((models): DiscoveredModelCatalog => {
      const value = { ...models, status: "ready" as const, source: inst.driverKind, refreshedAt: new Date().toISOString() };
      if (this.get(instanceId) === inst) this.catalogs.set(instanceId, { value, expiresAt: Date.now() + 60_000 });
      return value;
    }).catch((error): DiscoveredModelCatalog => {
      const message = error instanceof Error ? error.message : String(error);
      const value: DiscoveredModelCatalog = cached
        ? { ...cached.value, status: "stale", error: message }
        : { default: "", options: [], status: "error", source: inst.driverKind, error: message };
      if (this.get(instanceId) === inst) this.catalogs.set(instanceId, { value, expiresAt: Date.now() + 15_000 });
      return value;
    }).finally(() => {
      if (this.pendingCatalogs.get(instanceId) === task) this.pendingCatalogs.delete(instanceId);
    });
    this.pendingCatalogs.set(instanceId, task);
    return task;
  }

  async describe(refresh = false) {
    return Promise.all(
      this.entries().map(async (entry) => {
        if (entry.shadow) {
          return {
            instanceId: entry.instanceId,
            driverKind: entry.shadow.driverKind,
            displayName: entry.shadow.displayName ?? entry.shadow.driverKind,
            snapshot: { state: "unavailable", reason: entry.shadow.reason } satisfies ProviderSnapshot,
            models: { default: "", options: [] },
            autoApprove: null,
            appsCapable: false,
          };
        }
        const inst = entry.live;
        let snapshot: ProviderSnapshot;
        try {
          snapshot = await inst.snapshot();
        } catch (e) {
          snapshot = { state: "unavailable", reason: e instanceof Error ? e.message : String(e) };
        }
        const models = snapshot.state === "available"
          ? await this.modelCatalog(inst.instanceId, refresh)
          : { default: "", options: [], status: "error" as const, source: inst.driverKind, error: snapshot.reason };
        return {
          instanceId: inst.instanceId,
          driverKind: inst.driverKind,
          displayName: inst.displayName ?? inst.driverKind,
          snapshot,
          models,
          autoApprove: entry.driver.getAutoApprove?.(entry.config) ?? null,
          // apps reach a Buddy through the harness MCP proxy, so only drivers
          // that mount it can use them (shown as model tags on the Apps screen)
          appsCapable: inst.adapter.capabilities.agentsMcp === true,
        };
      }),
    );
  }

  async disposeAll() {
    await Promise.allSettled(this.instances().map((i) => i.dispose()));
    this.byId.clear();
    this.catalogs.clear();
    this.pendingCatalogs.clear();
  }
}
