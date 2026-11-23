// Google Antigravity through its official ACP server: managed runtime, isolated Google profile,
// model/mode configuration and OAuth.
import type { ChildProcess } from "node:child_process";
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
  antigravityTakesSystemPrompt,
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
import { AntigravityCliLogin, type LoginProcesses } from "./antigravity-native-login.ts";
import { NativeSignInCache, antigravityCliRefusedSession, antigravityCliSignIn, signOutAntigravityCli } from "./antigravity-native-status.ts";
import { AcpDiscoveryRpcError, AcpDiscoveryTimeoutError } from "./acp/custom-model-catalog.ts";
import {
  antigravityManagedInstallAvailable,
  isAntigravityNativeAlias,
  isAntigravityPinnedAlias,
  installAntigravityRuntime,
  resolveAntigravityRuntime,
  type AntigravityRuntime,
} from "./antigravity-runtime.ts";
import { ANTIGRAVITY_NATIVE_CLI, isAntigravityCliName } from "./antigravity-cli-install.ts";
import { acpFileEditWithin } from "./permission-command.ts";
import { resolveAntigravityReleaseAsset } from "./antigravity-release.ts";
import { AntigravityProcesses } from "./antigravity-processes.ts";
import { VERIFICATION_TEMP_KEY, scheduleAntigravityTempSweep } from "./antigravity-temp.ts";
import { augmentedPath } from "../env-path.ts";
import { killCliTree } from "../procs.ts";
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
const loginProcesses = new Map<string, LoginProcesses>();
/** Every live instance's sign-in and turns: a native sign-out ends those on the native CLI, which share its one sign-in. */
const liveInstances = new Map<string, {
  login: AntigravityCliLogin;
  stopAll: () => Promise<void>;
  native: () => boolean;
  profile: (runtime: AntigravityRuntime) => Promise<AntigravityProfile>;
}>();
/** While the native CLI's shared sign-in is being removed, no native process starts: it would hold the old sign-in. */
let nativeSigningOut: Promise<void> | null = null;
const nativeSignOutDone = async () => { while (nativeSigningOut) await nativeSigningOut.catch(() => {}); };
/** Starting a sign-in and signing out never overlap, across instances: a sign-in begun while the shared one is being
 * removed would be removed with it, or put it back. */
let exclusive: Promise<unknown> = Promise.resolve();
function alone<T>(work: () => Promise<T>): Promise<T> {
  const run = exclusive.then(work, work);
  exclusive = run.catch(() => {});
  return run;
}

/** A native process that starts while the shared sign-in is being removed was let in before that began: it is ended at
 * once, before it can use or write back the old sign-in. */
function trackNative(instanceId: string, child: ChildProcess): void {
  runtimeProcesses.track(instanceId, child);
  if (nativeSigningOut) void killCliTree(child).catch(() => false);
}
const tracked = (instanceId: string) => (child: ChildProcess) => trackNative(instanceId, child);

const nativeRuntimeKey = (runtime: AntigravityRuntime) => `${runtime.executablePath}\0${runtime.version}`;

/** Whether the native CLI accepts a session for this instance, as last learned. Throws when the CLI could not say: that
 * is not "signed out". */
async function nativeSignedIn(instanceId: string, runtime: AntigravityRuntime, profile: AntigravityProfile): Promise<boolean> {
  await nativeSignOutDone();
  return await nativeSignIn.state(instanceId, nativeRuntimeKey(runtime), () => antigravityCliSignIn(runtime, profile, { onProcess: tracked(instanceId) })) === "in";
}

/** Model discovery's failure as the shared catalog classifies it: a refused session is "signedOut", a slow CLI "timedOut".
 * A refusal is every native instance's, since they share one sign-in. */
