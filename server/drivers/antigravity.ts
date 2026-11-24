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
import { reportedConfigValue } from "./acp/applied-config.ts";
import { ANTIGRAVITY_HARNESS_FAILURE_LOG } from "./acp/harness-failure.ts";
import { acpVendorMessage } from "./acp/rpc-error.ts";
import { classifyError } from "./retry.ts";
import {
  antigravityCliSessionMode,
  antigravityClientInfo,
  antigravityLaunchArgs,
  antigravityProfileAuthenticated,
  antigravityProfileDirectory,
  antigravitySessionSetup,
  antigravityTakesSystemPrompt,
  antigravityCliTokenPath,
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
  antigravityInstallRunning,
  antigravityManagedInstallAvailable,
  isAntigravityNativeAlias,
  isAntigravityPinnedAlias,
  antigravityPathRunsNativeCli,
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
import { killCliTree } from "../procs.ts";
import { bundledEngineCatalog } from "../model-manifest/bundled.ts";
import { currentEngineCatalog } from "../model-manifest/manifest.ts";

export const STATIC_ANTIGRAVITY_MODELS: ModelCatalog = bundledEngineCatalog("antigravity");
/** A live runtime that never answers session/new or session/resume gives up after this, as T3 Code's ACP startup does
 * (pingdotgg/t3code@2f19cec0793); initialize keeps the core's longer limit, which the Windows runtime's unpack needs. */
export const ANTIGRAVITY_SESSION_SETUP_TIMEOUT_MS = 90_000;

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

const SIGN_IN_WORDS = /\bauthenticat|\bunauthenticated\b|\bsign(?:ed)?[ -]?in\b|\blog(?:ged)?[ -]?in\b|\bcredentials?\b/iu;
const SIGN_IN_ASKED = /\bauthentication required\b|\bunauthenticated\b|\bnot (?:logged|signed)[ -]?in\b|\b(?:sign|log)[ -]?in again\b|\bplease (?:sign|log)[ -]?in\b|\blogin expired\b|\bplease re-?authenticate\b|\bre-?authentication required\b|\binvalid_grant\b|\b(?:credentials?|token) (?:has been |have been |was |were )?revoked\b/iu;
const UNREACHABLE = /\bnetwork\b|\bunreachable\b|\boffline\b|\bgetaddrinfo\b|\benotfound\b|\beai_again\b/iu;

/** -32000 is ACP's `auth_required`, but an agent may reuse it for other failures, a sign-in service it cannot reach
 * among them. Words that ask for a sign-in decide; words that only mention one do unless the failure is one that passes.
 * The native CLI answers `authenticate` with -32603 "No browser is available here" when it has no sign-in and no display. */
export function antigravitySignInError(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown; data?: any } | null;
  if (value?.code === -32603 && typeof value.message === "string" && value.message.startsWith("No browser is available here")) return true;
  if (value?.code !== -32000) return false;
  const data = value.data;
  const bounded = (fields: unknown[]) => fields.filter((field): field is string => typeof field === "string").map((field) => field.slice(0, 2_000)).join(" ");
  const reason = bounded([acpVendorMessage(error) ?? value.message, ...(typeof data === "string" ? [data] : [data?.details, data?.message, data?.reason, data?.error?.message])]);
  const whole = `${reason} ${bounded([data && typeof data === "object" ? JSON.stringify(data) : undefined])}`;
  if (SIGN_IN_ASKED.test(whole)) return true;
  return SIGN_IN_WORDS.test(whole) && !UNREACHABLE.test(reason) && !classifyError({ text: reason }).transient;
}

const managedAsset = resolveAntigravityReleaseAsset();
const runtimeProcesses = new AntigravityProcesses();
/** Every model id an account here has been offered, beside the bundled catalog's. */
const offeredModels = new Set<string>();
/** The runtime each instance's turns were last started on, known before it answers initialize. */
const launched = new Map<string, { version: string | null; nativeCli: boolean }>();

const nativeSignIn = new NativeSignInCache();
const loginProcesses = new Map<string, LoginProcesses>();
/** While an account's native sign-in is being removed, no native process of that account starts: it would hold the old
 * sign-in, and could write it back. Each account's is its own (antigravity-acp.ts starts the CLI so it keeps one per
 * profile). */
