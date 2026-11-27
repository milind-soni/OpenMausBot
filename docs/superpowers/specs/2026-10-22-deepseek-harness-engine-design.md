# DeepSeek Harness as a MausBot engine

Date: 2026-10-22. Status: design, approved for build under stated assumptions
(the request was "wire this"; the calls below are the builder's, marked as such).

## Intent

People should be able to pick DeepSeek Harness (`dsh`, github.com/deepseek-ai/deepseek-harness)
as the engine behind a MausBot bot, the same way they pick Kimi, Droid or
Hermes today: it appears on the Engines page, Settings can install it, a
DeepSeek API key pasted in MausBot makes it ready, and bots run turns on it
with the normal approval cards, model picker and reasoning-effort control.

## Verified facts about dsh (0.2.1-rc.2, probed 2026-10-22)

- `npm install -g @deepseek-ai/dsh` installs a `dsh` bin (Node ^22.19 || >=24).
  `dsh --version` prints `0.2.1-rc.2` in 1.5 s.
- `dsh --profile acp` serves standard ACP v1 over stdio (JSON-RPC, newline
  framed). First boot auto-creates `$DSH_HOME/profiles/acp` (`~/.dsh` by
  default). Cold boot through npx took ~120 s (dependency download); warm
  boot is 1.6 s to `initialize`.
- `initialize` → `agentInfo.name = "deepseek-harness-acp"`, `authMethods: []`,
  `promptCapabilities.image: false`, `sessionCapabilities: {close, list, resume}`
  (no `loadSession`; resume is `session/resume`), `mcpCapabilities.http: true`
  (stdio MCP is also accepted in `session/new`).
- `session/new {cwd, mcpServers}` → `configOptions`:
  - `model` (select): values are JSON strings `["<provider>","<model>"]`,
    grouped per provider. Default group `deepseek-official` with
    `deepseek-v4-flash` (current), `deepseek-flash` ("DeepSeek-V4.1-Flash"),
    `deepseek-v4-pro` ("DeepSeek-V4-Pro"). Third-party providers the user
    adds in dsh appear as further groups.
  - `reasoning_effort` (select): `off | low | high | max`, default `high`.
- `session/set_config_option {sessionId, configId, value}` returns the full
  `configOptions` so a change can be confirmed.
- Credentials: `DEEPSEEK_API_KEY` from the launch env, outranked by a stored
  key in `$DSH_HOME/.credentials.yaml` (`DEEPSEEK_API_KEY: sk-…`), then
  `.env` in cwd, then `$DSH_HOME/.env`. No `authenticate` step exists.
- Permissions arrive as `session/request_permission` with allow/reject
  options; no modes, no `session/load`, no terminals, no client fs.

## Goals

1. `deepseekAgent` ACP driver in the default fleet (instance id `deepseek`).
2. Engines page card "DeepSeek Harness" with a DeepSeek mark, install from
   Settings (npm), and a ready state driven by the key.
3. A "DeepSeek API key" row under Model providers in Settings, stored like
   the xAI key (server config, write-only, env override `DEEPSEEK_API_KEY`),
   handed only to the `deepseekAgent` child.
4. Model picker: the three official models statically, and an explicit
   Refresh that asks the installed `dsh` for its real catalog (including
   third-party providers configured in dsh).
5. Reasoning effort none/low/high/max mapped to dsh's off/low/high/max.
6. Resume across turns through `session/resume`.
7. Tests at the same level as the Droid/Kimi drivers.

## Non-goals (v1)

- Local-model injection (omlx/ollama rows) into dsh's provider config.
- Image attachments (dsh advertises none by default; the core already refuses
  cleanly when a runtime does not advertise image input).
- "Full access" / "Auto-accept edits" approval levels (dsh has no modes; it
  stays ask/auto like Kimi and Hermes).
- Phone apps: engines come from the server, phones only need a provider mark;
  that is a separate mausbot-mobile change and is noted in the hand-over.
- Managed download of dsh; npm is the install route.

## Anti-goals

- Running a model other than the one the picker shows. Every set is
  confirmed against the returned `currentValue`; a mismatch fails the turn.
- Leaking `DEEPSEEK_API_KEY` into other engines' child processes. The name
  joins `PROVIDER_CREDENTIAL_ENV` so only this driver inherits it.
- Blocking app startup on dsh: no catalog probe on create
  (`resolveModelsOnCreate: false`), only on explicit Refresh.

## Design

### Driver: `server/drivers/acp/deepseek.ts`

`createAcpDriver(support)` with:

- `driverKind: "deepseekAgent"`, `displayName: "DeepSeek Harness"`,
  `defaultCli: "dsh"`, `nativeSource: "deepseek.acp"`,
  `spawnArgs: () => ["--profile", "acp"]`.
- `models`: static `{ default: "deepseek-official/deepseek-v4-flash", options: [...3] }`.
  Picker id format is `<provider>/<model>` (split on the first `/`); the wire
  value is `JSON.stringify([provider, model])`. Exported helpers
  `deepseekWireValue(id)` and `deepseekPickerId(wireValue)`.
- `resolveModels(env, config)`: spawn `config.cli --profile acp`, `initialize`,
  `session/new` in a temp cwd, read `configOptions[id=model]`, `session/close`,
  end stdin, kill. Options become `<provider>/<model>` with dsh's own names as
  labels; `currentValue` becomes the default. Any failure throws so the core
  keeps the last usable catalog. Timeout 60 s (`OPENMAUS_DEEPSEEK_MODELS_TIMEOUT_MS`).
  `resolveModelsOnCreate: false`.
- Model and reasoning effort ride the core's existing OpenCode-shaped path
  (builder's call, replacing the `effortLevels` + `configureSession` draft
  above once `core.ts` on main was read): `selectModel: { configId: "model" }`
  sets and confirms the model through `session/set_config_option`, and
  `modelVariants: true` discovers dsh's `reasoning_effort` option (category
  `thought_level`: off/low/high/max) as the per-session "Reasoning" picker the
  UI already renders for OpenCode. No driver code for effort.
