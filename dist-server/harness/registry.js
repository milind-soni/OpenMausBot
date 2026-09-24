export class ProviderRegistry {
    byId = new Map();
    driversByKind;
    catalogs = new Map();
    pendingCatalogs = new Map();
    constructor(drivers) {
        this.driversByKind = new Map(drivers.map((d) => [d.driverKind, d]));
    }
    async load(configs) {
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
            }
            catch (e) {
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
    get(instanceId) {
        return this.byId.get(instanceId)?.live ?? null;
    }
    /** Driver + decoded config behind a live instance, for permission edits. */
    getDriverConfig(instanceId) {
        const entry = this.byId.get(instanceId);
        return entry?.live ? { driver: entry.driver, config: entry.config } : null;
    }
    entries() {
        return [...this.byId.values()];
    }
    instances() {
        return [...this.byId.values()].flatMap((e) => (e.live ? [e.live] : []));
    }
    /** instance snapshots for the model picker: id, driver, models, health */
    async modelCatalog(instanceId, refresh = false) {
        const inst = this.get(instanceId);
        if (!inst)
            throw new Error(`provider instance ${instanceId} is unavailable`);
        if (!inst.discoverModels)
            return { ...inst.models, status: "unverified", source: "provider default" };
        const cached = this.catalogs.get(instanceId);
        if (!refresh && cached && cached.expiresAt > Date.now())
            return cached.value;
        const pending = this.pendingCatalogs.get(instanceId);
        if (pending)
            return pending;
        const task = inst.discoverModels().then((models) => {
            const value = { ...models, status: "ready", source: inst.driverKind, refreshedAt: new Date().toISOString() };
            if (this.get(instanceId) === inst)
                this.catalogs.set(instanceId, { value, expiresAt: Date.now() + 60_000 });
            return value;
        }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            const value = cached
                ? { ...cached.value, status: "stale", error: message }
                : { default: "", options: [], status: "error", source: inst.driverKind, error: message };
            if (this.get(instanceId) === inst)
                this.catalogs.set(instanceId, { value, expiresAt: Date.now() + 15_000 });
            return value;
        }).finally(() => {
            if (this.pendingCatalogs.get(instanceId) === task)
                this.pendingCatalogs.delete(instanceId);
        });
        this.pendingCatalogs.set(instanceId, task);
        return task;
    }
    async describe(refresh = false) {
        return Promise.all(this.entries().map(async (entry) => {
            if (entry.shadow) {
                return {
                    instanceId: entry.instanceId,
                    driverKind: entry.shadow.driverKind,
                    displayName: entry.shadow.displayName ?? entry.shadow.driverKind,
                    snapshot: { state: "unavailable", reason: entry.shadow.reason },
                    models: { default: "", options: [] },
                    autoApprove: null,
                };
            }
            const inst = entry.live;
            let snapshot;
            try {
                snapshot = await inst.snapshot();
            }
            catch (e) {
                snapshot = { state: "unavailable", reason: e instanceof Error ? e.message : String(e) };
            }
            const models = snapshot.state === "available"
                ? await this.modelCatalog(inst.instanceId, refresh)
                : { default: "", options: [], status: "error", source: inst.driverKind, error: snapshot.reason };
            return {
                instanceId: inst.instanceId,
                driverKind: inst.driverKind,
                displayName: inst.displayName ?? inst.driverKind,
                snapshot,
                models,
                autoApprove: entry.driver.getAutoApprove?.(entry.config) ?? null,
            };
        }));
    }
    async disposeAll() {
        await Promise.allSettled(this.instances().map((i) => i.dispose()));
        this.byId.clear();
        this.catalogs.clear();
        this.pendingCatalogs.clear();
    }
}
