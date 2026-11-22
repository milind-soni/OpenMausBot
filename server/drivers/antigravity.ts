// Google Antigravity through its official ACP server: managed runtime, isolated Google profile,
// model/mode configuration and OAuth.
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { dirname, join } from "node:path";
import { stageAntigravitySkills } from "./antigravity-skills.ts";
import { antigravityAccount } from "./antigravity-account.ts";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  SendTurnInput,
} from "../contracts.ts";
import { createAcpDriver, type AcpConfig, type AcpSupport } from "./acp/core.ts";
import {
  antigravityCliSessionMode,
  antigravityClientInfo,
  antigravityLaunchArgs,
  antigravityProfileAuthenticated,
  antigravityProfileDirectory,
  antigravitySessionSetup,
  antigravitySignInError,
  antigravityTokenPath,
  authorizationUrlFromLine,
  noteAntigravitySignedIn,
  noteAntigravitySignInRequired,
  prepareAntigravityProfile,
  probeAntigravityModels,
  type AntigravityProfile,
  removeAntigravitySignIn,
  validateAntigravityRuntime,
  verifyAntigravityBrowserHelper,
} from "./antigravity-acp.ts";
import { antigravityLimitFacts, watchAntigravityPromptOutcome } from "./antigravity-turn-outcome.ts";
import { splitAntigravityThinking } from "./antigravity-models.ts";
import { AntigravityAuthController } from "./antigravity-auth.ts";
import { AntigravityCliLogin } from "./antigravity-native-login.ts";
import { NativeSignInCache, antigravityCliSignIn, signOutAntigravityCli } from "./antigravity-native-status.ts";
import { antigravityNativeCredentialsHeld, clearAntigravityNativeCredentials, noteAntigravityNativeCredentials } from "./antigravity-native-credentials.ts";
import { AcpDiscoveryRpcError, AcpDiscoveryTimeoutError } from "./acp/custom-model-catalog.ts";
import {
  antigravityManagedInstallAvailable,
  isAntigravityNativeAlias,
  installAntigravityRuntime,
  resolveAntigravityRuntime,
  type AntigravityRuntime,
} from "./antigravity-runtime.ts";
import { ANTIGRAVITY_NATIVE_CLI } from "./antigravity-cli-install.ts";
import { acpFileEditWithin } from "./permission-command.ts";
import { resolveAntigravityReleaseAsset } from "./antigravity-release.ts";
import { AntigravityProcesses } from "./antigravity-processes.ts";
import { VERIFICATION_TEMP_KEY, scheduleAntigravityTempSweep } from "./antigravity-temp.ts";
import { augmentedPath } from "../env-path.ts";
import { bundledEngineCatalog } from "../model-manifest/bundled.ts";
import { currentEngineCatalog } from "../model-manifest/manifest.ts";

export { antigravitySignInError };

export const STATIC_ANTIGRAVITY_MODELS: ModelCatalog = bundledEngineCatalog("antigravity");

/** Bots saved before the thinking-level option hold ids like `gemini-3.8-flash-medium` or `gemini-4-neon-high`;
 * the official runtime offers only the base model with that option, so run the base at the saved level. A runtime
 * that still offers the suffixed id, or lacks the base, or a turn that chose its own level, keeps its selection. */
export function normalizeAntigravityTurn(turn: SendTurnInput, offeredModels: readonly string[], catalog?: ModelCatalog): SendTurnInput {
  if (turn.variant !== undefined || !turn.model) return turn;
  const split = splitAntigravityThinking(turn.model, offeredModels.map((id) => catalog?.options.find((option) => option.id === id) ?? { id }), true);
  return split ? { ...turn, ...split } : turn;
}

/** Antigravity's session modes: `yolo` for Full, `auto_edit` for auto-accept edits, `default` otherwise (it has no reviewer for Auto). */
export function antigravityPermissionMode(fullAuto: boolean, approvalMode?: ApprovalMode): "yolo" | "auto_edit" | "default" {
  if (fullAuto || approvalMode === "full") return "yolo";
  return approvalMode === "edits" ? "auto_edit" : "default";
}

/** agy_acp_server opens a text run after a tool call with `&_a_m_p_;_` tokens — `&` escaped
 * entity-style — which Markdown then parses as emphasis; they are never real reply text. */
export function cleanAntigravityTextStart(delta: string): string {
  return delta.replace(/^(?:&_a_m_p_;_\s*)+/u, "");
}

/** The escaping can open any text run, so cleanAntigravityTextStart applies to the first text chunk
 * after anything that is not one. */
