// Google Antigravity through its official ACP server. The protocol mechanics
// stay in the shared ACP core; this file only supplies Antigravity's managed
// runtime, isolated Google profile, model/mode configuration, and OAuth.
//
// The previous community `agy` print-mode bridge mutated the user's global
// ~/.gemini MCP config and could not surface interactive approvals. Official
// ACP mounts MCP servers per session and uses the same trusted approval cards
// as OpenMausBot's other ACP engines.
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
} from "../contracts.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./acp/core.ts";
import {
  AntigravityAuthController,
  antigravityProfileAuthenticated,
  catalogFromAntigravityConfigOptions,
  prepareAntigravityProfile,
  probeAntigravityModels,
  validateAntigravityRuntime,
} from "./antigravity-acp.ts";
import {
  antigravityManagedInstallAvailable,
  installAntigravityRuntime,
  resolveAntigravityRuntime,
} from "./antigravity-runtime.ts";
import { resolveAntigravityReleaseAsset } from "./antigravity-release.ts";
import {
  registerManagedAntigravityWorker,
  unregisterManagedAntigravityWorker,
} from "../antigravity-accounts.ts";

export const STATIC_ANTIGRAVITY_MODELS: ModelCatalog = {
  default: "gemini-3.8-flash-high",
  options: [
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  ],
};

export function antigravityPermissionMode(fullAuto: boolean): "yolo" | "default" {
  return fullAuto ? "yolo" : "default";
}

export function antigravityModelsFromSession(value: unknown): ModelCatalog | null {
  return catalogFromAntigravityConfigOptions(value, STATIC_ANTIGRAVITY_MODELS.default);
}

const managedAsset = resolveAntigravityReleaseAsset();

const support: AcpSupport = {
  driverKind: "antigravityAgent",
  displayName: "Antigravity",
  models: STATIC_ANTIGRAVITY_MODELS,
  defaultCli: "agy", // migration alias: resolveAntigravityRuntime treats it as managed
  nativeSource: "antigravity.acp",
  loginNote: "Antigravity needs a Google account — choose Sign in with Google in engine setup",
  install: {
    docsUrl: "https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp",
    ...(managedAsset
      ? { managed: { label: "Install official Antigravity", downloadBytes: managedAsset.archiveBytes } }
      : {}),
  },
  images: true,
  spawnArgs: () => [],
  selectModel: { configId: "model" },
  resumeMethod: "resume",
  clientFileSystem: true,
  redactStderr: true,
  sanitizeToolPayload: true,
  resolveModelsOnCreate: false,

  resolveCommand: async (env, config, instanceId) => {
    const runtime = await resolveAntigravityRuntime(config.cli, env);
    const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
    return {
      command: runtime.executablePath,
      args: process.platform === "linux" ? ["--uid="] : [],
      env: profile.environment,
    };
  },

  resolveModels: async (env, config, instanceId) => {
    const runtime = await resolveAntigravityRuntime(config.cli, env);
    const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
    if (!(await antigravityProfileAuthenticated(profile))) throw new Error(support.loginNote);
    return probeAntigravityModels({
      runtime,
      profile,
      fallbackDefault: STATIC_ANTIGRAVITY_MODELS.default,
    });
  },

  pickAuthMethod: (methods) => methods.some((method) => method.id === "oauth-personal")
    ? "oauth-personal"
    : null,
  authFailure: "fail",
  requireAuthenticationBeforeSpawn: true,
  isAuthenticated: async (env, config, instanceId) => {
    try {
      const runtime = await resolveAntigravityRuntime(config.cli, env);
      const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
      return antigravityProfileAuthenticated(profile);
    } catch {
      return false;
    }
  },
  snapshot: async (env, config, instanceId): Promise<ProviderSnapshot> => {
    try {
      const runtime = await resolveAntigravityRuntime(config.cli, env);
      const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
      return {
        state: "available",
        version: runtime.version,
        authenticated: await antigravityProfileAuthenticated(profile),
      };
    } catch (error) {
      return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
    }
  },

  configureSession: async ({ request, sessionId, config }) => {
    const wanted = antigravityPermissionMode(config.fullAuto);
    const result = await request("session/set_config_option", {
      sessionId,
      configId: "mode",
      value: wanted,
    });
    const mode = Array.isArray(result?.configOptions)
      ? result.configOptions.find((option: any) => option?.id === "mode")?.currentValue
      : undefined;
    if (mode !== wanted) throw new Error(`Antigravity did not apply ${wanted} permission mode.`);
  },
};

const AcpAntigravityDriver = createAcpDriver(support);

export const AntigravityDriver: ProviderDriver<AcpConfig> = {
  ...AcpAntigravityDriver,
  async create(input: DriverCreateInput<AcpConfig>): Promise<ProviderInstance> {
    const base = await AcpAntigravityDriver.create(input);
    const auth = new AntigravityAuthController();
    registerManagedAntigravityWorker(input.instanceId);
    const runtimeAndProfile = async () => {
      const environment = { ...process.env, ...input.environment };
      const runtime = await resolveAntigravityRuntime(input.config.cli, environment);
      const profile = await prepareAntigravityProfile({
        instanceId: input.instanceId,
        runtime,
        baseEnv: environment,
      });
      return { runtime, profile };
    };
    return {
      ...base,
      get models() {
        return base.models;
      },
      ...(antigravityManagedInstallAvailable()
        ? {
            installRuntime: async () => {
              await installAntigravityRuntime({ validate: validateAntigravityRuntime });
            },
          }
        : {}),
      startAuthentication: async () => {
        const { runtime, profile } = await runtimeAndProfile();
        return auth.start(runtime, profile);
      },
      completeAuthentication: async (flowId, callbackUrl) => auth.complete(flowId, callbackUrl),
      cancelAuthentication: async () => auth.cancel(),
      dispose: async () => {
        unregisterManagedAntigravityWorker(input.instanceId);
        auth.cancel();
        await base.dispose();
      },
    };
  },
};