- `resumeMethod: "resume"`.
- `pickAuthMethod: () => null`, `authFailure: "continue"` (ambient key).
- `isAuthenticated(env)`: `env.DEEPSEEK_API_KEY` set, or
  `$DSH_HOME/.credentials.yaml` (DSH_HOME or `~/.dsh`) has a non-empty
  `DEEPSEEK_API_KEY:` line, or `$DSH_HOME/.env` has one.
- `credentialEnv: ["DEEPSEEK_API_KEY"]`.
- `loginNote`: "DeepSeek Harness has no DeepSeek API key — paste one under
  Settings → Connections → Model providers, or set DEEPSEEK_API_KEY."
- `install`: `npm install -g @deepseek-ai/dsh` on all three platforms,
  `needsNode: true`, `docsUrl: https://github.com/deepseek-ai/deepseek-harness`,
  `settings: "connections"` so a keyless but installed dsh shows the
  "needs an API key → Open API keys" card instead of a terminal sign-in; the
  setup panel still offers the npm install while the CLI itself is missing.
- `buildPromptText`: persona then text, like Droid and Hermes.

### Registry and fleet

- `server/drivers/builtIn.ts`: import and append `DeepSeekAgentDriver`.
- `server/config.ts`: `deepseek: { driver: "deepseekAgent" }` in
  `DEFAULT_FLEET` and `PRODUCT_FLEET_ADDITIONS`; `DEEPSEEK_API_KEY` in
  `PROVIDER_CREDENTIAL_ENV`; `injectedEnvironment` gives `DEEPSEEK_API_KEY`
  to `deepseekAgent` from `cfg.deepseek.key`.

### API key (mirrors `xai`)

- `AppConfig.deepseek?: { key?: string }`; zod `deepseek: z.object({ key: optionalText })`;
  `loadConfig` env fallback `DEEPSEEK_API_KEY` → `cfg.deepseek.key`;
  `syncCredentialEnv` row `[patch.deepseek?.key, "DEEPSEEK_API_KEY"]`;
  `"deepseek"` in the merge-section list; tombstone in the Electron
  external-secret branch of `PUT /api/config`.
- `GET /api/config` → `deepseek: { configured: boolean }`; store `ConfigStatus`
  and the frame key list get `deepseek`.
- `ApiKeys.tsx`: section `deepseek` (`body: (v) => ({ deepseek: { key: v } })`),
  credential copy keys `keys.deepseek.label/desc/link`, placeholder `sk-…`,
  href `https://platform.deepseek.com/api_keys`. `SettingsModal` renders
  `<ApiKeyRow section="deepseek" />` after xAI under Model providers.
  No Test button (no `/api/keys/test` provider in v1).
- Locales: en strings; zh falls back to en like the xAI row does today.

### UI

- `ProviderIcons.tsx`: `DeepSeekMark` (DeepSeek whale, brand blue #4D6BFE)
  and `case "deepseekAgent"` in `ProviderMark`.
- `EngineLibrary.tsx`: `deepseekAgent: "DeepSeek"` in `providers`.
- `scripts/verify-engines-ui.ts`: fixture row `["deepseek", "deepseekAgent", "DeepSeek Harness", false, ""]`.

### Tests

- `server/drivers/acp/deepseek.test.ts`: id ↔ wire mapping; catalog parsing
  from a captured `configOptions` fixture; `isAuthenticated` for env, credentials
  file and `.env` under a temp DSH_HOME; `configureSession` issues the expected
  `set_config_option` calls, skips when already current, and throws on a
  sticky model; `spawnArgs`; effort `none` → `off`.
- `server/config.test.ts`: `DEEPSEEK_API_KEY` reaches only `deepseekAgent`;
  `deepseek` is in the default fleet; stripping removes it from other children.
- `server/index.test.ts`: config status reports `deepseek.configured`.
- Existing ACP core suites stay green.

## Left to the builder

- Exact SVG path for the mark (simple-icons DeepSeek path captured in the
  scratchpad is acceptable).
- Whether `resolveModels` reuses a helper from another driver or carries its
  own 40-line JSON-RPC client.
