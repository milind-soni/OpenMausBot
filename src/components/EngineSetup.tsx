// A focused setup card shared by onboarding, the model picker, and runtime
// errors. The command has one inline copy action and one primary next step;
// unusable model lists stay out of the way until the engine is ready.
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, Download, ExternalLink, Loader2, LogIn, TerminalSquare } from "lucide-react";
import { api, type EngineInstall, type InstanceInfo, useStore } from "@/state/store";
import { cn } from "@/lib/cn";

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
          aria-label="Copy command"
          title="Copy command"
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-ink-secondary hover:bg-control hover:text-ink"
        >
          {status === "copied" ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          {status === "copied" ? "Copied" : "Copy"}
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
            {status === "opened" ? "Opened" : "Terminal"}
          </button>
        )}
        <span aria-live="polite" className="sr-only">
          {status === "opened" ? "Terminal opened. Paste the command and press Enter." : ""}
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
            aria-label="Copy command"
            title="Copy command"
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-medium text-ink-secondary hover:bg-control hover:text-ink"
          >
            {status === "copied" ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            {status === "copied" ? "Copied" : "Copy"}
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
            {status === "opened" ? "Terminal opened" : actionLabel}
          </button>
          <p aria-live="polite" className="mt-1.5 text-center text-[11px] text-ink-secondary/70">
            {status === "opened" ? "Paste the command and press Enter." : "The command is copied when Terminal opens."}
          </p>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void copy()}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[12.5px] font-semibold text-ink hover:bg-raised-hover"
        >
          {status === "copied" ? <Check size={14} className="text-success" /> : <Copy size={14} />}
          {status === "copied" ? "Command copied" : "Copy command"}
        </button>
      )}
    </div>
  );
}

export function EngineUpdateNotice({
  update,
  className,
}: {
  update: NonNullable<InstanceInfo["snapshot"]["update"]>;
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
      <CommandRow command={update.command} actionLabel="Open update in Terminal" compact />
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
    if (!auth.flowId || !auth.authorizationUrl) throw new Error("Google sign-in did not return a link.");
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
          {busy === "install" ? "Downloading and verifying…" : managed.label}
        </button>
        <p className="mt-1.5 text-center text-[11px] text-ink-secondary/70">
          {Math.ceil(managed.downloadBytes / 1024 / 1024)} MB download from Google. OpenMausBot verifies it before use.
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
        {busy === "signin" ? "Starting Google sign-in…" : flow ? "Open Google sign-in again" : "Sign in with Google"}
      </button>
      {busy === "signin" && <p role="status" className="text-[11.5px] text-ink-secondary">Starting Antigravity can take up to 90 seconds. Your browser will open when it’s ready.</p>}
      {flow && (
        <>
          <button type="button" onClick={() => void check()} className="w-full rounded-lg bg-control px-3 py-2 text-[12px] font-semibold text-ink hover:bg-raised-hover">
            {busy === "check" ? "Checking…" : "I finished signing in"}
          </button>
          <details className="rounded-lg border border-hairline/50 bg-app px-2.5 py-2 text-[11.5px] text-ink-secondary">
            <summary className="cursor-pointer select-none">Signing in from another computer?</summary>
            <p className="mt-2 leading-relaxed">After Google redirects to a page that cannot load, paste that page’s complete URL here.</p>
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
              {busy === "complete" ? "Sending…" : "Send redirect to server"}
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
}: {
  instance: InstanceInfo;
  className?: string;
  /** `inject` installs the CLI but deliberately skips cloud sign-in. */
  intent?: "cloud" | "inject";
}) {
  const install = instance.install;
  const installCommand = installCommandFor(install);
  const signInCommand = install?.signInCommand;
  const signInOnly = intent === "cloud" && needsSignIn(instance);
  const command = signInOnly ? signInCommand : installCommand;
  const title = signInOnly ? `Sign in to ${instance.displayName}` : `Install ${instance.displayName}`;
  const description = signInOnly
    ? install?.managed
      ? "Each Antigravity engine has its own Google account. Your browser completes the secure sign-in."
      : "Finish the account sign-in in Terminal. Reopen this menu afterward and we’ll check again."
    : intent === "inject"
      ? "Install the agent once, then you can run it with local models—no cloud sign-in required."
      : install?.managed
        ? "OpenMausBot installs its own verified Antigravity runtime. It is separate from the Antigravity app and agy CLI; install it here, sign in with Google, and this model list will refresh from your account."
      : `Install the command-line app once. Models will appear here as soon as it’s ready${signInCommand ? "; sign-in may follow" : ""}.`;

  // Some engines are configured elsewhere (for example, a cloud computer
  // token) and intentionally have no install descriptor.
  if (!install) {
    return (
      <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
        <div className="text-[13px] font-semibold text-ink">{instance.displayName} isn’t ready</div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {instance.snapshot.reason ?? "This engine is not available on this machine."}
        </p>
      </div>
    );
  }

  return (
    <div className={cn("rounded-xl border border-hairline/40 bg-control/30 p-3", className)}>
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

      {install.managed ? (
        <ManagedEngineSetup instance={instance} signInOnly={signInOnly} />
      ) : command ? (
        <CommandRow command={command} actionLabel={signInOnly ? "Open sign-in in Terminal" : "Open install in Terminal"} />
      ) : (
        <p className="mt-3 rounded-lg bg-inset px-2.5 py-2 text-[12px] leading-relaxed text-ink-secondary">
          There isn’t a one-line installer for this platform. Use the setup guide below.
        </p>
      )}

      {!signInOnly && install.needsNode && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary/70">
          Requires Node.js and <code className="font-mono">npm</code>.
        </p>
      )}

      {install.docsUrl && (
        <a
          href={install.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2.5 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline"
        >
          <ExternalLink size={12} /> View setup guide
        </a>
      )}
    </div>
  );
}
