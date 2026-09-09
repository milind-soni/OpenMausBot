// Guided setup stays outside server/index: no server, store, or bot is started
// until the user has saved a connection and explicitly starts the application.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DATA_DIR, instanceConfigs, loadConfig, parseStoredConfig, saveConfig,
  stripWorkspaceCredentialEnv, PROVIDER_CREDENTIAL_ENV, type AppConfig,
} from "./config.ts";
import type { InstanceConfig, ModelCatalog, ProviderSnapshot } from "./contracts.ts";
import { acquireDataDirLease } from "./data-dir-lease.ts";
import { augmentedPath, resetPathCache } from "./env-path.ts";
import { resolveCli } from "./procs.ts";
import { ProviderRegistry } from "./harness/registry.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { defaultSetupIo, SetupCancelled, type SetupIo } from "./cli-prompts.ts";
import { API_ENDPOINTS, fetchSetupModels, normalizeApiUrl, verifySetupCompletion } from "./cli-api-setup.ts";

type Inspection = { snapshot: ProviderSnapshot; models: ModelCatalog };
interface SetupDependencies {
  inspect(id: string, entry: InstanceConfig): Promise<Inspection>;
  runCli(cli: string, args: string[], environment?: Record<string, string>): Promise<void>;
  models: typeof fetchSetupModels;
  verify: typeof verifySetupCompletion;
}

async function inspect(id: string, entry: InstanceConfig): Promise<Inspection> {
  const registry = new ProviderRegistry(BUILT_IN_DRIVERS);
  try {
    await registry.load({ [id]: entry });
    const provider = registry.get(id);
    if (!provider) throw new Error("This provider configuration could not be loaded. Check it in app Settings.");
    const snapshot = await provider.snapshot();
    return { snapshot, models: provider.models };
  } finally {
    await registry.disposeAll();
  }
}

/** Native CLIs own their OAuth flow; no tokens pass through our prompts. */
export async function runSetupCli(cli: string, args: string[], environment: Record<string, string> = {}): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...environment, PATH: augmentedPath() };
  stripWorkspaceCredentialEnv(env);
  for (const key of PROVIDER_CREDENTIAL_ENV) delete env[key];
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const command = resolveCli(cli, args);
  await new Promise<void>((done, reject) => {
    const child = spawn(command.command, command.args, { env, stdio: "inherit" });
    child.once("error", () => reject(new Error(`Could not start ${cli}. Check that it is installed and on PATH.`)));
    child.once("exit", (code, signal) => {
      if (code === 0) done();
      else if (signal === "SIGINT" || code === 130) reject(new SetupCancelled());
      else reject(new Error(`${cli} did not finish successfully. Fix the error shown above, then try again.`));
    });
  });
  resetPathCache();
}

const dependencies: SetupDependencies = { inspect, runCli: runSetupCli, models: fetchSetupModels, verify: verifySetupCompletion };

function assertDataDir(dataDir: string): void {
  if (resolve(dataDir) !== resolve(DATA_DIR)) throw new Error("Setup data directory mismatch. Restart the CLI with --data-dir.");
}

// loadConfig deliberately tolerates broken files at server boot. An onboarding
// write must instead refuse a broken existing file, never replace its contents.
function checkStoredConfig(dataDir: string): void {
  try {
    parseStoredConfig(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("Existing config.json could not be read or validated. Setup has not changed it; repair it before continuing.");
  }
}

export async function isSetupComplete(dataDir: string): Promise<boolean> {
  assertDataDir(dataDir);
  checkStoredConfig(dataDir);
  const cfg = loadConfig();
  const saved = cfg.defaultModelSelection;
  const instances = instanceConfigs(cfg);
  return !!(saved && Object.hasOwn(instances, saved.instanceId) && instances[saved.instanceId]?.enabled !== false);
}

export function readCliStartup(dataDir: string): AppConfig["cliStartup"] {
  assertDataDir(dataDir);
  checkStoredConfig(dataDir);
  return loadConfig().cliStartup;
}

export function saveCliStartup(dataDir: string, settings: NonNullable<AppConfig["cliStartup"]>): void {
  assertDataDir(dataDir);
  const lease = acquireDataDirLease(dataDir);
  try {
    checkStoredConfig(dataDir);
    saveConfig({ cliStartup: settings });
  } finally {
    lease.release();
  }
}

function rawObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function chooseModel(io: SetupIo, models: ModelCatalog): Promise<string> {
  if (!models.options.length) throw new Error("This connection returned no models. Check the provider and try again.");
  let query = "";
  for (;;) {
    const matches = models.options.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(query.toLowerCase()));
    const preferred = matches.find((m) => m.id === models.default);
    const visible = (preferred ? [preferred, ...matches.filter((m) => m !== preferred)] : matches).slice(0, 20);
    const defaultIndex = visible.findIndex((m) => m.id === models.default);
    const selected = await io.choose("Choose your model", [
      ...visible.map((m) => m.label.trim() || m.id),
      "Search models…",
    ], defaultIndex < 0 ? undefined : defaultIndex);
    if (selected < visible.length) return visible[selected]!.id;
    query = (await io.ask("Model name or part of its ID (Enter shows all): ")).trim();
  }
}

