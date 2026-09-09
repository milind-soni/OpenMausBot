// A focused setup card shared by onboarding, the model picker, and runtime
// errors. The command has one inline copy action and one primary next step;
// unusable model lists stay out of the way until the engine is ready.
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, Download, ExternalLink, Loader2, LogIn, TerminalSquare } from "lucide-react";
import { api, type EngineInstall, type InstanceInfo, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { CodexDeviceSignIn } from "./CodexDeviceSignIn";
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

/** The engine needs setup; unavailable does not prove its CLI is absent.
 * Local-model injection still requires an available engine, but no cloud sign-in. */
export function needsCli(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state !== "available";
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
  const [status, setStatus] = useState<"copied" | "opened" | null>(null);
  const canOpen = typeof window !== "undefined" && Boolean(window.ogb?.openInstallTerminal);

  const settle = (next: "copied" | "opened") => {
    setStatus(next);
    window.setTimeout(() => setStatus(null), 2200);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      settle("copied");
    } catch {
      // The command remains selectable when clipboard access is blocked.
    }
  };

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
          {status === "copied" ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          {status === "copied" ? t("engineSetup.copied") : t("engineSetup.copy")}
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
            {status === "copied" ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            {status === "copied" ? t("engineSetup.copied") : t("engineSetup.copy")}
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
          <p aria-live="polite" className="mt-1.5 text-center text-[11px] text-ink-secondary/70">
            {status === "opened" ? t("engineSetup.pasteHint") : t("engineSetup.copyOnOpenHint")}
          </p>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void copy()}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[12.5px] font-semibold text-ink hover:bg-raised-hover"
        >
          {status === "copied" ? <Check size={14} className="text-success" /> : <Copy size={14} />}
          {status === "copied" ? t("engineSetup.commandCopied") : t("engineSetup.copyCommand")}
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
        <p className="mt-1.5 text-center text-[11px] text-ink-secondary/70">
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

export function EngineSetup({
  instance,
  className,
  intent = "cloud",
  unframed = false,
}: {
  instance: InstanceInfo;
  className?: string;
  /** `inject` installs the CLI but deliberately skips cloud sign-in. */
  intent?: "cloud" | "inject";
  /** The containing engine disclosure already supplies the card surface. */
  unframed?: boolean;
}) {
  const install = instance.install;
  const installCommand = installCommandFor(install);
  const signInCommand = install?.signInCommand;
  const signInOnly = intent === "cloud" && needsSignIn(instance);
  const deviceSignIn = signInOnly && instance.authentication?.method === "device-code";
  const pasteSignIn = signInOnly && instance.authentication?.method === "paste-code";
  const command = signInOnly ? signInCommand : installCommand;
  const title = signInOnly
    ? t("engineSetup.signInTitle", { name: instance.displayName })
    : t("engineSetup.installTitle", { name: instance.displayName });
  const description = signInOnly
    ? deviceSignIn
      ? t("engineSetup.device.description")
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
        : t("engineSetup.installDesc");

  // Some engines are configured elsewhere (for example, a cloud computer
  // token) and intentionally have no install descriptor.
  if (!install) {
    return (
      <div className={cn(!unframed && "rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
        <div className="text-[13px] font-semibold text-ink">{t("engineSetup.notReady", { name: instance.displayName })}</div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {instance.snapshot.reason ?? t("engineSetup.noReason")}
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

      {deviceSignIn ? (
        <CodexDeviceSignIn key={instance.instanceId} instanceId={instance.instanceId} />
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
        <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary/70">
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
