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
import { useStore } from "@/state/store";

type Action = "pull" | "run" | "start" | "stop" | "remove" | "recreate";

interface ManagedStatus {
  source: "managed";
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

interface ExistingStatus {
  source: "existing";
  configured: boolean;
  sshAlias: string | null;
  ssh: "not-configured" | "connected" | "unreachable";
  os: "unknown" | "linux" | "unsupported";
  driver: "unknown" | "compatible" | "missing" | "incompatible";
  mcp: "unknown" | "ready" | "failed";
  tools: string[];
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  errorCode: string | null;
  driver_version: string;
  viewer_url: "";
  watch_only: true;
}

type Status = ManagedStatus | ExistingStatus;

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
  const { state, dispatch } = useStore();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [policyPending, setPolicyPending] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [source, setSource] = useState<"managed" | "existing">("managed");
  const [alias, setAlias] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal, force = false) => {
    const response = await fetch(`/api/local-computer${force ? "?refresh=1" : ""}`, { signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Status request failed (${response.status})`);
    let nextStatus: Status;
    if (body.source === "existing") {
      // SAFETY: the local-computer endpoint returns the discriminated ExistingStatus contract.
      nextStatus = body as ExistingStatus;
    } else {
      // SAFETY: the local-computer endpoint returns the managed status fields under this branch.
      nextStatus = { source: "managed", ...body } as ManagedStatus;
    }
    setStatus(nextStatus);
    setError(null);
  }, []);

  useEffect(() => {
    const configuredSource = state.config?.localVm.source ?? status?.source;
    if (configuredSource) setSource(configuredSource);
  }, [state.config?.localVm.source, status?.source]);

  const existingStatusAlias = status?.source === "existing" ? status.sshAlias ?? "" : null;

  useEffect(() => {
    if (state.config?.localVm.sshAlias !== undefined) setAlias(state.config.localVm.sshAlias);
    else if (existingStatusAlias !== null) setAlias(existingStatusAlias);
  }, [state.config?.localVm.sshAlias, existingStatusAlias]);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async (force = false) => {
      controller = new AbortController();
      try {
        await refresh(controller.signal, force);
      } catch (e) {
        if (active && !(e instanceof DOMException && e.name === "AbortError")) {
          setStatus(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (active) {
          setLoading(false);
          timer = window.setTimeout(() => void poll(), source === "existing" ? 30_000 : 5000);
        }
      }
    };
    void poll(refreshKey > 0);
    return () => {
      active = false;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh, refreshKey, source]);

  const post = async (action: Exclude<Action, "recreate">) => {
    const response = await fetch(`/api/local-computer/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `${action} failed`);
    // SAFETY: local-computer lifecycle endpoints return the same discriminated status contract as refresh().
    setStatus(body as Status);
  };

  const act = async (action: Action) => {
    if (
      action === "remove" &&
      !window.confirm("Delete the Local VM? Files and browser sign-ins in its durable workspace will remain.")
    ) return;
    if (
      action === "recreate" &&
      !window.confirm("Replace the existing Local VM with the pinned image and safety limits? Files and browser sign-ins in its durable workspace will remain.")
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

  const savePolicy = async (mode: ManagedStatus["mode"], maxInstances: number) => {
    setPolicyPending(true);
    setError(null);
    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localVm: { mode, maxInstances } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not save the Local VM isolation policy");
      setStatus((current) => current ? { ...current, mode, max_instances: maxInstances } : current);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolicyPending(false);
    }
  };

  const saveSource = async (nextSource: "managed" | "existing") => {
    if (policyPending || nextSource === source) return;
    setPolicyPending(true);
    setError(null);
    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localVm: { source: nextSource } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not change the Local VM source");
      dispatch({ type: "configStatus", config: body });
      setSource(nextSource);
      await refresh(undefined, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolicyPending(false);
    }
  };

  const saveAlias = async () => {
    if (policyPending) return;
    setPolicyPending(true);
    setError(null);
    try {
      const response = await fetch("/api/config", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ localVm: { sshAlias: alias.trim() } }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not save the Existing VM SSH alias");
      dispatch({ type: "configStatus", config: body });
      setAlias(body.localVm?.sshAlias ?? alias.trim());
      await refresh(undefined, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPolicyPending(false);
    }
  };

  const existingStatus = status?.source === "existing" ? status : null;
  if (source === "existing") {
    const savedAlias = Boolean(alias.trim() || existingStatus?.sshAlias);
    return (
      <>
        <Card
          title="Local VM"
          subtitle="Connect OpenMausBot to one Linux VM that you own through an SSH config alias. OpenMausBot never creates, starts, stops, replaces, or deletes this VM."
        >
          <div className="flex overflow-hidden rounded-lg border border-hairline/40">
            {(["managed", "existing"] as const).map((value, index) => (
              <button
                key={value}
                type="button"
                aria-pressed={source === value}
                disabled={policyPending}
                onClick={() => void saveSource(value)}
                className={cn(
                  "flex-1 px-3 py-2 text-[13px] disabled:opacity-50",
                  index > 0 && "border-l border-hairline/40",
                  source === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
                )}
              >
                {value === "managed" ? "Managed VM" : "Existing VM"}
              </button>
            ))}
          </div>
          {error && <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
        </Card>

        <Card
          title="SSH connection"
          subtitle="Use a host entry from your normal SSH config and agent. Only the alias is saved; OpenMausBot does not store keys, passwords, options, or commands."
        >
          <div className="flex gap-2">
            <input
              type="text"
              value={alias}
              onChange={(event) => setAlias(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void saveAlias()}
              placeholder="my-linux-vm"
              aria-label="Existing VM SSH config alias"
              autoComplete="off"
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void saveAlias()}
              disabled={policyPending || (!alias.trim() && !savedAlias)}
              className={cn(
                "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px] disabled:cursor-not-allowed disabled:opacity-50",
                !alias.trim() && savedAlias ? "bg-raised text-danger hover:bg-raised-hover" : "bg-raised text-ink hover:bg-raised-hover",
              )}
            >
              {policyPending ? <Loader2 size={13} className="animate-spin" /> : !alias.trim() && savedAlias ? "Clear" : <><Check size={13} />Save</>}
            </button>
          </div>
          <div className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
            Alias names may contain letters, numbers, dots, dashes, and underscores. The remote command is fixed to <code>cua-driver mcp</code>.
          </div>
        </Card>

        <Card title="Existing VM readiness" subtitle="The VM is usable only after SSH, Linux, the pinned CUA Driver, MCP tools, and a complete desktop image all pass." >
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px]",
                existingStatus?.ready ? "bg-success/15 text-success" : "bg-raised text-ink-secondary",
              )}
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : existingStatus?.ready ? <Check size={12} /> : <Circle size={9} />}
              {loading ? "Checking…" : existingStatus?.ready ? "Ready · watch-only preview" : existingStatus?.problem ?? "Not ready"}
            </span>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                setRefreshKey((key) => key + 1);
              }}
              disabled={loading || policyPending}
              className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
            >
              <RefreshCw size={12} /> Re-check
            </button>
          </div>
          <div className="mt-4 flex flex-col gap-3">
            <Step n={1} title="SSH config alias saved" done={Boolean(existingStatus?.sshAlias)}>
              <div className="text-[12.5px] text-ink-secondary">Enter the alias for the Linux VM above, then save it.</div>
            </Step>
            <Step n={2} title="SSH connection" done={existingStatus?.ssh === "connected"}>
              {existingStatus?.errorCode === "ssh-missing" && (
                <div className="text-[12.5px] text-danger">Install OpenSSH so the <code>ssh</code> command is available in OpenMausBot&apos;s PATH, then re-check.</div>
              )}
              {existingStatus?.ssh === "unreachable" && existingStatus.errorCode !== "ssh-missing" && (
                <div className="text-[12.5px] text-danger">Check the SSH alias, host key, and SSH agent, then re-check.</div>
              )}
            </Step>
            <Step n={3} title="Linux guest" done={existingStatus?.os === "linux"}>
              {existingStatus?.os === "unsupported" && <div className="text-[12.5px] text-danger">The Existing VM must report Linux.</div>}
            </Step>
            <Step n={4} title={`CUA Driver ${existingStatus?.driver_version ?? "0.20.0"}`} done={existingStatus?.driver === "compatible"}>
              {existingStatus?.driver === "missing" && <div className="text-[12.5px] text-danger">Install the pinned CUA Driver in the VM and re-check.</div>}
              {existingStatus?.driver === "incompatible" && <div className="text-[12.5px] text-danger">The VM has a different CUA Driver version than this OpenMausBot build.</div>}
            </Step>
            <Step n={5} title="CUA MCP tools" done={existingStatus?.mcp === "ready"}>
              {existingStatus?.mcp === "failed" && <div className="text-[12.5px] text-danger">The CUA MCP bridge did not become ready.</div>}
            </Step>
            <Step n={6} title="Desktop capture" done={Boolean(existingStatus?.desktopReady)}>
              {existingStatus?.desktopReady === false && existingStatus?.mcp === "ready" && <div className="text-[12.5px] text-danger">CUA could not return a complete desktop image.</div>}
            </Step>
          </div>
          {existingStatus?.ready && (
            <div className="mt-4 rounded-lg bg-raised px-3 py-2 text-[12px] leading-relaxed text-ink-secondary">
              The bot Computer panel can show a watch-only preview. Live viewer access and Take Control are intentionally unavailable for an Existing VM.
            </div>
          )}
        </Card>
      </>
    );
  }

  const managedStatus = status?.source === "managed" ? status : null;
  const c = managedStatus?.commands;
  const ready = managedStatus?.ready === true;
  const existing = managedStatus?.container !== "missing";
  const needsRecreate = Boolean(
    existing &&
      (managedStatus?.container === "stopped" ||
        !managedStatus?.imageMatches ||
        !managedStatus?.managed ||
        managedStatus?.network === "unsafe" ||
        managedStatus?.security === "unsafe" ||
        managedStatus?.persistence === "unsafe"),
  );
  const unavailable = !loading && !status;
  const host = managedStatus?.platform === "darwin" ? "Mac" : "computer";
  const perBot = managedStatus?.mode === "per-bot";
  const perBotRuntimeUnsupported = perBot && managedStatus?.runtime === "container";
  const headerReady = perBot ? Boolean(managedStatus?.daemonUp && managedStatus?.image && !perBotRuntimeUnsupported) : ready;

  return (
    <>
      <Card
        title="Local VM"
        subtitle={perBot
          ? `Private Cua Linux desktops on this ${host}, with one container and durable workspace per bot. Distinct bots can work concurrently and idle desktops stop after 8 hours.`
          : `A shared Cua Linux sandbox on this ${host} for bots to browse and work in — isolated, backed by one durable workspace, and automatically recycled after 8 hours without activity.`}
      >
        <div className="mb-4 flex overflow-hidden rounded-lg border border-hairline/40">
          {(["managed", "existing"] as const).map((value, index) => (
            <button
              key={value}
              type="button"
              aria-pressed={source === value}
              disabled={policyPending || pending !== null}
              onClick={() => void saveSource(value)}
              className={cn(
                "flex-1 px-3 py-2 text-[13px] disabled:opacity-50",
                index > 0 && "border-l border-hairline/40",
                source === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              {value === "managed" ? "Managed VM" : "Existing VM"}
            </button>
          ))}
        </div>
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
                ? "Status unavailable"
                : perBot && headerReady
                  ? "Ready for per-bot desktops"
                  : perBotRuntimeUnsupported
                    ? "Per-bot mode requires Docker or Podman"
                  : ready
                    ? "Ready"
                    : (managedStatus?.problem ?? "Not ready")}
          </span>
          <button
            onClick={() => {
              setLoading(true);
              setRefreshKey((key) => key + 1);
            }}
            disabled={loading || pending !== null}
            className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40"
          >
            <RefreshCw size={12} /> Re-check
          </button>
          {ready && !perBot && (
            <a
              href={managedStatus?.viewer_url ?? c?.view}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink hover:bg-control"
            >
              <ExternalLink size={12} /> Watch screen
            </a>
          )}
        </div>
        {error && <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
      </Card>

      <Card
        title="Isolation"
        subtitle="Shared keeps the original single-desktop behavior. Per bot gives each bot its own container, workspace, viewer port, lease, and idle timer."
      >
        <div className="flex overflow-hidden rounded-lg border border-hairline/40">
          {(["shared", "per-bot"] as const).map((mode, index) => (
            <button
              key={mode}
              type="button"
              disabled={!status || policyPending}
              aria-pressed={managedStatus?.mode === mode}
              onClick={() => void savePolicy(mode, managedStatus?.max_instances ?? 2)}
              className={cn(
                "flex-1 px-3 py-2 text-[13px] disabled:opacity-50",
                index > 0 && "border-l border-hairline/40",
                managedStatus?.mode === mode ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              {mode === "shared" ? "Shared" : "Per bot"}
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-[13px] text-ink">Maximum per-bot desktops</div>
            <div className="text-[11.5px] text-ink-secondary">Limits storage and host resource use; each running desktop may use up to 4 GB and 2 CPUs.</div>
          </div>
          <select
            aria-label="Maximum per-bot desktops"
            value={managedStatus?.max_instances ?? 2}
            disabled={!status || policyPending}
            onChange={(event) => void savePolicy(managedStatus?.mode ?? "shared", Number(event.target.value))}
            className="rounded-lg border border-hairline/40 bg-raised px-2.5 py-1.5 text-[13px] text-ink disabled:opacity-50"
          >
            {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        {policyPending && <div className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-secondary"><Loader2 size={12} className="animate-spin" /> Saving…</div>}
      </Card>

      <Card title="Setup" subtitle="Once a container runtime is open, OpenMausBot prepares Cua and the VM for you.">
        <div className="flex flex-col gap-4">
          <Step n={1} title="Install a container runtime" done={Boolean(managedStatus?.runtime)}>
            <div className="text-[13px] leading-relaxed text-ink-secondary">
              Podman and Colima are free. Docker Desktop may require a paid licence for larger companies and government use.
            </div>
            {c?.install ? (
              <CommandLine command={c.install} />
            ) : (
              <a href="https://podman.io/docs/installation" target="_blank" rel="noreferrer" className="text-[13px] text-accent hover:underline">
                Open the Podman installation guide
              </a>
            )}
          </Step>

          <Step
            n={2}
            title={managedStatus?.runtime && !managedStatus.daemonUp ? `Open and start ${managedStatus.runtime}` : "Start the container runtime"}
            done={Boolean(managedStatus?.daemonUp)}
          >
            {!managedStatus?.runtime ? null : c?.runtimeStart ? (
              <CommandLine command={c.runtimeStart} />
            ) : (
              <div className="text-[13px] text-ink-secondary">Open the installed runtime and start its engine, then re-check.</div>
            )}
          </Step>

          <Step n={3} title="Prepare the Cua desktop (one-time download and build)" done={Boolean(managedStatus?.image)}>
            {managedStatus?.daemonUp && (
              <ActionButton action="pull" pending={pending} onClick={() => void act("pull")}>Prepare Cua desktop</ActionButton>
            )}
            {c?.pull && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Show base-image download</summary><div className="mt-2"><CommandLine command={c.pull} /></div></details>}
          </Step>

          <Step
            n={4}
            title={perBot ? "Create a private desktop from each bot's Computer panel" : needsRecreate ? "Replace the older or unsafe VM" : "Create and start the Local VM"}
            done={!perBot && ready}
          >
            {perBot ? (
              <div className="text-[13px] leading-relaxed text-ink-secondary">
                {perBotRuntimeUnsupported
                  ? "Apple container requires an explicit host port, so OpenMausBot will not guess or expose one. Install or start Docker or Podman for safe per-bot dynamic loopback ports."
                  : <>
                      Choose <b className="text-ink">Local VM</b> for a bot, open that bot's Computer panel, then create its desktop there. OpenMausBot assigns a private workspace and an available loopback viewer port automatically.
                    </>}
              </div>
            ) : needsRecreate ? (
              <>
                <div className="flex gap-2 text-[13px] text-warning">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span>{managedStatus?.problem}</span>
                </div>
                {managedStatus?.image ? (
                  <ActionButton action="recreate" pending={pending} onClick={() => void act("recreate")} danger>
                    <RotateCcw size={13} /> Delete and recreate
                  </ActionButton>
                ) : (
                  <div className="text-[13px] text-ink-secondary">Prepare the pinned Cua desktop above before replacing this VM.</div>
                )}
              </>
            ) : managedStatus?.container === "stopped" ? (
              <ActionButton action="start" pending={pending} onClick={() => void act("start")}>Start Local VM</ActionButton>
            ) : managedStatus?.container === "running" ? (
              <div className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={13} className="animate-spin" /> Waiting for the desktop…</div>
            ) : managedStatus?.image ? (
              <ActionButton action="run" pending={pending} onClick={() => void act("run")}>Create Local VM</ActionButton>
            ) : null}
            {c?.run && <details className="text-[12px] text-ink-secondary"><summary className="cursor-pointer">Show command</summary><div className="mt-2"><CommandLine command={c.run} /></div></details>}
          </Step>
        </div>
      </Card>

      {unavailable && (
        <Card>
          <div className="flex gap-2 text-[13px] text-ink-secondary">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <span>OpenMausBot could not inspect the container runtime. Re-check, or review the app logs.</span>
          </div>
        </Card>
      )}

      <Card
        title="Safety and storage"
        subtitle={perBot
          ? `Cua Driver operates only each VM's desktop. Every bot gets a private host folder mounted at ${managedStatus?.workspace_guest_path ?? "/home/cua/workspace"}; its files and browser profile survive VM replacement. Viewers bind only to loopback, and exact bot-derived targets prevent one bot from attaching to another bot's container. Each VM keeps the existing 4 GB, 2 CPU, 512-process and dropped-capability limits. VMs can still reach the internet.`
          : `Cua Driver operates only the VM's desktop. Exactly one private host folder is mounted at ${managedStatus?.workspace_guest_path ?? "/home/cua/workspace"}; files and browser sign-ins there survive VM replacement, while everything elsewhere in the VM remains disposable. The password-protected viewer is available only on this machine. Docker and Podman runs are limited to 4 GB memory, 2 CPUs and 512 processes; all Linux capabilities are dropped except the two the desktop supervisor needs to switch to its unprivileged user. The VM can still reach the internet, and bots share it one at a time.`}
      >
        {existing && (
          <div className="flex flex-wrap gap-2">
            {managedStatus?.container === "running" && (
              <ActionButton action="stop" pending={pending} onClick={() => void act("stop")}>
                <Square size={12} /> Stop
              </ActionButton>
            )}
            <ActionButton action="remove" pending={pending} onClick={() => void act("remove")} danger>
              <Trash2 size={12} /> {perBot ? "Delete legacy shared VM" : "Delete VM"}
            </ActionButton>
          </div>
        )}
        <div className="mt-3 break-all text-[11px] text-ink-secondary">
          Durable workspace: {managedStatus?.workspace_path ?? "not created"} ·{" "}
          Cua Driver: {managedStatus?.driver_version ?? "0.20.0"} · Local image: {managedStatus?.image_ref ?? "not prepared"}
          {managedStatus?.base_image_ref ? <> · Base: {managedStatus.base_image_ref}</> : null}
        </div>
      </Card>
    </>
  );
}