export function antigravityUpdateFilter(): (update: Record<string, any>) => Record<string, any> | null {
  let runStart = true;
  return (update) => {
    if (update.sessionUpdate !== "agent_message_chunk" || update.content?.type === "image") {
      runStart = true;
      return update;
    }
    const text = update.content?.text;
    if (typeof text !== "string" || !text || !runStart) return update;
    const kept = cleanAntigravityTextStart(text);
    if (!kept) return null;
    runStart = false;
    return kept === text ? update : { ...update, content: { ...update.content, text: kept } };
  };
}

const managedAsset = resolveAntigravityReleaseAsset();
const runtimeProcesses = new AntigravityProcesses();
/** Every model id an account here has been offered, beside the bundled catalog's. */
const offeredModels = new Set<string>();
/** The runtime each instance's turns were last started on, known before it answers initialize. */
const launched = new Map<string, { version: string | null; nativeCli: boolean }>();

const nativeSignIn = new NativeSignInCache();

const nativeRuntimeKey = (runtime: AntigravityRuntime) => `${runtime.executablePath}\0${runtime.version}`;

/** Whether the native CLI accepts a session for this instance, kept for a short while. Throws when the CLI could not say:
 * that is not "signed out". */
async function nativeSignedIn(instanceId: string, runtime: AntigravityRuntime, profile: AntigravityProfile): Promise<boolean> {
  return await nativeSignIn.state(instanceId, nativeRuntimeKey(runtime), async () => {
    const found = await antigravityCliSignIn(runtime, profile);
    if (found === "in") noteAntigravityNativeCredentials(instanceId);
    return found;
  }) === "in";
}

/** Model discovery's failure as the shared catalog classifies it: a refused session is "signedOut", a slow CLI "timedOut". */
function nativeDiscoveryError(instanceId: string, error: unknown): unknown {
  if (antigravitySignInError(error)) {
    nativeSignIn.forget(instanceId);
    const refusal = error as { code: unknown; message: unknown };
    return new AcpDiscoveryRpcError(refusal.code, typeof refusal.message === "string" ? refusal.message : "");
  }
  return error instanceof Error && /timed out/iu.test(error.message) ? new AcpDiscoveryTimeoutError(error.message) : error;
}

