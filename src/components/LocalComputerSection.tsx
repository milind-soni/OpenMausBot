// One-place setup for the isolated Local VM image and its shared/per-bot policy.
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Circle,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { Card, CommandLine } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n-context";

type Action = "pull" | "run" | "start" | "stop" | "remove" | "recreate";

interface Status {
  platform: string;
  runtime: string | null;
  available: string[];
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  workspace_path: string;
  workspace_guest_path: string;
  viewer_url: string;
  idle_timeout_ms: number;
  mode: "shared" | "per-bot";
  max_instances: number;
  commands: {
    install: string | null;
    runtimeStart: string | null;
    pull: string | null;
    run: string | null;
    start: string | null;
    stop: string | null;
    remove: string | null;
    view: string;
  };
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]",
          done ? "bg-success/20 text-success" : "border border-hairline/50 text-ink-secondary",
        )}
      >
        {done ? <Check size={12} /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn("text-[14px]", done ? "text-ink-secondary line-through" : "text-ink")}>{title}</div>
        {!done && children && <div className="mt-2 flex flex-col items-start gap-2">{children}</div>}
      </div>
    </div>
  );
}

function ActionButton({
  action,
  pending,
  children,
  onClick,
  danger = false,
}: {
  action: Action;
  pending: Action | null;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={pending !== null}
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-50",
        danger ? "bg-danger/15 text-danger hover:bg-danger/20" : "bg-accent text-white hover:brightness-110",
      )}
    >
      {pending === action && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

export function LocalComputerSection() {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [policyPending, setPolicyPending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/local-computer", { signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? t("Status request failed ({status})", { status: response.status }));
    setStatus(body as Status);
    setError(null);
  }, [t]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController();
      try {
        await refresh(controller.signal);
      } catch (e) {
        if (active && !(e instanceof DOMException && e.name === "AbortError")) {
          setStatus(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (active) {
          setLoading(false);
          timer = window.setTimeout(() => void poll(), 5000);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh, refreshKey]);

  const post = async (action: Exclude<Action, "recreate">) => {
    const response = await fetch(`/api/local-computer/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `${action} failed`);
    setStatus(body as Status);
  };

  const act = async (action: Action) => {
    if (
      action === "remove" &&
      !window.confirm(t("Delete the Local VM? Files and browser sign-ins in its durable workspace will remain."))
    ) return;
    if (
      action === "recreate" &&
      !window.confirm(t("Replace the existing Local VM with the pinned image and safety limits? Files and browser sign-ins in its durable workspace will remain."))
    ) return;
    setPending(action);
    setError(null);
    try {
      if (action === "recreate") {
        await post("remove");
        await post("run");
      } else {
        await post(action);
      }
      // The desktop starts after the container process; keep the progress
      // state honest and let the regular poll mark it Ready a few seconds on.
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const savePolicy = async (mode: Status["mode"], maxInstances: number) => {
    setPolicyPending(true);
    setError(null);
    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localVm: { mode, maxInstances } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? t("Could not save the Local VM isolation policy"));
      setStatus((current) => current ? { ...current, mode, max_instances: maxInstances } : current);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolicyPending(false);
    }
  };

  const c = status?.commands;
  const ready = status?.ready === true;
  const existing = status?.container !== "missing";
  const needsRecreate = Boolean(
    existing &&
      (status?.container === "stopped" ||
        !status?.imageMatches ||
        !status?.managed ||
        status?.network === "unsafe" ||
        status?.security === "unsafe" ||
        status?.persistence === "unsafe"),
  );
  const unavailable = !loading && !status;
  const host = status?.platform === "darwin" ? "Mac" : t("computer");
  const perBot = status?.mode === "per-bot";
  const perBotRuntimeUnsupported = perBot && status?.runtime === "container";
  const headerReady = perBot ? Boolean(status?.daemonUp && status?.image && !perBotRuntimeUnsupported) : ready;

  return (
    <>
      <Card
        title={t("Local VM")}
        subtitle={perBot
          ? t("Private Cua Linux desktops on this {host}, with one container and durable workspace per bot. Distinct bots can work concurrently and idle desktops stop after 8 hours.", { host })
          : t("A shared Cua Linux sandbox on this {host} for bots to browse and work in — isolated, backed by one durable workspace, and automatically recycled after 8 hours without activity.", { host })}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px]",
              headerReady ? "bg-success/15 text-success" : "bg-control text-ink-secondary",
            )}
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : headerReady ? <Check size={12} /> : <Circle size={9} />}
            {loading
              ? "Checking…"
              : unavailable
                ? t("Status unavailable")
                : perBot && headerReady
                  ? t("Ready for per-bot desktops")
                  : perBotRuntimeUnsupported
                    ? t("Per-bot mode requires Docker or Podman")
                  : ready
                    ? t("Ready")
                    : (status?.problem ? t(status.problem) : t("Not ready"))}
          </span>
          <button
            onClick={() => {
              setLoading(true);
              setRefreshKey((key) => key + 1);
            }}
            disabled={loading || pending !== null}
            className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
          >
            <RefreshCw size={12} /> {t("Re-check")}
          </button>
          {ready && !perBot && (
            <a
              href={status?.viewer_url ?? c?.view}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink hover:bg-control"
            >
              <ExternalLink size={12} /> {t("Watch screen")}
            </a>
          )}
        </div>
        {error && <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
      </Card>

      <Card
        title={t("Isolation")}
        subtitle={t("Shared keeps the original single-desktop behavior. Per bot gives each bot its own container, workspace, viewer port, lease, and idle timer.")}
      >
        <div className="flex overflow-hidden rounded-lg border border-hairline/40">
          {(["shared", "per-bot"] as const).map((mode, index) => (
            <button
              key={mode}
              type="button"
              disabled={!status || policyPending}
              onClick={() => void savePolicy(mode, status?.max_instances ?? 2)}
              className={cn(
                "flex-1 px-3 py-2 text-[13px] disabled:opacity-50",
                index > 0 && "border-l border-hairline/40",
                status?.mode === mode ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              {mode === "shared" ? t("Shared") : t("Per bot")}
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] text-ink">{t("Maximum per-bot desktops")}</div>
            <div className="text-[11.5px] text-ink-secondary">{t("Limits storage and host resource use; each running desktop may use up to 4 GB and 2 CPUs.")}</div>
          </div>
          <select
            aria-label={t("Maximum per-bot desktops")}
            value={status?.max_instances ?? 2}
            disabled={!status || policyPending}
            onChange={(event) => void savePolicy(status?.mode ?? "shared", Number(event.target.value))}
            className="rounded-lg border border-hairline/40 bg-control px-2.5 py-1.5 text-[13px] text-ink disabled:opacity-50"
          >
            {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        {policyPending && <div className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-secondary"><Loader2 size={12} className="animate-spin" /> {t("Saving…")}</div>}
      </Card>

      <Card title={t("Setup")} subtitle={t("Once a container runtime is open, OpenMausBot prepares Cua and the VM for you.")}>
        <div className="flex flex-col gap-4">
          <Step n={1} title={t("Install a container runtime")} done={Boolean(status?.runtime)}>
            <div className="text-[13px] leading-relaxed text-ink-secondary">
              {t("Podman and Colima are free. Docker Desktop may require a paid licence for larger companies and government use.")}
            </div>
            {c?.install ? (
              <CommandLine command={c.install} />
            ) : (
              <a href="https://podman.io/docs/installation" target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">
                {t("Open the Podman installation guide")}
              </a>
            )}
          </Step>

          <Step
            n={2}
            title={status?.runtime && !status.daemonUp ? t("Open and start {runtime}", { runtime: status.runtime }) : t("Start the container runtime")}
            done={Boolean(status?.daemonUp)}
          >
            {!status?.runtime ? null : c?.runtimeStart ? (
              <CommandLine command={c.runtimeStart} />
            ) : (
              <div className="text-[13px] text-ink-secondary">{t("Open the installed runtime and start its engine, then re-check.")}</div>
            )}
          </Step>

          <Step n={3} title={t("Prepare the Cua desktop (one-time download and build)")} done={Boolean(status?.image)}>
            {status?.daemonUp && (
              <ActionButton action="pull" pending={pending} onClick={() => void act("pull")}>{t("Prepare Cua desktop")}</ActionButton>
            )}
            {c?.pull && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">{t("Show base-image download")}</summary><div className="mt-2"><CommandLine command={c.pull} /></div></details>}
          </Step>

          <Step
            n={4}
            title={perBot ? t("Create a private desktop from each bot's Computer panel") : needsRecreate ? t("Replace the older or unsafe VM") : t("Create and start the Local VM")}
            done={!perBot && ready}
          >
            {perBot ? (
              <div className="text-[13px] leading-relaxed text-ink-secondary">
                {perBotRuntimeUnsupported
                  ? t("Apple container requires an explicit host port, so OpenMausBot will not guess or expose one. Install or start Docker or Podman for safe per-bot dynamic loopback ports.")
                  : <>
                      {t("Choose Local VM for a bot, open that bot's Computer panel, then create its desktop there. OpenMausBot assigns a private workspace and an available loopback viewer port automatically.")}
                    </>}
              </div>
            ) : needsRecreate ? (
              <>
                <div className="flex gap-2 text-[13px] text-warning">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span>{status?.problem ? t(status.problem) : null}</span>
                </div>
                {status?.image ? (
                  <ActionButton action="recreate" pending={pending} onClick={() => void act("recreate")} danger>
                    <RotateCcw size={13} /> {t("Delete and recreate")}
                  </ActionButton>
                ) : (
                  <div className="text-[13px] text-ink-secondary">{t("Prepare the pinned Cua desktop above before replacing this VM.")}</div>
                )}
              </>
            ) : status?.container === "stopped" ? (
              <ActionButton action="start" pending={pending} onClick={() => void act("start")}>{t("Start Local VM")}</ActionButton>
            ) : status?.container === "running" ? (
              <div className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={13} className="animate-spin" /> {t("Waiting for the desktop…")}</div>
            ) : status?.image ? (
              <ActionButton action="run" pending={pending} onClick={() => void act("run")}>{t("Create Local VM")}</ActionButton>
            ) : null}
            {c?.run && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">{t("Show command")}</summary><div className="mt-2"><CommandLine command={c.run} /></div></details>}
          </Step>
        </div>
      </Card>

      {unavailable && (
        <Card>
          <div className="flex gap-2 text-[13px] text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>{t("OpenMausBot could not inspect the container runtime. Re-check, or review the app logs.")}</span>
          </div>
        </Card>
      )}

      <Card
        title={t("Safety and storage")}
        subtitle={perBot
          ? t("Cua Driver operates only each VM's desktop. Every bot gets a private host folder mounted at {path}; its files and browser profile survive VM replacement. Viewers bind only to loopback, and exact bot-derived targets prevent one bot from attaching to another bot's container. Each VM keeps the existing 4 GB, 2 CPU, 512-process and dropped-capability limits. VMs can still reach the internet.", { path: status?.workspace_guest_path ?? "/home/cua/workspace" })
          : t("Cua Driver operates only the VM's desktop. Exactly one private host folder is mounted at {path}; files and browser sign-ins there survive VM replacement, while everything elsewhere in the VM remains disposable. The password-protected viewer is available only on this machine. Docker and Podman runs are limited to 4 GB memory, 2 CPUs and 512 processes; all Linux capabilities are dropped except the two the desktop supervisor needs to switch to its unprivileged user. The VM can still reach the internet, and bots share it one at a time.", { path: status?.workspace_guest_path ?? "/home/cua/workspace" })}
      >
        {existing && (
          <div className="flex flex-wrap gap-2">
            {status?.container === "running" && (
              <ActionButton action="stop" pending={pending} onClick={() => void act("stop")}>
                <Square size={12} /> {t("Stop")}
              </ActionButton>
            )}
            <ActionButton action="remove" pending={pending} onClick={() => void act("remove")} danger>
              <Trash2 size={12} /> {perBot ? t("Delete legacy shared VM") : t("Delete VM")}
            </ActionButton>
          </div>
        )}
        <div className="mt-3 break-all text-[11px] text-ink-secondary">
          {t("Durable workspace")}: {status?.workspace_path ?? t("not created")} ·{" "}
          Cua Driver: {status?.driver_version ?? "0.20.0"} · {t("Local image")}: {status?.image_ref ?? t("not prepared")}
          {status?.base_image_ref ? <> · {t("Base image")}: {status.base_image_ref}</> : null}
        </div>
      </Card>
    </>
  );
}
