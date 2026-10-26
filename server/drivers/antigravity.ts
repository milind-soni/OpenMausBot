// Google Antigravity through its official ACP server: managed runtime, isolated Google profile,
// model/mode configuration and OAuth.
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { antigravityAccount } from "./antigravity-account.ts";
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
import { VERIFICATION_TEMP_KEY, scheduleAntigravityTempSweep } from "./antigravity-temp.ts";
import { augmentedPath } from "../env-path.ts";

export const STATIC_ANTIGRAVITY_MODELS: ModelCatalog = {
  default: "gemini-3.8-flash-high",
  options: [
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  ],
};

/** Antigravity's session modes: `yolo` for Full, `auto_edit` for auto-accept edits, `default` otherwise (it has no reviewer for Auto). */
export function antigravityPermissionMode(fullAuto: boolean, approvalMode?: ApprovalMode): "yolo" | "auto_edit" | "default" {
  if (fullAuto || approvalMode === "full") return "yolo";
  return approvalMode === "edits" ? "auto_edit" : "default";
}

const managedAsset = resolveAntigravityReleaseAsset();

const support: AcpSupport = {
  driverKind: "antigravityAgent",
  // Named for what people look for: Google moved personal Gemini subscriptions (free, AI Pro, AI Ultra) from Gemini CLI to Antigravity on 2026-06-18.
  displayName: "Google Gemini (Antigravity)",
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
  // Google's server reads its new-session default from this variable (agy_acp_server 1.4.3
  // model_selection.get_default_model_id); a later switch re-fetches the model list (1.3-1.8 s).
  sessionModelEnv: "AGY_ACP_DEFAULT_MODEL",
  sessionScopedApproval: true,
  resumeMethod: "resume",
  clientFileSystem: true,
  redactStderr: true,
  sanitizeToolPayload: true,
  resolveModelsOnCreate: false,

  resolveCommand: async (env, config, instanceId) => {
    const runtime = await resolveAntigravityRuntime(config.cli, env);
    const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
    if (profile.tempDirectory) scheduleAntigravityTempSweep(instanceId);
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
        account: await antigravityAccount(profile.tokenPath),
      };
    } catch (error) {
      return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
    }
  },

  configureSession: async ({ request, sessionId, config, turn }) => {
    const wanted = antigravityPermissionMode(config.fullAuto, turn.approvalMode);
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
    scheduleAntigravityTempSweep(input.instanceId);
    scheduleAntigravityTempSweep(VERIFICATION_TEMP_KEY);
    const auth = new AntigravityAuthController();
    let installFailure: string | undefined;
    const runtimeAndProfile = async () => {
      // A GUI launch's raw PATH may omit the official runtime the model picker found.
      const environment = { ...process.env, ...input.environment, PATH: augmentedPath() };
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
      snapshot: async () => {
        const snapshot = await base.snapshot();
        if (snapshot.state === "available") installFailure = undefined;
        return snapshot.state === "unavailable" && installFailure
          ? { ...snapshot, reason: installFailure }
          : snapshot;
      },
      ...(antigravityManagedInstallAvailable()
        ? {
            installRuntime: async () => {
              installFailure = undefined;
              try {
                await installAntigravityRuntime({ validate: validateAntigravityRuntime });
              } catch (error) {
                installFailure = error instanceof Error ? error.message : String(error);
                throw error;
              }
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
        auth.cancel();
        await base.dispose();
      },
    };
  },
};