const support: AcpSupport = {
  driverKind: "antigravityAgent",
  // Named for what people look for: Google moved personal Gemini subscriptions (free, AI Pro, AI Ultra) from Gemini CLI to Antigravity on 2026-06-18.
  displayName: "Google Gemini (Antigravity)",
  get models() { return currentEngineCatalog("antigravity"); },
  defaultCli: "agy", // migration alias: resolveAntigravityRuntime treats it as managed
  nativeSource: "antigravity.acp",
  loginNote: "Antigravity needs a Google account — choose Sign in with Google in engine setup",
  install: {
    docsUrl: "https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp",
    ...(antigravityManagedInstallAvailable()
      // A client from before the native CLI shows this size whatever else is sent: the pinned archive's, or none.
      ? { managed: { label: "Install official Antigravity", downloadBytes: managedAsset?.archiveBytes ?? 0, ...(ANTIGRAVITY_NATIVE_CLI ? { sizeUnknown: true as const } : {}) } }
      : {}),
  },
  images: true,
  mediaLinks: true,
  spawnArgs: () => [],
  selectModel: { configId: "model" },
  modelVariants: true,
  normalizeSessionSelection: normalizeAntigravityTurn,
  // Google's server reads its new-session default from this variable (agy_acp_server 1.4.3
  // model_selection.get_default_model_id); a later switch re-fetches the model list (1.3-1.8 s).
  sessionModelEnv: "AGY_ACP_DEFAULT_MODEL",
  sessionScopedApproval: true,
  resumeMethod: "resume",
  clientFileSystem: true,
  clientReadRoots: (turn) => (turn.skillFiles ?? []).map(dirname),
  sanitizeToolPayload: true,
  updateFilter: antigravityUpdateFilter,

  resolveCommand: async (env, config, instanceId) => {
    const runtime = await resolveAntigravityRuntime(config.cli, env);
    launched.set(instanceId, { version: runtime.version, nativeCli: runtime.harnessPath === null });
    const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
    if (profile.tempDirectory) scheduleAntigravityTempSweep(instanceId);
    return {
      command: runtime.executablePath,
      args: antigravityLaunchArgs(runtime, profile.directory),
      env: profile.environment,
      ro: [join(profile.directory, "omb-skills")],
    };
  },

  resolveModels: async (env, config, instanceId) => {
    const runtime = await resolveAntigravityRuntime(config.cli, env);
    const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
    const native = runtime.harnessPath === null;
    if (!native && !(await antigravityProfileAuthenticated(profile))) throw new Error(support.loginNote);
    const catalog = await probeAntigravityModels({
      runtime,
      profile,
      fallbackDefault: currentEngineCatalog("antigravity").default,
    }).catch((error: unknown) => { throw native ? nativeDiscoveryError(instanceId, error) : error; });
    for (const option of catalog.options) offeredModels.add(option.id);
    return catalog;
  },

  pickAuthMethod: (methods) => methods.some((method) => method.id === "oauth-personal")
    ? "oauth-personal"
    : null,
  authFailure: "fail",
  // The native CLI answers `authenticate` by opening a browser on its own machine, so only `acp --login` signs it in.
  skipsAuthenticate: (instanceId) => launched.get(instanceId)?.nativeCli === true,
  classifyError: (error) => antigravitySignInError(error) ? "invalid_credentials" : undefined,
  // With a stored token Google no longer honours, agy_acp_server 1.4.3 prints its sign-in link and waits on
  // `authenticate`.
  signInRequest: {
    stderrLine: (line) => authorizationUrlFromLine(line) !== null,
    rpcError: antigravitySignInError,
    required: (instanceId) => { nativeSignIn.forget(instanceId); noteAntigravitySignInRequired(antigravityTokenPath(instanceId)); },
  },
  processStarted: (child, instanceId) => runtimeProcesses.track(instanceId, child),
  sessionSetupParams: antigravitySessionSetup,
  // One model family's quota is not the account's: Gemini and the models that share another allowance keep running.
  limitFacts: (_text, model) => antigravityLimitFacts(model, [...support.models.options.map((option) => option.id), ...offeredModels]),
  clientInfo: (instanceId) => antigravityClientInfo(launched.get(instanceId)?.version),
  // In `default` the native CLI asks before every edit; Auto-accept edits answers those, as `auto_edit` did.
  // Security: only a file edit inside the turn's folder is answered; one that names a command or another place is asked.
  allowsAlone: (instanceId, turn, toolCall) => launched.get(instanceId)?.nativeCli === true && turn.approvalMode === "edits" && acpFileEditWithin(toolCall, turn.cwd),
  promptOutcome: (instanceId, sessionId) => watchAntigravityPromptOutcome(support.displayName, antigravityProfileDirectory(instanceId), sessionId),
  requireAuthenticationBeforeSpawn: true,
  // Before a native turn only a refusal the CLI gave recently stops it: otherwise the turn's own session/new is the
  // question, and its refusal ends the turn as a sign-in request.
  isAuthenticated: async (env, config, instanceId) => {
    let runtime: AntigravityRuntime;
    let profile: AntigravityProfile;
    try {
      runtime = await resolveAntigravityRuntime(config.cli, env);
      profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
    } catch {
      return false;
    }
    return runtime.harnessPath === null ? nativeSignIn.known(instanceId, nativeRuntimeKey(runtime)) !== "out" : antigravityProfileAuthenticated(profile);
  },
  snapshot: async (env, config, instanceId): Promise<ProviderSnapshot> => {
    try {
      const runtime = await resolveAntigravityRuntime(config.cli, env);
      const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
      if (runtime.harnessPath === null) {
        // A CLI that could not answer leaves `authenticated` out, which no caller reads as signed out.
        const authenticated = await nativeSignedIn(instanceId, runtime, profile).catch(() => undefined);
        return { state: "available", version: runtime.version, ...(authenticated === undefined ? {} : { authenticated }) };
      }
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

  configureSession: async ({ request, sessionId, instanceId, config, turn, configOptions }) => {
    const nativeCli = launched.get(instanceId)?.nativeCli === true;
    if (!Array.isArray(configOptions) || !configOptions.some(option => option?.id === "mode")) {
      // The native CLI answers by the turn's level only in `default`; with no mode to confirm, nothing says it is there.
      if (nativeCli) throw new Error("Antigravity did not report its permission mode.");
      return;
    }
    const level = antigravityPermissionMode(config.fullAuto, turn.approvalMode);
    const wanted = nativeCli ? antigravityCliSessionMode(level) : level;
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
    const auth = new AntigravityAuthController(() => {
      noteAntigravitySignedIn(antigravityTokenPath(input.instanceId));
      void base.refreshModels?.();
    });
    let signingOut: Promise<void> = Promise.resolve();
    let installFailure: string | undefined;
    // A GUI launch's raw PATH may omit the official runtime the model picker found.
    const environmentNow = () => ({ ...process.env, ...input.environment, PATH: augmentedPath() });
    const runtimeAndProfile = async (cli: string | undefined = input.config.cli) => {
      const environment = environmentNow();
      const runtime = await resolveAntigravityRuntime(cli, environment);
      const profile = await prepareAntigravityProfile({
        instanceId: input.instanceId,
        runtime,
        baseEnv: environment,
      });
      return { runtime, profile };
    };
    const login = new AntigravityCliLogin({
      submitting: () => noteAntigravityNativeCredentials(input.instanceId),
      signedIn: () => {
        nativeSignIn.forget(input.instanceId);
        void base.refreshModels?.();
      },
      confirm: async () => {
        const { runtime, profile } = await runtimeAndProfile();
        return (await antigravityCliSignIn(runtime, profile)) === "in";
      },
    });
    let nativeFlow = false;
    // Starting a sign-in and signing out never overlap: a sign-in begun while one is being removed would be removed with it.
    let exclusive: Promise<unknown> = Promise.resolve();
    const alone = <T>(work: () => Promise<T>): Promise<T> => {
      const run = exclusive.then(work, work);
      exclusive = run.catch(() => {});
      return run;
    };
    /** Signs the native CLI out when it holds a sign-in for this instance (a login made here, or one it found), and
     * confirms it no longer does. Throws when that cannot be confirmed: the account must then stay. */
    const signOutNative = async () => {
      let current: { runtime: AntigravityRuntime; profile: AntigravityProfile } | null = null;
      try { current = await runtimeAndProfile(); } catch {}
      if (current?.runtime.harnessPath !== null && !antigravityNativeCredentialsHeld(input.instanceId)) return;
      // Its processes are gone before the CLI is asked: one still running keeps the account it started with.
      await runtimeProcesses.stopped(input.instanceId);
      if (current?.runtime.harnessPath === null && !antigravityNativeCredentialsHeld(input.instanceId)) {
        const found = await antigravityCliSignIn(current.runtime, current.profile, { waitForExit: true })
          .catch(() => { throw new Error("Antigravity could not confirm whether this account is signed in. Try again."); });
        if (found === "in") noteAntigravityNativeCredentials(input.instanceId);
      }
      if (!antigravityNativeCredentialsHeld(input.instanceId)) return;
      let cli = current?.runtime.harnessPath === null ? current : null;
      if (!cli) {
        try { cli = await runtimeAndProfile("antigravity"); }
        catch (error) { throw new Error(`Antigravity's native CLI is needed to sign this account out, and could not be started: ${error instanceof Error ? error.message : String(error)}`); }
      }
      nativeSignIn.forget(input.instanceId);
      await signOutAntigravityCli(cli.runtime, cli.profile);
      clearAntigravityNativeCredentials(input.instanceId);
    };
    return {
      ...base,
      adapter: {
        ...base.adapter,
        sendTurn: async (turn) => base.adapter.sendTurn(stageAntigravitySkills(turn, antigravityProfileDirectory(input.instanceId))),
      },
      get models() {
        return base.models;
      },
      get modelsUnconfirmed() {
        return base.modelsUnconfirmed;
      },
      get modelsUnreadable() {
        return base.modelsUnreadable;
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
                await installAntigravityRuntime({ validate: validateAntigravityRuntime, native: isAntigravityNativeAlias(input.config.cli) });
              } catch (error) {
                installFailure = error instanceof Error ? error.message : String(error);
                throw error;
              }
            },
          }
        : {}),
      authenticationMethod: "callback-url",
      startAuthentication: () => alone(async () => {
        await signingOut;
        const { runtime, profile } = await runtimeAndProfile();
        await login.cancel();
        auth.cancel();
        nativeFlow = runtime.harnessPath === null;
        if (nativeFlow) return login.start(runtime, profile);
        await verifyAntigravityBrowserHelper(profile);
        return auth.start(runtime, profile);
      }),
      getAuthentication: async (flowId) => nativeFlow ? login.get(flowId) : auth.get(flowId),
      completeAuthentication: async (flowId, pasted) => nativeFlow ? login.complete(flowId, pasted) : auth.complete(flowId, pasted),
      cancelAuthentication: async () => {
        auth.cancel();
        await login.cancel();
      },
      forgetAuthentication: () => nativeSignIn.forget(input.instanceId),
      // A runtime process keeps the account it started with, and can write the token file again as it exits: the
      // sign-in is removed at once, and once more when those processes are gone. A new sign-in waits for that.
      signOut: () => alone(async () => {
        auth.cancel();
        if (!(await login.cancel())) throw new Error("The Antigravity sign-in in progress could not be stopped. Try again.");
        await base.adapter.stopAll();
        await signOutNative();
        await removeAntigravitySignIn(input.instanceId);
        if (!runtimeProcesses.count(input.instanceId)) return;
        signingOut = runtimeProcesses.stopped(input.instanceId)
          .then(() => removeAntigravitySignIn(input.instanceId))
          .catch((error) => console.warn(`antigravity: could not finish the sign-out: ${error instanceof Error ? error.message : String(error)}`));
      }),
      dispose: async () => {
        auth.cancel();
        await login.cancel();
        await base.dispose();
      },
    };
  },
};