const NATIVE = [
  { id: "codex", driver: "codex", label: "ChatGPT / Codex — sign in with your account", cli: "codex", pkg: "@openai/codex" },
  { id: "claude", driver: "claudeAgent", label: "Claude Code — sign in with your account", cli: "claude", pkg: "@anthropic-ai/claude-code" },
] as const;

async function connectNative(
  choice: typeof NATIVE[number], id: string, entry: InstanceConfig, io: SetupIo, deps: SetupDependencies,
): Promise<ModelCatalog> {
  const cli = typeof rawObject(entry.config).cli === "string" ? rawObject(entry.config).cli as string : choice.cli;
  io.log("Connecting your account…");
  io.log("Sign-in stays with your provider. Its account limits apply; OMB never asks for your password.");
  let state = await deps.inspect(id, entry);
  if (state.snapshot.state !== "available") {
    if (cli !== choice.cli) throw new Error("Your custom CLI path is unavailable. Fix that path in Settings before running setup again.");
    if (!await io.confirm(`Install ${choice.cli} with npm install -g ${choice.pkg}?`, true)) throw new SetupCancelled();
    await deps.runCli("npm", ["install", "-g", choice.pkg]);
    state = await deps.inspect(id, entry);
    if (state.snapshot.state !== "available") throw new Error(`${choice.cli} is still unavailable. Check the installation output and try again.`);
  }
  if (!state.snapshot.authenticated) {
    let args = ["auth", "login"];
    if (choice.id === "codex") {
      const method = await io.choose("How would you like to sign in?", [
        "Open a browser on this computer", "Use a device code (SSH / remote server)",
      ], process.env.SSH_CONNECTION ? 1 : 0);
      args = method === 1 ? ["login", "--device-auth"] : ["login"];
    }
    if (args.includes("--device-auth")) io.log("Enable device-code login in ChatGPT security settings if your account requests it.");
    await deps.runCli(cli, args, entry.environment);
    state = await deps.inspect(id, entry);
    if (state.snapshot.state !== "available" || !state.snapshot.authenticated) {
      throw new Error("Sign-in was not confirmed. Your OMB settings are unchanged; complete provider sign-in and try again.");
    }
  } else {
    io.log("Existing sign-in found — you do not need to sign in again.");
  }
  if (state.snapshot.update) io.log(`${state.snapshot.update.title}: ${state.snapshot.update.command}`);
  io.log("Sign-in confirmed. Model access is checked by the provider when you send your first message.");
  return state.models;
}