function nativeDiscoveryError(error: unknown): unknown {
  if (antigravityCliRefusedSession(error)) {
    nativeSignIn.forgetAll();
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
    if (runtime.harnessPath === null) await nativeSignOutDone();
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
    if (runtime.harnessPath === null) await nativeSignOutDone();
    const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
    const native = runtime.harnessPath === null;
    if (!native && !(await antigravityProfileAuthenticated(profile))) throw new Error(support.loginNote);
    const accepted = native ? nativeSignIn.seen(instanceId, nativeRuntimeKey(runtime)) : undefined;
    const catalog = await probeAntigravityModels({
      runtime,
      profile,
      fallbackDefault: currentEngineCatalog("antigravity").default,
      ...(native ? { onProcess: tracked(instanceId) } : {}),
    }).catch((error: unknown) => { throw native ? nativeDiscoveryError(error) : error; });
    accepted?.("in");
    for (const option of catalog.options) offeredModels.add(option.id);
    return catalog;
  },

  pickAuthMethod: (methods) => methods.some((method) => method.id === "oauth-personal")
    ? "oauth-personal"
    : null,
  authFailure: "fail",
  // The native CLI answers `authenticate` by opening a browser on its own machine, so only `acp --login` signs it in.
  skipsAuthenticate: (instanceId) => launched.get(instanceId)?.nativeCli === true,
  classifyError: (error) => antigravityCliRefusedSession(error) ? "invalid_credentials" : undefined,
  // With a stored token Google no longer honours, agy_acp_server 1.4.3 prints its sign-in link and waits on
  // `authenticate`.
  signInRequest: {
    stderrLine: (line) => authorizationUrlFromLine(line) !== null,
    rpcError: (error, instanceId) => launched.get(instanceId)?.nativeCli === true ? antigravityCliRefusedSession(error) : antigravitySignInError(error),
    required: (instanceId) => {
      if (launched.get(instanceId)?.nativeCli === true) nativeSignIn.forgetAll();
      else nativeSignIn.forget(instanceId);
      noteAntigravitySignInRequired(antigravityTokenPath(instanceId));
    },
  },
  processStarted: (child, instanceId) => launched.get(instanceId)?.nativeCli === true ? trackNative(instanceId, child) : runtimeProcesses.track(instanceId, child),
  sessionSetupParams: antigravitySessionSetup,
  sessionSystemPrompt: (initialized, instanceId) => launched.get(instanceId)?.nativeCli === true && antigravityTakesSystemPrompt(initialized),
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
        return { state: "available", version: runtime.version, sharedSignIn: true, ...(authenticated === undefined ? {} : { authenticated }) };
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
    // A rebuilt instance may run another CLI, or the same one after a sign-in made outside MausBot.
    nativeSignIn.forget(input.instanceId);
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
    const alive = loginProcesses.get(input.instanceId) ?? new Map();
    loginProcesses.set(input.instanceId, alive);
    const login = new AntigravityCliLogin({
      signedIn: () => {
        nativeSignIn.forgetAll();
        void base.refreshModels?.();
      },
      confirm: async () => {
        const { runtime, profile } = await runtimeAndProfile();
        return (await antigravityCliSignIn(runtime, profile)) === "in";
      },
    }, {}, alive);
    let nativeFlow = false;
    // The runtime it last started on or signs in with, else what its CLI path names: a binary called antigravity beside a
    // harness is pinned.
    liveInstances.set(input.instanceId, {
      login, stopAll: () => base.adapter.stopAll(),
      native: () => launched.get(input.instanceId)?.nativeCli ?? (nativeFlow || isAntigravityCliName(input.config.cli?.trim() ?? "")),
      profile: (runtime) => prepareAntigravityProfile({ instanceId: input.instanceId, runtime, baseEnv: environmentNow() }),
    });
    /** The native CLI keeps one sign-in for every instance run by it and for the Antigravity CLI in a terminal here
     * (1.5.14: one OS keyring entry, whatever `--gemini-dir` says), so this signs all of them out. Throws, keeping the
     * sign-in, when the CLI still accepts a session or cannot say. */
    const signOutNative = async (runtime: AntigravityRuntime, profile: AntigravityProfile) => {
      let done!: () => void;
      nativeSigningOut = new Promise<void>((resolveDone) => { done = resolveDone; });
      try {
        const affected = [...liveInstances].filter(([instanceId, live]) => live.native() || instanceId === input.instanceId);
        for (const [, live] of liveInstances) {
          if (!(await live.login.cancel())) throw new Error("An Antigravity sign-in in progress could not be stopped. Try again.");
        }
        for (const [, live] of affected) await live.stopAll();
        // A process still running keeps the account it started with, and may write it back when it refreshes it.
        for (const instanceId of new Set([input.instanceId, ...affected.map(([instanceId]) => instanceId)])) {
          if (!(await runtimeProcesses.stopped(instanceId)) || runtimeProcesses.count(instanceId)) throw new Error("Antigravity is still running and could not be stopped. Try again.");
        }
        nativeSignIn.forgetAll();
        await signOutAntigravityCli(runtime, profile, { onProcess: (child) => runtimeProcesses.track(input.instanceId, child) });
        // Without an OS keyring the CLI keeps each profile's sign-in in that profile's file (1.5.14), so each is removed too.
        for (const [instanceId, live] of affected) {
          if (instanceId === input.instanceId) continue;
          await signOutAntigravityCli(runtime, await live.profile(runtime), { onProcess: (child) => runtimeProcesses.track(instanceId, child) });
        }
        nativeSignIn.forgetAll();
      } finally {
        nativeSigningOut = null;
        done();
      }
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
                await installAntigravityRuntime({
                  validate: validateAntigravityRuntime,
                  native: isAntigravityNativeAlias(input.config.cli),
                  ...(isAntigravityPinnedAlias(input.config.cli) ? { nativeByDefault: false } : {}),
                });
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
        // An account set to the native CLI that cannot be started cannot be signed out of it: that must not pass as done.
        const current = await runtimeAndProfile().catch((error: unknown) => { if (isAntigravityCliName(input.config.cli?.trim() ?? "")) throw error; return null; });
        if (current?.runtime.harnessPath === null) return await signOutNative(current.runtime, current.profile);
        await removeAntigravitySignIn(input.instanceId);
        if (!runtimeProcesses.count(input.instanceId)) return;
        signingOut = runtimeProcesses.stopped(input.instanceId)
          .then(() => removeAntigravitySignIn(input.instanceId))
          .catch((error) => console.warn(`antigravity: could not finish the sign-out: ${error instanceof Error ? error.message : String(error)}`));
      }),
      dispose: async () => {
        if (liveInstances.get(input.instanceId)?.login === login) liveInstances.delete(input.instanceId);
        auth.cancel();
        await login.cancel();
        await base.dispose();
      },
    };
  },
};
