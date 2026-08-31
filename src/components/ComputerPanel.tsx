// The bot's computer, in the right-side slot. Where it runs decides the
// whole flow: cloud → provision the box on open (idempotent) and preview
// via SSE frames or a ~4s screenshot poll. macOS local mode keeps the legacy
// in-panel capture. Linux local mode is an automation readiness state and its
// separate preview remains explicitly user-initiated. Auto never selects a
// Linux user's desktop.
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  CalendarClock,
  CalendarDays,
  Columns2,
  ExternalLink,
  Globe,
  Hand,
  Loader2,
  Maximize2,
  Monitor,
  Moon,
  Plus,
  Power,
  Settings,
  Smartphone,
  X,
} from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import type { Routine } from "@/lib/routines";
import { ApiKeyRow } from "./ApiKeys";
import { cn } from "@/lib/cn";
import { builtInBrowserEnabled } from "@/lib/feature-flags";
import { usePageVisible } from "@/lib/page-visible";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { RoutineEditor } from "./RoutinesPage";
import { AndroidDevicePanel, useAndroidUsbDevices } from "./AndroidDevicePanel";
import { transitionComputerControlLease, type ComputerControlAction } from "@/lib/computer-control";
import { LocalScreenPreview } from "./LocalScreenPreview";
import { LinuxLocalControl } from "./LinuxLocalControl";
import { MacLocalControl } from "./MacLocalControl";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { Switch } from "./SettingsPrimitives";
import {
  autoSelectsLocalComputer,
  instanceSupportsLocalComputer,
  linuxAutoDescription,
  localComputerDisabledReason,
  localComputerSelectable,
} from "@/lib/local-computer";
import {
  readComputerPanelView,
  writeComputerPanelView,
  type ComputerPanelView,
} from "@/lib/computer-panel-view";

interface VpsComputerStatus {
  configured: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  ready: boolean;
  problem: string | null;
}

type Phase =
  | "checking"
  | "unconfigured"
  | "starting"
  | "ready"
  | "vm"
  | "vm-unavailable"
  | "vps-unconfigured"
  | "vps-incompatible"
  | "vps-stopped"
  | "local"
  | "local-unavailable"
  | "off"
  | "error";

interface LocalVmStatus {
  mode: "shared" | "per-bot";
  max_instances: number;
  image: boolean;
  create_supported: boolean;
  container: "running" | "stopped" | "missing";
  imageMatches: boolean;
  managed: boolean;
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  viewer_url: string;
}

const computerControlSnapshotSchema = z.object({
  held: z.boolean().optional().default(false),
  helpReason: z.string().nullable().optional().default(null),
}).passthrough();

