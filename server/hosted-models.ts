import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { hostedWorkspaceConfiguration } from "./enterprise.ts";
import type { InstanceConfigMap, ModelSelection, ProviderInstance } from "./contracts.ts";
import type { Store } from "./store.ts";

export const HOSTED_MODEL_POLICY_HEADER = "X-Omb-Hosted-Model-Policy";
export const HOSTED_MODEL_SETUP_ERROR = "No company models are assigned to this workspace. Ask your administrator to enable model access in Admin.";
export const HOSTED_MODEL_SELECTION_ERROR = "This model is not assigned to this workspace. Choose one of its company models.";
export const HOSTED_PROVIDER_SETTINGS_ERROR = "Company models and provider accounts are managed in Admin.";
const nativeModels = z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/)).max(100);
const catalogSchema = z.object({
  anthropic: nativeModels,
  openai: nativeModels,
  openrouter: z.array(z.string().max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/+-]*$/)).max(100),
}).strict();
type HostedCatalog = z.infer<typeof catalogSchema>;
const providerFor = { claude: "anthropic", codex: "openai", opencode: "openrouter" } as const;

/** Operator-only policy. An ordinary desktop has neither input and keeps its
 * personal providers. Partial policy configuration must never enable them. */
export function hostedModelPolicy(dataDirectory: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.OMB_HOSTED_MODELS === undefined && env.OMB_HOSTED_MODEL_TOKEN === undefined) return null;
  const hosted = hostedWorkspaceConfiguration(env);
  if (!hosted?.portalMembership || env.OMB_DESKTOP_PARENT === "1" || !/^omb_workspace_[A-Za-z0-9_-]{43}$/.test(env.OMB_HOSTED_MODEL_TOKEN ?? "")) {
    throw new Error("Hosted model access requires complete portal-managed configuration.");
  }
  let catalog: HostedCatalog;
  try {
    if (!env.OMB_HOSTED_MODELS || env.OMB_HOSTED_MODELS.length > 65536) throw new Error();
    catalog = catalogSchema.parse(JSON.parse(env.OMB_HOSTED_MODELS));
  } catch { throw new Error("Invalid hosted model catalog."); }
  for (const key of ["anthropic", "openai", "openrouter"] as const) catalog[key] = [...new Set(catalog[key])];
  const token = env.OMB_HOSTED_MODEL_TOKEN!;
  const base = `${hosted.admin.origin}/api/gateway/${hosted.workspace}`;
  const assigned = (id: string): string[] => Object.hasOwn(providerFor, id) ? catalog[providerFor[id as keyof typeof providerFor]] : [];
  const allows = (selection: ModelSelection) => assigned(selection.instanceId).includes(selection.model);
  const normalized = (selection: ModelSelection): ModelSelection => {
    if (selection.instanceId === "codex" && selection.model.startsWith("omb-managed-openai::")) {
      return { ...selection, model: selection.model.slice("omb-managed-openai::".length) };
    }
    if (["opencode", "opencodeGo"].includes(selection.instanceId) && selection.model.startsWith("omb-managed-openrouter/")) {
      return { instanceId: "opencode", model: selection.model.slice("omb-managed-openrouter/".length) };
    }
    // This stable ID now uses the replay-based OpenAI-compatible driver,
    // which supports neither OpenCode variants nor native effort levels.
    if (selection.instanceId === "opencode") return { instanceId: "opencode", model: selection.model };
    return selection;
  };
  const select = (previous?: ModelSelection): ModelSelection => {
    const current = previous ? normalized(previous) : undefined;
    if (current && allows(current)) return { ...current };
    const id = current && assigned(current.instanceId).length ? current.instanceId
      : Object.keys(providerFor).find(id => assigned(id).length);
    return id ? { instanceId: id, model: assigned(id)[0] } : { instanceId: "", model: "" };
  };
  const home = (name: string) => {
    let directory = dataDirectory;
    for (const part of ["providers", "hosted", name]) {
      directory = join(directory, part);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Hosted provider storage must be an owned directory.");
    }
    return directory;
  };
  return {
    allows, select,
    resetTask(previous: ModelSelection, next: ModelSelection) {
      return previous.instanceId !== next.instanceId || previous.model !== next.model
        ? { resumeCursors: {}, lastInstanceId: undefined, rewound: true, lastContextModel: undefined, appliedCompactionId: undefined }
        : {};
    },
    error: () => Object.values(catalog).some(models => models.length) ? HOSTED_MODEL_SELECTION_ERROR : HOSTED_MODEL_SETUP_ERROR,
    configs(): InstanceConfigMap {
      const configs: InstanceConfigMap = {};
      // Saved instance commands are tenant-editable personal configuration.
      // Only the operator may replace the bundled executables (also how an
      // isolated verification fixture supplies its synthetic native engines).
      const cli = (name: "CLAUDE" | "CODEX") => env[`OMB_HOSTED_${name}_CLI`]?.trim() || name.toLowerCase();
      if (catalog.anthropic.length) configs.claude = {
        driver: "claudeAgent", displayName: "Company · Claude",
        config: { cli: cli("CLAUDE"), managed: true, managedModels: catalog.anthropic, configDir: home("claude") },
        environment: { ANTHROPIC_API_KEY: token, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_BASE_URL: `${base}/anthropic`,
          ANTHROPIC_MODEL: catalog.anthropic[0], ANTHROPIC_DEFAULT_HAIKU_MODEL: catalog.anthropic[0],
          ANTHROPIC_DEFAULT_SONNET_MODEL: catalog.anthropic[0], ANTHROPIC_DEFAULT_OPUS_MODEL: catalog.anthropic[0],
          ANTHROPIC_SMALL_FAST_MODEL: catalog.anthropic[0] },
      };
      if (catalog.openai.length) configs.codex = {
        driver: "codex", displayName: "Company · Codex",
        config: { cli: cli("CODEX"), managed: { url: `${base}/openai/v1`, models: catalog.openai } },
        environment: { OPENMAUSBOT_COMPANY_API_KEY: token, CODEX_HOME: home("codex") },
      };
      if (catalog.openrouter.length) configs.opencode = {
        driver: "openai-compat", displayName: "Company · OpenRouter",
        config: { url: `${base}/openrouter/v1`, apiKeyEnv: "OPENMAUSBOT_COMPANY_API_KEY", provider: "", model: catalog.openrouter[0], managedModels: catalog.openrouter },
        environment: { OPENMAUSBOT_COMPANY_API_KEY: token },
      };
      return configs;
    },
    decorate(instance: ProviderInstance): ProviderInstance {
      const models = assigned(instance.instanceId);
      return {
        ...instance,
        models: { default: models[0], options: models.map(id => ({ id, label: id })) },
        refreshModels: async () => {},
        installRuntime: undefined, startAuthentication: undefined, getAuthentication: undefined,
        completeAuthentication: undefined, cancelAuthentication: undefined, signOut: undefined,
        snapshot: async () => ({ ...await instance.snapshot(), authenticated: true, billing: "metered" }),
        adapter: { ...instance.adapter, sendTurn: async input => {
          if (!input.model || !models.includes(input.model)) throw new Error(HOSTED_MODEL_SELECTION_ERROR);
          return instance.adapter.sendTurn(input);
        } },
      };
    },
    /** A one-time route migration drops only native continuation handles. The
     * canonical conversations and branches remain, and rewind replays them. */
    reconcile(store: Store) {
      const marker = join(dataDirectory, "hosted-model-policy.json");
      const identity = JSON.stringify({ version: 1, admin: hosted.admin.origin, workspace: hosted.workspace });
      const changedRoute = !existsSync(marker) || readFileSync(marker, "utf8") !== identity;
      for (const bot of store.bots) {
        const previousDefault = bot.modelSelection;
        const nextDefault = select(previousDefault);
        for (const task of store.tasks(bot.id)) {
          const current = task.modelSelection ?? previousDefault;
          const next = select(current);
          const changed = JSON.stringify(next) !== JSON.stringify(current);
          if (changed || changedRoute) store.patchTask(bot.id, task.threadId, {
            modelSelection: next, resumeCursors: {}, lastInstanceId: undefined, rewound: true,
            lastContextModel: undefined, appliedCompactionId: undefined,
          });
        }
        if (JSON.stringify(previousDefault) !== JSON.stringify(nextDefault)) store.patchBot(bot.id, { modelSelection: nextDefault });
      }
      writeFileAtomic(marker, identity, { mode: 0o600 });
    },
  };
}