const nativeSigningOut = new Map<string, Promise<void>>();
const nativeSignOutDone = async (instanceId: string) => {
  for (let running = nativeSigningOut.get(instanceId); running; running = nativeSigningOut.get(instanceId)) await running.catch(() => {});
};

/** A native process of an account whose sign-in is being removed was let in before that began: it is ended at once,
 * before it can use or write back the old sign-in. */
function trackNative(instanceId: string, child: ChildProcess): void {
  runtimeProcesses.track(instanceId, child);
  if (nativeSigningOut.has(instanceId)) void killCliTree(child).catch(() => false);
}
const tracked = (instanceId: string) => (child: ChildProcess) => trackNative(instanceId, child);

const nativeRuntimeKey = (runtime: AntigravityRuntime) => `${runtime.executablePath}\0${runtime.version}`;

/** Whether the native CLI accepts a session for this instance, as last learned. Throws when the CLI could not say: that
 * is not "signed out". */
async function nativeSignedIn(instanceId: string, runtime: AntigravityRuntime, profile: AntigravityProfile): Promise<boolean> {
  await nativeSignOutDone(instanceId);
  return await nativeSignIn.state(instanceId, nativeRuntimeKey(runtime), () => antigravityCliSignIn(runtime, profile, { onProcess: tracked(instanceId) })) === "in";
}

