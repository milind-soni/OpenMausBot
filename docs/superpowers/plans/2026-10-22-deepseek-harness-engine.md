# DeepSeek Harness Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add DeepSeek Harness (`dsh`) as a selectable MausBot engine: an ACP driver, a default-fleet instance, a DeepSeek API-key row in Settings, an Engines-page card with mark and npm install.

**Architecture:** One new ACP support file `server/drivers/acp/deepseek.ts` built on `createAcpDriver` from `server/drivers/acp/core.ts`, using the core's existing `selectModel` + `modelVariants` path (model and reasoning effort are ACP config options on dsh, exactly like OpenCode). Picker ids are `<provider>/<model>`; `resolveTurnModel` turns them into dsh's wire value `["<provider>","<model>"]`. The key follows the Groq pattern end to end (zod section, env override, sync, merge list, injected env, status flag, Settings row).

**Tech Stack:** TypeScript (Node 22, `--experimental-strip-types`), vitest, React + Tailwind renderer, zod config.

**Spec:** `docs/superpowers/specs/2026-10-22-deepseek-harness-engine-design.md`

## Global Constraints

- Driver kind `deepseekAgent`, default instance id `deepseek`, display name `DeepSeek Harness`, CLI `dsh`, spawn args `--profile acp`.
- Picker id format `<provider>/<model>`, split on the FIRST `/`. Wire value `JSON.stringify([provider, model])` with no spaces (dsh's own encoding, verified: `["deepseek-official","deepseek-v4-flash"]`).
- Static catalog, in this order: `deepseek-official/deepseek-v4-flash` "DeepSeek-V4-Flash" (default), `deepseek-official/deepseek-flash` "DeepSeek-V4.1-Flash", `deepseek-official/deepseek-v4-pro` "DeepSeek-V4-Pro".
- Config section `deepseek: { key }`; env override `OMB_DEEPSEEK_API_KEY` (config layer) and `DEEPSEEK_API_KEY` (what the child reads). `DEEPSEEK_API_KEY` joins `PROVIDER_CREDENTIAL_ENV`.
- Install line on every platform: `npm install -g @deepseek-ai/dsh`, `needsNode: true`, docs `https://github.com/deepseek-ai/deepseek-harness`.
- No catalog probe at startup (`resolveModelsOnCreate: false`). Probe timeout env `OPENMAUS_DEEPSEEK_MODELS_TIMEOUT_MS`, default 60 000 ms.
- Nothing is pushed and no PR is opened (Omkar owns publishing). Commits stay local on `feat/deepseek-harness-engine`.
- Run tests with `pnpm vitest run <file>` from the worktree root.

## Review Focus

1. A picker id with no `/` (an old bot config, or a user-typed id) must pass through `resolveTurnModel` unchanged so dsh answers with its own error instead of a crash. Test in Task 1.
2. A `~/.dsh/.credentials.yaml` with `DEEPSEEK_API_KEY: ""` or the key commented out must read as NOT authenticated. Test in Task 1.
3. The live catalog probe must never hang the Refresh button: a `dsh` that prints nothing, exits early, or is missing must settle within the timeout and throw (so the core keeps the last catalog). Test in Task 2.
4. A parent server env carrying `DEEPSEEK_API_KEY` must reach only the `deepseekAgent` child; Kimi/Droid/Hermes children must not see it. Test in Task 3.
5. Clearing the DeepSeek key in Settings (empty save) must drop `DEEPSEEK_API_KEY` from the process env so the next turn really runs without it. Test in Task 3.

---

### Task 1: DeepSeek support: ids, auth, static catalog

**Files:**
- Create: `server/drivers/acp/deepseek.ts`
- Test: `server/drivers/acp/deepseek.test.ts`

**Interfaces:**
- Consumes: `createAcpDriver`, `AcpSupport`, `AcpConfig` from `./core.ts`; `harnessHome` from `../../env-path.ts` (`harnessHome("dsh", env)` → `~/.dsh`); `ModelCatalog` from `../../contracts.ts`.
- Produces:
  - `export const DEEPSEEK_MODELS: ModelCatalog` (the static three).
  - `export function deepseekWireValue(pickerId: string): string` — `"deepseek-official/deepseek-v4-pro"` → `'["deepseek-official","deepseek-v4-pro"]'`; an id without `/` is returned unchanged.
  - `export function deepseekPickerId(wireValue: string): string | null` — inverse; `null` when the value is not a two-string JSON array.
  - `export function dshHome(env: Record<string, string | undefined>): string` — `env.DSH_HOME` else `harnessHome("dsh", env)`.
  - `export function hasDeepSeekKey(env: Record<string, string | undefined>): boolean` — true when `env.DEEPSEEK_API_KEY` is non-blank, or `<dshHome>/.credentials.yaml` has a line matching `/^\s*DEEPSEEK_API_KEY\s*:\s*\S/`, or `<dshHome>/.env` has a line matching `/^\s*(export\s+)?DEEPSEEK_API_KEY\s*=\s*\S/`.
  - `export const deepseekSupport: AcpSupport` and `export const DeepSeekAgentDriver = createAcpDriver(deepseekSupport)`.

- [ ] **Step 1: Write the failing tests**

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../../testing/cleanup.ts";
import { DEEPSEEK_MODELS, deepseekPickerId, deepseekSupport, deepseekWireValue, dshHome, hasDeepSeekKey } from "./deepseek.ts";

describe("DeepSeek model ids", () => {
  it("maps a picker id to dsh's JSON pair and back", () => {
    expect(deepseekWireValue("deepseek-official/deepseek-v4-pro")).toBe('["deepseek-official","deepseek-v4-pro"]');
    expect(deepseekPickerId('["deepseek-official","deepseek-v4-pro"]')).toBe("deepseek-official/deepseek-v4-pro");
  });
  it("splits on the first slash so gateway model ids keep their own slashes", () => {
    expect(deepseekWireValue("my-gateway/vendor/model-v2")).toBe('["my-gateway","vendor/model-v2"]');
    expect(deepseekPickerId('["my-gateway","vendor/model-v2"]')).toBe("my-gateway/vendor/model-v2");
  });
  it("passes an id without a provider through unchanged and rejects a non-pair", () => {
    expect(deepseekWireValue("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(deepseekPickerId("deepseek-v4-pro")).toBeNull();
    expect(deepseekPickerId('["only-one"]')).toBeNull();
  });
  it("ships the three official models with V4-Flash as default", () => {
    expect(DEEPSEEK_MODELS.default).toBe("deepseek-official/deepseek-v4-flash");
    expect(DEEPSEEK_MODELS.options.map((o) => o.id)).toEqual([
      "deepseek-official/deepseek-v4-flash",
      "deepseek-official/deepseek-flash",
      "deepseek-official/deepseek-v4-pro",
    ]);
  });
});

describe("DeepSeek key detection", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) await removeTempDir(d); });
  const home = () => { const d = mkdtempSync(join(tmpdir(), "omb-dsh-")); dirs.push(d); return d; };

  it("honours DSH_HOME over the default ~/.dsh", () => {
    expect(dshHome({ DSH_HOME: "/x/dsh", HOME: "/h" })).toBe("/x/dsh");
    expect(dshHome({ HOME: "/h" })).toBe(join("/h", ".dsh"));
  });
  it("is authenticated on DEEPSEEK_API_KEY in the env", () => {
    expect(hasDeepSeekKey({ DEEPSEEK_API_KEY: "sk-x", HOME: home() })).toBe(true);
    expect(hasDeepSeekKey({ DEEPSEEK_API_KEY: "  ", HOME: home() })).toBe(false);
  });
  it("reads a stored key from $DSH_HOME/.credentials.yaml", () => {
    const h = home();
    writeFileSync(join(h, ".credentials.yaml"), "DEEPSEEK_API_KEY: sk-stored\n");
    expect(hasDeepSeekKey({ DSH_HOME: h })).toBe(true);
  });
  it("treats an empty or commented credential as missing", () => {
    const h = home();
    writeFileSync(join(h, ".credentials.yaml"), "# DEEPSEEK_API_KEY: sk-old\nDEEPSEEK_API_KEY: \n");
    expect(hasDeepSeekKey({ DSH_HOME: h })).toBe(false);
  });
  it("accepts the harness-home .env fallback", () => {
    const h = home();
    writeFileSync(join(h, ".env"), "export DEEPSEEK_API_KEY=sk-env\n");
    expect(hasDeepSeekKey({ DSH_HOME: h })).toBe(true);
  });
  it("is not authenticated with no key anywhere", () => {
    const h = home();
    mkdirSync(join(h, "profiles"), { recursive: true });
    expect(hasDeepSeekKey({ DSH_HOME: h })).toBe(false);
  });
});

