// Google Antigravity through its official ACP server. The protocol mechanics
// stay in the shared ACP core; this file only supplies Antigravity's managed
// runtime, isolated Google profile, model/mode configuration, and OAuth.
//
// The previous community `agy` print-mode bridge mutated the user's global
// ~/.gemini MCP config and could not surface interactive approvals. Official
// ACP mounts MCP servers per session and uses the same trusted approval cards
// as OpenMausBot's other ACP engines.
import type { ApprovalMode } from "../../shared/approval-mode.ts";
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

/** Antigravity's own session modes: `yolo` for Full access, `auto_edit` for
 * auto-accept edits, `default` otherwise (Ask, and Auto, which it has no
 * reviewer for). */
export function antigravityPermissionMode(fullAuto: boolean, approvalMode?: ApprovalMode): "yolo" | "auto_edit" | "default" {
  if (fullAuto) return "yolo";
  return approvalMode === "edits" ? "auto_edit" : "default";
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
  // Google's server reads its new-session default from this variable
  // (model_selection.get_default_model_id in agy_acp_server 1.1.1). Starting
  // on OMB's model skips a switch that re-fetches the account's model list
  // from Google: 1.3-1.8 s on every new or cold-resumed conversation.
  sessionModelEnv: "AGY_ACP_DEFAULT_MODEL",
  // configureSession sets the permission mode on every turn and nothing in
  // the launch depends on it, so an approval change keeps the process.
  sessionScopedApproval: true,
  resumeMethod: "resume",
  clientFileSystem: true,
  redactStderr: true,
  sanitizeToolPayload: true,
  resolveModelsOnCreate: false,

  resolveCommand: async (env, config, instanceId) => {
    const runtime = await resolveAntigravityRuntime(config.cli, env);
    const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
    // A process stopped by force since the last launch (an idle close that
    // outlived its grace, a crash) left its unpacked files behind. Reclaim
    // them in the background; live folders are kept.
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
    // Reclaim what a previous run of this instance left behind when it was
    // stopped by force (Windows keeps 0.34-1.26 GB per forced stop). Only
    // this instance's folder under DATA_DIR/tmp/agy, only folders whose
    // process is gone; the system temp folder is cleaned only on request.
    scheduleAntigravityTempSweep(input.instanceId);
    // The same for a runtime verification whose runtime would not stop.
    scheduleAntigravityTempSweep(VERIFICATION_TEMP_KEY);
    const auth = new AntigravityAuthController();
    let installFailure: string | undefined;
    const runtimeAndProfile = async () => {
      // Match the ACP driver's discovery/chat environment. A GUI launch's
      // raw PATH may omit an official runtime that the model picker found.
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
        // A failed first install has no promoted executable yet. Preserve
        // why it failed across closing/reopening setup in this app session.
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