/** Model discovery's failure as the shared catalog classifies it: a refused session is "signedOut", a slow CLI "timedOut". */
function nativeDiscoveryError(instanceId: string, error: unknown): unknown {
  if (antigravityCliRefusedSession(error)) {
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
  // The packaged runtime unpacks and loads a ~1 GB Python bundle before it answers initialize (STARTUP_TIMEOUT_MS).
  coldStartCost: "expensive",
  // The startup model read is a second runtime process and a thinking-level survey: a saved list stands in for it.
  modelListStandsIn: true,
  sessionSetupTimeoutMs: ANTIGRAVITY_SESSION_SETUP_TIMEOUT_MS,
  stderrFailure: {
    line: ANTIGRAVITY_HARNESS_FAILURE_LOG,
    message: "Antigravity's local agent connection failed. Send the message again to continue in a fresh Antigravity process.",
  },
  clientFileSystem: true,
  clientReadRoots: (turn) => (turn.skillFiles ?? []).map(dirname),
  sanitizeToolPayload: true,
  updateFilter: antigravityUpdateFilter,

  resolveCommand: async (env, config, instanceId) => {
    const runtime = await resolveAntigravityRuntime(config.cli, env);
    if (runtime.harnessPath === null) await nativeSignOutDone(instanceId);
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
    if (runtime.harnessPath === null) await nativeSignOutDone(instanceId);
    const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
    const native = runtime.harnessPath === null;
    if (!native && !(await antigravityProfileAuthenticated(profile))) throw new Error(support.loginNote);
    const accepted = native ? nativeSignIn.seen(instanceId, nativeRuntimeKey(runtime)) : undefined;
    const catalog = await probeAntigravityModels({
      runtime,
      profile,
      fallbackDefault: currentEngineCatalog("antigravity").default,
      ...(native ? { onProcess: tracked(instanceId) } : {}),
    }).catch((error: unknown) => { throw native ? nativeDiscoveryError(instanceId, error) : error; });
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
      nativeSignIn.forget(instanceId);
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
  allowsAlone: (instanceId, turn, toolCall) => launched.get(instanceId)?.nativeCli === true
    && (turn.approvalModeNow?.() ?? turn.approvalMode) === "edits" && acpFileEditWithin(toolCall, turn.cwd),
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
        const account = authenticated ? await antigravityAccount(antigravityCliTokenPath(instanceId)) : undefined;
        return { state: "available", version: runtime.version, nativeCli: true, ...(authenticated === undefined ? {} : { authenticated }), ...(account ? { account } : {}) };
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

  configureSession: async ({ request, sessionId, instanceId, config, turn, configOptions, applied }) => {
    const nativeCli = launched.get(instanceId)?.nativeCli === true;
    if (!Array.isArray(configOptions) || !configOptions.some(option => option?.id === "mode")) {
      // The native CLI answers by the turn's level only in `default`; with no mode to confirm, nothing says it is there.
      if (nativeCli) throw new Error("Antigravity did not report its permission mode.");
      return;
    }
    const level = antigravityPermissionMode(config.fullAuto, turn.approvalMode);
    const wanted = nativeCli ? antigravityCliSessionMode(level) : level;
    // A mode this live session confirmed, and still reports, is not sent again.
    if (applied?.holds("mode", wanted, reportedConfigValue(configOptions, "mode"))) return;
    const result = await request("session/set_config_option", {
      sessionId,
      configId: "mode",
      value: wanted,
    });
    const mode = Array.isArray(result?.configOptions)
      ? result.configOptions.find((option: any) => option?.id === "mode")?.currentValue
      : undefined;
    if (mode !== wanted) throw (applied?.clear(), new Error(`Antigravity did not apply ${wanted} permission mode.`));
    applied?.accepted("mode", wanted);
  },
};

const AcpAntigravityDriver = createAcpDriver(support);

export const AntigravityDriver: ProviderDriver<AcpConfig> = {
  ...AcpAntigravityDriver,
  metadata: { ...AcpAntigravityDriver.metadata, signInAccount: "Google" },
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
        nativeSignIn.forget(input.instanceId);
        void base.refreshModels?.();
      },
      confirm: async () => {
        await nativeSignOutDone(input.instanceId);
        const { runtime, profile } = await runtimeAndProfile();
        return (await antigravityCliSignIn(runtime, profile, { onProcess: tracked(input.instanceId) })) === "in";
      },
    }, {}, alive);
    const runtimeAndProfileUnlessNativeFails = () => runtimeAndProfile().catch(async (error: unknown) => {
      if (await antigravityPathRunsNativeCli(input.config.cli, environmentNow())) throw error;
      return null;
    });
    let nativeFlow = false;
    /** Starting a sign-in and signing out never overlap: a sign-in begun while the sign-in is being removed would be
     * removed with it, or put it back. */
    let exclusive: Promise<unknown> = Promise.resolve();
    const alone = <T>(work: () => Promise<T>): Promise<T> => {
      const run = exclusive.then(work, work);
      exclusive = run.catch(() => {});
      return run;
    };
    /** Signs this account out of the native CLI, which keeps its sign-in in this account's profile alone. Throws, keeping
     * the sign-in, when the CLI still accepts a session or cannot say. */
    const signOutNative = async (runtime: AntigravityRuntime, profile: AntigravityProfile) => {
      let done!: () => void;
      nativeSigningOut.set(input.instanceId, new Promise<void>((resolveDone) => { done = resolveDone; }));
      try {
        // A process still running keeps the account it started with, and may write it back when it refreshes it.
        if (!(await runtimeProcesses.stopped(input.instanceId)) || runtimeProcesses.count(input.instanceId)) {
          throw new Error("Antigravity is still running and could not be stopped. Try again.");
        }
        nativeSignIn.forget(input.instanceId);
        await signOutAntigravityCli(runtime, profile, { onProcess: (child) => runtimeProcesses.track(input.instanceId, child) });
      } finally {
        nativeSignIn.forget(input.instanceId);
        nativeSigningOut.delete(input.instanceId);
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
        // The engine updater (or another account's card) is installing a runtime here now.
        if (snapshot.state === "unavailable" && antigravityInstallRunning()) return { ...snapshot, installing: true };
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
        if (!(await login.cancel())) throw new Error("The Antigravity sign-in in progress could not be stopped. Try again.");
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
        const current = await runtimeAndProfileUnlessNativeFails();
        if (current?.runtime.harnessPath === null) return await signOutNative(current.runtime, current.profile);
        await removeAntigravitySignIn(input.instanceId);
        if (!runtimeProcesses.count(input.instanceId)) return;
        signingOut = runtimeProcesses.stopped(input.instanceId)
          .then((gone) => {
            if (!gone) console.warn("antigravity: a runtime process outlived its kill; its sign-in is removed again, but it may write it back");
            return removeAntigravitySignIn(input.instanceId);
          })
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
