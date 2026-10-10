// A focused setup card shared by onboarding, the model picker, and runtime
// errors. The command has one inline copy action and one primary next step;
// unusable model lists stay out of the way until the engine is ready.
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, Download, ExternalLink, KeyRound, Loader2, LogIn, TerminalSquare, X } from "lucide-react";
import { api, type EngineInstall, type InstanceInfo, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { copyText } from "@/lib/copy-text";
import { DEVICE_SIGN_IN_COPY, DeviceSignIn, deviceSignInProvider } from "./DeviceSignIn";
import { ClaudeSignIn } from "./ClaudeSignIn";

type Platform = "darwin" | "win32" | "linux";

function hostPlatform(): Platform {
  const platform = window.ogb?.platform;
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  const userAgent = navigator.userAgent;
  if (userAgent.includes("Mac")) return "darwin";
  if (userAgent.includes("Win")) return "win32";
  return "linux";
}

/** The install command for this machine, or null when the engine has none
 * here (a GUI download, or a POSIX-only installer viewed on Windows). */
export function installCommandFor(install: EngineInstall | undefined): string | null {
  return install?.command?.[hostPlatform()] ?? null;
}

/** Installed but missing the cloud account session. */
export function needsSignIn(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state === "available" && instance.snapshot.authenticated === false;
}

/** The card EngineSetup shows for this engine is its sign-in — not an API
 * key row, an install, or a note that it cannot be set up here. A caller
 * that words a line around that card (a failed turn's headline) asks this,
 * so the line and the card never disagree. */
export function offersSignIn(instance: InstanceInfo | undefined): boolean {
  return Boolean(instance && needsSignIn(instance) && instance.install
    && !instance.snapshot.authenticationUnavailableReason && !apiKeySetup(instance));
}

/** The engine needs setup; unavailable does not prove its CLI is absent.
 * Local-model injection still requires an available engine, but no cloud sign-in. */
export function needsCli(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state !== "available";
}

/** A terminal opened from this page runs on the machine the server runs on:
 * the desktop app's own window on its own server. Never a browser, a paired
 * remote client, or My Cloud, where a terminal command is a dead end. */
export function serverTerminal(cloudHome: boolean): boolean {
  return Boolean(window.ogb?.openInstallTerminal) && window.ogb?.remoteClient?.active !== true && !cloudHome;
}

/** Grok Build cannot run here (no Grok CLI on this server, an older Cloud
 * computer image for one) and nobody here can install it. Its models are
 * still an xAI API key away, so the card says that instead of handing over
 * an install command that cannot run. */
export function grokKeyInstead(instance: InstanceInfo, cloudHome: boolean): boolean {
  return instance.driverKind === "grokAgent" && needsCli(instance) && !serverTerminal(cloudHome);
}

export function CommandRow({
  command,
  actionLabel,
  compact = false,
}: {
  command: string;
  actionLabel: string;
  compact?: boolean;
}) {
  const [status, setStatus] = useState<"copied" | "failed" | "opened" | null>(null);
  const canOpen = typeof window !== "undefined" && Boolean(window.ogb?.openInstallTerminal);

  const settle = (next: "copied" | "failed" | "opened") => {
    setStatus(next);
    window.setTimeout(() => setStatus(null), 2200);
  };

  // The command remains selectable when clipboard access is blocked.
  const copy = async () => {
    const result = await copyText(command);
    if (result !== "empty") settle(result);
  };
  const copyIcon = (size: number) => status === "copied" ? <Check size={size} className="text-success" />
    : status === "failed" ? <X size={size} className="text-danger" /> : <Copy size={size} />;

  const openTerminal = async () => {
    const opened = await window.ogb!.openInstallTerminal!(command);
    settle(opened ? "opened" : "copied");
  };

  if (compact) {
    return (
      <div className="mt-2 flex min-w-0 items-center gap-1.5 rounded-lg border border-hairline/50 bg-app px-2 py-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-secondary" title={command}>
          {command}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={t("engineSetup.copyCommand")}
          title={t("engineSetup.copyCommand")}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-ink-secondary hover:bg-control hover:text-ink"
        >
          {copyIcon(12)}
          {t(status === "copied" ? "engineSetup.copied" : status === "failed" ? "common.copyFailed" : "engineSetup.copy")}
        </button>
        {canOpen && (
          <button
            type="button"
            onClick={() => void openTerminal()}
            aria-label={actionLabel}
            title={actionLabel}
            className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-semibold text-white hover:brightness-110"
          >
            {status === "opened" ? <Check size={12} /> : <TerminalSquare size={12} />}
            {status === "opened" ? t("engineSetup.opened") : t("engineSetup.terminal")}
          </button>
        )}
        <span aria-live="polite" className="sr-only">
          {status === "opened" ? t("engineSetup.openedHint") : ""}
        </span>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-hairline/50 bg-app px-2.5 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-secondary" title={command}>
          {command}
        </code>
        {canOpen && (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={t("engineSetup.copyCommand")}
            title={t("engineSetup.copyCommand")}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-medium text-ink-secondary hover:bg-control hover:text-ink"
          >
            {copyIcon(12)}
            {t(status === "copied" ? "engineSetup.copied" : status === "failed" ? "common.copyFailed" : "engineSetup.copy")}
          </button>
        )}
      </div>

      {canOpen ? (
        <>
          <button
            type="button"
            onClick={() => void openTerminal()}
            className="mt-2 flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110"
          >
            {status === "opened" ? <Check size={14} /> : <TerminalSquare size={14} />}
            {status === "opened" ? t("engineSetup.terminalOpened") : actionLabel}
          </button>
          <p aria-live="polite" className="mt-1.5 text-center text-[11px] text-ink-tertiary">
            {status === "opened" ? t("engineSetup.pasteHint") : t("engineSetup.copyOnOpenHint")}
          </p>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void copy()}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[12.5px] font-semibold text-ink hover:bg-raised-hover"
        >
          {copyIcon(14)}
          {t(status === "copied" ? "engineSetup.commandCopied" : status === "failed" ? "common.copyFailed" : "engineSetup.copyCommand")}
        </button>
      )}
    </div>
  );
}

/** One click installs or updates the engine on the machine running the
 * server, as the server's own user, into the app's own folder. The terminal
 * command stays behind a disclosure for people who prefer it. */
function ServerEngineInstall({ instance, mode, command }: { instance: InstanceInfo; mode: "install" | "update"; command: string | null }) {
  const { refreshInstances, refreshModels } = useStore();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setDone(false);
    setError(null);
    try {
      await api(`/api/instances/${encodeURIComponent(instance.instanceId)}/install`, { method: "POST" });
      setDone(true);
      // The install has happened even if the status refresh fails.
      await refreshInstances().catch(() => {});
      await refreshModels(instance.instanceId).catch(() => {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:cursor-wait disabled:opacity-70"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        {busy
          ? t("engineSetup.serverInstalling")
          : t(mode === "update" ? "engineSetup.serverUpdate" : "engineSetup.serverInstall", { name: instance.displayName })}
      </button>
      {done && !busy && <p role="status" className="text-center text-[11px] text-success">{t("engineSetup.serverInstalled")}</p>}
      {error && <p role="alert" className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-danger">{error}</p>}
      {command && (
        <details className="rounded-lg border border-hairline/50 bg-app px-2.5 py-2 text-[11.5px] text-ink-secondary">
          <summary className="cursor-pointer select-none">{t("engineSetup.preferTerminal")}</summary>
          <CommandRow command={command} actionLabel={t(mode === "update" ? "engineSetup.openUpdate" : "engineSetup.openInstall")} compact />
        </details>
      )}
    </div>
  );
}

export function EngineUpdateNotice({
  update,
  instance,
  className,
}: {
  update: NonNullable<InstanceInfo["snapshot"]["update"]>;
  /** When given and the server can update this engine itself, the notice
   * offers a button instead of a terminal command. */
  instance?: InstanceInfo;
  className?: string;
}) {
  return (
    <div
      data-engine-update-notice
      className={cn("rounded-xl border border-warning/25 bg-warning/5 p-2.5", className)}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-ink">{update.title}</div>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">{update.message}</p>
        </div>
      </div>
      {instance?.install?.server
        ? <ServerEngineInstall instance={instance} mode="update" command={update.command} />
        : <CommandRow command={update.command} actionLabel={t("engineSetup.openUpdate")} compact />}
    </div>
  );
}

/** Like the update notice, minus the command: there is nothing to run, only
 * something to know — the message says what and where to change it. */
export function EngineWarningNotice({
  warning,
  className,
}: {
  warning: NonNullable<InstanceInfo["snapshot"]["warning"]>;
  className?: string;
}) {
  return (
    <div
      data-engine-warning-notice
      className={cn("rounded-xl border border-warning/25 bg-warning/5 p-2.5", className)}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold text-ink">{warning.title}</div>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">{warning.message}</p>
        </div>
      </div>
    </div>
  );
}

function ManagedEngineSetup({ instance, signInOnly }: { instance: InstanceInfo; signInOnly: boolean }) {
  const { refreshInstances, refreshModels } = useStore();
  const [busy, setBusy] = useState<"install" | "signin" | "complete" | "check" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flow, setFlow] = useState<{ flowId: string; authorizationUrl: string } | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const managed = instance.install!.managed!;

  useEffect(() => {
    if (!flow || instance.snapshot.authenticated) return;
    const timer = window.setInterval(() => void refreshInstances(), 2_000);
    return () => window.clearInterval(timer);
  }, [flow, instance.snapshot.authenticated, refreshInstances]);

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  };

  const install = () => run("install", async () => {
    try {
      await api(`/api/instances/${encodeURIComponent(instance.instanceId)}/install`, { method: "POST" });
    } finally {
      // Keep the latest setup reason without replacing the install error if
      // the status refresh also fails.
      await refreshInstances().catch(() => {});
    }
  });

  const signIn = () => run("signin", async () => {
    const { auth } = await api(`/api/instances/${encodeURIComponent(instance.instanceId)}/auth/start`, { method: "POST" });
    if (auth.phase === "succeeded") {
      await refreshInstances();
      await refreshModels(instance.instanceId);
      return;
    }
    if (!auth.flowId || !auth.authorizationUrl) throw new Error(t("engineSetup.googleNoLink"));
    setFlow({ flowId: auth.flowId, authorizationUrl: auth.authorizationUrl });
    if (window.ogb?.openExternal) await window.ogb.openExternal(auth.authorizationUrl);
    else window.open(auth.authorizationUrl, "_blank", "noopener,noreferrer");
  });

  const complete = () => run("complete", async () => {
    if (!flow) return;
    await api(`/api/instances/${encodeURIComponent(instance.instanceId)}/auth/complete`, {
      method: "POST",
      body: JSON.stringify({ flowId: flow.flowId, callbackUrl }),
    });
    setCallbackUrl("");
    await refreshInstances();
    await refreshModels(instance.instanceId);
  });

  const check = () => run("check", async () => {
    await refreshInstances();
    await refreshModels(instance.instanceId);
  });

  if (!signInOnly) {
    return (
      <div className="mt-3">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void install()}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:cursor-wait disabled:opacity-70"
        >
          {busy === "install" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {busy === "install" ? t("engineSetup.installing") : managed.label}
        </button>
        <p className="mt-1.5 text-center text-[11px] text-ink-tertiary">
          {t("engineSetup.downloadNote", { mb: Math.ceil(managed.downloadBytes / 1024 / 1024) })}
        </p>
        {error && <p className="mt-2 text-[11.5px] text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void signIn()}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:cursor-wait disabled:opacity-70"
      >
        {busy === "signin" ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
        {busy === "signin"
          ? t("engineSetup.startingGoogle")
          : flow
            ? t("engineSetup.openGoogleAgain")
            : t("engineSetup.signInGoogle")}
      </button>
      {busy === "signin" && <p role="status" className="text-[11.5px] text-ink-secondary">{t("engineSetup.antigravitySlow")}</p>}
      {flow && (
        <>
          <button type="button" onClick={() => void check()} className="w-full rounded-lg bg-control px-3 py-2 text-[12px] font-semibold text-ink hover:bg-raised-hover">
            {busy === "check" ? t("common.checking") : t("engineSetup.finishedSignIn")}
          </button>
          <details className="rounded-lg border border-hairline/50 bg-app px-2.5 py-2 text-[11.5px] text-ink-secondary">
            <summary className="cursor-pointer select-none">{t("engineSetup.otherComputer")}</summary>
            <p className="mt-2 leading-relaxed">{t("engineSetup.otherComputerHint")}</p>
            <input
              value={callbackUrl}
              onChange={(event) => setCallbackUrl(event.target.value)}
              placeholder="http://127.0.0.1:…/?code=…"
              className="mt-2 w-full rounded-md border border-hairline bg-inset px-2 py-1.5 text-[11px] text-ink outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={!callbackUrl.trim() || busy !== null}
              onClick={() => void complete()}
              className="mt-2 w-full rounded-md bg-control px-2 py-1.5 font-medium text-ink disabled:opacity-50"
            >
              {busy === "complete" ? t("engineSetup.sending") : t("engineSetup.sendRedirect")}
            </button>
          </details>
        </>
      )}
      {error && <p className="text-[11.5px] text-danger">{error}</p>}
    </div>
  );
}

/** Engines that run on a pasted API key. Their setup is the key row in
 * Settings → API keys, never a terminal command or a sign-in. Claude on the
 * workspace key still needs its CLI first, which the install card covers. */
export function isApiKeyEngine(instance: InstanceInfo | undefined): boolean {
  if (!instance || instance.access !== "api" || instance.managed) return false;
  return instance.driverKind !== "claudeAgent" || Boolean(instance.snapshot.version);
}

/** A key engine whose key is saved. A mistyped key counts too: it is only
 * found wrong when used or tested. */
export function hasSavedApiKey(instance: InstanceInfo): boolean {
  return isApiKeyEngine(instance) && instance.snapshot.authenticated === true;
}

/** Its setup is a key in Settings → API keys, and that is not done yet. */
function apiKeySetup(instance: InstanceInfo): boolean {
  return (isApiKeyEngine(instance) || instance.install?.settings === "connections") && !instance.snapshot.authenticationUnavailableReason
    && (instance.snapshot.state !== "available" || instance.snapshot.authenticated === false);
}

function GrokKeyInstead({ className, unframed }: { className?: string; unframed: boolean }) {
  const { dispatch } = useStore();
  const remote = window.ogb?.remoteClient?.active === true;
  return (
    <div data-engine-setup-key-instead className={cn(!unframed && "rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
          <KeyRound size={14} />
        </span>
        <p className="min-w-0 text-[12.5px] leading-relaxed text-ink">{t("engineSetup.grok.notInstalled")}</p>
      </div>
      {/* a remote client's Settings has no API keys to open (ApiKeyEngineSetup) */}
      {!remote && (
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}
          className="mt-3 flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-raised-hover"
        >
          <KeyRound size={13} aria-hidden="true" />
          {t("engineSetup.grok.addKey")}
        </button>
      )}
    </div>
  );
}

/** `configured`: the key is saved, so the card offers to change it instead.
 * A typo'd key still counts as saved, and this is the way back to fix it. */
function ApiKeyEngineSetup({ instance, className, unframed, configured = false }: { instance: InstanceInfo; className?: string; unframed: boolean; configured?: boolean }) {
  const { dispatch } = useStore();
  const remote = window.ogb?.remoteClient?.active === true;
  const copy = configured
    ? { title: "engineSetup.apiKey.configuredTitle", description: remote ? "engineSetup.apiKey.configuredRemote" : "engineSetup.apiKey.configuredDescription", action: "engineSetup.apiKey.change" } as const
    : { title: "engineSetup.apiKey.title", description: remote ? "engineSetup.apiKey.remote" : "engineSetup.apiKey.description", action: "engineSetup.apiKey.open" } as const;
  return (
    <div data-engine-setup-api-key={configured ? "configured" : ""} className={cn(!unframed && "rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
          <KeyRound size={14} />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{t(copy.title, { name: instance.displayName })}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t(copy.description)}</p>
        </div>
      </div>
      {/* a saved key the provider refused reads as installed but signed out */}
      {needsSignIn(instance) && (
        <p role="alert" className="mt-2 text-[12px] leading-relaxed text-danger">{t("engineSetup.apiKey.rejected")}</p>
      )}
      {!remote && (
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}
          className="mt-3 flex items-center gap-1.5 rounded-lg bg-raised px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-raised-hover"
        >
          <KeyRound size={13} aria-hidden="true" />
          {t(copy.action)}
        </button>
      )}
    </div>
  );
}

/** A ready engine that runs on a pasted key: name the key and link to where it
 * is replaced or cleared. Without this, saving any key (even a wrong one)
 * left Model providers with no way back to it. */
export function ApiKeyEngineManage({ instance, className }: { instance: InstanceInfo; className?: string }) {
  if (!hasSavedApiKey(instance)) return null;
  return <ApiKeyEngineSetup instance={instance} className={className} unframed={false} configured />;
}

export function EngineSetup({
  instance,
  className,
  intent = "cloud",
  unframed = false,
  description: descriptionOverride,
}: {
  instance: InstanceInfo;
  className?: string;
  /** `inject` installs the CLI but deliberately skips cloud sign-in. */
  intent?: "cloud" | "inject";
  /** The containing engine disclosure already supplies the card surface. */
  unframed?: boolean;
  /** Why this install is needed, when the caller knows better (a Company
   * model that runs this CLI with the organisation's access). */
  description?: string;
}) {
  const { state } = useStore();
  const cloudHome = state.config?.cloudHome === true;
  const install = instance.install;
  const installCommand = installCommandFor(install);
  const signInCommand = install?.signInCommand;
  const signInOnly = intent === "cloud" && needsSignIn(instance);
  const deviceSignIn = signInOnly && instance.authentication?.method === "device-code";
  const browserSignIn = signInOnly && instance.authentication?.method === "browser-pkce";
  const pasteSignIn = signInOnly && instance.authentication?.method === "paste-code";
  const provider = deviceSignInProvider(instance.driverKind);
  const command = signInOnly ? signInCommand : installCommand;
  const title = signInOnly
    ? t("engineSetup.signInTitle", { name: instance.displayName })
    : t("engineSetup.installTitle", { name: instance.displayName });
  const description = descriptionOverride ?? (signInOnly
    ? browserSignIn
      ? t("engineSetup.chatgpt.description")
      : deviceSignIn
      ? t(DEVICE_SIGN_IN_COPY[provider].description)
      : pasteSignIn
      ? t("engineSetup.claude.description")
      : install?.managed
      ? t("engineSetup.managedSignIn")
      : t("engineSetup.terminalSignIn")
    : intent === "inject"
      ? t("engineSetup.injectDesc")
      : install?.server
        ? t("engineSetup.serverInstallDesc")
      : install?.managed
        ? t("engineSetup.managedDesc")
      : signInCommand
        ? t("engineSetup.installDescSignIn")
        : t("engineSetup.installDesc"));

  if (apiKeySetup(instance)) {
    return <ApiKeyEngineSetup instance={instance} className={className} unframed={unframed} />;
  }

  if (intent === "cloud" && grokKeyInstead(instance, cloudHome)) {
    return <GrokKeyInstead className={className} unframed={unframed} />;
  }

  // Some engines are configured elsewhere (for example, a cloud computer
  // token) and intentionally have no install descriptor.
  if (!install || instance.snapshot.authenticationUnavailableReason) {
    return (
      <div className={cn(!unframed && "rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
        <div className="text-[13px] font-semibold text-ink">{t("engineSetup.notReady", { name: instance.displayName })}</div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {instance.snapshot.authenticationUnavailableReason ?? instance.snapshot.reason ?? t("engineSetup.noReason")}
        </p>
      </div>
    );
  }

  return (
    <div className={cn(!unframed && "rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-inset text-ink-secondary">
          {signInOnly ? <LogIn size={14} /> : <Download size={14} />}
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">{title}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{description}</p>
        </div>
      </div>

      {instance.snapshot.state === "unavailable" && instance.snapshot.reason && (
        <p role="alert" className="mt-2 text-[12px] leading-relaxed text-danger">
          {instance.snapshot.reason}
        </p>
      )}

      {deviceSignIn || browserSignIn ? (
        <>
          <DeviceSignIn key={instance.instanceId} instanceId={instance.instanceId} browserPkce={browserSignIn} provider={provider} />
          {/* Grok keeps its terminal sign-in for people who prefer one, where
              a terminal runs on this server; the code above needs none. */}
          {deviceSignIn && provider === "grok" && signInCommand && serverTerminal(cloudHome) && (
            <details className="mt-2 rounded-lg border border-hairline/50 bg-app px-2.5 py-2 text-[11.5px] text-ink-secondary">
              <summary className="cursor-pointer select-none">{t("engineSetup.preferTerminal")}</summary>
              <CommandRow command={signInCommand} actionLabel={t("engineSetup.openSignIn")} compact />
            </details>
          )}
        </>
      ) : pasteSignIn ? (
        <ClaudeSignIn key={instance.instanceId} instanceId={instance.instanceId} />
      ) : install.server && !signInOnly ? (
        <ServerEngineInstall instance={instance} mode="install" command={installCommand} />
      ) : install.managed ? (
        <ManagedEngineSetup instance={instance} signInOnly={signInOnly} />
      ) : command ? (
        <CommandRow
          command={command}
          actionLabel={signInOnly ? t("engineSetup.openSignIn") : t("engineSetup.openInstall")}
        />
      ) : (
        <p className="mt-3 rounded-lg bg-inset px-2.5 py-2 text-[12px] leading-relaxed text-ink-secondary">
          {t("engineSetup.noInstaller")}
        </p>
      )}

      {!signInOnly && install.needsNode && !install.server && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-tertiary">
          {/* the sentence is one catalog entry; {npm} marks where the code
              chip goes, so a translator can move it */}
          {t("engineSetup.needsNode").split("{npm}").flatMap((part, index) =>
            index === 0
              ? [part]
              : [<code key="npm" className="font-mono">npm</code>, part],
          )}
        </p>
      )}

      {install.docsUrl && (
        <a
          href={install.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2.5 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline"
        >
          <ExternalLink size={12} /> {t("engineSetup.viewGuide")}
        </a>
      )}
    </div>
  );
}