describe("DeepSeek ACP support", () => {
  it("spawns dsh in its ACP profile and selects model + variants over the wire", () => {
    expect(deepseekSupport.driverKind).toBe("deepseekAgent");
    expect(deepseekSupport.defaultCli).toBe("dsh");
    expect(deepseekSupport.spawnArgs({ cli: "dsh", fullAuto: false }, {} as never)).toEqual(["--profile", "acp"]);
    expect(deepseekSupport.selectModel).toEqual({ configId: "model" });
    expect(deepseekSupport.modelVariants).toBe(true);
    expect(deepseekSupport.resumeMethod).toBe("resume");
    expect(deepseekSupport.resolveModelsOnCreate).toBe(false);
    expect(deepseekSupport.credentialEnv).toEqual(["DEEPSEEK_API_KEY"]);
    expect(deepseekSupport.authFailure).toBe("continue");
    expect(deepseekSupport.pickAuthMethod([], {})).toBeNull();
    expect(deepseekSupport.install?.command?.darwin).toBe("npm install -g @deepseek-ai/dsh");
    expect(deepseekSupport.install?.needsNode).toBe(true);
  });
  it("resolves the turn model to the wire pair", () => {
    expect(deepseekSupport.resolveTurnModel?.("deepseek-official/deepseek-v4-pro", {})).toBe('["deepseek-official","deepseek-v4-pro"]');
    expect(deepseekSupport.resolveTurnModel?.(undefined, {})).toBeUndefined();
  });
  it("falls back to the catalog default when offered, else the session's current model", () => {
    const session = { configOptions: [{ id: "model", currentValue: '["deepseek-official","deepseek-flash"]', options: [
      { group: "deepseek-official", options: [{ value: '["deepseek-official","deepseek-flash"]' }, { value: '["deepseek-official","deepseek-v4-flash"]' }] },
    ] }] };
    expect(deepseekSupport.fallbackModel?.(session, "deepseek-official/deepseek-v4-flash")).toBe('["deepseek-official","deepseek-v4-flash"]');
    expect(deepseekSupport.fallbackModel?.(session, "deepseek-official/deepseek-v4-pro")).toBe('["deepseek-official","deepseek-flash"]');
    expect(deepseekSupport.fallbackModel?.({}, "deepseek-official/deepseek-v4-pro")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run server/drivers/acp/deepseek.test.ts`
Expected: FAIL, cannot find module `./deepseek.ts`.

- [ ] **Step 3: Implement `server/drivers/acp/deepseek.ts`**

Header comment in the house style (what dsh is, what was verified on 0.2.1-rc.2: no authMethods, config options `model` as JSON pairs + `reasoning_effort` as `thought_level`, `session/resume`, warm boot 1.6 s / cold npx boot ~120 s). Then the exports from the Interfaces block. Support object values, beyond the constants above:

- `displayName: "DeepSeek Harness"`, `nativeSource: "deepseek.acp"`, `models: DEEPSEEK_MODELS`.
- `loginNote: "DeepSeek Harness has no DeepSeek API key — paste one under Settings → Connections → Model providers, or set DEEPSEEK_API_KEY."`
- `install.docsUrl: "https://github.com/deepseek-ai/deepseek-harness"`, same `npm install -g @deepseek-ai/dsh` on darwin/linux/win32.
- `isAuthenticated: (env) => hasDeepSeekKey(env)`.
- `resolveTurnModel: (model) => model ? deepseekWireValue(model) : model`.
- `fallbackModel(sessionConfig, catalogDefault)`: collect every `value` string under `configOptions[id=model].options` recursively (groups nest `options`); return `deepseekWireValue(catalogDefault)` if offered, else the option's `currentValue` if offered, else `null`.
- `buildPromptText: (turn) => turn.system ? \`${turn.system}\n\n${turn.text}\` : turn.text`.
- `resolveModels` is added in Task 2; leave it out here.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run server/drivers/acp/deepseek.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/drivers/acp/deepseek.ts server/drivers/acp/deepseek.test.ts
git commit -m "feat(engines): DeepSeek Harness ACP support (ids, key detection, static catalog)"
```

---

### Task 2: Live catalog probe on Refresh

**Files:**
- Modify: `server/drivers/acp/deepseek.ts`
- Test: `server/drivers/acp/deepseek.test.ts`
- Fixture CLI: `server/testing/fake-dsh-cli.ts` (new, ~60 lines)

**Interfaces:**
- Consumes: `resolveCli(cli, args, env)` from `../../procs.ts` (returns `{ command, args }`), `spawn` from `node:child_process`, the JSON-RPC pattern of `fetchHermesAcpModels` in `./hermes.ts`.
- Produces:
  - `export function parseDeepSeekCatalog(sessionResult: unknown): ModelCatalog` — reads `configOptions[id=model]`; each leaf `{value, name}` becomes `{ id: deepseekPickerId(value), label: name ?? id, provider: <group name or provider id> }` (skip leaves whose value is not a pair); `default` is `deepseekPickerId(currentValue)` when offered, else the first option; throws `Error("dsh advertised no models")` when empty.
  - `export async function fetchDeepSeekCatalog(cli: string, env: Record<string, string | undefined>, cwd: string): Promise<ModelCatalog>` — spawns `cli --profile acp` with `stdio: ["pipe","pipe","ignore"]`, sends `initialize` (`protocolVersion: 1`, fs caps false), then `session/new {cwd, mcpServers: []}`, parses the result, sends `session/close {sessionId}`, ends stdin, kills (SIGKILL after 1 s). Rejects on spawn error, child close before the answer, non-JSON only output, or timeout `OPENMAUS_DEEPSEEK_MODELS_TIMEOUT_MS` (default 60 000, same validation as `hermesAcpModelsTimeoutMs`). Export `DEEPSEEK_MODELS_TIMEOUT_ENV` and `DEEPSEEK_MODELS_DEFAULT_TIMEOUT_MS`.
  - `deepseekSupport.resolveModels = (env, config) => fetchDeepSeekCatalog(config.cli || "dsh", env, tmpdir())`, `resolveModelsOnCreate: false`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to deepseek.test.ts
import { delimiter, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEEPSEEK_MODELS_TIMEOUT_ENV, fetchDeepSeekCatalog, parseDeepSeekCatalog } from "./deepseek.ts";

const SESSION_NEW = { sessionId: "s1", configOptions: [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: '["deepseek-official","deepseek-v4-flash"]',
    options: [
      { group: "deepseek-official", name: "DeepSeek", options: [
        { value: '["deepseek-official","deepseek-v4-flash"]', name: "deepseek-v4-flash" },
        { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro" },
      ] },
      { group: "anthropic", name: "Anthropic", options: [{ value: '["anthropic","claude-opus-4.6"]', name: "Claude Opus 4.6" }] },
    ] },
  { id: "reasoning_effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "off", name: "Off" }, { value: "high", name: "High" }] },
] };

describe("parseDeepSeekCatalog", () => {
  it("flattens provider groups into picker ids with dsh's names as labels", () => {
    expect(parseDeepSeekCatalog(SESSION_NEW)).toEqual({
      default: "deepseek-official/deepseek-v4-flash",
      options: [
        { id: "deepseek-official/deepseek-v4-flash", label: "deepseek-v4-flash", provider: "DeepSeek" },
        { id: "deepseek-official/deepseek-v4-pro", label: "DeepSeek-V4-Pro", provider: "DeepSeek" },
        { id: "anthropic/claude-opus-4.6", label: "Claude Opus 4.6", provider: "Anthropic" },
      ],
    });
  });
  it("throws when dsh advertises no model option", () => {
    expect(() => parseDeepSeekCatalog({ sessionId: "s", configOptions: [] })).toThrow(/no models/);
  });
});

describe("fetchDeepSeekCatalog", () => {
  const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-dsh-cli.ts");
  const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, FAKE_DSH_SESSION: JSON.stringify(SESSION_NEW) });
  it("drives initialize → session/new → session/close and returns the catalog", async () => {
    const dump = join(mkdtempSync(join(tmpdir(), "omb-dsh-")), "calls.json");
    const catalog = await fetchDeepSeekCatalog(FAKE, { ...env(), FAKE_DSH_DUMP: dump }, tmpdir());
    expect(catalog.default).toBe("deepseek-official/deepseek-v4-flash");
    expect(catalog.options).toHaveLength(3);
    const calls = JSON.parse(readFileSync(dump, "utf8")) as Array<{ method: string; params: any }>;
    expect(calls.map((c) => c.method)).toEqual(["initialize", "session/new", "session/close"]);
    expect(calls[1].params).toMatchObject({ cwd: tmpdir(), mcpServers: [] });
    expect(calls[2].params).toEqual({ sessionId: "s1" });
  });
  it("rejects within the timeout when dsh never answers", async () => {
    await expect(fetchDeepSeekCatalog(FAKE, { ...env(), FAKE_DSH_MODE: "hang", [DEEPSEEK_MODELS_TIMEOUT_ENV]: "300" }, tmpdir()))
      .rejects.toThrow(/timed out/);
  });
  it("rejects when dsh exits before answering", async () => {
    await expect(fetchDeepSeekCatalog(FAKE, { ...env(), FAKE_DSH_MODE: "exit" }, tmpdir())).rejects.toThrow(/exited/);
  });
  it("rejects when the binary is missing", async () => {
    await expect(fetchDeepSeekCatalog("/nonexistent/dsh-fixture", env(), tmpdir())).rejects.toThrow();
  });
});
```

The fake CLI (`server/testing/fake-dsh-cli.ts`, `#!/usr/bin/env node`, run through the same `resolveCli` the Hermes test relies on for `.ts` fixtures — check how `hermes.test.ts` / `opencode-go.test.ts` invoke `fake-acp-cli.ts` and copy that spawn convention): reads newline JSON-RPC from stdin; appends `{method, params}` to `FAKE_DSH_DUMP` when set; `initialize` → the real dsh initialize result captured in the spec; `session/new` → `JSON.parse(FAKE_DSH_SESSION)`; `session/close` → `{}`. `FAKE_DSH_MODE=hang` never answers; `FAKE_DSH_MODE=exit` exits 0 before answering `initialize`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run server/drivers/acp/deepseek.test.ts`
Expected: FAIL on the new describe blocks (missing exports).

- [ ] **Step 3: Implement `parseDeepSeekCatalog`, `fetchDeepSeekCatalog`, the fake CLI, and wire `resolveModels`**

Timeout error text must contain "timed out"; early-exit error text must contain "exited". Register the ACP agent's returned `sessionId` and always attempt `session/close` before killing, even on parse failure.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run server/drivers/acp/deepseek.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/drivers/acp/deepseek.ts server/drivers/acp/deepseek.test.ts server/testing/fake-dsh-cli.ts
git commit -m "feat(engines): DeepSeek Harness live catalog on Refresh"
```

---

### Task 3: Registry, fleet and the DeepSeek key (server)

**Files:**
- Modify: `server/drivers/builtIn.ts` (import + append `DeepSeekAgentDriver` after `MuseCodeDriver`)
- Modify: `server/config.ts` — zod section near line 339 (`deepseek: z.object({ key: optionalText }).optional()`), `AppConfig` near line 487 (`deepseek?: { key?: string }`), `loadConfig` env override near line 787 (`OMB_DEEPSEEK_API_KEY` → `cfg.deepseek.key`), `syncCredentialEnv` near line 857 (`[patch.deepseek?.key, "OMB_DEEPSEEK_API_KEY"]`), merge-section list near line 1050 (add `"deepseek"` after `"meta"`), `PROVIDER_CREDENTIAL_ENV` (add `"DEEPSEEK_API_KEY"` after `"META_API_KEY"`), `injectedEnvironment` (`if (driver === "deepseekAgent" && cfg.deepseek?.key) environment.set("DEEPSEEK_API_KEY", cfg.deepseek.key);`), `DEFAULT_FLEET` and `PRODUCT_FLEET_ADDITIONS` (`deepseek: { driver: "deepseekAgent" }` after `museCode`).
- Modify: `server/index.ts` config status near line 12795 (`deepseek: { configured: Boolean(cfg.deepseek?.key) }`); the Electron external-secret tombstone block (search `persisted.xai?.key !== undefined`) gets `if (persisted.deepseek?.key !== undefined) persisted.deepseek.key = "";`.
- Test: `server/config.test.ts` (in `describe("default fleet")`), `server/index.test.ts` (next to the Groq/Meta config-status PUT test if one exists; otherwise next to the `opencodeGo` PUT test near line 11921).

**Interfaces:**
- Consumes: `DeepSeekAgentDriver` from Task 1.
- Produces: `cfg.deepseek.key`; `DEEPSEEK_API_KEY` in the `deepseek` instance environment; `GET /api/config` → `deepseek: { configured }`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/config.test.ts, inside describe("default fleet")
it("adds DeepSeek Harness to product fleets and hands its key only to that engine", () => {
  const cfg: AppConfig = { deepseek: { key: "ds-workspace" }, instances: {
    codex: { driver: "codex" },
    kimi: { driver: "kimiAgent" },
    deepseekOwn: { driver: "deepseekAgent", environment: { DEEPSEEK_API_KEY: "ds-own" } },
  } };
  const map = instanceConfigs(cfg);
  expect(map.deepseek).toEqual({ driver: "deepseekAgent", environment: { DEEPSEEK_API_KEY: "ds-workspace" } });
  expect(map.codex.environment).toEqual({});
  expect(map.kimi.environment).toEqual({});
  expect(map.deepseekOwn.environment).toEqual({ DEEPSEEK_API_KEY: "ds-own" });
  expect(cfg.instances).not.toHaveProperty("deepseek");
  expect(instanceConfigs({ instances: { standalone: { driver: "fake" } } })).not.toHaveProperty("deepseek");
});

it("accepts clearing a DeepSeek key and removes it from child environments", () => {
  expect(parseConfigPatch({ deepseek: { key: "" } })).toEqual({ deepseek: { key: "" } });
  const env = { OMB_DEEPSEEK_API_KEY: "ds-fixture", DEEPSEEK_API_KEY: "ds-ambient", KEEP: "yes" };
  stripWorkspaceCredentialEnv(env);
  expect(env).toEqual({ DEEPSEEK_API_KEY: "ds-ambient", KEEP: "yes" });
});

it("strips an ambient DEEPSEEK_API_KEY from every engine that did not declare it", () => {
  expect(PROVIDER_CREDENTIAL_ENV).toContain("DEEPSEEK_API_KEY");
});
```

```ts
// server/index.test.ts, same shape as the opencodeGo PUT test near line 11921
it("stores a DeepSeek key write-only and reports it configured", async () => {
  const put = await api("PUT", "/api/config", { deepseek: { key: "ds-secret" } });
  expect(put.body.deepseek).toEqual({ configured: true });
  const get = await api("GET", "/api/config");
  expect(get.body.deepseek).toEqual({ configured: true });
  expect(JSON.stringify(get.body)).not.toContain("ds-secret");
});
```

Check `syncCredentialEnv` is covered the way Groq's is (search `OMB_GROQ_API_KEY` in `config.test.ts`); if a sync test exists, add the DeepSeek pair to it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run server/config.test.ts -t DeepSeek` and `pnpm vitest run server/index.test.ts -t DeepSeek`
Expected: FAIL (no `deepseek` instance; zod strips the unknown section).

- [ ] **Step 3: Make the edits listed under Files**

- [ ] **Step 4: Run the suites**

Run: `pnpm vitest run server/config.test.ts server/index.test.ts server/drivers/builtIn.test.ts 2>/dev/null || pnpm vitest run server/config.test.ts server/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/drivers/builtIn.ts server/config.ts server/config.test.ts server/index.ts server/index.test.ts
git commit -m "feat(engines): register DeepSeek Harness in the fleet with a workspace DeepSeek key"
```

---

### Task 4: Renderer: mark, library label, Settings key row, locales, preview fixture

**Files:**
- Modify: `src/components/ProviderIcons.tsx` — lift the inline DeepSeek SVG in `PresetProviderMark` (`case "deepseek"`) into `export function DeepSeekMark({ size = 16, className }: IconProps)`; `PresetProviderMark` returns `<DeepSeekMark …/>`; `ProviderMark` gains `case "deepseekAgent": return <DeepSeekMark size={size} className={className} />;`.
- Modify: `src/components/EngineLibrary.tsx` — `providers` map gains `deepseekAgent: "DeepSeek"`.
- Modify: `src/components/ApiKeys.tsx` — `ConfigSection` union adds `"deepseek"`; `SECTIONS.deepseek = { body: (v) => ({ deepseek: { key: v } }), flag: (c) => c.deepseek?.configured ?? false }`; `CREDENTIALS.deepseek = { labelKey: "keys.deepseek.label", placeholder: "sk-…", descriptionKey: "keys.deepseek.desc", href: "https://platform.deepseek.com/api_keys", linkLabelKey: "keys.deepseek.link", optional: true }`.
- Modify: `src/components/SettingsModal.tsx` — `<ApiKeyRow section="deepseek" />` directly after the `meta` row; add `"deepseek"` to the connections keywords list on line 88.
- Modify: `src/state/store.tsx` — `ConfigStatus` gains `deepseek?: { configured: boolean }` next to `groq`; the frame key union (line 436) and the frame copy (line 444 area) gain `deepseek`.
- Modify: `src/locales/en.json` after the `keys.meta.*` lines:
  - `"keys.deepseek.label": "DeepSeek API key"`
  - `"keys.deepseek.desc": "For the DeepSeek Harness engine. Bots on DeepSeek Harness run on this key, billed to your DeepSeek account; a key saved inside dsh itself also works."`
  - `"keys.deepseek.link": "DeepSeek API keys"`
- Modify: `src/locales/zh.json` after `keys.meta.desc`: `"keys.deepseek.label": "DeepSeek API 密钥"`, `"keys.deepseek.desc": "用于 DeepSeek Harness 引擎。使用 DeepSeek Harness 的机器人会用这个密钥运行，费用计入你的 DeepSeek 账户；在 dsh 内保存的密钥同样有效。"`, `"keys.deepseek.link": "DeepSeek API 密钥页面"`.
- Modify: `scripts/verify-engines-ui.ts` — fixture row `["deepseek", "deepseekAgent", "DeepSeek Harness", false, ""]` after the `pi` row.
- Test: `src/components/ProviderIcons.test.tsx` if it exists (search for an existing `ProviderMark` test and add `deepseekAgent`); otherwise `src/components/BotModelBadge.test.ts` style is the reference. Add to `src/components/EngineLibrary.test.ts` if present: `providerName({ driverKind: "deepseekAgent" } as InstanceInfo)` → `"DeepSeek"`.

- [ ] **Step 1: Write the failing test(s)** per the Test line (one assertion per surface: mark renders for `deepseekAgent`, provider name is `DeepSeek`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/components/EngineLibrary.test.ts src/components/ProviderIcons.test.tsx` (whichever exist)
Expected: FAIL.

- [ ] **Step 3: Make the edits listed under Files**

- [ ] **Step 4: Verify**

Run: `pnpm vitest run src/components` then `pnpm tsc -p tsconfig.json --noEmit` (or the repo's `pnpm typecheck` script if present; check `package.json`).
Expected: PASS, no type errors. Locale lint: if `src/locales` has a key-parity test (search for `locales.test`), run it.

- [ ] **Step 5: Commit**

```bash
git add src/components/ProviderIcons.tsx src/components/EngineLibrary.tsx src/components/ApiKeys.tsx src/components/SettingsModal.tsx src/state/store.tsx src/locales/en.json src/locales/zh.json scripts/verify-engines-ui.ts src/components/*.test.*
git commit -m "feat(engines): DeepSeek Harness card, mark and API-key row"
```

---

### Task 5: End-to-end check against the real dsh

**Files:** none changed (verification only; fix-ups go into the task that owns the file).

- [ ] **Step 1: Server-side typecheck and the ACP core suite**

Run: `pnpm vitest run server/drivers/acp server/config.test.ts` and the server typecheck (`node --experimental-strip-types` build script or `pnpm tsc -p tsconfig.server.json --noEmit`; check `package.json` scripts).
Expected: PASS.

- [ ] **Step 2: Isolated instance with a throwaway home**

Follow the isolated-instance recipe from memory `single-folder-per-pr-workflow` (throwaway `HOME`, `OMB_PORT=18899`, vite on 5299). Put the probe's `dsh` on PATH (`npx -y @deepseek-ai/dsh@0.2.1-rc.2` already cached under the scratchpad `dsh-home`; point `DSH_HOME` at it) and set `OMB_DEEPSEEK_API_KEY=<a real key only if Omkar has one in the environment; otherwise a placeholder>`.
Expected: `GET /api/instances` lists `deepseek` with `driverKind: "deepseekAgent"`, `snapshot.state: "available"`, `snapshot.version` matching `0.2.1`, `authenticated: true` with the placeholder key, and `capabilities.modelVariants: true`. Refresh (`POST /api/instances/deepseek/models/refresh` or the route the Engines page calls) returns the three official models.

- [ ] **Step 3: Engines page screenshot**

Use the Playwright MCP against `http://127.0.0.1:5299/` to open Settings → Engines and capture the DeepSeek Harness card (mark, "DeepSeek" subtitle, Ready/Needs setup pill) and Settings → Connections with the DeepSeek key row. Save the screenshots in the scratchpad for the hand-over.

- [ ] **Step 4: One real turn (only with a real key)**

If a real DeepSeek key is available, send one message to a bot on `deepseek` with model `deepseek-official/deepseek-v4-flash` and reasoning `low`; expect a reply and `session.started.model` equal to `["deepseek-official","deepseek-v4-flash"]`. Without a key, record that this step was skipped in the hand-over.