function routineScheduleLabel(routine: Routine) {
  if (routine.schedule.type === "once") {
    return new Date(routine.schedule.at).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const days = routine.schedule.weekdays;
  const cadence =
    days.length === 7
      ? "Every day"
      : days.join(",") === "1,2,3,4,5"
        ? "Weekdays"
        : days.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ");
  const [hour, minute] = routine.schedule.time.split(":").map(Number);
  return `${cadence} · ${new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function nextRunLabel(at: number | null) {
  if (at == null) return "Paused";
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return `${sameDay ? "Today" : date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

const PANEL_WIDTH_KEY = "omb-computer-panel-width";
const PANEL_MIN_WIDTH = 360;
const PANEL_MAX_WIDTH = 960;
const PANEL_DEFAULT_WIDTH = 400;

function readPanelWidth(): number {
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= PANEL_MIN_WIDTH && stored <= PANEL_MAX_WIDTH) return stored;
  } catch {
    /* storage blocked — default width */
  }
  return PANEL_DEFAULT_WIDTH;
}

export function ComputerPanel({
  bot,
  onOpenVmWorkspace,
}: {
  bot: Bot;
  onOpenVmWorkspace?: (botId: string) => void;
}) {
  // The panel is a fixed column by default; a drag handle on its left edge
  // makes it wide enough to actually read the screen preview.
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const onResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    resizeFrom.current = { x: event.clientX, width: panelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, resizeFrom.current.width + (resizeFrom.current.x - event.clientX)));
    setPanelWidth(next);
  };
  const onResizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
    } catch {
      /* storage blocked — width lives for this session */
    }
  };
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const localAvailable = capabilities.localComputer.available;
  const isLinux = capabilities.host.platform === "linux";
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = localComputerSelectable({ capabilities, providerSupportsLocal });
  const [localAutoWarning, setLocalAutoWarning] = useState(false);
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const [phase, setPhase] = useState<Phase>("checking");
  const [boxState, setBoxState] = useState<string | null>(null);
  const [polledFrame, setPolledFrame] = useState<{ png: string; mime: string } | null>(null);
  const [vmFrame, setVmFrame] = useState<string | null>(null);
  // The Local VM's interactive noVNC viewer (passworded, autoconnect). The
  // preview below is a periodic screenshot that swallows clicks — this URL is
  // the only way a person can actually drive the VM.
  const [vmViewerUrl, setVmViewerUrl] = useState<string | null>(null);
  const [vmStatus, setVmStatus] = useState<LocalVmStatus | null>(null);
  const [vpsStatus, setVpsStatus] = useState<VpsComputerStatus | null>(null);
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [pending, setPending] = useState<
    "join" | "sleep" | "provision" | "vps-replace" | "vm-create" | "vm-recreate" | "vm-delete" | null
  >(null);
  const [controlPending, setControlPending] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatingRoutine, setCreatingRoutine] = useState(false);
  const [panelView, setPanelView] = useState<ComputerPanelView>(() => readComputerPanelView(bot.id));
  const androidStatus = useAndroidUsbDevices();
  const androidConnected = androidStatus.devices.length > 0;
  // bumped when a Box API key is saved inline, to re-run the spin-up flow
  const [retry, setRetry] = useState(0);
  const vmReadinessAttempts = useRef(0);
  // The bot's browser lives in BetterWright, not in this panel; the person
  // watches or takes over through its live-view page in a normal tab.
  const browserEnabled = builtInBrowserEnabled(state.config) && bot.browser !== false;
  const [browserViewPending, setBrowserViewPending] = useState(false);
  const [browserViewError, setBrowserViewError] = useState<string | null>(null);
  const openBrowserLiveView = async () => {
    setBrowserViewPending(true);
    setBrowserViewError(null);
    try {
      const { url } = await api(`/api/bots/${bot.id}/browser/view`, { method: "POST", body: "{}" });
      if (window.ogb?.openExternal) void window.ogb.openExternal(url);
      else window.open(url, "_blank", "noopener");
    } catch (cause) {
      setBrowserViewError(cause instanceof Error ? cause.message : "Could not open the browser live view.");
    } finally {
      setBrowserViewPending(false);
    }
  };
  const selectedInstance = state.instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  );

  const selectPanelView = (view: ComputerPanelView) => {
    setPanelView(view);
    writeComputerPanelView(bot.id, view);
  };

  useEffect(() => {
    setPanelView(readComputerPanelView(bot.id));
  }, [bot.id]);

  // Pause the screenshot poll while this bot's viewer is open; seed from the
  // live viewer so a remount/switch mid-session doesn't wrongly resume it.
  useEffect(() => {
    let alive = true;
    const dv = window.ogb?.desktopViewer;
    if (dv?.currentState) {
      void dv
        .currentState()
        .then((s) => {
          if (alive) setViewerOpen(s.open && s.contextId === bot.id);
        })
        .catch(() => {});
    }
    const off = dv?.onState((viewer) => {
      if (viewer.contextId === bot.id) setViewerOpen(viewer.open);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [bot.id]);

  useEffect(() => {
    if (!androidConnected && panelView === "android") {
      setPanelView("computer");
      writeComputerPanelView(bot.id, "computer");
    }
  }, [androidConnected, bot.id, panelView]);
  useEffect(() => {
    if (!browserEnabled && panelView === "browser") {
      setPanelView("computer");
      writeComputerPanelView(bot.id, "computer");
    }
  }, [browserEnabled, bot.id, panelView]);
  useEffect(() => {
    vmReadinessAttempts.current = 0;
  }, [bot.id, bot.computer]);
  const vmSupported = Boolean(
    selectedInstance?.snapshot.state === "available" &&
      selectedInstance.capabilities?.computerMcp &&
      selectedInstance.driverKind !== "boxAgent",
  );
  const computerToolSupported = selectedInstance?.capabilities?.computerMcp === true;
  const vpsSupported = Boolean(computerToolSupported && selectedInstance?.driverKind !== "boxAgent");
  const cloudBackend = bot.cloudBackend ?? "box";
  const cloudSupported = cloudBackend === "vps"
    ? vpsSupported
    : computerToolSupported || selectedInstance?.driverKind === "boxAgent";
  const botRoutines = state.routines
    .filter((routine) => routine.botId === bot.id)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  const cloudRoutineReady = Boolean(
    state.config?.box.configured &&
      state.instances.some((instance) => instance.driverKind === "boxAgent" && instance.snapshot.state === "available"),
  );
  const activeRoutineRun = state.routineRuns.find(
    (run) => run.botId === bot.id && ["queued", "running", "waiting"].includes(run.status),
  );
  const computerDestination =
    bot.computer === "cloud"
      ? cloudBackend === "vps" ? "this self-hosted VPS" : "this cloud box"
      : bot.computer === "vm"
        ? "the Local VM"
      : bot.computer === "local"
        ? "this computer"
        : bot.computer === "off"
          ? null
          : phase === "ready"
            ? cloudBackend === "vps" ? "the self-hosted VPS selected by Auto" : "the cloud box selected by Auto"
            : "this computer selected by Auto";

  // resolve the mode on open; box endpoints are only ever hit on the
  // cloud path, so local/off can never render a JSON error as an image
  useEffect(() => {
    // Android owns its own live surface. Do not provision a VM, wake a box,
    // or churn preview state behind that tab.
    if (panelView !== "computer") return;
    let alive = true;
    setPhase("checking");
    setPolledFrame(null);
    setVmFrame(null);
    setVmViewerUrl(null);
    setVmStatus(null);
    setVpsStatus(null);
    setLocalFrame(null);
    setError(null);
    if (bot.computer === "off") {
      setPhase("off");
      return;
    }
    if (bot.computer === "local") {
      if (!providerSupportsLocal) {
        setError("This model engine cannot control this computer. Choose Claude or an ACP engine.");
      }
      setPhase(capabilitiesReady && localAvailable && providerSupportsLocal ? "local" : "local-unavailable");
      return;
    }
    if (bot.computer === "vm") {
      if (!vmSupported) {
        setError("This model engine cannot use the Local VM. Choose Claude or an ACP engine.");
        setPhase("vm-unavailable");
        return;
      }
      let retryTimer: number | undefined;
      api(`/api/bots/${bot.id}/local-computer`)
        .then((rawStatus) => {
          if (!alive) return;
          const status: LocalVmStatus = rawStatus;
          setVmStatus(status);
          // parse at the boundary: our own status endpoint sends a string or nothing
          const viewerUrl = String(status.viewer_url ?? "");
          if (viewerUrl.startsWith("http")) setVmViewerUrl(viewerUrl);
          if (status.ready) {
            vmReadinessAttempts.current = 0;
            setPhase("vm");
          } else if (
            status.container === "running" &&
            status.imageMatches &&
            status.managed &&
            status.network === "loopback" &&
            status.security === "hardened" &&
            status.persistence === "durable" &&
            !status.desktopReady &&
            vmReadinessAttempts.current < 15
          ) {
            vmReadinessAttempts.current += 1;
            setError(null);
            setPhase("checking");
            retryTimer = window.setTimeout(() => setRetry((n) => n + 1), 2000);
          }
          else {
            const canCreateHere =
              status.mode === "per-bot" &&
              status.container === "missing" &&
              status.image &&
              status.create_supported;
            setError(canCreateHere ? null : `${status.problem ?? "The Local VM is not ready"}. Open App Settings → Local VM.`);
            setPhase("vm-unavailable");
          }
        })
        .catch((e) => {
          if (!alive) return;
          setError(e.message);
          setPhase("vm-unavailable");
        });
      return () => {
        alive = false;
        if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      };
    }
    if (bot.computer === "cloud" && !cloudSupported) {
      setError("This model engine cannot use cloud computer tools. Choose Claude, an ACP engine, or the Computer engine.");
      setPhase("error");
      return;
    }
    if (bot.computer !== "cloud" && !capabilitiesReady) return;
    if (cloudBackend === "vps") {
      const autoLocal =
        !isLinux && bot.computer !== "cloud" && capabilitiesReady && localSelectable;
      if (!vpsSupported) {
        if (autoLocal) setPhase("local");
        else {
          setError("This model engine cannot use a self-hosted VPS. Choose Claude or an ACP engine, or switch the cloud backend to Box.");
          setPhase("error");
        }
        return;
      }
      api(`/api/bots/${bot.id}/computer`)
        .then((rawStatus) => {
          if (!alive) return;
          const status: VpsComputerStatus = rawStatus;
          setVpsStatus(status);
          if (!status.configured) {
            if (autoLocal) setPhase("local");
            else {
              setError("Add the VPS SSH config alias in App Settings → Connections.");
              setPhase("vps-unconfigured");
            }
            return;
          }
          if (status.ready) {
            setBoxState(status.container ?? null);
            setPhase("ready");
            return;
          }
          // App updates can bump IMAGE_LAYER_VERSION while this bot still has
          // a managed container from the previous release. Provision refuses
          // to overwrite it by design, so surface the explicit replacement
          // path instead of automatically issuing a request that can only 409.
          if (status.managed && status.container !== "missing" && !status.imageMatches) {
            setError(status.problem);
            setPhase("vps-incompatible");
            return;
          }
          if (bot.computer === "cloud") {
            setPhase("starting");
            return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((result) => {
              if (!alive) return;
              setBoxState(result.container ?? null);
              if (result.ready) setPhase("ready");
              else {
                setError(result.problem ?? "The VPS Cua desktop is not ready yet");
                setPhase("error");
              }
            });
          }
          if (autoLocal) {
            setPhase("local");
            return;
          }
          setBoxState(status.container ?? null);
          setError(
            bot.autoStartVps
              ? `${status.problem ?? "No ready VPS container"}. Auto will prepare or wake it when this bot next works.`
              : `${status.problem ?? "No ready VPS container"}. Enable Start VPS automatically below, or choose Cloud to provision it.`,
          );
          setPhase(status.container === "stopped" ? "vps-stopped" : "vps-unconfigured");
        })
        .catch((e) => {
          if (!alive) return;
          setError(e.message);
          setPhase("error");
        });
      return () => {
        alive = false;
      };
    }
    // cloud, or auto (cloud box wins when one exists, else local in-app)
    api(`/api/bots/${bot.id}/computer`)
      .then((status) => {
        if (!alive) return;
        const autoLocal = autoSelectsLocalComputer({
          platform: capabilities.host.platform,
          computer: bot.computer,
          capabilitiesReady,
          localSelectable,
        });
        if (!status.configured) {
          setPhase(autoLocal ? "local" : "unconfigured");
          return;
        }
        if (!status.box && autoLocal) {
          setPhase("local");
          return;
        }
        setPhase("starting");
        return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((r) => {
          if (!alive) return;
          setBoxState(r.state ?? null);
          setPhase("ready");
        });
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message);
        setPhase("error");
      });
    return () => {
      alive = false;
    };
  }, [
    bot.id,
    bot.computer,
    bot.autoStartVps,
    cloudBackend,
    retry,
    capabilitiesReady,
    localSelectable,
    isLinux,
    providerSupportsLocal,
    vmSupported,
    cloudSupported,
    vpsSupported,
    state.config?.vps?.sshAlias,
    panelView,
  ]);

  // cloud preview: SSE frames win while the bot works; otherwise poll.
  // Every preview poll below gates on visibility and slows way down for an
  // idle bot — a drawer left open overnight must not keep shooting.
  const pageVisible = usePageVisible();
  const live = state.screens[bot.id];
  const sseFlowing = Boolean(bot.busy && live);
  const inFlight = useRef(false);
  useEffect(() => {
    if (panelView !== "computer" || phase !== "ready" || sseFlowing || viewerOpen || !pageVisible) return;
    let alive = true;
    const shoot = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const { png, format } = await api(`/api/bots/${bot.id}/computer/screenshot`, { method: "POST" });
        if (alive) setPolledFrame({ png, mime: format === "jpeg" ? "image/jpeg" : "image/png" });
      } catch {
        /* box mid-command or asleep — next tick */
      } finally {
        inFlight.current = false;
      }
    };
    void shoot();
    const timer = setInterval(shoot, bot.busy ? 4000 : 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [panelView, phase, sseFlowing, bot.id, viewerOpen, pageVisible, bot.busy]);

  // Local VM preview comes directly from Cua Driver through the harness. It
  // does not use the password-protected noVNC viewer or cloud endpoints.
  const vmInFlight = useRef(false);
  useEffect(() => {
    if (panelView !== "computer" || phase !== "vm" || viewerOpen || !pageVisible) return;
    let alive = true;
    const shoot = async () => {
      if (vmInFlight.current) return;
      vmInFlight.current = true;
      try {
        const { image } = await api(`/api/bots/${bot.id}/local-computer/screenshot`, { method: "POST" });
        if (alive && typeof image === "string") setVmFrame(image);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        vmInFlight.current = false;
      }
    };
    void shoot();
    const timer = window.setInterval(() => void shoot(), bot.busy ? 3000 : 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [panelView, phase, bot.id, viewerOpen, pageVisible, bot.busy]);

  // local preview: frames from the Electron main process. The FIRST capture
  // attempt is what makes macOS show the Screen Recording prompt (there is
  // no reliable pre-grant flow on macOS 15+), so repeated empty frames mean
  // the user denied — surface the Settings repair path instead of spinning.
  const [localMisses, setLocalMisses] = useState(0);
  useEffect(() => {
    if (panelView !== "computer" || phase !== "local" || !window.ogb || isLinux || !pageVisible) return;
    let alive = true;
    setLocalMisses(0);
    const shoot = async () => {
      try {
        const url = await window.ogb!.screenFrame();
        if (alive && url) setLocalFrame(url);
        else if (alive) setLocalMisses((n) => n + 1);
      } catch {
        if (alive) setLocalMisses((n) => n + 1);
      }
    };
    void shoot();
    // A real ScreenCaptureKit capture + PNG encode per tick: idle bots get a
    // slow heartbeat, working ones the live cadence.
    const timer = setInterval(shoot, bot.busy ? 3000 : 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [panelView, phase, isLinux, pageVisible, bot.busy, bot.id]);

  const lastScreenMessage = [...bot.messages].reverse().find((m) => m.kind === "screen" && m.png);
  const cloudFrame =
    live ??
    polledFrame ??
    (lastScreenMessage ? { png: lastScreenMessage.png!, mime: lastScreenMessage.mime ?? "image/png" } : null);
  const frameSrc =
    phase === "vm"
      ? vmFrame
      : phase === "local" && !isLinux
      ? localFrame
      : phase === "ready" || phase === "starting"
        ? cloudFrame && `data:${cloudFrame.mime};base64,${cloudFrame.png}`
        : null;
  const previewOpensDesktop = Boolean(
    frameSrc &&
      ((phase === "vm" && vmViewerUrl) || phase === "ready"),
  );

  // who-is-driving: SSE keeps this fresh; the mount fetch covers a panel
  // opened after the last frame (e.g. an app reload mid-hold)
  const control = state.computerControl[bot.id] ?? { held: false, helpReason: null };
  useEffect(() => {
    let alive = true;
    api(`/api/bots/${bot.id}/computer/control`)
      .then((raw) => {
        if (!alive) return;
        const snap = computerControlSnapshotSchema.parse(raw);
        dispatch({
          type: "computerControl",
          botId: bot.id,
          held: snap.held === true,
          helpReason: snap.helpReason,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);
  const requestControl = useCallback(async (action: ComputerControlAction) => {
    const snap = computerControlSnapshotSchema.parse(await api(`/api/bots/${bot.id}/computer/control`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }));
    dispatch({
      type: "computerControl",
      botId: bot.id,
      held: snap.held === true,
      helpReason: snap.helpReason,
    });
    return snap;
  }, [bot.id, dispatch]);

  const transitionControl = useCallback(async (action: ComputerControlAction) => {
    return transitionComputerControlLease({ action, requestControl });
  }, [requestControl]);

  const controlAction = useCallback(async (action: ComputerControlAction): Promise<boolean> => {
    setControlPending(true);
    setError(null);
    try {
      await transitionControl(action);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setControlPending(false);
    }
  }, [transitionControl]);

  const openDesktop = async () => {
    setPending("join");
    setControlPending(true);
    setError(null);
    let tookControl = false;
    // A plain-web development session still needs a synchronous blank tab;
    // the packaged app uses the reliable Electron viewer window below.
    let fallbackTab: Window | null = null;
    if (!window.ogb?.desktopViewer && !window.ogb?.openExternal) {
      fallbackTab = window.open("", "_blank");
      if (fallbackTab) fallbackTab.opener = null;
    }
    try {
      if (!control.held) {
        await transitionControl("take");
        tookControl = true;
      }

      let viewerUrl = vmViewerUrl;
      if (phase === "ready") {
        const result = await api(`/api/bots/${bot.id}/computer/join`, { method: "POST" });
        viewerUrl = result.joinUrl?.constructor === String ? String(result.joinUrl) : null;
      }
      if (!viewerUrl) throw new Error("The computer did not return a live desktop link");

      if (window.ogb?.desktopViewer) {
        const opened = await window.ogb.desktopViewer.open(viewerUrl, `${bot.name}'s live desktop`, bot.id);
        if (!opened) throw new Error("OpenMausBot could not open the live desktop");
      } else if (fallbackTab) {
        fallbackTab.location.replace(viewerUrl);
      } else if (window.ogb?.openExternal) {
        const opened = await window.ogb.openExternal(viewerUrl);
        if (!opened) throw new Error("OpenMausBot could not open the live desktop link");
      } else if (!window.open(viewerUrl, "_blank", "noopener")) {
        throw new Error("Your browser blocked the live desktop tab");
      }
    } catch (e) {
      fallbackTab?.close();
      // Release the bot before waiting on best-effort tunnel cleanup. A sick
      // SSH process must never leave the agent paused indefinitely.
      if (tookControl) await transitionControl("release").catch(() => {});
      if (phase === "ready" && cloudBackend === "vps") {
        await api(`/api/bots/${bot.id}/computer/viewer-close`, { method: "POST", body: "{}" }).catch(() => {});
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
      setControlPending(false);
    }
  };

  const run = (kind: "sleep" | "provision") => {
    setPending(kind);
    setError(null);
    api(`/api/bots/${bot.id}/computer/${kind}`, { method: "POST" })
      .then((result) => {
        if (kind === "provision") {
          setBoxState(result.container ?? null);
          if (result.ready) setPhase("ready");
          else {
            setError(result.problem ?? "The VPS Cua desktop is not ready yet");
            setPhase("error");
          }
        }
        if (kind === "sleep") {
          setBoxState(cloudBackend === "vps" ? "stopped" : "archived");
          if (cloudBackend === "vps") setPhase("vps-stopped");
        }
      })
      .catch((e) => {
        setError(e.message);
      })
      .finally(() => setPending(null));
  };

  const runVmAction = async (action: "vm-create" | "vm-recreate" | "vm-delete") => {
    if (
      (action === "vm-recreate" || action === "vm-delete") &&
      !window.confirm(
        action === "vm-delete"
          ? `Delete ${bot.name}'s Local VM? Its private durable workspace will remain.`
          : `Replace ${bot.name}'s Local VM? Its private durable workspace will remain.`,
      )
    ) return;
    setPending(action);
    setError(null);
    setVmStatus(null);
    vmReadinessAttempts.current = 0;
    try {
      if (action !== "vm-create") {
        await api(`/api/bots/${bot.id}/local-computer/remove`, {
          method: "POST",
          body: "{}",
        });
      }
      if (action !== "vm-delete") {
        const status: LocalVmStatus = await api(`/api/bots/${bot.id}/local-computer/run`, {
          method: "POST",
          body: "{}",
        });
        setVmStatus(status);
        setPhase(status.ready ? "vm" : "checking");
      } else {
        setVmStatus((current) => current ? { ...current, container: "missing", ready: false } : current);
        setPhase("vm-unavailable");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("vm-unavailable");
    } finally {
      setPending(null);
      setRetry((n) => n + 1);
    }
  };

  const replaceVpsComputer = async () => {
    if (!window.confirm(`Replace ${bot.name}'s VPS computer with the version required by this OpenMausBot update? Files stored only inside the disposable container will be deleted.`)) return;
    setPending("vps-replace");
    setError(null);
    try {
      await api(`/api/bots/${bot.id}/computer/remove`, { method: "POST", body: "{}" });
      const result: VpsComputerStatus = await api(`/api/bots/${bot.id}/computer/provision`, {
        method: "POST",
        body: "{}",
      });
      setVpsStatus(result);
      setBoxState(result.container ?? null);
      setPhase(result.ready ? "ready" : "error");
      if (!result.ready) setError(result.problem ?? "The replacement VPS Cua desktop is not ready yet");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      setPending(null);
      setRetry((n) => n + 1);
    }
  };

  const openVmSettings = () => {
    window.sessionStorage.setItem("openmausbot.settings.section", "computer");
    dispatch({ type: "toggleAppSettings", open: true });
  };

  const openConnectionSettings = () => {
    dispatch({ type: "toggleAppSettings", open: true, section: "connections" });
  };

  const emptyState = {
    checking: "Checking…",
    starting: "Starting your bot's computer…",
    unconfigured: "No cloud computer configured",
    "vps-unconfigured": "No managed VPS computer is configured for this bot",
    "vps-incompatible": "This VPS computer belongs to an earlier OpenMausBot version",
    "vps-stopped": "The managed VPS computer is stopped",
    "local-unavailable": localDisabledReason ?? "Local computer control isn't ready.",
    "vm-unavailable": "The Local VM isn't available for this bot",
    off: "This bot's computer is off",
    error: "Couldn't reach the computer",
  } satisfies Record<Exclude<Phase, "ready" | "local" | "vm">, string>;

  return (
    <>
    <aside
      className="animate-panel-in relative flex h-full shrink-0 flex-col border-l border-hairline/40 bg-panel"
      style={{ width: panelWidth }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40"
      />
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: true })}
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          title="Bot settings"
        >
          <Settings size={18} />
        </button>
        {androidConnected || browserEnabled ? (
          <div className="flex overflow-hidden rounded-lg border border-hairline/40">
            <button
              onClick={() => selectPanelView("computer")}
              aria-pressed={panelView === "computer"}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 text-[12.5px]",
                panelView === "computer" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              <Monitor size={13} /> Computer
            </button>
            {androidConnected && (
              <button
                onClick={() => selectPanelView("android")}
                aria-pressed={panelView === "android"}
                className={cn(
                  "flex items-center gap-1.5 border-l border-hairline/40 px-2.5 py-1 text-[12.5px]",
                  panelView === "android" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
                )}
              >
                <Smartphone size={13} /> Android
              </button>
            )}
            {browserEnabled && (
              <button
                onClick={() => selectPanelView("browser")}
                aria-pressed={panelView === "browser"}
                className={cn(
                  "flex items-center gap-1.5 border-l border-hairline/40 px-2.5 py-1 text-[12.5px]",
                  panelView === "browser" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
                )}
              >
                <Globe size={13} /> Browser
              </button>
            )}
          </div>
        ) : (
          <span className="text-[15px] font-semibold text-ink">Computer</span>
        )}
        <button
          onClick={() => dispatch({ type: "toggleComputer", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      {panelView === "browser" && browserEnabled ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-2">
          <div className="mb-1.5 flex items-center justify-between text-[13px] text-ink-secondary">
            <span>{bot.name}'s browser</span>
            <button
              onClick={() => void openBrowserLiveView()}
              disabled={browserViewPending}
              className="flex items-center gap-1.5 rounded-md bg-control px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50"
              title="Open this live view in its own browser tab"
            >
              {browserViewPending ? <Loader2 size={12} className="animate-spin" /> : <ExternalLink size={12} />}
              Open in tab
            </button>
          </div>
          {browserViewError && (
            <div className="mb-1.5 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {browserViewError}
            </div>
          )}
          <iframe
            src={`/api/bots/${bot.id}/browser/view-embed`}
            title={`${bot.name}'s browser live view`}
            className="min-h-0 w-full flex-1 rounded-xl border border-hairline/40 bg-card"
          />
          <div className="mt-1.5 text-[12px] text-ink-secondary">
            Live page — click into it to take over any time; hand back when you are done.
          </div>
        </div>
      ) : panelView === "android" && androidConnected ? (
        <div className="flex-1 overflow-y-auto px-4 pt-2">
          <AndroidDevicePanel status={androidStatus} />
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto px-5 pb-5">
          {/* Screen preview */}
          <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
            <span>{bot.name}'s screen</span>
            {phase === "local" && <span className="text-[11px]">this computer</span>}
            {phase === "vm" && <span className="text-[11px]">Local VM</span>}
            {cloudBackend === "vps" && (phase === "ready" || phase === "starting") && <span className="text-[11px]">self-hosted VPS</span>}
        </div>
        <div className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
          {frameSrc && previewOpensDesktop ? (
            <button
              type="button"
              onClick={() => void openDesktop()}
              disabled={controlPending || pending === "join"}
              className="group relative flex h-full w-full cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait"
              aria-label={`Open ${bot.name}'s live desktop`}
              title="Open live desktop"
            >
              <img
                src={frameSrc}
                alt={`${bot.name}'s screen`}
                className="h-full w-full object-contain transition group-hover:brightness-75 group-focus-visible:brightness-75"
              />
              <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white opacity-80 shadow-sm transition group-hover:opacity-100 group-focus-visible:opacity-100">
                {pending === "join" ? <Loader2 size={12} className="animate-spin" /> : <Maximize2 size={12} />}
                Open
              </span>
            </button>
          ) : frameSrc ? (
            <img
              src={frameSrc}
              alt={`${bot.name}'s screen`}
              className="h-full w-full object-contain"
              title={phase === "vm" ? "Watch-only preview" : undefined}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
              {phase === "checking" || phase === "starting" || phase === "vm" || (phase === "local" && !isLinux) ? (
                <Loader2 size={18} className="animate-spin" />
              ) : phase === "off" ? (
                <Power size={22} />
              ) : (
                <Monitor size={22} />
              )}
              <span className="text-[12px]">
                {phase === "ready"
                  ? "Waiting for the first frame…"
                  : phase === "vm"
                    ? "Capturing the Local VM screen…"
                  : phase === "local"
                    ? isLinux
                      ? "Ready for approved bot actions. Start the separate preview below when you want to watch the screen."
                      : localMisses >= 3
                      ? "No frames yet — the preview needs Screen Recording permission. After granting, relaunch the app."
                      : "Capturing this computer's screen…"
                    : emptyState[phase]}
              </span>
              {phase === "local" && !isLinux && localMisses >= 3 && (
                <button
                  onClick={() => window.ogb?.permOpenSettings?.("screen")}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  Open Settings
                </button>
              )}
              {phase === "vm-unavailable" && (
                vmStatus?.mode === "per-bot" && vmStatus.image && vmStatus.create_supported ? (
                  <button
                    onClick={() => void runVmAction(vmStatus.container === "missing" ? "vm-create" : "vm-recreate")}
                    disabled={pending !== null}
                    className="mt-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                  >
                    {(pending === "vm-create" || pending === "vm-recreate") && (
                      <Loader2 size={13} className="mr-1.5 inline animate-spin" />
                    )}
                    {vmStatus.container === "missing" ? `Create ${bot.name}'s VM` : `Replace ${bot.name}'s VM`}
                  </button>
                ) : (
                  <button
                    onClick={openVmSettings}
                    className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                  >
                    Open Local VM setup
                  </button>
                )
              )}
              {(phase === "vps-unconfigured" || phase === "vps-stopped") && (
                <button
                  onClick={openConnectionSettings}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  Open VPS settings
                </button>
              )}
              {(phase === "vps-stopped" || (phase === "vps-unconfigured" && vpsStatus?.configured)) &&
                (bot.computer === "cloud" || bot.autoStartVps) && (
                <button
                  onClick={() => run("provision")}
                  disabled={pending === "provision"}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50"
                >
                  {pending === "provision" && <Loader2 size={13} className="mr-1.5 inline animate-spin" />}
                  {phase === "vps-stopped" ? "Start VPS computer" : "Prepare VPS computer"}
                </button>
              )}
              {phase === "vps-incompatible" && vpsStatus?.managed &&
                (bot.computer === "cloud" || bot.autoStartVps) && (
                <button
                  onClick={() => void replaceVpsComputer()}
                  disabled={pending === "vps-replace"}
                  className="mt-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                >
                  {pending === "vps-replace" && <Loader2 size={13} className="mr-1.5 inline animate-spin" />}
                  Replace VPS computer
                </button>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}
        {phase === "unconfigured" && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <div className="mb-3 text-[13px] text-ink-secondary">
              Add a Box API key to give this bot a cloud computer — it spins up right here.
            </div>
            <ApiKeyRow
              section="box"
              onSaved={(configured) => configured && setRetry((n) => n + 1)}
            />
          </div>
        )}
        {phase === "vps-unconfigured" && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <div className="mb-3 text-[13px] text-ink-secondary">
              Configure the VPS SSH alias in App Settings → Connections. Auto only reuses an existing ready container.
            </div>
            <button
              onClick={openConnectionSettings}
              className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
            >
              Open VPS settings
            </button>
          </div>
        )}

        {phase === "vm" &&
          vmStatus?.mode === "per-bot" &&
          window.ogb?.desktopWorkspace &&
          onOpenVmWorkspace && (
            <button
              type="button"
              onClick={() => onOpenVmWorkspace(bot.id)}
              disabled={pending !== null}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-accent/30 bg-accent/10 py-2 text-[13px] font-medium text-ink hover:bg-accent/15 disabled:opacity-50"
              title="Watch two Local VM desktops together without pausing either bot"
            >
              <Columns2 size={14} />
              Open two desktops
            </button>
          )}

        {/* Who is driving — take the wheel / hand it back */}
        {(phase === "ready" || phase === "vm") && control.helpReason && !control.held && (
          <div className="mt-3 rounded-xl border border-warning/25 bg-warning/10 p-4">
            <div className="text-[13px] leading-relaxed text-warning">
              <b>{bot.name}</b> asked for your hands: {control.helpReason}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() =>
                  phase === "vm" || phase === "ready" ? void openDesktop() : controlAction("take")
                }
                disabled={controlPending || pending === "join"}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
                Take control
              </button>
              <button
                onClick={() => controlAction("dismiss-help")}
                disabled={controlPending}
                className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {(phase === "ready" || phase === "vm") && control.held && (
          <div className="mt-3 rounded-xl border border-accent/25 bg-accent/10 p-4">
            <div className="text-[13px] leading-relaxed text-ink">
              You have the wheel — the bot's clicks and keystrokes are refused until you hand it back.
              {phase === "ready" && " Use Open desktop to drive."}
              {phase === "vm" && " Use Open desktop to drive — the preview here is watch-only."}
            </div>
            <button
              onClick={() => {
                controlAction("release");
                void window.ogb?.desktopViewer?.close(bot.id);
              }}
              disabled={controlPending}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              <Hand size={14} />
              Hand control back
            </button>
          </div>
        )}
        {phase === "vm" && vmViewerUrl && control.held && (
          <button
            onClick={() => void openDesktop()}
            disabled={pending === "join"}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            title="Open the Local VM's live desktop inside OpenMausBot"
          >
            {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
            Open live desktop
          </button>
        )}
        {phase === "vm" && !control.held && !control.helpReason && (
          <button
            onClick={() => void openDesktop()}
            disabled={controlPending || pending === "join" || !vmViewerUrl}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            title="Pause the bot's hands and open the Local VM's live desktop"
          >
            {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
            Take control
          </button>
        )}
        {phase === "vm" && vmStatus?.mode === "per-bot" && (
          <button
            onClick={() => void runVmAction("vm-delete")}
            disabled={pending !== null || bot.busy}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-danger/30 py-2 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50"
            title={bot.busy ? "Stop this bot's turn before deleting its VM" : `Delete ${bot.name}'s Local VM`}
          >
            {pending === "vm-delete" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            Delete this bot's VM
          </button>
        )}
        {/* Cloud-only actions */}
        {phase === "ready" && (
          <div className="mt-3 flex gap-2">
            {!control.held && !control.helpReason && (
              <button
                onClick={() =>
                  void openDesktop()
                }
                disabled={controlPending || pending === "join"}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title="Pause the bot's hands and drive this computer yourself"
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
                Take control
              </button>
            )}
            {control.held && (
              <button
                onClick={() => void openDesktop()}
                disabled={pending === "join"}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
                Open live desktop
              </button>
            )}
            {(cloudBackend === "vps" || boxState !== "archived") && (
              <button
                onClick={() => run("sleep")}
                disabled={pending === "sleep"}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title="Put the computer to sleep"
              >
                {pending === "sleep" ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}
                Sleep
              </button>
            )}
          </div>
        )}

        <LocalScreenPreview />
        <LinuxLocalControl />
        <MacLocalControl />

        {/* Computer source */}
          <div className="mt-4 rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Runs on</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {!bot.computer &&
                (isLinux || !localSelectable
                  ? cloudBackend === "vps"
                    ? "Auto reuses a ready VPS when one is configured; otherwise computer use stays off. "
                    : `${linuxAutoDescription()} `
                  : cloudBackend === "vps"
                    ? "Auto reuses a ready VPS when one exists, otherwise this computer. "
                    : "Auto uses a cloud box when one exists, otherwise this computer. ")}
              Pick where this bot's computer lives. <b className="text-ink">Local VM</b> is a Cua-controlled Linux desktop
              in a container on this machine — free and separate from your own desktop. Set it up in App
              Settings → Local VM.
          </div>
          <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
            {(
              [
                ["cloud", "Cloud"],
                ["vm", "Local VM"],
                ["local", "This computer"],
                ["off", "Off"],
              ] as const
            ).map(([mode, label], i) => (
              (() => {
                const disabled =
                  (mode === "cloud" && !cloudSupported) ||
                  (mode === "vm" && !vmSupported) ||
                  (mode === "local" && !localSelectable);
                const unavailableTitle =
                  mode === "vm" && !vmSupported
                    ? "This model engine cannot use the Local VM"
                    : mode === "cloud" && !cloudSupported
                      ? "This model engine cannot use cloud computer tools"
                      : mode === "local" && !localSelectable
                        ? localDisabledReason ?? "Local computer control isn't ready"
                          : undefined;
                return (
              <button
                key={mode}
                disabled={disabled}
                title={unavailableTitle}
                onClick={() => {
                  if (mode === bot.computer) return;
                  if (mode === "local" && bot.autoApprove) setLocalAutoWarning(true);
                  else dispatch({ type: "updateBot", botId: bot.id, patch: { computer: mode } });
                }}
                className={cn(
                  "flex-1 py-1.5 text-[13px]",
                  i > 0 && "border-l border-hairline/40",
                  disabled && "cursor-not-allowed opacity-40",
                  bot.computer === mode
                    ? "bg-control text-ink"
                    : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                )}
              >
                {label}
              </button>
                );
              })()
            ))}
          </div>
          {(!bot.computer || bot.computer === "cloud") && (
            <>
              <CloudBackendPicker
                value={cloudBackend}
                vpsSupported={vpsSupported}
                onChange={(backend) => dispatch({ type: "updateBot", botId: bot.id, patch: { cloudBackend: backend } })}
              />
              {!bot.computer && cloudBackend === "vps" && (
                <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-inset px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px] text-ink">Start VPS automatically</div>
                    <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                      Off by default. When enabled, Auto may create or wake this bot's managed container.
                    </div>
                  </div>
                  <Switch
                    checked={Boolean(bot.autoStartVps)}
                    aria-label="Start VPS automatically"
                    onClick={() => dispatch({
                      type: "updateBot",
                      botId: bot.id,
                      patch: { autoStartVps: !bot.autoStartVps },
                    })}
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Routines */}
        <div className="mt-4 rounded-xl bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
              <CalendarClock size={16} className="text-accent" />
              Scheduled tasks
            </div>
            {botRoutines.length > 0 && (
              <span className="rounded-full bg-control px-2 py-0.5 text-[10px] font-medium text-ink-secondary">
                {botRoutines.length}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Schedule work for {bot.name}. Use its current setup, or run the whole job inside its cloud VM.
          </div>
          {!computerDestination && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-[11.5px] leading-relaxed text-warning">
              <Power size={13} className="mt-0.5 shrink-0" />
              Scheduled tasks on this computer will not have desktop access while this is Off. Choose Cloud VM in the schedule editor to run the whole job there.
            </div>
          )}
          {activeRoutineRun && (
            <button
              onClick={() => dispatch({ type: "showRoutines" })}
              className="mt-3 flex w-full items-center gap-2 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-left text-[12px] text-accent hover:bg-accent/15"
            >
              <Loader2 size={13} className={activeRoutineRun.status === "queued" ? "" : "animate-spin"} />
              <span className="min-w-0 flex-1 truncate">
                {activeRoutineRun.routineName} · {activeRoutineRun.status === "waiting" ? "needs you" : activeRoutineRun.status}
              </span>
            </button>
          )}
          {botRoutines.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {botRoutines.slice(0, 3).map((routine) => (
                <button
                  key={routine.id}
                  onClick={() => dispatch({ type: "showRoutines" })}
                  className="flex w-full items-center gap-2 rounded-lg bg-inset px-3 py-2 text-left hover:bg-control/60"
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", routine.enabled ? "bg-success" : "bg-ink-secondary/40")} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-ink">{routine.name}</span>
                    <span className="block truncate text-[10.5px] text-ink-secondary">
                      {routineScheduleLabel(routine)}{routine.runOn === "cloud" ? " · runs on VM" : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-ink-secondary">{nextRunLabel(routine.nextRunAt)}</span>
                </button>
              ))}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => setCreatingRoutine(true)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110"
            >
              <Plus size={14} />
              Create schedule
            </button>
            <button
              onClick={() => dispatch({ type: "showRoutines" })}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
              title="Open schedules"
            >
              <CalendarDays size={14} />
              Schedules
            </button>
          </div>
        </div>
      </div>
      )}
      {creatingRoutine && (
        <RoutineEditor
          bots={[bot]}
          lockedBotId={bot.id}
          defaultRunOn={cloudRoutineReady ? "cloud" : "maus"}
          onClose={() => setCreatingRoutine(false)}
        />
      )}
    </aside>
    <LocalComputerAutoWarning
      open={localAutoWarning}
      onCancel={() => setLocalAutoWarning(false)}
      onConfirm={() => {
        dispatch({ type: "updateBot", botId: bot.id, patch: { computer: "local", acknowledgeLocalAuto: true } });
        setLocalAutoWarning(false);
      }}
    />
    </>
  );
}