export async function runSetup(
  options: { dataDir: string; port: number },
  io: SetupIo = defaultSetupIo(),
  deps: SetupDependencies = dependencies,
): Promise<boolean> {
  assertDataDir(options.dataDir);
  const lease = acquireDataDirLease(options.dataDir);
  try {
    checkStoredConfig(options.dataDir);
    const cfg = loadConfig();
    const runtime = instanceConfigs(cfg);
    const existing = Object.entries(runtime).filter(([id, entry]) =>
      !!cfg.instances?.[id] && ["codex", "claudeAgent", "openai-compat"].includes(entry.driver) && entry.enabled !== false);
    io.log("\nWelcome to OpenMausBot\n");
    io.log("Let's connect your AI. Choose a provider, then a model.");
    io.log("Existing bots and conversations stay untouched. Ctrl-C cancels.");
    io.log("You can add integrations and change settings later.\n");
    const existingDefault = existing.findIndex(([id]) => id === cfg.defaultModelSelection?.instanceId);
    const providerOptions = [
      ...NATIVE.map((n) => n.label),
      "API key — OpenAI, OpenRouter, Groq or a compatible service (chat only)",
      ...existing.map(([id, entry]) => `Use existing: ${entry.displayName ?? id}${id === cfg.defaultModelSelection?.instanceId ? " — current" : ""}`),
    ];
    let pick: number | undefined;

    let id: string;
    let entry: InstanceConfig;
    let model: string;
    for (;;) {
      pick ??= await io.choose("Choose your AI connection", providerOptions, existingDefault < 0 ? 0 : existingDefault + 3);
      const prior = pick >= 3 ? existing[pick - 3] : undefined;
      const native = pick < 2 ? NATIVE[pick] : NATIVE.find((n) => n.driver === prior?.[1].driver);
      try {
        if (native) {
          // Reuse native provider settings, including custom CLI paths. If a user
          // repurposed the familiar ID, do not overwrite their connection.
          id = prior?.[0] ?? native.id;
          if (!prior && runtime[id] && runtime[id]!.driver !== native.driver) id = `${native.id}-${randomUUID().slice(0, 8)}`;
          entry = { ...(cfg.instances?.[id] ?? { driver: native.driver }), enabled: true };
          const models = await connectNative(native, id, entry, io, deps);
          const saved = cfg.defaultModelSelection;
          model = await chooseModel(io, {
            ...models,
            default: saved?.instanceId === id ? saved.model : models.default,
          });
        } else {
          io.log("Connect an API key");
          io.log("API usage is billed separately from ChatGPT/Claude subscriptions.");
          io.log("This connection supports chat, not agent tools or computer use. Choose Codex or Claude for those.");
          let url: string;
          let key: string;
          let label: string;
          let reuse = false;
          let routingProvider: string | undefined;
          if (prior) {
            const config = rawObject(prior[1].config);
            const decoded = BUILT_IN_DRIVERS.find((d) => d.driverKind === "openai-compat")!.decodeConfig(config);
            url = normalizeApiUrl(decoded.url);
            key = decoded.key ?? prior[1].environment?.[decoded.apiKeyEnv]
              ?? prior[1].environment?.OPENAI_COMPAT_API_KEY
              ?? process.env[decoded.apiKeyEnv] ?? process.env.OPENAI_COMPAT_API_KEY ?? "";
            routingProvider = decoded.provider;
            label = prior[1].displayName ?? prior[0];
            reuse = !!key;
            if (!key) key = (await io.secret(`API key for ${url} (hidden): `)).trim();
          } else {
            const endpoint = await io.choose("Which API service?", [...API_ENDPOINTS.map((e) => e.label), "Other OpenAI-compatible endpoint"]);
            const preset = API_ENDPOINTS[endpoint];
            url = preset ? preset.url : normalizeApiUrl((await io.ask("API base URL (including /v1): ")).trim());
            label = preset?.label ?? new URL(url).hostname;
            if (preset) io.log(`Create a key: ${preset.keyUrl}`);
            key = (await io.secret(`API key for ${url} (hidden): `)).trim();
          }
          if (!key) throw new Error("An API key is required. Nothing was saved.");
          io.log("Checking the model catalog…");
          let models: ModelCatalog["options"];
          try { models = await deps.models(url, key); }
          catch (error) {
            if (error instanceof SetupCancelled) throw error;
            io.log(error instanceof Error ? error.message : "Could not load this model catalog.");
            if (!await io.confirm("Enter an exact chat model ID and check it directly instead?", false)) throw error;
            const manual = (await io.ask("Chat model ID: ")).trim();
            if (!manual) throw new Error("A model ID is required. Nothing was saved.");
            models = [{ id: manual, label: manual }];
          }
          const previousModel = prior ? rawObject(prior[1].config).model : undefined;
          const preferredModel = cfg.defaultModelSelection?.instanceId === prior?.[0]
            ? cfg.defaultModelSelection?.model : previousModel;
          io.log("Choose a chat model; image, audio and embedding-only models cannot reply here.");
          model = await chooseModel(io, { default: typeof preferredModel === "string" ? preferredModel : "", options: models });
          if (!await io.confirm("Send one short test message? Your API provider may charge for this request.", true)) throw new SetupCancelled();
          if (routingProvider) await deps.verify(url, key, model, routingProvider);
          else await deps.verify(url, key, model);
          io.log("Test reply received.");
          // API additions never change the URL/key behind an existing bot. A new
          // isolated instance also avoids inherited global URL/key overrides.
          id = reuse && prior ? prior[0] : `api-${randomUUID().slice(0, 8)}`;
          entry = reuse && prior
            ? { ...cfg.instances![id]!, config: { ...rawObject(cfg.instances![id]!.config), model } }
            : { driver: "openai-compat", displayName: label, config: { url, key, model, provider: routingProvider ?? "" } };
          if (!reuse) io.log("The key will be stored in your private config.json (plaintext, owner-only permissions on Unix). Never share this file.");
        }
        break;
      } catch (error) {
        if (error instanceof SetupCancelled) throw error;
        io.log(error instanceof Error ? error.message : "This connection could not be set up.");
        io.log("Your saved connection and model have not changed.");
        const recovery = await io.choose("What would you like to do?", [
          "Try this connection again", "Choose another connection or API key", "Cancel setup",
        ], 0);
        if (recovery === 2) throw new SetupCancelled();
        if (recovery === 1) pick = undefined;
      }
    }

    io.log(`\nDefault for new bots: ${entry.displayName ?? id} / ${model}`);
    if (!await io.confirm("Save this setup?", true)) throw new SetupCancelled();
    // An explicit fleet replaces the implicit fleet. Start from an EMPTY
    // config's defaults, not instanceConfigs(cfg), whose env contains secrets.
    const instances = { ...(cfg.instances && Object.keys(cfg.instances).length ? cfg.instances : instanceConfigs({})), [id]: entry };
    saveConfig({ instances, defaultModelSelection: { instanceId: id, model } });
    io.log("\nSetup saved. Existing bots and conversations were not changed.");
    return true;
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error;
    io.log("\nSetup cancelled. No OMB settings were changed. Provider sign-ins or installs already completed are kept.");
    return false;
  } finally {
    lease.release();
  }
}
