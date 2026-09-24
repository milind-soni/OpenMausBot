import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { companyInstanceConfigs, companyInstanceId, legacyCompanyInstanceId, LICENSE_EXPIRED_MESSAGE, ManagedDesktopProviders, parseManagedDesktopConnection, type ManagedDesktopConnection } from "./managed-desktop.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { DATA_DIR, instanceConfigs, loadConfig, persistableInstanceConfigs, saveConfig } from "./config.ts";
import { CodexDriver, managedCodexArgs } from "./drivers/codex.ts";
import { ClaudeDriver } from "./drivers/claude.ts";
import { recordEvents } from "./testing/events.ts";
import { redactSecretsInText } from "./redact.ts";
import { excludedWorkspaceAuthPath } from "./workspace-backup-policy.ts";
import type { ProviderInstance } from "./contracts.ts";
import { selectDefaultModelSelection } from "./default-model-selection.ts";
import { Store } from "./store.ts";

const managers: ManagedDesktopProviders[] = [], registries: ProviderRegistry[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close())); await Promise.all(registries.splice(0).map(registry => registry.disposeAll())); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function connection(): ManagedDesktopConnection {
  return { portalOrigin: "https://admin.example.test", organizationId: "11111111-1111-4111-8111-111111111111", organizationName: "Fixture Agency", email: "employee@example.test", deviceId: "22222222-2222-4222-8222-222222222222", token: `omg_${randomBytes(32).toString("base64url")}`, expiresAt: Date.now() + 60_000,
    providers: [{ id: "anthropic", configured: true, models: ["claude-fixture"] }, { id: "openai", configured: true, models: ["gpt-fixture"] }, { id: "openrouter", configured: true, models: ["fixture/writer"] }] };
}
async function setup(options: { now?: () => number; dataDirectory?: string; migrate?: (aliases: { from: string; to: string }[]) => void; onAvailability?: () => void } = {}) {
  const fakes = ["claudeAgent", "codex", "openai-compat"].map(kind => makeFakeDriver({ kind }));
  const registry = new ProviderRegistry(fakes.map(fake => fake.driver), { npmAvailable: () => false }); registries.push(registry);
  await registry.load({ personal: { driver: "claudeAgent" }, local: { driver: "openai-compat" } });
  const before = vi.fn(), after = vi.fn();
  const manager = new ManagedDesktopProviders({ registry, dataDirectory: join(DATA_DIR, `company-fixture-${randomUUID()}`), beforeReplace: before, afterReplace: after, ...options }); managers.push(manager);
  return { registry, manager, fakes, before, after };
}

it("adds Company instances without mutating personal/global configuration or persisting credentials", async () => {
  const { registry, manager } = await setup(), value = connection();
  const personal = registry.get("personal"), local = registry.get("local");
  const cfg = { anthropic: { key: "personal-key", url: "https://personal.example.test" }, openaiCompat: { key: "personal-router", url: "http://127.0.0.1:8080/v1" }, instances: { personal: { driver: "claudeAgent" }, local: { driver: "openai-compat" } } };
  saveConfig(cfg, { replaceInstances: true });
  const persisted = readFileSync(join(DATA_DIR, "config.json"), "utf8");
  await manager.apply(value);
  expect(registry.instances()).toHaveLength(5);
  expect(registry.get("personal")).toBe(personal); expect(registry.get("local")).toBe(local);
  expect(readFileSync(join(DATA_DIR, "config.json"), "utf8")).toBe(persisted);
  expect(JSON.stringify(instanceConfigs(cfg))).not.toContain(value.token);
  expect(Object.keys(persistableInstanceConfigs(loadConfig()))).toEqual(["personal", "local"]);
  for (const provider of value.providers) {
    const id = companyInstanceId(value, provider.id), company = registry.get(id)!;
    expect(company.displayName).toContain("Company · Fixture Agency");
    expect(company.models.options.map(row => row.id)).toEqual(provider.models);
    expect(manager.info(id)).toEqual({ organizationId: value.organizationId, organizationName: value.organizationName });
    expect(company.startAuthentication).toBeUndefined(); expect(company.signOut).toBeUndefined();
    expect(await company.snapshot()).toMatchObject({ authenticated: true, billing: "metered", account: { organization: value.organizationName, email: value.email } });
  }
  expect(JSON.stringify(await registry.describe())).not.toContain(value.token);
});

