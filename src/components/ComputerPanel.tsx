import { boatCapableEngine, cloudEngineOf } from "@/lib/remote-desktop";
import { canWorkOnCloud } from "../../shared/cloud-computer";
// The bot's computer, in the right-side slot. Where it runs decides the
// whole flow: explicit cloud → provision the boat on open (idempotent) and preview
// via SSE frames or a ~4s screenshot poll. macOS local mode keeps the legacy
// in-panel capture. Linux local mode is an automation readiness state and its
// separate preview remains explicitly user-initiated. Auto only reads an
// existing Boat's state: opening this panel never creates, wakes, bootstraps
// or opens one. A conversation's selected surface owns its preview;
// its profile default owns lifecycle actions and the Works on picker.
// An inherited team Boat is shown as a shared resource, managed from Team map;
// it must never fall back to this host or become a private Cloud selection.
import { Switch } from "./SettingsPrimitives";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { waitForLocalVmReady } from "@/lib/local-vm-readiness";
import {
  CalendarClock,
  Columns2,
  Box,
  Check,
  Cloud,
  FolderOpen,
  Sparkles,
  Globe,
  Hand,
  Loader2,
  Maximize2,
  Monitor,
  Moon,
  Power,
  Settings,
  Smartphone,
  X,
} from "lucide-react";
import { api, ApiError, currentTaskBot, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { setAdvancedMode, useAdvancedMode } from "@/lib/interface-mode";
import { ComputerFilesPane } from "./ComputerFilesPane";
import { effectivePlace, isComputerPlace, placeLabelKey, placeOffered } from "@/lib/place";
import type { CloudBackend, VmOs } from "../../shared/wire";
import { ApiKeyRow } from "./ApiKeys";
import { cn } from "@/lib/cn";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { usePageVisible } from "@/lib/page-visible";
import { listenLiveFrames } from "@/lib/live-events";
import { CloudScreenPreview } from "./CloudScreenPreview";
import { isActiveTurnRefusal, isRemoteScreenshotContention } from "@/lib/remote-desktop";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { RoutinesSection } from "./bot-settings/RoutinesSection";
import { routineRunLabel, routineRunTone } from "@/lib/routine-display";
import { AndroidDevicePanel, useAndroidUsbDevices } from "./AndroidDevicePanel";
import { BrowserPanel } from "./BrowserPanel";
import { browserAvailable, browserUnavailableReason, builtInBrowserEnabled } from "@/lib/feature-flags";
import { transitionComputerControlLease, type ComputerControlAction } from "@/lib/computer-control";
import { LocalScreenPreview } from "./LocalScreenPreview";
import { LinuxLocalControl } from "./LinuxLocalControl";
import { MacLocalControl } from "./MacLocalControl";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import {
  instanceSupportsLocalComputer,
  localComputerDisabledReason,
  localComputerSelectable,
  persistedComputerSelectionMatches,
  isReadyBoatState,
  resolveBoatPanelAction,
  shouldPollCloudPreview,
} from "@/lib/local-computer";
import {
  readComputerPanelView,
  writeComputerPanelView,
  type ComputerPanelView,
} from "@/lib/computer-panel-view";
import { approvalModeFor } from "../../shared/approval-mode";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

/** Keep local failure copy translatable while it remains in panel state. */
class LocalizedPanelError extends Error {
  constructor(
    readonly key: LocaleKey,
    readonly problem?: string | null,
    readonly fallbackKey?: LocaleKey,
  ) {
    super(key);
  }
}

function panelErrorText(error: Error | string | null): string | null {
  if (error instanceof LocalizedPanelError) {
    return t(error.key, error.fallbackKey ? { problem: error.problem ?? t(error.fallbackKey) } : undefined);
  }
  return error instanceof Error ? error.message : error;
}

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
  | "busy-boat"
  | "ready"
  | "vm"
  | "vm-unavailable"
  | "vps-unconfigured"
  | "vps-incompatible"
  | "vps-stopped"
  | "local"
  | "local-unavailable"
  | "auto-unavailable"
  | "team-boat"
  | "show-ready-boat"
  | "show-sleeping-boat"
  | "show-pending-boat"
  | "browser"
  | "off"
  | "error";

interface LocalVmStatus {
  backend?: "container" | "cua-spaces";
  os?: VmOs;
  /** Optional: a hosted server can lag behind this app. */
  resumable?: boolean;
  stop_reason?: "idle" | null;
  mode: "shared" | "per-bot" | "pool";
  max_instances: number;
  image?: boolean;
  create_supported: boolean;
  container: "running" | "stopped" | "missing";
  imageMatches?: boolean;
  managed: boolean;
  network?: "loopback" | "unsafe" | "unknown";
  security?: "hardened" | "unsafe" | "unknown";
  persistence?: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  ready: boolean;
  problem: string | null;
  viewer_url: string;
}

const computerControlSnapshotSchema = z.object({
  held: z.boolean().optional().default(false),
  helpReason: z.string().nullable().optional().default(null),
}).passthrough();

const PANEL_WIDTH_KEY = "omb-computer-panel-width";
const PANEL_MIN_WIDTH = 360;
const PANEL_MAX_WIDTH = 960;
const PANEL_DEFAULT_WIDTH = 400;
const PANEL_RESIZE_STEP = 40;

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
  bot: profileBot,
  onOpenVmWorkspace,
}: {
  bot: Bot;
  onOpenVmWorkspace?: (botId: string) => void;
}) {
  // Docked flush under the Windows caption corner: drop the header 16px.
  const { padClass } = useCaptionChrome();
  // The panel is a fixed column by default; a drag handle on its left edge
  // makes it wide enough to actually read a page in the Browser tab.
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const persistPanelWidth = (width: number) => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(width));
    } catch {
      /* storage blocked — width lives for this session */
    }
  };
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
    persistPanelWidth(panelWidth);
  };
  /** Keyboard resize: the same clamp and stored preference the pointer flow
   * uses, so arrow-key changes stay in React state like a drag would. */
  const onResizeBy = (delta: number) => {
    setPanelWidth((current) => {
      const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, current + delta));
      persistPanelWidth(next);
      return next;
    });
  };
  const separatorRef = useRef<HTMLDivElement>(null);
  const [separatorWidth, setSeparatorWidth] = useState<number | null>(null);
  useEffect(() => {
    // The width state lives with the panel; mirror the styled panel only
    // so the slider semantics stay truthful for assistive tech.
    const panel = separatorRef.current?.closest("aside");
    if (!panel) return;
    const read = () => setSeparatorWidth(panel.offsetWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const onSeparatorKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const widen = event.key === "ArrowLeft" ? PANEL_RESIZE_STEP : event.key === "ArrowRight" ? -PANEL_RESIZE_STEP : null;
    if (widen === null || separatorWidth === null) return;
    event.preventDefault();
    onResizeBy(widen);
  };
  const { state, dispatch, flushBotPatches } = useStore();
  // Where this bot's current conversation works and whether a turn is acting
  // there now: the tab for that place carries the live dot.
  const liveTask = profileBot.tasks?.find((task) => task.threadId === profileBot.threadId);
  const livePlace = effectivePlace(profileBot, liveTask);
  const threadBot = currentTaskBot(profileBot);
  const connectionKey = `${profileBot.id}:${profileBot.threadId}:${livePlace}:${profileBot.cloudBackend ?? "box"}:${threadBot.modelSelection.instanceId}:${state.config?.localVm?.backend ?? "container"}:${profileBot.vmOs ?? state.config?.localVm?.spacesOs ?? "linux"}`;
  const [autoSurface, setAutoSurface] = useState<{ key: string; surface: Bot["computer"] } | null>(null);
  const autoSurfaceCurrent = autoSurface?.key === connectionKey;
  const surfaceReady = livePlace !== "auto" || autoSurfaceCurrent;
  // Profile defaults still belong to the Works on picker below. The screen
  // and capability checks belong to the selected conversation, not that default.
  const bot = { ...threadBot, computer: livePlace === "auto"
    ? autoSurfaceCurrent ? autoSurface.surface : undefined : livePlace };
  const viewerConnectionKey = `${bot.id}:${bot.threadId}:${bot.computer}:${bot.cloudBackend ?? "box"}:${state.config?.localVm?.backend ?? "container"}:${bot.vmOs ?? state.config?.localVm?.spacesOs ?? "linux"}`;
  const viewerConnection = useRef(viewerConnectionKey);
  viewerConnection.current = viewerConnectionKey;
  const desktopJoin = useRef<AbortController | null>(null);
  useEffect(() => () => desktopJoin.current?.abort(), [viewerConnectionKey]);
  const placeLive = Boolean(bot.busy);
  const threadPath = useCallback((suffix: string) =>
    `/api/bots/${profileBot.id}/${suffix}?threadId=${encodeURIComponent(profileBot.threadId)}`,
  [profileBot.id, profileBot.threadId]);
  const canManageCloud = profileBot.computer === "cloud" && livePlace === "cloud";
  const canManageVm = profileBot.computer === "vm" && livePlace === "vm";
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const localAvailable = capabilities.localComputer.available;
  const isLinux = capabilities.host.platform === "linux";
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  // An OMB Cloud home never offers this computer (shared/cloud-home.ts).
  const localSelectable = placeOffered("local", state.config) && localComputerSelectable({ capabilities, providerSupportsLocal });
  const [localAutoWarningTarget, setLocalAutoWarningTarget] = useState<string | null>(null);
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const [phase, setPhase] = useState<Phase>("checking");
  const [persistedComputerSelection, setPersistedComputerSelection] = useState<{
    botId: string;
    computer: Bot["computer"];
    cloudBackend: CloudBackend;
    section: string;
  } | null>(null);
  const [resolvedComputerSelection, setResolvedComputerSelection] = useState<{
    botId: string;
    threadId: string;
    computer: Bot["computer"];
    cloudBackend: CloudBackend;
  } | null>(null);
  const [teamComputer, setTeamComputer] = useState<{
    id: string; name: string; botId: string; section: string;
  } | null>(null);
  const cloudBackend = bot.cloudBackend ?? "box";
  const computerSelectionPersisted = Boolean(
    persistedComputerSelection
      && persistedComputerSelection.botId === bot.id
      && persistedComputerSelection.computer === profileBot.computer
      && persistedComputerSelection.cloudBackend === cloudBackend
      && persistedComputerSelection.section === (bot.section?.trim() ?? ""),
  );
  const computerStatusCurrent = Boolean(
    resolvedComputerSelection
      && resolvedComputerSelection.botId === bot.id
      && resolvedComputerSelection.threadId === bot.threadId
      && resolvedComputerSelection.computer === bot.computer
      && resolvedComputerSelection.cloudBackend === cloudBackend,
  );
  const currentTeamComputer = computerStatusCurrent && livePlace === "auto" && cloudBackend === "box"
    && teamComputer?.botId === bot.id && teamComputer.section === (bot.section?.trim() ?? "")
    ? teamComputer : null;
  const cloudPreviewReady = computerStatusCurrent && shouldPollCloudPreview({
    computer: bot.computer,
    cloudBackend,
    phase,
    botId: bot.id,
    resolvedBotId: resolvedComputerSelection?.botId ?? null,
    resolvedComputer: resolvedComputerSelection?.computer ?? null,
    resolvedCloudBackend: resolvedComputerSelection?.cloudBackend ?? null,
  });
  const updateComputerSelection = useCallback((patch: {
    computer?: Bot["computer"] | null;
    cloudBackend?: CloudBackend;
    browser?: boolean;
    acknowledgeLocalAuto?: boolean;
  }) => {
    // Clear old-provider UI in the same render as the optimistic profile
    // change. The resolving effect waits for its PATCH before doing any work.
    setResolvedComputerSelection(null);
    setTeamComputer(null);
    setPhase("checking");
    dispatch({ type: "updateBot", botId: bot.id, patch });
  }, [bot.id, dispatch]);
  useEffect(() => {
    let alive = true;
    setPersistedComputerSelection(null);
    void flushBotPatches(bot.id).then((persistedBot) => {
      if (!alive) return;
      if (persistedBot && !persistedComputerSelectionMatches({
        computer: profileBot.computer,
        cloudBackend,
        persistedBot,
      })) return;
      if (persistedBot && (persistedBot.section?.trim() ?? "") !== (bot.section?.trim() ?? "")) return;
      setPersistedComputerSelection({
        botId: bot.id,
        computer: profileBot.computer,
        cloudBackend,
        section: bot.section?.trim() ?? "",
      });
    });
    return () => {
      alive = false;
    };
  }, [bot.id, profileBot.computer, bot.section, cloudBackend, flushBotPatches]);
  const [boatState, setBoatState] = useState<string | null>(null);
  const [polledFrame, setPolledFrame] = useState<{ png: string; mime: string } | null>(null);
  const [previewError, setPreviewError] = useState<Error | string | null>(null);
  const [previewRefreshing, setPreviewRefreshing] = useState(false);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [vmFrame, setVmFrame] = useState<string | null>(null);
  // The Local VM's interactive noVNC viewer (passworded, autoconnect). The
  // preview below is a periodic screenshot that swallows clicks — this URL is
  // the only way a person can actually drive the VM.
  const [vmViewerUrl, setVmViewerUrl] = useState<string | null>(null);
  const [vmStatus, setVmStatus] = useState<LocalVmStatus | null>(null);
  const [vpsStatus, setVpsStatus] = useState<VpsComputerStatus | null>(null);
  const cua = vmStatus?.backend === "cua-spaces";
  const cuaPool = cua && (vmStatus?.mode === "pool" || state.config?.localVm?.mode === "pool");
  // Cua's viewer opens in the app's own desktop window, on this computer only.
  const cuaViewerAvailable = capabilitiesReady && capabilities.host.platform !== "other"
    && window.ogb?.remoteClient?.active !== true && Boolean(window.ogb?.desktopViewer);
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [pending, setPending] = useState<
    "join" | "sleep" | "provision" | "vps-replace" | "vm-start" | "vm-create" | "vm-recreate" | "vm-delete" | null
  >(null);
  const [controlPending, setControlPending] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [error, setError] = useState<Error | string | null>(null);
  const errorText = panelErrorText(error);
  // Simple mode shows Computer | Browser | Files; Advanced keeps Computer |
  // Routines | Android | Browser. A view stored by the other mode reads as
  // the Computer tab instead of an empty pane.
  const advanced = useAdvancedMode();
  const [storedPanelView, setPanelView] = useState<ComputerPanelView>(() => readComputerPanelView(bot.id));
  const panelView: ComputerPanelView = advanced
    ? storedPanelView === "files" ? "computer" : storedPanelView
    : storedPanelView === "routines" || storedPanelView === "android" ? "computer" : storedPanelView;
  const androidStatus = useAndroidUsbDevices();
  const androidConnected = androidStatus.devices.length > 0;
  // Keep installation reachable before the engine is ready. Actual browser
  // operations below still require browserAvailableHere.
  const browserAvailableHere = browserAvailable(state.config);
  const browserEnabled = builtInBrowserEnabled(state.config) && bot.browser !== false
    && (browserAvailableHere || state.config?.browserEngine?.installable === true);
  // bumped when a Boat API key is saved inline, to re-run the spin-up flow
  const [retry, setRetry] = useState(0);
  // Auto is a server decision (including an existing Local VM). Do not guess
  // host-vs-cloud from desktop capabilities and show a different computer.
  useEffect(() => {
    if (livePlace !== "auto" || !computerSelectionPersisted) return;
    const controller = new AbortController();
    setAutoSurface(null);
    void api(threadPath("computer"), { signal: controller.signal }).then((status) => {
      if (controller.signal.aborted) return;
      const surface = status.surface;
      setAutoSurface({ key: connectionKey, surface:
        surface === "cloud" || surface === "vm" || surface === "local" || surface === "browser" || surface === "off"
          ? surface : undefined });
    }).catch((cause) => {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause : String(cause));
      setPhase("error");
    });
    return () => controller.abort();
  }, [connectionKey, livePlace, computerSelectionPersisted, threadPath, retry]);
  const vmResumable = phase === "vm-unavailable" && vmStatus?.resumable === true;
  const vmStartable = vmResumable || (cua && phase === "vm-unavailable"
    && vmStatus?.managed === true && vmStatus.container === "running");
  const vmReadinessAttempts = useRef(0);
  const vmActionController = useRef<AbortController | null>(null);
  useEffect(() => {
    if (vmActionController.current?.signal.aborted) {
      vmActionController.current = null;
      setPending(null);
    }
    return () => { vmActionController.current?.abort(); };
  }, [bot.id, bot.threadId, bot.computer, panelView]);
  const selectedInstance = state.instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  );
  // "Works on: Browser" needs the same things as the browser switch minus
  // the switch itself — picking it turns the switch on. The boat-native
  // Computer engine runs inside the boat, so it has no browser-only mode.
  const browserSelectable =
    builtInBrowserEnabled(state.config) &&
    browserAvailableHere &&
    selectedInstance?.capabilities?.browserMcp === true &&
    selectedInstance.driverKind !== "boxAgent";
  const browserDisabledReason = !browserAvailableHere
    ? browserUnavailableReason(state.config)
    : !builtInBrowserEnabled(state.config)
      ? t("computer.err.browserOff")
      : t("computer.err.browserEngine");

  const selectPanelView = (view: ComputerPanelView) => {
    setPanelView(view);
    writeComputerPanelView(bot.id, view);
  };

  const previousPanelTarget = useRef<string | null>(null);
  useEffect(() => {
    // Restore a manually chosen tab on reopen. After a real thread/place
    // change, follow that target once; busy/tool events never steal the tab.
    const previous = previousPanelTarget.current;
    if (previous === viewerConnectionKey && !(bot.computer === "browser" && browserEnabled)) return;
    previousPanelTarget.current = viewerConnectionKey;
    setPanelView(bot.computer === "browser" && browserEnabled ? "browser"
      : previous === null ? readComputerPanelView(bot.id) : "computer");
  }, [viewerConnectionKey, bot.id, bot.computer, browserEnabled]);

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
    // Simple mode keeps the Browser tab when the browser is off: it explains
    // how to turn it on instead of disappearing.
    if (!androidConnected && panelView === "android") {
      setPanelView("computer");
      writeComputerPanelView(bot.id, "computer");
    }
  }, [androidConnected, bot.id, panelView]);
  useEffect(() => {
    vmReadinessAttempts.current = 0;
  }, [bot.id, bot.computer]);
  const vmSupported = Boolean(
    selectedInstance?.snapshot.state === "available" &&
      selectedInstance.capabilities?.computerMcp &&
      selectedInstance.driverKind !== "boxAgent",
  );
  const vpsSupported = canWorkOnCloud(cloudEngineOf(selectedInstance), "vps");
  const cloudSupported = canWorkOnCloud(cloudEngineOf(selectedInstance), cloudBackend === "vps" ? "vps" : "box");
  const botRoutines = state.routines
    .filter((routine) => routine.botId === bot.id)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
  const cloudRoutineReady = Boolean(
    state.config?.box.configured &&
      boatCapableEngine(state.instances, bot.modelSelection.instanceId)?.snapshot.state === "available",
  );
  const activeRoutineRun = state.routineRuns.find(
    (run) => run.botId === bot.id && ["queued", "running", "waiting"].includes(run.status),
  );
  // resolve the mode on open; boat endpoints are only ever hit on the
  // cloud path, so local/off can never render a JSON error as an image
  useEffect(() => {
    // Other tabs own their surfaces. Do not provision a VM, wake a boat,
    // or churn preview state while reading routine history.
    if (panelView !== "computer") return;
    let alive = true;
    let boatRetryTimer: number | undefined;
    setResolvedComputerSelection(null);
    setTeamComputer(null);
    setPhase("checking");
    setPolledFrame(null);
    setPreviewError(null);
    setVmFrame(null);
    setVmViewerUrl(null);
    setVmStatus(null);
    setVpsStatus(null);
    setLocalFrame(null);
    setError(null);
    // The selection may be optimistic for up to the profile debounce. Never
    // let it choose a provider until the PATCH lane confirms server state.
    if (!computerSelectionPersisted || !surfaceReady) return;
    if (bot.computer === undefined) {
      setPhase("auto-unavailable");
      return;
    }

    if (bot.computer === "off") {
      setPhase("off");
      return;
    }
    // Browser-only bots own no desktop: the Browser tab is their whole
    // screen, so this tab must not wake a boat or start host capture.
    if (bot.computer === "browser") {
      setPhase("browser");
      return;
    }
    if (bot.computer === "local") {
      if (!providerSupportsLocal) {
        setError(new LocalizedPanelError("computer.err.localEngine"));
      }
      setPhase(capabilitiesReady && localAvailable && providerSupportsLocal ? "local" : "local-unavailable");
      setResolvedComputerSelection({ botId: bot.id, threadId: bot.threadId, computer: bot.computer, cloudBackend });
      return;
    }
    if (bot.computer === "vm") {
      if (!vmSupported) {
        setError(new LocalizedPanelError("computer.err.vmEngine"));
        setPhase("vm-unavailable");
        return;
      }
      let retryTimer: number | undefined;
      api(threadPath("local-computer"))
        .then((rawStatus) => {
          if (!alive) return;
          const status: LocalVmStatus = rawStatus;
          setResolvedComputerSelection({ botId: bot.id, threadId: bot.threadId, computer: bot.computer, cloudBackend });
          setVmStatus(status);
          // parse at the boundary: our own status endpoint sends a string or nothing
          const viewerUrl = status.backend === "cua-spaces" ? "" : String(status.viewer_url ?? "");
          if (viewerUrl.startsWith("http") || viewerUrl.startsWith("/desktop-viewer#")) {
            setVmViewerUrl(new URL(viewerUrl, window.location.href).href);
          }
          if (status.ready) {
            vmReadinessAttempts.current = 0;
            setPhase("vm");
          } else if (
            status.container === "running" &&
            (status.backend === "cua-spaces" ? status.managed : (
              status.imageMatches &&
              status.managed &&
              status.network === "loopback" &&
              status.security === "hardened" &&
              status.persistence === "durable"
            )) &&
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
              (status.backend === "cua-spaces" ? status.mode !== "pool" && state.config?.localVm?.mode !== "pool" : status.mode === "per-bot") &&
              status.container === "missing" &&
              (status.backend === "cua-spaces" || status.image) &&
              status.create_supported;
            setError(canCreateHere || status.resumable ? null : new LocalizedPanelError(
              "computer.err.vmOpenSettings", status.problem, "computer.err.vmNotReady",
            ));
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
      setError(new LocalizedPanelError("computer.err.cloudEngine"));
      setPhase("error");
      return;
    }
    if (bot.computer !== "cloud" && !capabilitiesReady) return;
    if (cloudBackend === "vps") {
      if (!vpsSupported) {
        setError(new LocalizedPanelError("computer.err.vpsEngine"));
        setPhase("error");
        return;
      }
      api(threadPath("computer"))
        .then((rawStatus) => {
          if (!alive) return;
          const status: VpsComputerStatus = rawStatus;
          setVpsStatus(status);
          setResolvedComputerSelection({
            botId: bot.id,
            threadId: bot.threadId,
            computer: bot.computer,
            cloudBackend,
          });
          if (!status.configured) {
            setError(new LocalizedPanelError("computer.err.vpsAlias"));
            setPhase("vps-unconfigured");
            return;
          }
          if (status.ready) {
            setBoatState(status.container ?? null);
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
          if (canManageCloud) {
            setPhase("starting");
            return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((result) => {
              if (!alive) return;
              setBoatState(result.container ?? null);
              if (result.ready) {
                setResolvedComputerSelection({
                  botId: bot.id,
                  threadId: bot.threadId,
                  computer: bot.computer,
                  cloudBackend,
                });
                setPhase("ready");
              }
              else {
                setError(result.problem ?? new LocalizedPanelError("computer.err.vpsNotReady"));
                setPhase("error");
              }
            });
          }
          setBoatState(status.container ?? null);
          setError(
            bot.autoStartVps
              ? new LocalizedPanelError("computer.err.vpsAuto", status.problem, "computer.err.vpsNoContainer")
              : new LocalizedPanelError("computer.err.vpsManual", status.problem, "computer.err.vpsNoContainer"),
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
    // Explicit Cloud may create/wake its Boat. Auto is observation-only here:
    // even a ready Boat and the boat-native engine stay free of POSTs until the
    // person deliberately chooses Cloud.
    api(threadPath("computer"))
      .then((status) => {
        if (!alive) return;
        const action = resolveBoatPanelAction({
          computer: canManageCloud ? "cloud" : undefined,
          configured: Boolean(status.configured),
          boatState: typeof status.box?.state === "string" ? status.box.state : null,
          canUseCloud: cloudSupported,
          autoLocal: false,
          teamComputer: typeof status.teamComputer?.id === "string" && typeof status.teamComputer?.name === "string",
          busy: profileBot.busy,
        });
        setResolvedComputerSelection({
          botId: bot.id,
          threadId: bot.threadId,
          computer: bot.computer,
          cloudBackend,
        });
        if (!status.configured && bot.computer === "cloud" && !status.teamComputer) {
          setPhase("unconfigured");
          return;
        }
        if (action === "team-boat") {
          setTeamComputer({ id: status.teamComputer.id, name: status.teamComputer.name,
            botId: bot.id, section: bot.section?.trim() ?? "" });
          setBoatState(typeof status.box?.state === "string" ? status.box.state : status.configured ? "missing" : "unavailable");
          setError(typeof status.problem === "string" ? status.problem : null);
          setPhase("team-boat");
          return;
        }
        if (action === "attach-ready-boat" || (bot.computer === "cloud" && action === "show-ready-boat")) {
          // The turn owns a ready boat; provisioning would be refused (409)
          // and is not needed. Going straight to ready lets the turn's live
          // frames and the screenshot poll show what the bot is doing.
          setBoatState(typeof status.box?.state === "string" ? status.box.state : null);
          setPhase("ready");
          return;
        }
        if (action !== "ensure-boat") {
          if (action === "show-ready-boat" || action === "show-sleeping-boat" || action === "show-pending-boat") {
            setBoatState(typeof status.box?.state === "string" ? status.box.state : null);
          }
          setPhase(action);
          return;
        }
        setPhase("starting");
        return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((r) => {
          if (!alive) return;
          setBoatState(r.state ?? null);
          setResolvedComputerSelection({
            botId: bot.id,
            threadId: bot.threadId,
            computer: bot.computer,
            cloudBackend,
          });
          setPhase("ready");
        });
      })
      .catch((e) => {
        if (!alive) return;
        // A turn that started while provision was in flight: not a fault,
        // the panel waits for the turn (bot.busy re-runs this effect).
        if (isActiveTurnRefusal(e)) {
          setPhase("busy-boat");
          return;
        }
        // The panel's own screenshot poll holds this boat's lifecycle claim
        // while it captures, so a provision landing mid-capture is refused
        // with a *different* 409. It is a wait too: re-resolve shortly
        // instead of showing the fault this panel exists to stop showing.
        if (isRemoteScreenshotContention({ status: Number((e as { status?: unknown })?.status ?? 0), message: String(e?.message ?? "") })) {
          setError(null);
          setPhase("checking");
          boatRetryTimer = window.setTimeout(() => setRetry((n) => n + 1), 2000);
          return;
        }
        setError(e.message);
        setPhase("error");
      });
    return () => {
      alive = false;
      if (boatRetryTimer !== undefined) window.clearTimeout(boatRetryTimer);
    };
  }, [
    bot.id,
    bot.threadId,
    bot.computer,
    bot.section,
    bot.autoStartVps,
    cloudBackend,
    state.config?.localVm?.backend,
    state.config?.localVm?.spacesOs,
    bot.vmOs,
    retry,
    capabilitiesReady,
    localSelectable,
    isLinux,
    providerSupportsLocal,
    selectedInstance?.driverKind,
    vmSupported,
    cloudSupported,
    vpsSupported,
    state.config?.vps?.sshAlias,
    panelView,
    computerSelectionPersisted,
    surfaceReady,
    canManageCloud,
    threadPath,
  ]);

  // busy-boat waits for the turn's own provisioning. Nothing else re-runs the
  // resolve effect until the turn ends, so watch the boat ourselves and attach
  // as soon as it is ready — the screen should appear mid-turn, not after.
  useEffect(() => {
    if (phase !== "busy-boat") return;
    let alive = true;
    const check = () => {
      if (!profileBot.busy && canManageCloud) {
        setRetry((n) => n + 1);
        return;
      }
      api(threadPath("computer"))
        .then((status) => {
          if (!alive) return;
          const state = typeof status.box?.state === "string" ? status.box.state : null;
          if (isReadyBoatState(state)) {
            setBoatState(state);
            setPhase("ready");
          }
        })
        .catch(() => { /* the next tick tries again */ });
    };
    const timer = window.setInterval(check, 5_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [phase, threadPath, profileBot.busy, canManageCloud]);

  // Live frames of this conversation's screen come straight from the app's
  // stream, never through the store. Only a frame heard while this preview is
  // up may replace it, and the poll below waits while they keep coming.
  const pageVisible = usePageVisible();
  const lastLiveAt = useRef(0);
  const previewBusy = useRef(bot.busy);
  useEffect(() => { previewBusy.current = bot.busy; }, [bot.busy]);
  useEffect(() => {
    lastLiveAt.current = 0;
    if (!cloudPreviewReady) return;
    return listenLiveFrames({
      onFrame: (frame) => {
        if (frame.kind !== "screen" || frame.botId !== bot.id || frame.threadId !== bot.threadId) return;
        lastLiveAt.current = Date.now();
        setPolledFrame({ png: frame.png, mime: frame.mime ?? "image/png" });
        setPreviewError(null);
        setPreviewRefreshing(false);
      },
    });
  }, [cloudPreviewReady, bot.id, bot.threadId]);

  useEffect(() => {
    if (panelView !== "computer" || !cloudPreviewReady || viewerOpen || !pageVisible || pending || controlPending) return;
    let inFlight = false;
    let lastAttemptAt = -Infinity;
    let retryDelay: number | null = null;
    let contentionSince: number | null = null;
    const controller = new AbortController();
    setPreviewError(null);
    setPreviewRefreshing(true);
    const shoot = async () => {
      if (inFlight || controller.signal.aborted) return;
      if (Date.now() - lastAttemptAt < (retryDelay ?? (previewBusy.current ? 4000 : 30_000))) return;
      // Resume polling if a busy bot stops publishing frames. A single old
      // SSE event is not evidence of a working stream for the whole turn.
      if (previewBusy.current && Date.now() - lastLiveAt.current < 10_000) return;
      inFlight = true;
      retryDelay = null;
      const startedAt = Date.now();
      try {
        const { png, format } = await api(threadPath("computer/screenshot"), {
          method: "POST",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
        });
        if (!controller.signal.aborted && lastLiveAt.current <= startedAt) {
          if (typeof png !== "string" || !png.trim()) throw new LocalizedPanelError("computer.err.emptyFrame");
          setPolledFrame({ png, mime: format === "jpeg" ? "image/jpeg" : "image/png" });
          setPreviewError(null);
          setPreviewRefreshing(false);
          contentionSince = null;
        }
      } catch (e) {
        if (!controller.signal.aborted && lastLiveAt.current <= startedAt) {
          // A canceled client request can leave its capture running on the
          // host. Contention is temporary, not a disconnected computer.
          if (e instanceof ApiError && isRemoteScreenshotContention(e)) {
            retryDelay = 1000;
            contentionSince ??= Date.now();
            const prolonged = Date.now() - contentionSince >= 10_000;
            setPreviewError(prolonged ? e : null);
            setPreviewRefreshing(!prolonged);
          } else {
            contentionSince = null;
            setPreviewRefreshing(false);
            setPreviewError(e instanceof Error && e.name === "TimeoutError"
              ? new LocalizedPanelError("computer.err.frameTimeout")
              : e instanceof Error ? e : new LocalizedPanelError("computer.err.screenUnavailable"));
          }
        }
      } finally {
        inFlight = false;
        lastAttemptAt = Date.now();
      }
    };
    void shoot();
    // Read the current cadence without aborting a capture on every busy
    // transition. Only connection/action changes replace its generation.
    const timer = setInterval(shoot, 1000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [panelView, cloudPreviewReady, threadPath, cloudBackend, viewerOpen, pageVisible, pending, controlPending, previewRetry]);

  // Local VM preview comes directly from Cua Driver through the harness. It
  // does not use the password-protected noVNC viewer or cloud endpoints.
  useEffect(() => {
    if (panelView !== "computer" || phase !== "vm" || !computerStatusCurrent || viewerOpen || !pageVisible) return;
    const controller = new AbortController();
    let inFlight = false;
    let lastAttemptAt = -Infinity;
    let retryDelay: number | null = null;
    let initialAttempt = true;
    const shoot = async () => {
      if (inFlight || controller.signal.aborted) return;
      if (Date.now() - lastAttemptAt < (retryDelay ?? (bot.busy ? 3000 : 30_000))) return;
      inFlight = true;
      retryDelay = null;
      try {
        const { image } = await api(threadPath("local-computer/screenshot"), { method: "POST", signal: controller.signal });
        if (!controller.signal.aborted && typeof image === "string") {
          setVmFrame(image);
          setPreviewError(null);
        }
      } catch (e) {
        // The first miss leaves the pane with nothing to show, so it stays a
        // panel error. Later transient misses are the preview's own retry
        // business — they keep the last frame, back off, and never rewrite
        // the panel banner every tick.
        if (!controller.signal.aborted) {
          retryDelay = 5000;
          if (initialAttempt) setError(e instanceof Error ? e.message : String(e));
          else setPreviewError(e instanceof Error ? e : new LocalizedPanelError("computer.err.screenUnavailable"));
        }
      } finally {
        inFlight = false;
        initialAttempt = false;
        lastAttemptAt = Date.now();
      }
    };
    void shoot();
    const timer = window.setInterval(() => void shoot(), bot.busy ? 3000 : 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [panelView, phase, computerStatusCurrent, threadPath, viewerOpen, pageVisible, bot.busy, setError, setPreviewError, setVmFrame]);

  // local preview: frames from the Electron main process. The FIRST capture
  // attempt is what makes macOS show the Screen Recording prompt (there is
  // no reliable pre-grant flow on macOS 15+), so repeated empty frames mean
  // the user denied — surface the Settings repair path instead of spinning.
  const [localMisses, setLocalMisses] = useState(0);
  useEffect(() => {
    if (panelView !== "computer" || phase !== "local" || !computerStatusCurrent || !window.ogb || isLinux || !pageVisible) return;
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
  }, [panelView, phase, computerStatusCurrent, isLinux, pageVisible, bot.busy, bot.id, bot.threadId]);

  const frameSrc = !computerStatusCurrent ? null :
    phase === "vm"
      ? vmFrame
      : phase === "local" && !isLinux
      ? localFrame
      : cloudPreviewReady || (bot.computer === "cloud" && phase === "starting")
        ? polledFrame && `data:${polledFrame.mime};base64,${polledFrame.png}`
        : null;
  const previewOpensDesktop = Boolean(
    frameSrc &&
      ((phase === "vm" && !cua && vmViewerUrl) || cloudPreviewReady),
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

  // The engine owns its browser; there is no native surface to hold.
  const setNativeBrowserControl = useCallback(async (): Promise<boolean> => true, []);

  const transitionControl = useCallback(async (action: ComputerControlAction) => {
    // BrowserPanel performs the same two-phase transition itself. Every
    // other computer surface must also gate Electron's direct browser host:
    // the server hold is bot-wide, and a shell-capable agent can otherwise
    // bypass the server proxy while the person drives Local VM/Box/VPS.
    return transitionComputerControlLease({
      action,
      syncNativeBrowser: panelView !== "browser",
      requestControl,
      setNativeBrowserControl,
    });
  }, [panelView, requestControl, setNativeBrowserControl]);

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

  /** Cua's own viewer in the app's live-desktop window. Opening it never
   * pauses the bot — the person and the bot can use the Space together;
   * Take control (`takeControl`) holds the computer first, and closing the
   * window hands it back like any live desktop. */
  const openCuaViewer = async (takeControl: boolean) => {
    const viewer = window.ogb?.desktopViewer;
    if (!cuaViewerAvailable || !viewer || desktopJoin.current) return;
    const controller = new AbortController();
    desktopJoin.current = controller;
    const ownsConnection = () => !controller.signal.aborted && viewerConnection.current === viewerConnectionKey;
    setPending("join");
    setControlPending(takeControl);
    setError(null);
    let tookControl = false;
    try {
      if (takeControl && !control.held) {
        await transitionControl("take");
        tookControl = true;
      }
      if (!ownsConnection()) throw new DOMException("The selected conversation changed", "AbortError");
      const result = await api(threadPath("local-computer/viewer"), { method: "POST", body: "{}", signal: controller.signal });
      if (!ownsConnection()) throw new DOMException("The selected conversation changed", "AbortError");
      if (typeof result.url !== "string" || !result.url) throw new LocalizedPanelError("vm.cua.viewerError");
      const opened = await viewer.open(result.url, t("computer.viewerTitle", { name: bot.name }), bot.id);
      if (!opened) throw new LocalizedPanelError("computer.err.openDesktop");
    } catch (cause) {
      if (tookControl) await transitionControl("release").catch(() => {});
      if (ownsConnection()) setError(cause instanceof Error ? cause : String(cause));
    } finally {
      if (desktopJoin.current === controller) {
        desktopJoin.current = null;
        setPending(null);
        setControlPending(false);
      }
    }
  };


  const openDesktop = async () => {
    if (cua) return openCuaViewer(true);
    const controller = new AbortController();
    desktopJoin.current = controller;
    const ownsConnection = () => !controller.signal.aborted && viewerConnection.current === viewerConnectionKey;
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
      if (!ownsConnection()) throw new DOMException("The selected conversation changed", "AbortError");

      let viewerUrl = vmViewerUrl;
      if (cloudPreviewReady) {
        const result = await api(threadPath("computer/join"), { method: "POST", signal: controller.signal });
        viewerUrl = result.joinUrl?.constructor === String ? String(result.joinUrl) : null;
      }
      if (!ownsConnection()) throw new DOMException("The selected conversation changed", "AbortError");
      if (!viewerUrl) throw new LocalizedPanelError("computer.err.noDesktopLink");

      if (window.ogb?.desktopViewer) {
        const opened = await window.ogb.desktopViewer.open(viewerUrl, t("computer.viewerTitle", { name: bot.name }), bot.id);
        if (!opened) throw new LocalizedPanelError("computer.err.openDesktop");
      } else if (fallbackTab) {
        fallbackTab.location.replace(viewerUrl);
      } else if (window.ogb?.openExternal) {
        const opened = await window.ogb.openExternal(viewerUrl);
        if (!opened) throw new LocalizedPanelError("computer.err.openDesktopLink");
      } else if (!window.open(viewerUrl, "_blank", "noopener")) {
        throw new LocalizedPanelError("computer.err.popupBlocked");
      }
    } catch (e) {
      fallbackTab?.close();
      // Release the bot before waiting on best-effort tunnel cleanup. A sick
      // SSH process must never leave the agent paused indefinitely.
      if (tookControl) await transitionControl("release").catch(() => {});
      if (cloudPreviewReady && cloudBackend === "vps") {
        await api(threadPath("computer/viewer-close"), { method: "POST", body: "{}" }).catch(() => {});
      }
      if (ownsConnection()) setError(e instanceof Error ? e : String(e));
    } finally {
      if (desktopJoin.current === controller) {
        desktopJoin.current = null;
        setPending(null);
        setControlPending(false);
      }
    }
  };

  const run = (kind: "sleep" | "provision") => {
    setPending(kind);
    setError(null);
    api(`/api/bots/${bot.id}/computer/${kind}`, { method: "POST" })
      .then((result) => {
        if (kind === "provision") {
          setBoatState(result.container ?? null);
          if (result.ready) {
            if (bot.computer === "cloud") {
              setResolvedComputerSelection({ botId: bot.id, threadId: bot.threadId, computer: bot.computer, cloudBackend });
            }
            setPhase("ready");
          }
          else {
            setError(result.problem ?? new LocalizedPanelError("computer.err.vpsNotReady"));
            setPhase("error");
          }
        }
        if (kind === "sleep") {
          setResolvedComputerSelection(null);
          setBoatState(cloudBackend === "vps" ? "stopped" : "archived");
          if (cloudBackend === "vps") setPhase("vps-stopped");
          // The deciders map an archived boat to the sleeping observation
          // phase; re-resolving would see "ensure-boat" and wake it again.
          else setPhase("show-sleeping-boat");
        }
      })
      .catch((e) => {
        setError(e.message);
      })
      .finally(() => setPending(null));
  };

  const runVmAction = async (action: "vm-start" | "vm-create" | "vm-recreate" | "vm-delete") => {
    if (
      (action === "vm-recreate" || action === "vm-delete") &&
      !window.confirm(
        action === "vm-delete"
          ? cua
            ? vmStatus?.mode === "shared"
              ? t("vm.cua.confirmDeleteShared")
              : t("vm.cua.confirmDeleteBot", { name: bot.name, os: t(vmStatus?.os === "macos" ? "vm.cua.os.macos" : "vm.cua.os.linux") })
            : t("computer.confirm.deleteVm", { name: bot.name })
          : t("computer.confirm.replaceVm", { name: bot.name }),
      )
    ) return;
    if (vmActionController.current) return;
    const controller = new AbortController();
    vmActionController.current = controller;
    setPending(action);
    setError(null);
    vmReadinessAttempts.current = 0;
    try {
      if (action === "vm-recreate" || action === "vm-delete") {
        await api(`/api/bots/${bot.id}/local-computer/remove`, {
          method: "POST",
          body: "{}",
          signal: controller.signal,
        });
      }
      if (action !== "vm-delete") {
        // Container shared mode uses Settings; Spaces always target this bot's OS.
        const lifecyclePath = action === "vm-start" && !cua && vmStatus?.mode !== "per-bot"
          ? "/api/local-computer/start"
          : `/api/bots/${bot.id}/local-computer/${action === "vm-start" ? "start" : "run"}`;
        const started: LocalVmStatus = await api(lifecyclePath, {
          method: "POST",
          body: "{}",
          signal: controller.signal,
        });
        setVmStatus(started);
        const status = await waitForLocalVmReady(started, (signal) => api(threadPath("local-computer"), { signal }), controller.signal);
        setVmStatus(status);
        if (!status.ready) throw new Error(status.problem ?? t(cua ? "vm.err.readinessTimeout" : "computer.err.vmNotReady"));
        setPhase("vm");
      } else {
        setVmStatus((current) => current ? { ...current, container: "missing", ready: false } : current);
        setPhase("vm-unavailable");
      }
      if (cua) setRetry((n) => n + 1);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("vm-unavailable");
    } finally {
      if (vmActionController.current === controller && !controller.signal.aborted) {
        vmActionController.current = null;
        setPending(null);
        if (!cua) setRetry((n) => n + 1);
      }
    }
  };

  const replaceVpsComputer = async () => {
    if (!window.confirm(t("computer.confirm.replaceVps", { name: bot.name }))) return;
    setPending("vps-replace");
    setError(null);
    try {
      await api(`/api/bots/${bot.id}/computer/remove`, { method: "POST", body: "{}" });
      const result: VpsComputerStatus = await api(`/api/bots/${bot.id}/computer/provision`, {
        method: "POST",
        body: "{}",
      });
      setVpsStatus(result);
      setBoatState(result.container ?? null);
      if (result.ready && bot.computer === "cloud") {
        setResolvedComputerSelection({ botId: bot.id, threadId: bot.threadId, computer: bot.computer, cloudBackend });
      }
      setPhase(result.ready ? "ready" : "error");
      if (!result.ready) setError(result.problem ?? new LocalizedPanelError("computer.err.vpsReplaceNotReady"));
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

  // Simple mode's Browser tab when the browser is off: the same installation
  // switch as Settings → Computers → Built-in browser, plus this bot's own
  // browser switch, turned on together.
  const browserCanTurnOn = browserAvailableHere || state.config?.browserEngine?.installable === true;
  const [browserTurningOn, setBrowserTurningOn] = useState(false);
  const turnOnBrowser = async () => {
    if (browserTurningOn) return;
    setBrowserTurningOn(true);
    setError(null);
    try {
      if (!builtInBrowserEnabled(state.config)) {
        const config: ConfigStatus = await api("/api/config", {
          method: "PATCH",
          body: JSON.stringify({ features: { browser: true } }),
        });
        dispatch({ type: "configStatus", config });
      }
      if (profileBot.browser === false) dispatch({ type: "updateBot", botId: profileBot.id, patch: { browser: true } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.experimental.error"));
    } finally {
      setBrowserTurningOn(false);
    }
  };

  // Turning it off is this bot's own switch; the app-wide one stays on for
  // every other bot. Turning on (above) flips both when needed.
  const turnOffBrowser = () => {
    setError(null);
    dispatch({ type: "updateBot", botId: profileBot.id, patch: { browser: false } });
  };
  const browserSwitchRow = (
    <div data-testid="browser-switch-row" className="mb-3 flex items-center gap-3 rounded-xl bg-card px-3 py-2.5">
      <Globe size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink">{t("computer.browserSwitch.title", { name: bot.name })}</div>
        {!browserCanTurnOn && <div className="text-[11.5px] text-ink-secondary">{browserUnavailableReason(state.config)}</div>}
      </div>
      <Switch
        checked={browserEnabled}
        disabled={browserTurningOn || (!browserEnabled && !browserCanTurnOn)}
        aria-label={t("computer.browserSwitch.title", { name: bot.name })}
        onClick={() => (browserEnabled ? turnOffBrowser() : void turnOnBrowser())}
      />
    </div>
  );

  // The six Works-on places, shared by the Advanced cards and the Simple grid
  // so both run exactly the same availability rules and selection actions.
  const isMacHost = capabilities.host.platform === "darwin";
  const managedPolicy = state.config?.managedPolicy;
  const placeOptions = ([
    [null, "vm.dest.auto", "computer.dest.autoDesc", Sparkles, "vm.dest.auto"],
    ["cloud", "place.cloud", "computer.dest.cloudDesc", Cloud, "place.cloud"],
    ["vm", "vm.dest.vm", "computer.dest.vmDesc", Box, "vm.dest.vm"],
    ["local", "vm.dest.local", "computer.dest.localDesc", Monitor, isMacHost ? "computer.simple.dest.thisMac" : "computer.simple.dest.thisPc"],
    ["browser", "vm.dest.browser", "computer.dest.browserDesc", Globe, "vm.dest.browser"],
    ["off", "vm.dest.off", "computer.dest.offDesc", Power, "vm.dest.off"],
  ] as const).filter(([mode]) => mode === null || mode === "off" || placeOffered(mode, state.config)).map(([mode, labelKey, descriptionKey, Icon, simpleLabelKey]) => {
    const selected = mode === null ? !profileBot.computer : profileBot.computer === mode;
    // A place the enrolled organisation disallows is not offered.
    const managedKind = mode === "local" ? "thisComputer" : mode === "vm" ? "localVm" : mode === "cloud" ? (profileBot.cloudBackend === "vps" ? "vps" : "box") : null;
    const managedBy = managedPolicy && managedKind && !managedPolicy.computers[managedKind] ? t("policy.managedBy", { organization: managedPolicy.organizationName }) : undefined;
    const disabled = Boolean(managedBy) ||
      (mode === "cloud" && !cloudSupported) ||
      (mode === "vm" && !vmSupported) ||
      (mode === "local" && !localSelectable) ||
      (mode === "browser" && !browserSelectable);
    const unavailableTitle = managedBy ?? (
      mode === "vm" && !vmSupported
        ? t("computer.unavailableVm")
        : mode === "cloud" && !cloudSupported
          ? t("computer.unavailableCloud")
          : mode === "local" && !localSelectable
            ? localDisabledReason ?? t("computer.unavailableLocal")
            : mode === "browser"
              ? browserSelectable ? t("computer.browserOnlyTitle") : browserDisabledReason
              : undefined);
    return { mode, labelKey, descriptionKey, Icon, simpleLabel: t(simpleLabelKey), selected, managedBy, disabled, unavailableTitle };
  });
  const selectPlace = (mode: (typeof placeOptions)[number]["mode"]) => {
    if ((mode === null && profileBot.computer === undefined) || mode === profileBot.computer) return;
    if (mode === "local" && approvalModeFor(profileBot) === "auto") {
      setLocalAutoWarningTarget(bot.id);
    }
    // a browser-only bot must actually have its browser: flip
    // the per-bot switch on with the destination
    else if (mode === "browser") updateComputerSelection({ computer: mode, browser: true });
    else updateComputerSelection({ computer: mode });
  };
  // A pin that keeps this chat away from the grid's choice and will not move
  // with it: a person's, or one older than the server's record of who set
  // it. An auto pin moves with the next Works on change, one that matches
  // Works on changes nothing, and Off wins over any pin.
  const heldPin = liveTask?.surface && !liveTask.surfaceAuto && profileBot.computer !== "off"
    && liveTask.surface !== profileBot.computer ? liveTask.surface : undefined;

  const tabClass = (active: boolean) => cn(
    "flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] transition-colors",
    active ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
  );

  const emptyState = {
    checking: t("computer.phase.checking"),
    starting: t("computer.phase.starting"),
    "busy-boat": t("computer.phase.busyBoat"),
    unconfigured: t("computer.phase.unconfigured"),
    "auto-unavailable": t("computer.phase.autoUnavailable"),
    "team-boat": "This bot uses a shared team computer. Open Team map to view or manage it.",
    "show-ready-boat": t("computer.phase.showReadyBoat"),
    "show-sleeping-boat": t("computer.phase.showSleepingBoat"),
    "show-pending-boat": t("computer.phase.showPendingBoat"),
    "vps-unconfigured": t("computer.phase.vpsUnconfigured"),
    "vps-incompatible": t("computer.phase.vpsIncompatible"),
    "vps-stopped": t("computer.phase.vpsStopped"),
    "local-unavailable": localDisabledReason ?? t("computer.phase.localUnavailable"),
    "vm-unavailable": t("computer.phase.vmUnavailable"),
    browser: t("computer.phase.browser"),
    off: t("computer.phase.off"),
    error: t("computer.phase.error"),
  } satisfies Record<Exclude<Phase, "ready" | "local" | "vm">, string>;

  return (
    <>
    <aside
      className={cn(
        "animate-panel-in relative flex h-full shrink-0 flex-col border-l border-hairline/40 bg-panel",
        // Below md (a phone on remote access) the stored width would push the
        // chat to zero and run off the edge, so cover the window like the
        // settings and inspector panels. `!` beats the inline width.
        "max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full!",
      )}
      style={{ width: panelWidth }}
    >
      <div
        ref={separatorRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("computer.resizeAria")}
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={PANEL_MAX_WIDTH}
        aria-valuenow={separatorWidth ?? undefined}
        tabIndex={0}
        onKeyDown={onSeparatorKeyDown}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/60 max-md:hidden"
      />
      {/* Header: tabs centred as a segmented pill; gear and close pinned to the edges. */}
      <div className={cn("px-4 py-3", padClass)}>
        <div className="relative flex min-h-7 items-center justify-center">
          {advanced && (
            <button
              onClick={() => {
                // Keep the panel/modal states exclusive at this entry point. That
                // removes the still-mounted Computer panel from the settings
                // dialog's focus path, and dismissing Settings returns directly
                // to the conversation that opened it.
                dispatch({ type: "toggleComputer", open: false });
                dispatch({ type: "toggleSettings", open: true, section: "access" });
              }}
              className="absolute left-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
              title={t("computer.botSettings")}
            >
              <Settings size={18} />
            </button>
          )}
          <div className="mx-9 flex min-w-0 flex-wrap justify-center gap-0.5 rounded-full bg-inset p-0.5" data-tour="computer-tabs" data-testid="computer-tabs" aria-label="Bot panel view">
            <button
              onClick={() => selectPanelView("computer")}
              aria-pressed={panelView === "computer"}
              className={tabClass(panelView === "computer")}
            >
              <Monitor size={13} /> {t("computer.tab.computer")}
              {placeLive && isComputerPlace(livePlace) && <span className="size-1.5 animate-pulse rounded-full bg-success" role="img" aria-label={t("place.live")} data-testid="computer-tab-live" />}
            </button>
            {advanced && (
            <button
              type="button"
              onClick={() => selectPanelView("routines")}
              aria-pressed={panelView === "routines"}
              className={tabClass(panelView === "routines")}
            ><CalendarClock size={13} />{t("computer.tab.routines")}</button>
            )}
            {advanced && androidConnected && (
            <button
              onClick={() => selectPanelView("android")}
              aria-pressed={panelView === "android"}
              className={tabClass(panelView === "android")}
            >
              <Smartphone size={13} /> {t("computer.tab.android")}
            </button>
            )}
            {(
            <button
              data-tour="computer-browser"
              onClick={() => {
                setError(null);
                selectPanelView("browser");
              }}
              aria-pressed={panelView === "browser"}
              className={tabClass(panelView === "browser")}
            >
              <Globe size={13} /> {t("computer.tab.browser")}
              {placeLive && livePlace === "browser" && <span className="size-1.5 animate-pulse rounded-full bg-success" role="img" aria-label={t("place.live")} data-testid="browser-tab-live" />}
            </button>
            )}
            {!advanced && (
            <button
              type="button"
              onClick={() => selectPanelView("files")}
              aria-pressed={panelView === "files"}
              className={tabClass(panelView === "files")}
            >
              <FolderOpen size={13} /> {t("computer.tab.files")}
            </button>
            )}
          </div>
          <button
            onClick={() => dispatch({ type: "toggleComputer", open: false })}
            className="absolute right-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            aria-label={t("computer.close")}
            title={t("computer.close")}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {panelView === "routines" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <RoutinesSection key={bot.id} bot={bot} routines={botRoutines} runs={state.routineRuns} defaultRunOn={cloudRoutineReady ? "cloud" : "maus"} />
        </div>
      ) : panelView === "browser" && browserEnabled ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
          {browserSwitchRow}
          <BrowserPanel bot={bot} />
          {errorText && (
            <div role="alert" className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {errorText}
            </div>
          )}
        </div>
      ) : panelView === "browser" ? (
        <div className="flex-1 overflow-y-auto px-5 pb-5" data-testid="browser-off">
          {browserSwitchRow}
          <div className="mt-2 flex flex-col items-center gap-3 rounded-xl bg-card px-6 py-8 text-center">
            <Globe size={22} className="text-ink-secondary" aria-hidden="true" />
            <div className="text-[14px] font-medium text-ink">{t("computer.browserOff.title")}</div>
            <p className="text-[12px] leading-5 text-ink-secondary">
              {browserCanTurnOn ? t("computer.browserOff.body", { name: bot.name }) : browserUnavailableReason(state.config)}
            </p>
            {errorText && (
              <div role="alert" className="w-full rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
                {errorText}
              </div>
            )}
          </div>
        </div>
      ) : panelView === "files" ? (
        <ComputerFilesPane bot={bot} />
      ) : panelView === "android" && androidConnected ? (
        <div className="flex-1 overflow-y-auto px-4 pt-2">
          <AndroidDevicePanel status={androidStatus} />
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto px-5 pb-5">
          {/* Screen preview */}
          <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
            <span>{t("computer.screenOf", { name: bot.name })}</span>
            {currentTeamComputer && <span className="text-[11px]">Team default</span>}
            {phase === "local" && <span className="text-[11px]">{t("computer.badge.local")}</span>}
            {(phase === "vm" || (cua && phase === "vm-unavailable")) && <span className="text-[11px]">{cua ? t(vmStatus?.os === "macos" ? "vm.cua.space.macos" : "vm.cua.space.linux") : t("vm.dest.vm")}</span>}
            {(phase === "show-ready-boat" || phase === "show-sleeping-boat" || phase === "show-pending-boat") && (
              <span className="text-[11px]">{t("computer.badge.autoBoat")}</span>
            )}
            {computerStatusCurrent && bot.computer === "cloud" && cloudBackend === "vps" && (phase === "ready" || phase === "starting") && <span className="text-[11px]">{t("computer.badge.vps")}</span>}
        </div>
        <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
          {cloudPreviewReady || (bot.computer === "cloud" && phase === "starting") ? (
            <CloudScreenPreview
              key={`${bot.id}:${bot.threadId}:${bot.computer}:${cloudBackend}`}
              src={frameSrc}
              name={bot.name}
              error={panelErrorText(previewError)}
              refreshing={previewRefreshing}
              retry={previewRetry}
              starting={phase === "starting"}
              opening={pending === "join"}
              disabled={controlPending}
              onOpen={() => void openDesktop()}
              onRetry={(discardFrame) => {
                lastLiveAt.current = 0;
                if (discardFrame) setPolledFrame(null);
                setPreviewError(null);
                setPreviewRefreshing(true);
                setPreviewRetry((n) => n + 1);
              }}
            />
          ) : frameSrc && previewOpensDesktop ? (
            <button
              type="button"
              onClick={() => void openDesktop()}
              disabled={controlPending || pending === "join"}
              className="group relative flex h-full w-full cursor-pointer items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait"
              aria-label={t("computer.openLiveDesktopAria", { name: bot.name })}
              title={t("computer.openLiveDesktop")}
            >
              <img
                src={frameSrc}
                alt={t("computer.screenOf", { name: bot.name })}
                className="h-full w-full object-contain transition group-hover:brightness-75 group-focus-visible:brightness-75"
              />
              <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white opacity-80 shadow-sm transition group-hover:opacity-100 group-focus-visible:opacity-100">
                {pending === "join" ? <Loader2 size={12} className="animate-spin" /> : <Maximize2 size={12} />}
                {t("computer.open")}
              </span>
            </button>
          ) : frameSrc ? (
            <img
              src={frameSrc}
              alt={t("computer.screenOf", { name: bot.name })}
              className="h-full w-full object-contain"
              title={phase === "vm" ? t("computer.watchOnly") : undefined}
            />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
              {phase === "checking" || phase === "starting" || phase === "busy-boat" || phase === "vm" || (phase === "local" && !isLinux) ? (
                <Loader2 size={18} className="animate-spin" />
              ) : phase === "off" ? (
                <Power size={22} />
              ) : (
                <Monitor size={22} />
              )}
              <span className="text-[12px]">
                {currentTeamComputer
                  ? `${currentTeamComputer.name} · ${boatState ?? "unavailable"}`
                  : cloudPreviewReady
                  ? t("computer.waitingFrame")
                  : phase === "ready"
                    ? t("computer.autoChooseCloudOpen")
                  : phase === "vm"
                    ? t("computer.capturingVm")
                  : phase === "local"
                    ? isLinux
                      ? t("computer.linuxReady")
                      : localMisses >= 3
                      ? t("computer.needsScreenPerm")
                      : t("computer.capturingLocal")
                    : cua && pending === "vm-create"
                      ? t("vm.cua.creating")
                    : vmResumable
                      ? t(pending === "vm-start" ? "vm.setup.starting" : "computer.phase.vmStopped")
                      : emptyState[phase]}
              </span>
              {currentTeamComputer && <>
                <p className="text-[12px]">Shared files and signed-in accounts. Auto uses this cloud computer, not a private one.</p>
                <button type="button" onClick={() => dispatch({ type: "showTeamMap" })}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover">Open Team map</button>
                <button type="button" onClick={() => setRetry(n => n + 1)}
                  className="text-[11px] text-ink-secondary hover:text-ink">Refresh shared computer status</button>
              </>}
              {phase === "local" && !isLinux && localMisses >= 3 && (
                <button
                  onClick={() => window.ogb?.permOpenSettings?.("screen")}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {t("computer.openSettings")}
                </button>
              )}
              {phase === "browser" && browserEnabled && (
                <button
                  onClick={() => selectPanelView("browser")}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {t("computer.openBrowserTab")}
                </button>
              )}
              {(phase === "show-ready-boat" || phase === "show-sleeping-boat" || phase === "show-pending-boat") && (
                <button
                  type="button"
                  onClick={() => updateComputerSelection({ computer: "cloud" })}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {phase === "show-sleeping-boat"
                    ? t("computer.chooseCloudWake")
                    : phase === "show-ready-boat"
                      ? t("computer.chooseCloudOpen")
                      : t("computer.chooseCloudManage")}
                </button>
              )}
              {vmResumable && pending !== "vm-start" && (
                <p className="text-[12px]">{t(vmStatus?.stop_reason === "idle" ? "vm.stopped.idle" : "vm.stopped.detail")}</p>
              )}
              {phase === "vm-unavailable" && (
                canManageVm && vmStartable && vmStatus?.mode !== "pool" && (!cua || (!cuaPool && vmStatus.managed)) ? (
                  <button
                    onClick={() => void runVmAction("vm-start")}
                    disabled={pending !== null}
                    aria-busy={pending === "vm-start"}
                    className="mt-1 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                  >
                    {pending === "vm-start" && <Loader2 size={13} className="animate-spin" />}
                    {t(cua ? pending === "vm-start" ? "vm.cua.starting" : "vm.cua.start" : pending === "vm-start" ? "vm.setup.starting" : "vm.setup.start")}
                  </button>
                ) : canManageVm && vmStatus?.create_supported && (cua ? !cuaPool && vmStatus.container === "missing" : vmStatus.mode === "per-bot" && vmStatus.image) ? (
                  <button
                    onClick={() => void runVmAction(vmStatus.container === "missing" ? "vm-create" : "vm-recreate")}
                    disabled={pending !== null}
                    className="mt-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                  >
                    {(pending === "vm-create" || pending === "vm-recreate") && (
                      <Loader2 size={13} className="mr-1.5 inline animate-spin" />
                    )}
                    {cua
                      ? t(pending === "vm-create" ? "vm.cua.creating" : "vm.cua.create")
                      : vmStatus.container === "missing"
                        ? t("computer.createVm", { name: bot.name })
                        : t("computer.replaceVm", { name: bot.name })}
                  </button>
                ) : (
                  <button
                    onClick={openVmSettings}
                    className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                  >
                    {t("computer.openVmSetup")}
                  </button>
                )
              )}
              {!advanced && computerStatusCurrent && (phase === "vps-unconfigured" || phase === "vps-stopped" || phase === "vps-incompatible") && (
                <>
                  <p className="text-[12px]">{t("computer.simple.needsSetup", { name: bot.name })}</p>
                  <button
                    type="button"
                    onClick={() => setAdvancedMode(true)}
                    className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                  >
                    {t("computer.simple.showAdvanced")}
                  </button>
                </>
              )}
              {advanced && computerStatusCurrent && (phase === "vps-unconfigured" || phase === "vps-stopped") && (
                <button
                  onClick={openConnectionSettings}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {t("computer.openVpsSettings")}
                </button>
              )}
              {advanced && computerStatusCurrent && (phase === "vps-stopped" || (phase === "vps-unconfigured" && vpsStatus?.configured)) &&
                canManageCloud && (
                <button
                  onClick={() => run("provision")}
                  disabled={pending === "provision"}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50"
                >
                  {pending === "provision" && <Loader2 size={13} className="mr-1.5 inline animate-spin" />}
                  {phase === "vps-stopped" ? t("computer.startVps") : t("computer.prepareVps")}
                </button>
              )}
              {advanced && computerStatusCurrent && phase === "vps-incompatible" && vpsStatus?.managed &&
                canManageCloud && (
                <button
                  onClick={() => void replaceVpsComputer()}
                  disabled={pending === "vps-replace"}
                  className="mt-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                >
                  {pending === "vps-replace" && <Loader2 size={13} className="mr-1.5 inline animate-spin" />}
                  {t("computer.replaceVps")}
                </button>
              )}
            </div>
          )}
        </div>

        {errorText && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {errorText}
          </div>
        )}
        {phase === "unconfigured" && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <div className="mb-3 text-[13px] text-ink-secondary">
              {t("computer.addBoatKey")}
            </div>
            <ApiKeyRow
              section="box"
              onSaved={(configured) => configured && setRetry((n) => n + 1)}
            />
          </div>
        )}
        {advanced && phase === "vps-unconfigured" && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <div className="mb-3 text-[13px] text-ink-secondary">
              {t("computer.vpsAliasHint")}
            </div>
            <button
              onClick={openConnectionSettings}
              className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
            >
              {t("computer.openVpsSettings")}
            </button>
          </div>
        )}

        {cua && phase === "vm" && cuaViewerAvailable && (
          <button
            type="button"
            onClick={() => void openCuaViewer(false)}
            title={t("vm.cua.openViewerTitle")}
            disabled={pending !== null || controlPending}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
            {t("vm.cua.openViewer")}
          </button>
        )}

        {advanced &&
          phase === "vm" &&
          !cua &&
          vmStatus?.mode === "per-bot" &&
          window.ogb?.desktopWorkspace &&
          onOpenVmWorkspace && (
            <button
              type="button"
              onClick={() => onOpenVmWorkspace(bot.id)}
              disabled={pending !== null}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-accent/30 bg-accent/10 py-2 text-[13px] font-medium text-ink hover:bg-accent/15 disabled:opacity-50"
              title={t("computer.twoDesktopsTitle")}
            >
              <Columns2 size={14} />
              {t("computer.twoDesktops")}
            </button>
          )}

        {/* Who is driving — take the wheel / hand it back */}
        {(cloudPreviewReady || phase === "vm" || currentTeamComputer) && control.helpReason && !control.held && (
          <div className="mt-3 rounded-xl border border-warning/25 bg-warning/10 p-4">
            <div className="text-[13px] leading-relaxed text-warning">
              <b>{bot.name}</b> {t("computer.askedHands")} {control.helpReason}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() =>
                  phase === "vm" || cloudPreviewReady ? void openDesktop() : controlAction("take")
                }
                disabled={controlPending || pending === "join" || (cua && !cuaViewerAvailable)}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
                {t("computer.takeControl")}
              </button>
              <button
                onClick={() => controlAction("dismiss-help")}
                disabled={controlPending}
                className="rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {t("computer.dismiss")}
              </button>
            </div>
          </div>
        )}
        {(cloudPreviewReady || phase === "vm" || currentTeamComputer) && control.held && (
          <div className="mt-3 rounded-xl border border-accent/25 bg-accent/10 p-4">
            <div className="text-[13px] leading-relaxed text-ink">
              {t("computer.youHaveWheel")}
              {/* Simple mode names its own button: Full screen, not Open live desktop. */}
              {cloudPreviewReady && ` ${t(advanced ? "computer.useOpenDesktop" : "computer.simple.useFullScreen")}`}
              {phase === "vm" && ` ${t(cua || advanced ? "computer.useOpenDesktopVm" : "computer.simple.useFullScreenVm")}`}
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
              {t("computer.handBack")}
            </button>
          </div>
        )}
        {advanced && !cua && phase === "vm" && vmViewerUrl && control.held && (
          <button
            onClick={() => void openDesktop()}
            disabled={pending === "join"}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            title={t("computer.openVmDesktopTitle")}
          >
            {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
            {t("computer.openLiveDesktop")}
          </button>
        )}
        {advanced && phase === "vm" && !control.held && !control.helpReason && (
          <button
            onClick={() => void openDesktop()}
            disabled={controlPending || pending === "join" || (cua ? !cuaViewerAvailable : !vmViewerUrl)}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            title={t("computer.takeControlVmTitle")}
          >
            {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
            {t("computer.takeControl")}
          </button>
        )}
        {advanced && canManageVm && phase === "vm" && (cua ? !cuaPool && vmStatus?.managed : vmStatus?.mode === "per-bot") && (
          <button
            onClick={() => void runVmAction("vm-delete")}
            disabled={pending !== null || profileBot.busy}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-danger/30 py-2 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50"
            title={profileBot.busy ? t("computer.deleteVmBlocked") : t("computer.deleteVmTitle", { name: bot.name })}
          >
            {pending === "vm-delete" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            {t(cua ? "vm.cua.delete" : "computer.deleteVm")}
          </button>
        )}
        {/* Simple mode: one row under the screen — Take control, Full screen, Sleep. */}
        {!advanced && (cloudPreviewReady || phase === "vm") && (
          <div className="mt-3 flex gap-2" data-testid="computer-actions">
            {!control.held && !control.helpReason && (
              <button
                type="button"
                onClick={() => void openDesktop()}
                disabled={controlPending || pending === "join" || (phase === "vm" && (cua ? !cuaViewerAvailable : !vmViewerUrl))}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-50"
                title={phase === "vm" ? t("computer.takeControlVmTitle") : t("computer.takeControlTitle")}
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
                {t("computer.takeControl")}
              </button>
            )}
            {!cua && (
            <button
              type="button"
              onClick={() => void openDesktop()}
              disabled={pending === "join" || (!control.held && controlPending) || (phase === "vm" && !vmViewerUrl)}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              title={t("computer.openLiveDesktop")}
            >
              <Maximize2 size={14} />
              {t("computer.fullScreen")}
            </button>
            )}
            {cloudPreviewReady && canManageCloud && (cloudBackend === "vps" || boatState !== "archived") && (
              <button
                type="button"
                onClick={() => run("sleep")}
                // the server refuses sleep while a turn owns the boat (409)
                disabled={pending === "sleep" || profileBot.busy}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title={t("computer.sleepTitle")}
              >
                {pending === "sleep" ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}
                {t("vm.cloud.sleep")}
              </button>
            )}
          </div>
        )}
        {/* Cloud-only actions */}
        {advanced && cloudPreviewReady && (
          <div className="mt-3 flex gap-2">
            {!control.held && !control.helpReason && (
              <button
                onClick={() =>
                  void openDesktop()
                }
                disabled={controlPending || pending === "join"}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title={t("computer.takeControlTitle")}
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
                {t("computer.takeControl")}
              </button>
            )}
            {control.held && (
              <button
                onClick={() => void openDesktop()}
                disabled={pending === "join"}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
                {t("computer.openLiveDesktop")}
              </button>
            )}
            {canManageCloud && (cloudBackend === "vps" || boatState !== "archived") && (
              <button
                onClick={() => run("sleep")}
                // the server refuses sleep while a turn owns the boat (409)
                disabled={pending === "sleep" || profileBot.busy}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title={t("computer.sleepTitle")}
              >
                {pending === "sleep" ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}
                {t("vm.cloud.sleep")}
              </button>
            )}
          </div>
        )}

        {phase !== "team-boat" && (bot.computer !== undefined || computerStatusCurrent) && <>
          <LocalScreenPreview />
          <LinuxLocalControl />
          <MacLocalControl />
        </>}

        {/* Computer source */}
        {advanced ? <>
          <div className="mt-4 rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">{t("computer.worksOn")}</div>
            <p className="mt-1 text-[12px] leading-5 text-ink-secondary">
              {t(state.config?.cloudHome ? "computer.worksOnHintCloudHome" : "computer.worksOnHint")}
            </p>
          <div role="group" aria-label={t("computer.destinationAria")} className="mt-3 grid auto-rows-fr grid-cols-2 gap-2">
            {placeOptions.map(({ mode, labelKey, descriptionKey, Icon, selected, managedBy, disabled, unavailableTitle }) => (
              <button
                key={mode ?? "auto"}
                disabled={disabled}
                title={unavailableTitle}
                onClick={() => selectPlace(mode)}
                type="button"
                aria-pressed={selected}
                className={cn(
                  "min-w-0 rounded-lg border px-2.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                  selected
                    ? "border-accent/60 bg-accent/10 text-ink"
                    : "border-hairline/50 bg-panel/30 text-ink-secondary",
                  disabled
                    ? "cursor-not-allowed"
                    : "hover:border-accent/40 hover:bg-control/60",
                )}
              >
                <span className="flex items-center gap-2 text-[12px] font-medium leading-4">
                  {selected ? <Check size={14} className="shrink-0 text-accent" /> : <Icon size={14} className="shrink-0 text-ink-secondary" />}
                  <span>{t(labelKey)}</span>
                </span>
                <span className="mt-1.5 block text-[11px] leading-4 text-ink-secondary">
                  {managedBy ?? (disabled ? t("computer.unavailableHere") : t(descriptionKey))}
                </span>
              </button>
            ))}
          </div>
          {liveTask?.surface && (
            <p className="mt-2 text-[11.5px] leading-5 text-ink-secondary" data-testid="place-pinned-note">
              {t("place.pinnedNote", { place: t(placeLabelKey(liveTask.surface)) })}
            </p>
          )}
          {profileBot.computer === "cloud" && (
            <>
              <CloudBackendPicker
                compact
                value={cloudBackend}
                vpsSupported={vpsSupported}
                onChange={(backend) => updateComputerSelection({ cloudBackend: backend })}
              />
            </>
          )}
          {profileBot.computer !== "cloud" && (
            <div className="mt-3 border-t border-hairline/40 pt-3 text-[11.5px] leading-5 text-ink-secondary" aria-live="polite">
              {!profileBot.computer ? (
                currentTeamComputer
                  ? `Auto uses ${currentTeamComputer.name}, shared with this team's other Auto bots. Choosing another destination overrides the team default.`
                  : cloudBackend === "vps" && bot.autoStartVps
                  ? t("computer.hint.vpsAuto")
                  : localSelectable && !isLinux
                    ? t("computer.hint.autoLocal")
                    : t("computer.hint.autoCloud")
              ) : profileBot.computer === "vm" ? (
                <>
                  {t("computer.hint.vm")}
                  <button type="button" onClick={openVmSettings} className="mt-1 block font-medium text-accent hover:underline">
                    {t("computer.vmSettingsLink")}
                  </button>
                </>
              ) : profileBot.computer === "local" ? (
                t("computer.hint.local")
              ) : profileBot.computer === "browser" ? (
                t("computer.hint.browser")
              ) : (
                t("computer.hint.off")
              )}
            </div>
          )}
        </div>

        {/* A compact entry beneath the computer; the tab owns the full list. */}
        <button type="button" onClick={() => selectPanelView("routines")} className="mt-4 flex w-full items-start gap-3 rounded-xl bg-card p-4 text-left hover:bg-raised">
          <CalendarClock size={17} className="mt-0.5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium text-ink">{t("computer.tab.routines")} <span className="ml-1 text-[11px] text-ink-secondary">{botRoutines.length}</span></span>
            <span className={cn("mt-1 block truncate text-[11.5px]", activeRoutineRun ? routineRunTone(activeRoutineRun) : "text-ink-secondary")}>{activeRoutineRun ? `${activeRoutineRun.routineName} · ${routineRunLabel(activeRoutineRun)}` : t("computer.routines.openTitle")}</span>
          </span>
          <span className="text-ink-secondary" aria-hidden="true">→</span>
        </button>
        </> : (
          <div className="mt-4 rounded-xl bg-card p-4" data-testid="where-works">
            <div className="text-[15px] font-medium text-ink">{t("computer.simple.whereWorks", { name: bot.name })}</div>
            <div role="group" aria-label={t("computer.destinationAria")} className="mt-3 grid grid-cols-3 gap-2">
              {placeOptions.map(({ mode, Icon, selected, disabled, unavailableTitle, simpleLabel }) => (
                <button
                  key={mode ?? "auto"}
                  type="button"
                  disabled={disabled}
                  title={unavailableTitle}
                  aria-pressed={selected}
                  onClick={() => selectPlace(mode)}
                  className={cn(
                    "flex min-w-0 flex-col items-center gap-1.5 rounded-lg border px-1.5 py-2.5 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                    selected
                      ? "border-accent/60 bg-accent/10 text-ink"
                      : "border-hairline/50 bg-panel/30 text-ink-secondary",
                    disabled ? "cursor-not-allowed opacity-50" : "hover:border-accent/40 hover:bg-control/60",
                  )}
                >
                  <Icon size={16} className={cn("shrink-0", selected ? "text-accent" : "text-ink-secondary")} aria-hidden="true" />
                  <span className="w-full truncate text-[12px] font-medium leading-4">{simpleLabel}</span>
                </button>
              ))}
            </div>
            <p className="mt-3 text-[11.5px] leading-5 text-ink-secondary">
              {t(state.config?.cloudHome ? "computer.simple.autoHintCloudHome" : isMacHost ? "computer.simple.autoHintMac" : "computer.simple.autoHintPc")}
            </p>
            {/* Simple has no composer chip, so a held pin is named here, in
                the grid's words, with the way back to the grid's choice. An
                auto pin gets no note: the person never set it. */}
            {heldPin && (
              <div className="mt-2 flex items-center gap-2">
                <p className="min-w-0 flex-1 text-[11.5px] leading-5 text-ink-secondary" data-testid="place-pinned-note">
                  {t("place.pinnedNoteSimple", {
                    place: placeOptions.find(({ mode }) => mode === heldPin)?.simpleLabel ?? t(placeLabelKey(heldPin)),
                  })}
                </p>
                {/* The server refuses a busy thread's place change (409). */}
                <button
                  type="button"
                  disabled={Boolean(bot.busy)}
                  title={bot.busy ? t("place.busy") : undefined}
                  onClick={() => dispatch({ type: "updateTask", botId: profileBot.id, threadId: profileBot.threadId, patch: { surface: null } })}
                  className="shrink-0 rounded-md px-2 py-0.5 text-[11.5px] font-medium leading-5 text-accent-text transition-colors hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                  data-testid="place-unpin"
                >
                  {t("place.unpinSimple", {
                    place: placeOptions.find(({ selected }) => selected)?.simpleLabel ?? t(placeLabelKey(profileBot.computer ?? "auto")),
                  })}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      )}

    </aside>
    <LocalComputerAutoWarning
      open={localAutoWarningTarget !== null}
      onCancel={() => setLocalAutoWarningTarget(null)}
      onConfirm={() => {
        const targetBotId = localAutoWarningTarget;
        setLocalAutoWarningTarget(null);
        if (!targetBotId) return;
        if (targetBotId === bot.id) {
          setResolvedComputerSelection(null);
          setPhase("checking");
        }
        dispatch({
          type: "updateBot",
          botId: targetBotId,
          patch: { computer: "local", acknowledgeLocalAuto: true },
        });
      }}
    />
    </>
  );
}