it("keeps routing and secrets per instance and uses separate device-scoped Claude/Codex homes", () => {
  const value = connection(), map = companyInstanceConfigs(value, "/fixture/company-runtime");
  const claude = map[companyInstanceId(value, "anthropic")], codex = map[companyInstanceId(value, "openai")], router = map[companyInstanceId(value, "openrouter")];
  expect(claude.environment).toMatchObject({ ANTHROPIC_BASE_URL: `${value.portalOrigin}/api/desktop/gateway/anthropic`, ANTHROPIC_API_KEY: value.token });
  expect((claude.config as { configDir: string }).configDir).toContain(join("/fixture/company-runtime", "company."));
  expect(claude.config).toMatchObject({ managed: true });
  expect(codex.environment).toMatchObject({ OPENMAUSBOT_COMPANY_API_KEY: value.token });
  expect(codex.environment?.CODEX_HOME).toContain(join("/fixture/company-runtime", "company."));
  expect(codex.config).toEqual({ managed: { url: `${value.portalOrigin}/api/desktop/gateway/openai/v1`, models: ["gpt-fixture"] } });
  expect(router.config).toMatchObject({ url: `${value.portalOrigin}/api/desktop/gateway/openrouter/v1`, provider: "", apiKeyEnv: "OPENMAUSBOT_COMPANY_API_KEY" });
  expect(router.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(codex.environment).not.toHaveProperty("OPENAI_API_KEY");
});

it("preserves native sessions across restart and re-enrolment of the same person, never for another account", async () => {
  const dataDirectory = join(DATA_DIR, `company-restart-${randomUUID()}`), value = connection();
  const first = await setup({ dataDirectory });
  await first.manager.apply(value);
  const runtimeDirectory = join(dataDirectory, "providers", "company");
  const id = companyInstanceId(value, "openai"), nativeFile = join(runtimeDirectory, id, "codex", "fixture-session.json");
  writeFileSync(nativeFile, JSON.stringify({ id: "original-native-thread", transcript: "Synthetic conversation" }));
  await first.manager.close();
  expect(existsSync(nativeFile)).toBe(true);
  const restarted = await setup({ dataDirectory });
  await restarted.manager.apply(value);
  expect(readFileSync(nativeFile, "utf8")).toContain("original-native-thread");
  expect(companyInstanceConfigs(value, runtimeDirectory)[id].environment?.CODEX_HOME).toBe(join(runtimeDirectory, id, "codex"));
  expect(excludedWorkspaceAuthPath(`providers/company/${id}/codex/fixture-session.json`)).toBe(true);
  // Re-enrolment mints a new deviceId; the same person keeps the same id and home.
  const reenrolled = { ...value, deviceId: "33333333-3333-4333-8333-333333333333" };
  await restarted.manager.apply(reenrolled);
  expect(companyInstanceId(reenrolled, "openai")).toBe(id);
  expect(readFileSync(nativeFile, "utf8")).toContain("original-native-thread");
  const anotherAccount = { ...value, email: "colleague@example.test", deviceId: "44444444-4444-4444-8444-444444444444" };
  await restarted.manager.apply(anotherAccount);
  const nextId = companyInstanceId(anotherAccount, "openai");
  expect(nextId).not.toBe(id);
  expect(existsSync(join(runtimeDirectory, nextId, "codex", "fixture-session.json"))).toBe(false);
});

it("refuses a redirected Company storage parent before creating native homes", async () => {
  const dataDirectory = join(DATA_DIR, `company-link-${randomUUID()}`), target = join(DATA_DIR, `personal-target-${randomUUID()}`);
  mkdirSync(dataDirectory, { recursive: true }); mkdirSync(target, { recursive: true });
  symlinkSync(target, join(dataDirectory, "providers"), process.platform === "win32" ? "junction" : "dir");
  const { manager, registry } = await setup({ dataDirectory });
  await expect(manager.apply(connection())).rejects.toThrow("owned workspace directory");
  expect(existsSync(join(target, "company"))).toBe(false);
  expect(registry.instances().map(instance => instance.instanceId)).toEqual(["personal", "local"]);
});

it("never discovers or injects personal local routes into an approved Company Claude model", async () => {
  const value = { ...connection(), providers: [{ id: "anthropic" as const, configured: true, models: ["custom-company-model"] }] };
  const dataDirectory = join(DATA_DIR, `company-claude-${randomUUID()}`), dump = join(dataDirectory, "spawn.json");
  const fetcher = vi.fn(async () => Response.json({ data: [{ id: "custom-company-model" }] }));
  vi.stubGlobal("fetch", fetcher);
  const driver: typeof ClaudeDriver = { ...ClaudeDriver, create: input => ClaudeDriver.create({ ...input,
    config: { ...input.config, cli: join(import.meta.dirname, "testing", "fake-claude-cli.ts") },
    environment: { ...input.environment, FAKE_CLAUDE_DUMP: dump },
  }) };
  const registry = new ProviderRegistry([driver], { npmAvailable: () => false }); registries.push(registry);
  const manager = new ManagedDesktopProviders({ registry, dataDirectory }); managers.push(manager);
  await manager.apply(value);
  const company = registry.get(companyInstanceId(value, "anthropic"))!, events = recordEvents(company.adapter);
  expect(fetcher).not.toHaveBeenCalled();
  await company.adapter.sendTurn({ threadId: "company-claude-routing", text: "Synthetic company turn", model: "custom-company-model", cwd: dataDirectory });
  await events.until(event => event.type === "turn.completed"); events.stop();
  const spawned = JSON.parse(readFileSync(dump, "utf8"));
  expect(spawned.env.ANTHROPIC_BASE_URL).toBe(`${value.portalOrigin}/api/desktop/gateway/anthropic`);
  expect(spawned.env.ANTHROPIC_API_KEY).toBe(value.token);
  expect(spawned.env.ANTHROPIC_AUTH_TOKEN).toBe(value.token);
  expect(spawned.argv[spawned.argv.indexOf("--model") + 1]).toBe("custom-company-model");
  expect(fetcher).not.toHaveBeenCalled();
  expect(JSON.stringify(spawned.argv)).not.toContain(value.token);
  await expect(company.adapter.sendTurn({ threadId: "company-claude-injected", text: "Do not route locally", model: "ollama::custom-company-model" })).rejects.toThrow("not enabled");
});

it("does not restart any instance for an identical heartbeat and never substitutes personal billing", async () => {
  const { registry, manager, before, fakes } = await setup(), value = connection();
  await manager.apply(value);
  const id = companyInstanceId(value, "anthropic"), company = registry.get(id)!;
  await manager.apply(structuredClone(value));
  expect(registry.get(id)).toBe(company); expect(before).toHaveBeenCalledTimes(1);
  expect(fakes.flatMap(fake => fake.disposed)).toEqual([]);
  await expect(company.adapter.sendTurn({ threadId: "company", text: "Fixture", model: "personal-model" })).rejects.toThrow("not enabled");
  expect(await company.adapter.sendTurn({ threadId: "company", text: "Fixture", model: "claude-fixture" })).toEqual({ turnId: "fake-turn" });
  const clearing = manager.apply(null);
  await expect(company.adapter.sendTurn({ threadId: "company", text: "Fixture", model: "claude-fixture" })).rejects.toThrow("personal billing");
  await clearing;
  expect(registry.get(id)).toBeNull(); expect(registry.get("personal")).not.toBeNull(); expect(registry.get("local")).not.toBeNull();
  expect(fakes.flatMap(fake => fake.disposed)).not.toContain("personal");
});

it("expires Company access and cancels only its instances", async () => {
  let now = Date.now();
  const { registry, manager } = await setup({ now: () => now }), value = connection();
  await manager.apply(value);
  const company = registry.get(companyInstanceId(value, "openai"))!;
  now = value.expiresAt;
  await expect(company.adapter.sendTurn({ threadId: "company", text: "Fixture", model: "gpt-fixture" })).rejects.toThrow("ended");
  expect(await company.snapshot()).toMatchObject({ state: "unavailable" });
  await manager.restore();
  expect(registry.instances().map(instance => instance.instanceId)).toEqual(["personal", "local"]);
});

it("reapplies the transient overlay after a personal fleet rebuild without copying it into config", async () => {
  const { registry, manager } = await setup(), value = connection();
  await manager.apply(value);
  await registry.disposeAll();
  await registry.load({ personal: { driver: "claudeAgent" }, local: { driver: "openai-compat" } });
  const personal = registry.get("personal");
  await manager.restore();
  expect(registry.instances()).toHaveLength(5);
  expect(registry.get("personal")).toBe(personal);
});

it("does not revive a delayed Company creation after the parent revokes it", async () => {
  const { registry, manager, fakes } = await setup();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const create = fakes[0].driver.create;
  const entered = vi.fn();
  fakes[0].driver.create = async input => { entered(); await blocked; return create(input); };
  const applying = manager.apply(connection());
  await vi.waitFor(() => expect(entered).toHaveBeenCalled());
  const clearing = manager.apply(null);
  release(); await applying; await clearing;
  expect(registry.instances().map(instance => instance.instanceId)).toEqual(["personal", "local"]);
});

it("publishes catalog changes only after replacement and retries a failed identical grant", async () => {
  const { registry, manager, after } = await setup(), value = connection();
  const catalogs: string[][] = [];
  after.mockImplementation(() => catalogs.push(registry.instances().map(instance => instance.instanceId)));
  const original = registry.load.bind(registry);
  const load = vi.spyOn(registry, "load").mockImplementationOnce(async (...args) => {
    await original(...args);
    throw new Error("Fixture replacement failure");
  });
  await expect(manager.apply(value)).rejects.toThrow("Fixture replacement failure");
  expect(catalogs).toEqual([["personal", "local"]]);
  await manager.apply(structuredClone(value));
  expect(load).toHaveBeenCalledTimes(2);
  expect(catalogs[1]).toHaveLength(5);
  await manager.apply(structuredClone(value));
  expect(catalogs).toHaveLength(2);
  await manager.apply(null);
  expect(catalogs[2]).toEqual(["personal", "local"]);
});

it("keeps a newer revocation authoritative while a previous registry load fails", async () => {
  const { registry, manager } = await setup(), value = connection();
  const original = registry.load.bind(registry);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const entered = vi.fn();
  vi.spyOn(registry, "load").mockImplementationOnce(async (...args) => {
    await original(...args); entered(); await blocked;
    throw new Error("Fixture late failure");
  });
  const applying = manager.apply(value);
  const rejected = expect(applying).rejects.toThrow("Fixture late failure");
  await vi.waitFor(() => expect(entered).toHaveBeenCalled());
  const oldCompany = registry.get(companyInstanceId(value, "anthropic"))!;
  const clearing = manager.apply(null);
  release(); await rejected; await clearing;
  expect(registry.instances().map(instance => instance.instanceId)).toEqual(["personal", "local"]);
  await expect(oldCompany.adapter.sendTurn({ threadId: "stale", text: "No revival", model: "claude-fixture" })).rejects.toThrow("personal billing");
  await manager.apply(null); // A superseded failure must not poison the later successful snapshot.
});

it("rejects invalid origins, expired tokens, provider collisions and local model injection IDs without echoing secrets", () => {
  const value = connection();
  for (const patch of [
    { portalOrigin: "http://public.example.test" }, { portalOrigin: "https://user:secret@example.test" },
    { portalOrigin: "https://admin.example.test/other" }, { expiresAt: Date.now() - 1 }, { token: "not-a-device-token" },
    { token: `omd_${"A".repeat(43)}` }, // Device/session/backup authority never enters a provider process.
    { providers: [value.providers[0], value.providers[0]] },
    { providers: [{ id: "anthropic", configured: true, models: ["ollama::personal-local"] }] },
  ]) expect(() => parseManagedDesktopConnection({ ...value, ...patch })).toThrow();
  expect(parseManagedDesktopConnection({ ...value, portalOrigin: "http://127.0.0.1:1234" })?.portalOrigin).toBe("http://127.0.0.1:1234");
  expect(redactSecretsInText(`A provider echoed ${value.token} here.`)).not.toContain(value.token);
  expect(redactSecretsInText(`A provider echoed omd_${"A".repeat(42)}- here.`)).not.toContain("omd_");
  expect(redactSecretsInText(`A provider echoed omg_${"A".repeat(42)}- here.`)).not.toContain("omg_");
  expect(companyInstanceId(value, "openai")).not.toBe(companyInstanceId({ ...value, email: "colleague@example.test" }, "openai"));
});

it("runs native Codex with Company Responses routing, isolated home and no OAuth or argv credential fallback", async () => {
  const value = connection(), cli = join(import.meta.dirname, "testing", "fake-codex-app-server.ts");
  chmodSync(cli, 0o755); mkdirSync(DATA_DIR, { recursive: true });
  const dump = join(DATA_DIR, "company-codex-dump.json"), isolatedHome = join(DATA_DIR, "company-codex-home");
  mkdirSync(isolatedHome, { recursive: true });
  const config = CodexDriver.decodeConfig({ cli, managed: { url: `${value.portalOrigin}/api/desktop/gateway/openai/v1`, models: ["gpt-fixture"] } });
  let native: ProviderInstance | undefined;
  try {
    native = await CodexDriver.create({ instanceId: "fixture-company-codex", displayName: "Company", enabled: true, config,
      environment: { CODEX_HOME: isolatedHome, OPENMAUSBOT_COMPANY_API_KEY: value.token, OPENAI_API_KEY: "personal-must-not-leak", FAKE_CODEX_DUMP: dump, FAKE_CODEX_MODE: "logged-out" } });
    expect(await native.snapshot()).toMatchObject({ state: "available", authenticated: true, billing: "metered" });
    const events = recordEvents(native.adapter);
    await native.adapter.sendTurn({ threadId: "company-codex-fixture", text: "Fixture request", model: "gpt-fixture" });
    await events.until(event => event.type === "turn.completed"); events.stop();
    const spawned = JSON.parse(readFileSync(dump, "utf8"));
    expect(spawned.env.CODEX_HOME).toBe(isolatedHome);
    expect(spawned.env.OPENMAUSBOT_COMPANY_API_KEY).toBe(value.token);
    expect(spawned.env.OPENAI_API_KEY).toBeUndefined();
    expect(spawned.argv).toEqual(expect.arrayContaining(managedCodexArgs(config.managed!)));
    expect(JSON.stringify(spawned.argv)).not.toContain(value.token);
    expect(spawned.calls.find((call: { method: string }) => call.method === "thread/start").params).toMatchObject({ model: "gpt-fixture", modelProvider: "openmaus_company" });
    await expect(native.adapter.sendTurn({ threadId: "blocked", text: "No fallback", model: "gpt-personal" })).rejects.toThrow("personal billing");
  } finally { await native?.dispose(); }
});

it("applies a renewal or a lapsed licence in place, without restarting or ending Company conversations", async () => {
  let now = Date.now();
  const onAvailability = vi.fn();
  const { registry, manager, before, fakes } = await setup({ now: () => now, onAvailability }), value = connection();
  await manager.apply(value);
  const id = companyInstanceId(value, "anthropic"), company = registry.get(id)!;
  // Renewal: the same token and processes, a later expiry.
  const renewed = { ...value, expiresAt: value.expiresAt + 30 * 86400_000 };
  await manager.apply(renewed);
  expect(registry.get(id)).toBe(company); expect(before).toHaveBeenCalledTimes(1);
  expect(fakes.flatMap(fake => fake.disposed)).toEqual([]);
  now = value.expiresAt + 1000;
  expect(await company.adapter.sendTurn({ threadId: "company", text: "Fixture", model: "claude-fixture" })).toEqual({ turnId: "fake-turn" });
  // The Admin's licence lapsed: listed, unavailable, never a revocation.
  await manager.apply({ ...renewed, suspended: "license-expired" });
  expect(registry.get(id)).toBe(company); expect(before).toHaveBeenCalledTimes(1);
  expect(await company.snapshot()).toEqual({ state: "unavailable", reason: LICENSE_EXPIRED_MESSAGE });
  await expect(company.adapter.sendTurn({ threadId: "company", text: "Fixture", model: "claude-fixture" })).rejects.toThrow("licence has expired");
  await manager.apply(renewed);
  expect(await company.snapshot()).toMatchObject({ authenticated: true });
  expect(onAvailability).toHaveBeenCalledTimes(3);
  expect(fakes.flatMap(fake => fake.disposed)).toEqual([]);
});

it("moves a pre-upgrade device-scoped id, its native home and saved references onto the stable id once", async () => {
  const dataDirectory = join(DATA_DIR, `company-legacy-${randomUUID()}`), value = connection();
  const legacy = legacyCompanyInstanceId(value, "openai"), stable = companyInstanceId(value, "openai");
  expect(legacy).not.toBe(stable);
  const legacyHome = join(dataDirectory, "providers", "company", legacy, "codex");
  mkdirSync(legacyHome, { recursive: true }); writeFileSync(join(legacyHome, "fixture-session.json"), "original-native-thread");
  const migrate = vi.fn();
  const { registry, manager } = await setup({ dataDirectory, migrate });
  await manager.apply(value);
  expect(migrate).toHaveBeenCalledWith(expect.arrayContaining([{ from: legacy, to: stable }]));
  expect(readFileSync(join(dataDirectory, "providers", "company", stable, "codex", "fixture-session.json"), "utf8")).toBe("original-native-thread");
  expect(existsSync(join(dataDirectory, "providers", "company", legacy))).toBe(false);
  expect(registry.get(stable)).not.toBeNull(); expect(registry.get(legacy)).toBeNull();
});

it("migrates an expired or cleared enrollment by its identity alone, so a later re-enrolment finds its bots", async () => {
  const dataDirectory = join(DATA_DIR, `company-identity-${randomUUID()}`), expired = connection();
  const legacy = legacyCompanyInstanceId(expired, "anthropic"), stable = companyInstanceId(expired, "anthropic");
  const legacyHome = join(dataDirectory, "providers", "company", legacy, "claude");
  mkdirSync(legacyHome, { recursive: true }); writeFileSync(join(legacyHome, "session.json"), "native-resume");
  const migrate = vi.fn();
  const { manager, registry } = await setup({ dataDirectory, migrate });
  // No live grant: the enrollment expired before this version was installed.
  await manager.migrateIdentity({ portalOrigin: expired.portalOrigin, organizationId: expired.organizationId, email: "Employee@Example.test", deviceId: expired.deviceId });
  expect(migrate).toHaveBeenCalledWith(expect.arrayContaining([{ from: legacy, to: stable }]));
  expect(readFileSync(join(dataDirectory, "providers", "company", stable, "claude", "session.json"), "utf8")).toBe("native-resume");
  // Re-enrolment as a new device resolves to the same stable id.
  const reenrolled = { ...expired, deviceId: "55555555-5555-4555-8555-555555555555" };
  await manager.apply(reenrolled);
  expect(registry.get(stable)).not.toBeNull();
  await expect(manager.migrateIdentity({ portalOrigin: "https://admin.example.test", organizationId: expired.organizationId, email: expired.email, deviceId: expired.deviceId, token: "omd_x" })).rejects.toThrow();
  await expect(manager.migrateIdentity({ portalOrigin: "http://admin.example.test", organizationId: expired.organizationId, email: expired.email, deviceId: expired.deviceId })).rejects.toThrow("HTTPS");
});

it("keeps Company models available when moving old references fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { manager, registry } = await setup({ migrate: () => { throw new Error("bots.json is read-only"); } }), value = connection();
  await manager.apply(value);
  expect(registry.get(companyInstanceId(value, "anthropic"))).not.toBeNull();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not move saved Company model references"));
});

it("sends new bots to a Company model that can run while enrolled, and disconnecting leaves personal selections untouched", async () => {
  const store = new Store(() => ({ instanceId: "personal", model: "fake-default" }));
  const { registry, manager } = await setup({ migrate: aliases => { store.renameInstances(new Map(aliases.map(({ from, to }) => [from, to]))); } });
  const value = connection(), companyClaude = companyInstanceId(value, "anthropic");
  const company = (instanceId: string) => manager.owns(instanceId);
  // The personal Claude CLI is installed but signed out, and the local model server is not running.
  const described = async (signedIn = false) => (await registry.describe()).map(instance =>
    instance.instanceId === "personal" && !signedIn ? { ...instance, snapshot: { ...instance.snapshot, authenticated: false } }
      : instance.instanceId === "local" ? { ...instance, snapshot: { state: "unavailable" as const, reason: "fixture server stopped" } } : instance);
  const before = selectDefaultModelSelection(await described(), undefined, { company });
  expect(before.instanceId).toBe("personal");
  await manager.apply(value);
  expect(selectDefaultModelSelection(await described(), undefined, { company })).toEqual({ instanceId: companyClaude, model: "claude-fixture" });
  expect(selectDefaultModelSelection(await described(true), undefined, { company }).instanceId).toBe("personal");
  const personalBot = store.createBot({ modelSelection: { instanceId: "personal", model: "fake-default" } }, { seedMessages: false });
  const companyBot = store.createBot({ modelSelection: { instanceId: companyClaude, model: "claude-fixture" } }, { seedMessages: false });
  await manager.migrateIdentity({ portalOrigin: value.portalOrigin, organizationId: value.organizationId, email: value.email, deviceId: value.deviceId });
  await manager.apply(null);
  expect(registry.get(companyClaude)).toBeNull();
  expect(store.bot(personalBot.id)!.modelSelection).toEqual({ instanceId: "personal", model: "fake-default" });
  // The Company choice waits for the same person to reconnect; it never falls back to personal billing.
  expect(store.bot(companyBot.id)!.modelSelection).toEqual({ instanceId: companyClaude, model: "claude-fixture" });
  expect(selectDefaultModelSelection(await described(), undefined, { company })).toEqual(before);
});
