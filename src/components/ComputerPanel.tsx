import { boatCapableEngine, cloudEngineOf } from "@/lib/remote-desktop";
import { canWorkOnCloud } from "../../shared/cloud-computer";
import { viewerTargetId } from "../../shared/desktop-viewer";
import { Switch } from "./SettingsPrimitives";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { waitForLocalVmReady } from "@/lib/local-vm-readiness";
import { CalendarClock, Columns2, Box, Check, Cloud, Sparkles, Globe, Hand, Loader2, Maximize2, Monitor, Moon, Power, Settings, X } from "lucide-react";
import { api, ApiError, currentTaskBot, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { setAdvancedMode, useAdvancedMode } from "@/lib/interface-mode";
import { ComputerFilesPane } from "./ComputerFilesPane";
import { effectivePlace, isComputerPlace, placeLabelKey, placeOffered } from "@/lib/place";
import type { CloudBackend } from "../../shared/wire";
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
import { usePanelPage, type PanelPage } from "@/lib/page-open";
const DataPanel = lazy(() => import("./data/DataPanel").then((module) => ({ default: module.DataPanel })));
const loadLiveDesktop = () => import("./LiveDesktop").then((module) => ({ default: module.LiveDesktop }));
const LiveDesktop = lazy(loadLiveDesktop);
import { browserAvailable, browserUnavailableReason, builtInBrowserEnabled } from "@/lib/feature-flags";
import { parseComputerHelp, transitionComputerControlLease, type ComputerControlAction } from "@/lib/computer-control";
import { openProviderDesktop, useComputerTakeover } from "./computer-takeover";
import { SignInBanner } from "./SignInRequestCard";
import { LocalScreenPreview } from "./LocalScreenPreview";
import { LinuxLocalControl } from "./LinuxLocalControl";
import { MacLocalControl } from "./MacLocalControl";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import {
  busyBoatView,
  instanceSupportsLocalComputer,
  localComputerDisabledReason,
  localComputerSelectable,
  persistedComputerSelectionMatches,
  isReadyBoatState,
  resolveBoatPanelAction,
  shouldPollCloudPreview,
} from "@/lib/local-computer";
import { moveBetweenTabs, PANEL_TABS, panelTabProps, scrollTabsWithWheel, TAB_PANEL_FOCUS, tabPanelProps, useAndroidTabFallback } from "./computer-panel-tabs";
import { releaseComputerPanelFocus, useComputerPanelEntry } from "@/lib/computer-panel-focus";
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, useComputerPanelResize } from "./computer-panel-resize";
import {
  computerPanelTabs,
  readComputerPanelView,
  resolveComputerPanelView,
  writeComputerPanelView,
  type ComputerPanelView,
} from "@/lib/computer-panel-view";
import { approvalModeFor } from "../../shared/approval-mode";
import { openPlaceAction, placeBlocked, placeFacts, placeHasIssue, placeViewFor, usePlaceSeat, worksOnSimpleLabel } from "@/lib/place-view";
import { cloudRefusal, type PlaceActionId, type PlaceFacts, type PlaceView } from "../../shared/place-view";
import { t } from "@/lib/i18n";
import { LocalizedPanelError, panelErrorText } from "@/lib/computer-messages";

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
  | "cloud-new"
  | "cloud-asleep"
  | "browser"
  | "off"
  | "error";

interface LocalVmStatus {
  resumable?: boolean;
  stop_reason?: "idle" | null;
  mode: "shared" | "per-bot" | "pool";
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
  target_key: string;
}

const computerControlSnapshotSchema = z.object({
  held: z.boolean().optional().default(false),
  helpReason: z.string().nullable().optional().default(null),
  help: z.unknown().optional().transform(parseComputerHelp),
  owned: z.boolean().optional(),
}).passthrough();

export function ComputerPanel({
  bot: profileBot,
  onOpenVmWorkspace,
}: {
  bot: Bot;
  onOpenVmWorkspace?: (botId: string) => void;
}) {
  const { padClass, dragProps } = useCaptionChrome();
  const { panelWidth, separatorRef, separatorWidth, onSeparatorKeyDown, onResizeStart, onResizeMove, onResizeEnd } = useComputerPanelResize();
  const { state, dispatch, flushBotPatches } = useStore();
  const liveTask = profileBot.tasks?.find((task) => task.threadId === profileBot.threadId);
  const livePlace = effectivePlace(profileBot, liveTask);
  const threadBot = currentTaskBot(profileBot);
  const connectionKey = `${profileBot.id}:${profileBot.threadId}:${livePlace}:${profileBot.cloudBackend ?? "box"}:${threadBot.modelSelection.instanceId}`;
  const [autoSurface, setAutoSurface] = useState<{ key: string; surface: Bot["computer"] } | null>(null);
  const autoSurfaceCurrent = autoSurface?.key === connectionKey;
  const surfaceReady = livePlace !== "auto" || autoSurfaceCurrent;
  const bot = { ...threadBot, computer: livePlace === "auto"
    ? autoSurfaceCurrent ? autoSurface.surface : undefined : livePlace };
  const viewerConnectionKey = `${bot.id}:${bot.threadId}:${bot.computer}:${bot.cloudBackend ?? "box"}`;
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
  const localSelectable = placeOffered("local", state.config) && localComputerSelectable({ capabilities, providerSupportsLocal });
  const [localAutoWarningTarget, setLocalAutoWarningTarget] = useState<string | null>(null);
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const placeSeat = usePlaceSeat(state.config, capabilities.host.platform);
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
    // Clear in the same render as the optimistic profile change; the resolving effect waits for its PATCH.
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
  const [vmStatus, setVmStatus] = useState<LocalVmStatus | null>(null);
  const [vpsStatus, setVpsStatus] = useState<VpsComputerStatus | null>(null);
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [pending, setPending] = useState<
    "join" | "sleep" | "provision" | "vps-replace" | "vm-start" | "vm-create" | "vm-recreate" | "vm-delete" | null
  >(null);
  const [controlPending, setControlPending] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [error, setError] = useState<Error | string | null>(null);
  const errorText = panelErrorText(error);
  const advanced = useAdvancedMode();
  const [storedPanelView, setPanelView] = useState<ComputerPanelView>(() => readComputerPanelView(bot.id));
  const requestedDataResult = state.dataResultFocus?.botId === bot.id ? state.dataResultFocus : undefined;
  const [dataRequest, setDataRequest] = useState<{ id: string; requestId: number }>();
  const androidStatus = useAndroidUsbDevices();
  const androidConnected = androidStatus.devices.length > 0;
  const panelTabs = computerPanelTabs({ advanced, androidConnected });
  const panelView = resolveComputerPanelView(storedPanelView, { advanced, androidConnected });
  const panelRef = useComputerPanelEntry(profileBot.id, panelView);
  const browserAvailableHere = browserAvailable(state.config);
  const browserEnabled = builtInBrowserEnabled(state.config) && bot.browser !== false
    && (browserAvailableHere || state.config?.browserEngine?.installable === true);
  const [retry, setRetry] = useState(0);
  // Auto is the server's decision: never guess host-vs-cloud from desktop capabilities.
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
  const explicitPanelView = useRef(false);
  const selectPanelView = (view: ComputerPanelView) => {
    explicitPanelView.current = true;
    setPanelView(view);
    writeComputerPanelView(bot.id, view);
  };

  const previousPanelTarget = useRef<string | null>(null);
  // Excludes the model and Auto's resolved surface: neither may move the tab.
  const panelTargetKey = `${profileBot.id}:${profileBot.threadId}:${livePlace}:${profileBot.cloudBackend ?? "box"}`;
  useEffect(() => {
    const previous = previousPanelTarget.current;
    if (previous === panelTargetKey && (explicitPanelView.current || !(bot.computer === "browser" && browserEnabled))) return;
    if (previous !== panelTargetKey) explicitPanelView.current = false;
    previousPanelTarget.current = panelTargetKey;
    setPanelView(bot.computer === "browser" && browserEnabled ? "browser"
      : previous === null ? readComputerPanelView(bot.id) : "computer");
  }, [panelTargetKey, bot.id, bot.computer, browserEnabled]);

  useEffect(() => {
    if (!requestedDataResult || requestedDataResult.consumed) return;
    explicitPanelView.current = true;
    setDataRequest(requestedDataResult);
    setPanelView("data");
    writeComputerPanelView(bot.id, "data");
    dispatch({ type: "dataResultFocusConsumed", requestId: requestedDataResult.requestId });
  }, [bot.id, dispatch, requestedDataResult]);

  const requestedSignIn = state.signInFocus?.botId === bot.id ? state.signInFocus : undefined;
  const [signInRequest, setSignInRequest] = useState<{ url: string; site: string; nonce: number }>();
  // A published page's Open (usePageOpener): this bot's browser shows, with the page in a new tab.
  const [pageRequest, setPageRequest] = useState<PanelPage>();
  usePanelPage(bot.id, (page) => { selectPanelView("browser"); setPageRequest(page); });
  useEffect(() => {
    if (!requestedSignIn || requestedSignIn.consumed) return;
    const view = requestedSignIn.place === "browser" ? "browser" : "computer";
    explicitPanelView.current = true;
    setPanelView(view);
    writeComputerPanelView(bot.id, view);
    if (view === "browser") setSignInRequest({ url: requestedSignIn.url, site: requestedSignIn.site, nonce: requestedSignIn.requestId });
    dispatch({ type: "signInFocusConsumed", requestId: requestedSignIn.requestId });
  }, [bot.id, dispatch, requestedSignIn]);

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

  useAndroidTabFallback(bot.id, androidStatus, setPanelView);
  useEffect(() => {
    vmReadinessAttempts.current = 0;
  }, [bot.id, bot.computer]);
  const vmSupported = Boolean(
    selectedInstance?.snapshot.state === "available" &&
      selectedInstance.capabilities?.computerMcp,
  );
  const cloudSupported = canWorkOnCloud(cloudEngineOf(selectedInstance));
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
  useEffect(() => {
    if (panelView !== "computer") return;
    let alive = true;
    setResolvedComputerSelection(null);
    setTeamComputer(null);
    setPhase("checking");
    setPolledFrame(null);
    setPreviewError(null);
    setVmFrame(null);
    setVmStatus(null);
    setVpsStatus(null);
    setLocalFrame(null);
    setError(null);
    // The selection may be optimistic: never let it choose a provider until the PATCH confirms server state.
    if (!computerSelectionPersisted || !surfaceReady) return;
    if (bot.computer === undefined) {
      setPhase("auto-unavailable");
      return;
    }

    if (bot.computer === "off") {
      setPhase("off");
      return;
    }
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
      setPhase("error");
      return;
    }
    if (bot.computer !== "cloud" && !capabilitiesReady) return;
    if (cloudBackend === "vps") {
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
    // Opening the panel only looks: it never creates or wakes a Boat.
    api(threadPath("computer"))
      .then((status) => {
        if (!alive) return;
        const action = resolveBoatPanelAction({
          computer: livePlace === "cloud" ? "cloud" : undefined,
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
          setBoatState(typeof status.box?.state === "string" ? status.box.state : null);
          setPhase("ready");
          return;
        }
        setBoatState(typeof status.box?.state === "string" ? status.box.state : null);
        setPhase(action);
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
    bot.threadId,
    bot.computer,
    bot.section,
    bot.autoStartVps, bot.vpsAlias,
    cloudBackend,
    retry,
    capabilitiesReady,
    localSelectable,
    isLinux,
    providerSupportsLocal,
    selectedInstance?.driverKind,
    vmSupported,
    cloudSupported,
    state.config?.vps?.sshAlias,
    panelView,
    computerSelectionPersisted,
    surfaceReady,
    canManageCloud,
    livePlace,
    threadPath,
  ]);

  useEffect(() => {
    if (phase !== "busy-boat") return;
    let alive = true;
    const check = () => {
      if (!profileBot.busy && livePlace === "cloud") {
        setRetry((n) => n + 1);
        return;
      }
      api(threadPath("computer"), { background: true })
        .then((status) => {
          if (!alive) return;
          const state = typeof status.box?.state === "string" ? status.box.state : null;
          setBoatState(state);
          if (isReadyBoatState(state)) setPhase("ready");
        })
        .catch(() => {});
    };
    const timer = window.setInterval(check, 5_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [phase, threadPath, profileBot.busy, livePlace]);

  const control = state.computerControl[bot.id] ?? { held: false, helpReason: null };
  const requestControl = useCallback(async (action: ComputerControlAction, controlLeaseId?: string) => {
    const snap = computerControlSnapshotSchema.parse(await api(`/api/bots/${bot.id}/computer/control`, {
      method: "POST",
      body: JSON.stringify({ action, ...(controlLeaseId ? { controlLeaseId } : {}) }),
    }));
    dispatch({
      type: "computerControl",
      botId: bot.id,
      held: snap.held === true,
      helpReason: snap.helpReason,
      help: snap.help,
    });
    return snap;
  }, [bot.id, dispatch]);
  const liveTarget = !computerStatusCurrent ? null
    : phase === "vm" && vmStatus?.viewer_url && vmStatus.target_key ? viewerTargetId({ key: vmStatus.target_key })
      : cloudPreviewReady && cloudBackend === "vps" ? `vps/${bot.id}` : null;
  const takeover = useComputerTakeover({
    botId: bot.id, session: `${viewerConnectionKey}:${panelView}`, held: control.held, request: requestControl,
    viewerClose: liveTarget?.startsWith("vps/") ? threadPath("computer/viewer-close") : null,
  });
  const liveHere = takeover.here && Boolean(liveTarget);
  useEffect(() => { if (liveTarget) void loadLiveDesktop(); }, [liveTarget]);

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
    if (panelView !== "computer" || !cloudPreviewReady || viewerOpen || liveHere || !pageVisible || pending || controlPending) return;
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
    const timer = setInterval(shoot, 1000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [panelView, cloudPreviewReady, threadPath, cloudBackend, viewerOpen, liveHere, pageVisible, pending, controlPending, previewRetry]);

  useEffect(() => {
    if (panelView !== "computer" || phase !== "vm" || !computerStatusCurrent || viewerOpen || liveHere || !pageVisible) return;
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
  }, [panelView, phase, computerStatusCurrent, threadPath, viewerOpen, liveHere, pageVisible, bot.busy, setError, setPreviewError, setVmFrame]);

  // The first capture attempt is what makes macOS show the Screen Recording prompt (no reliable pre-grant on macOS
  // 15+), so repeated empty frames mean denied.
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
  const previewOpensDesktop = Boolean(frameSrc && (liveTarget || cloudPreviewReady));

  const signInHelp = control.help ?? null;
  const signInAsker = signInHelp ? state.bots.find((candidate) => candidate.id === signInHelp.botId)?.name ?? bot.name : bot.name;
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
          help: snap.help,
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  const setNativeBrowserControl = useCallback(async (): Promise<boolean> => true, []);

  const transitionControl = useCallback(async (action: ComputerControlAction) => {
    // Security: every computer surface must gate Electron's direct browser host; the server hold is bot-wide, and a
    // shell-capable agent could otherwise bypass the server proxy while the person drives.
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

  const bannerTakesControl = Boolean(signInHelp && signInHelp.place !== "browser" && signInHelp.place !== "local" &&
    (cloudPreviewReady || phase === "vm" || currentTeamComputer));
  const signInBanner = (take?: () => void) => signInHelp && (
    <SignInBanner
      help={signInHelp}
      askerName={signInAsker}
      takeControl={take && { onClick: take, disabled: controlPending || pending === "join", pending: pending === "join" }}
      onError={setError}
    />
  );

  const openDesktop = async () => {
    const controller = new AbortController();
    desktopJoin.current = controller;
    const ownsConnection = () => !controller.signal.aborted && viewerConnection.current === viewerConnectionKey;
    setPending("join");
    setControlPending(true);
    setError(null);
    try {
      await openProviderDesktop({
        botId: bot.id, title: t("computer.viewerTitle", { name: bot.name }), held: control.held, request: requestControl,
        join: (signal) => api(threadPath("computer/join"), { method: "POST", signal: AbortSignal.any([controller.signal, signal]) }),
        current: ownsConnection,
      });
    } catch (e) {
      if (ownsConnection()) setError(e instanceof Error ? e : String(e));
    } finally {
      if (desktopJoin.current === controller) {
        desktopJoin.current = null;
        setPending(null);
        setControlPending(false);
      }
    }
  };

  const takeControl = async (expand = false) => {
    if (!liveTarget) return cloudPreviewReady ? openDesktop() : undefined;
    if (takeover.here) return takeover.setExpanded(expand || takeover.expanded);
    setControlPending(true);
    setError(null);
    try {
      await takeover.take(expand);
    } catch (cause) {
      setError(cause instanceof Error ? cause : String(cause));
    } finally {
      setControlPending(false);
    }
  };

  const handBack = async () => {
    setError(null);
    void window.ogb?.desktopViewer?.close(bot.id);
    await takeover.handBack().catch((cause) => setError(cause instanceof Error ? cause : String(cause)));
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
          else setPhase(canManageCloud ? "cloud-asleep" : "show-sleeping-boat");
        }
      })
      .catch((e) => {
        setError(e.message);
      })
      .finally(() => setPending(null));
  };

  const startCloudComputer = () => {
    setPending("provision");
    setError(null);
    setPhase("starting");
    api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" })
      .then((result) => {
        setBoatState(result.state ?? null);
        setResolvedComputerSelection({ botId: bot.id, threadId: bot.threadId, computer: bot.computer, cloudBackend });
        setPhase("ready");
      })
      .catch((e) => {
        if (isActiveTurnRefusal(e)) {
          setPhase("busy-boat");
          return;
        }
        setError(e.message);
        setPhase("error");
      })
      .finally(() => setPending(null));
  };

  const runVmAction = async (action: "vm-start" | "vm-create" | "vm-recreate" | "vm-delete") => {
    if (
      (action === "vm-recreate" || action === "vm-delete") &&
      !window.confirm(
        action === "vm-delete"
          ? t("computer.confirm.deleteVm", { name: bot.name })
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
        const lifecyclePath = action === "vm-start" && vmStatus?.mode !== "per-bot"
          ? "/api/local-computer/start"
          : `/api/bots/${bot.id}/local-computer/${action === "vm-start" ? "start" : "run"}`;
        const started: LocalVmStatus = await api(lifecyclePath, {
          method: "POST",
          body: "{}",
          signal: controller.signal,
        });
        const status = await waitForLocalVmReady(started, () => api(threadPath("local-computer"), { signal: controller.signal }), controller.signal);
        if (!status.ready) throw new Error(status.problem ?? t("computer.err.vmNotReady"));
        setVmStatus(status);
        setPhase("vm");
      } else {
        setVmStatus((current) => current ? { ...current, container: "missing", ready: false } : current);
        setPhase("vm-unavailable");
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("vm-unavailable");
    } finally {
      if (vmActionController.current === controller && !controller.signal.aborted) {
        vmActionController.current = null;
        setPending(null);
        setRetry((n) => n + 1);
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

  const managedPolicy = state.config?.managedPolicy;
  const busyBoat = busyBoatView(boatState, profileBot.busy === true);
  const cloudComputer: PlaceFacts["computer"] = !computerStatusCurrent || livePlace !== "cloud" || cloudBackend !== "box" ? undefined
    : phase === "starting" ? "starting"
      : phase === "busy-boat" ? (busyBoat.spinner ? "starting" : busyBoat.line === "computer.cloud.asleep" ? "asleep" : "none")
        : phase === "ready" ? "on"
          : boatState === "archived" || boatState === "stopped" ? "asleep" : undefined;
  const viewOf = (place: PlaceFacts["place"], refusal?: PlaceFacts["refusal"]): PlaceView => placeViewFor({
    ...placeFacts({
      bot, place, seat: placeSeat, config: state.config, instances: state.instances,
      local: { ready: localSelectable, reason: localDisabledReason ?? t("computer.unavailableLocal") },
      ...(place === "cloud" ? { computer: cloudComputer } : {}),
      ...(place === "auto" && currentTeamComputer ? { teamComputer: currentTeamComputer.name } : {}),
    }),
    ...(refusal ? { refusal } : {}),
  });
  const cloudRefused = bot.computer === "cloud" && cloudBackend === "box" && phase === "error" && error && !(error instanceof LocalizedPanelError)
    ? cloudRefusal({ message: errorText ?? "", status: Number((error as { status?: unknown }).status ?? 0) || undefined }, state.config?.box?.included === true)
    : undefined;
  const cloudView = viewOf("cloud", cloudRefused);
  const autoView = viewOf("auto");
  const placeOptions = ([
    [null, "vm.dest.auto", "computer.dest.autoDesc", Sparkles],
    ["cloud", "place.cloud", "computer.dest.cloudDesc", Cloud],
    ["vm", "vm.dest.vm", "computer.dest.vmDesc", Box],
    ["local", "vm.dest.local", "computer.dest.localDesc", Monitor],
    ["browser", "vm.dest.browser", "computer.dest.browserDesc", Globe],
    ["off", "vm.dest.off", "computer.dest.offDesc", Power],
  ] as const).filter(([mode]) => mode === null || mode === "off" || placeOffered(mode, state.config)).map(([mode, labelKey, descriptionKey, Icon]) => {
    const selected = mode === null ? !profileBot.computer : profileBot.computer === mode;
    const managedKind = mode === "local" ? "thisComputer" : mode === "vm" ? "localVm" : mode === "cloud" ? (profileBot.cloudBackend === "vps" ? "vps" : "box") : null;
    const managedBy = managedPolicy && managedKind && !managedPolicy.computers[managedKind] ? t("policy.managedBy", { organization: managedPolicy.organizationName }) : undefined;
    const view = mode === null ? autoView : mode === "cloud" ? cloudView : viewOf(mode);
    const disabled = Boolean(managedBy) || placeBlocked(view);
    const issue = !managedBy && placeHasIssue(view);
    const unavailableTitle = managedBy ?? (issue ? view.line : mode === "browser" ? t("computer.browserOnlyTitle") : undefined);
    return { mode, labelKey, descriptionKey, Icon, simpleLabel: worksOnSimpleLabel(mode ?? undefined, capabilities.host.platform), selected, managedBy, disabled, unavailableTitle, view, issue };
  });
  const worksOnView = placeOptions.find(({ selected }) => selected)?.view ?? autoView;
  const runPlaceAction = (id: PlaceActionId) => {
    if (id === "start" || id === "wake") return startCloudComputer();
    if (id === "try-again") return setRetry((n) => n + 1);
    if (id === "turn-on-browser") return void turnOnBrowser();
    if (id === "open-vm-settings") return openVmSettings();
    openPlaceAction(id, { botId: profileBot.id, threadId: profileBot.threadId }, dispatch);
  };
  const panelOffers = (id: PlaceActionId | undefined): id is PlaceActionId => Boolean(id) && id !== "watch" && id !== "open-computer-panel"
    && ((id !== "start" && id !== "wake") || (canManageCloud && !profileBot.busy));
  const placeActionButton = (view: PlaceView, className = "mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover") =>
    view.action && panelOffers(view.action.id) ? (
      <button type="button" data-testid="place-action" onClick={() => runPlaceAction(view.action!.id)} className={className}>
        {view.action.label}
      </button>
    ) : null;
  const selectPlace = (mode: (typeof placeOptions)[number]["mode"]) => {
    if ((mode === null && profileBot.computer === undefined) || mode === profileBot.computer) return;
    if (mode === "local" && approvalModeFor(profileBot) === "auto") {
      setLocalAutoWarningTarget(bot.id);
    }
    else if (mode === "browser") updateComputerSelection({ computer: mode, browser: true });
    else updateComputerSelection({ computer: mode });
  };
  const heldPin = liveTask?.surface && !liveTask.surfaceAuto && profileBot.computer !== "off"
    && liveTask.surface !== profileBot.computer ? liveTask.surface : undefined;

  const tabClass = (active: boolean) => cn(
    "flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] transition-colors @max-[28rem]/paneltabs:[&>svg]:hidden @max-[22rem]/paneltabs:px-2",
    active ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
  );

  const chooseTab = (view: ComputerPanelView) => {
    if (view === "browser") setError(null);
    selectPanelView(view);
  };

  const emptyState = {
    checking: t("computer.phase.checking"),
    starting: cloudBackend === "vps" ? t("computer.phase.starting") : cloudView.line,
    "busy-boat": cloudView.line,
    unconfigured: cloudView.line,
    "auto-unavailable": autoView.line,
    "team-boat": autoView.line,
    "show-ready-boat": t("computer.phase.showReadyBoat"),
    "show-sleeping-boat": t("computer.phase.showSleepingBoat"),
    "show-pending-boat": t("computer.phase.showPendingBoat"),
    "cloud-new": cloudView.line,
    "cloud-asleep": cloudView.line,
    "vps-unconfigured": t("computer.phase.vpsUnconfigured"),
    "vps-incompatible": t("computer.phase.vpsIncompatible"),
    "vps-stopped": t("computer.phase.vpsStopped"),
    "local-unavailable": localDisabledReason ?? t("computer.phase.localUnavailable"),
    "vm-unavailable": t("computer.phase.vmUnavailable"),
    browser: viewOf("browser").line,
    off: viewOf("off").line,
    error: bot.computer === "cloud" && (cloudRefused || placeBlocked(cloudView)) ? cloudView.line : t("computer.phase.error"),
  } satisfies Record<Exclude<Phase, "ready" | "local" | "vm">, string>;

  return (
    <>
    <aside
      className={cn(
        "animate-panel-in relative flex h-full shrink-0 flex-col border-l border-hairline/40 bg-panel",
        "max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full!",
      )}
      ref={panelRef}
      data-computer-panel
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
      {/* ml-1.5 keeps the drag region clear of the resize handle: a later drag region in the DOM wins. */}
      <div {...dragProps} className={cn("@container/paneltabs ml-1.5 py-3 pl-2.5 pr-4", padClass)}>
        <div className="relative flex min-h-7 items-center justify-center">
          {advanced && (
            <button
              onClick={() => {
                releaseComputerPanelFocus(panelRef.current, bot.id);
                dispatch({ type: "toggleComputer", open: false });
                dispatch({ type: "toggleSettings", open: true, section: "access" });
              }}
              className="absolute left-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
              title={t("computer.botSettings")}
            >
              <Settings size={18} />
            </button>
          )}
          <div className="mx-9 flex min-w-0 touch-pan-x gap-0.5 overflow-x-auto whitespace-nowrap rounded-full bg-inset p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-tour="computer-tabs" data-testid="computer-tabs" role="tablist" aria-label={t("computer.tabsAria")} onWheel={scrollTabsWithWheel} onKeyDown={(event) => moveBetweenTabs(event, panelTabs, chooseTab)}>
            {panelTabs.map((view) => {
              const { Icon, label, tour } = PANEL_TABS[view];
              const live = !placeLive ? undefined
                : view === "computer" && isComputerPlace(livePlace) ? "computer-tab-live"
                : view === "browser" && livePlace === "browser" ? "browser-tab-live" : undefined;
              return (
                <button key={view} type="button" data-tour={tour} {...panelTabProps(view, view === panelView)} title={t(label)} onClick={() => chooseTab(view)} className={tabClass(view === panelView)}>
                  <Icon size={13} /> {t(label)}
                  {live && <span className="size-1.5 animate-pulse rounded-full bg-success" role="img" aria-label={t("place.live")} data-testid={live} />}
                </button>
              );
            })}
          </div>
          <button
            data-computer-panel-close
            onClick={() => {
              releaseComputerPanelFocus(panelRef.current, bot.id);
              dispatch({ type: "toggleComputer", open: false });
            }}
            className="absolute right-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            aria-label={t("computer.close")}
            title={t("computer.close")}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {panelView === "routines" ? (
        <div {...tabPanelProps("routines")} className={cn("min-h-0 flex-1 overflow-y-auto px-4 pb-4", TAB_PANEL_FOCUS)}>
          <RoutinesSection key={bot.id} bot={bot} routines={botRoutines} runs={state.routineRuns} defaultRunOn={cloudRoutineReady ? "cloud" : "maus"} />
        </div>
      ) : panelView === "browser" && browserEnabled ? (
        <div {...tabPanelProps("browser")} className={cn("flex min-h-0 flex-1 flex-col px-4 pb-4", TAB_PANEL_FOCUS)}>
          {browserSwitchRow}
          {signInHelp?.place === "browser" && <div className="-mt-1 mb-3">{signInBanner()}</div>}
          <BrowserPanel bot={bot} signIn={signInRequest} page={pageRequest} />
          {errorText && (
            <div role="alert" className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {errorText}
            </div>
          )}
        </div>
      ) : panelView === "browser" ? (
        <div {...tabPanelProps("browser")} className={cn("flex-1 overflow-y-auto px-5 pb-5", TAB_PANEL_FOCUS)} data-testid="browser-off">
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
      ) : panelView === "data" ? (
        <div {...tabPanelProps("data")} className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", TAB_PANEL_FOCUS)}>
          <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[13px] text-ink-secondary" role="status">{t("data.loading")}</div>}>
            <DataPanel key={bot.id} bot={bot} requestedCard={dataRequest} />
          </Suspense>
        </div>
      ) : panelView === "files" ? (
        <div {...tabPanelProps("files")} className={cn("flex min-h-0 flex-1 flex-col", TAB_PANEL_FOCUS)}>
          <ComputerFilesPane bot={bot} />
        </div>
      ) : panelView === "android" && androidConnected ? (
        <div {...tabPanelProps("android")} className={cn("flex-1 overflow-y-auto px-4 pt-2", TAB_PANEL_FOCUS)}>
          <AndroidDevicePanel status={androidStatus} />
        </div>
      ) : (
      <div {...tabPanelProps("computer")} className={cn("flex-1 overflow-y-auto px-5 pb-5", TAB_PANEL_FOCUS)}>
          <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
            <span>{t("computer.screenOf", { name: bot.name })}</span>
            {currentTeamComputer && <span className="text-[11px]">{autoView.short}</span>}
            {phase === "local" && <span className="text-[11px]">{t("computer.badge.local")}</span>}
            {liveHere && <span className="flex items-center gap-1.5 text-[11px] font-medium text-ink"><span className="size-1.5 rounded-full bg-success" />{t("computer.inControl")}</span>}
            {phase === "vm" && !liveHere && <span className="text-[11px]">{t("vm.dest.vm")}</span>}
            {(phase === "show-ready-boat" || phase === "show-sleeping-boat" || phase === "show-pending-boat") && (
              <span className="text-[11px]">{t("computer.badge.autoBoat")}</span>
            )}
            {computerStatusCurrent && bot.computer === "cloud" && cloudBackend === "vps" && (phase === "ready" || phase === "starting") && !liveHere && <span className="text-[11px]">{t("computer.badge.vps")}</span>}
        </div>
        <div className={cn("relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card", liveHere && "ring-2 ring-accent")}>
          {liveHere && liveTarget ? (
            <Suspense fallback={<Loader2 size={18} className="animate-spin text-ink-secondary" />}>
              <LiveDesktop
                target={liveTarget} threadId={bot.threadId} name={bot.name} poster={frameSrc}
                expanded={takeover.expanded} onExpandedChange={takeover.setExpanded}
                onHandBack={() => void handBack()} handingBack={takeover.handingBack}
                onUnreachable={() => { takeover.leave(); setError(new LocalizedPanelError("computer.err.openDesktop")); }}
              />
            </Suspense>
          ) : cloudPreviewReady || (bot.computer === "cloud" && phase === "starting") ? (
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
              onOpen={() => void takeControl()}
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
              onClick={() => void takeControl()}
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
              {phase === "checking" || phase === "starting" || (phase === "busy-boat" && busyBoat.spinner) || phase === "vm" || (phase === "local" && !isLinux) ? (
                <Loader2 size={18} className="animate-spin" />
              ) : phase === "off" ? (
                <Power size={22} />
              ) : (
                <Monitor size={22} />
              )}
              <span className="text-[12px]">
                {currentTeamComputer
                  ? autoView.line
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
                    : vmResumable
                      ? t(pending === "vm-start" ? "vm.setup.starting" : "computer.phase.vmStopped")
                      : emptyState[phase]}
              </span>
              {currentTeamComputer && placeActionButton(autoView)}
              {bot.computer === "cloud" && (phase === "unconfigured" || phase === "error") && cloudView.action?.id !== "add-boat-key" && placeActionButton(cloudView)}
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
              {pending === null && (phase === "cloud-new" || phase === "cloud-asleep") && placeActionButton(cloudView)}
              {vmResumable && pending !== "vm-start" && (
                <p className="text-[12px]">{t(vmStatus?.stop_reason === "idle" ? "vm.stopped.idle" : "vm.stopped.detail")}</p>
              )}
              {phase === "vm-unavailable" && (
                canManageVm && vmResumable && vmStatus.mode !== "pool" ? (
                  <button
                    onClick={() => void runVmAction("vm-start")}
                    disabled={pending !== null}
                    aria-busy={pending === "vm-start"}
                    className="mt-1 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                  >
                    {pending === "vm-start" && <Loader2 size={13} className="animate-spin" />}
                    {t(pending === "vm-start" ? "vm.setup.starting" : "vm.setup.start")}
                  </button>
                ) : canManageVm && vmStatus?.mode === "per-bot" && vmStatus.image && vmStatus.create_supported ? (
                  <button
                    onClick={() => void runVmAction(vmStatus.container === "missing" ? "vm-create" : "vm-recreate")}
                    disabled={pending !== null}
                    className="mt-1 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                  >
                    {(pending === "vm-create" || pending === "vm-recreate") && (
                      <Loader2 size={13} className="mr-1.5 inline animate-spin" />
                    )}
                    {vmStatus.container === "missing"
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

        {errorText && !cloudRefused && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {errorText}
          </div>
        )}
        {phase === "unconfigured" && cloudView.action?.id === "add-boat-key" && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <ApiKeyRow
              section="box" via="computer_panel"
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

        {advanced &&
          phase === "vm" &&
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

        {signInHelp && signInHelp.place !== "browser" && signInBanner(bannerTakesControl && !control.held
          ? () => phase === "vm" || cloudPreviewReady ? void takeControl() : void controlAction("take")
          : undefined)}
        {(cloudPreviewReady || phase === "vm" || currentTeamComputer) && control.held && (
          <div className="mt-3 rounded-xl border border-accent/25 bg-accent/10 p-4">
            <div className="text-[13px] leading-relaxed text-ink">
              {t("computer.youHaveWheel")}
              {cloudPreviewReady && !liveTarget && ` ${t(advanced ? "computer.useOpenDesktop" : "computer.simple.useFullScreen")}`}
            </div>
            <button
              onClick={() => void handBack()}
              disabled={controlPending || takeover.handingBack}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
            >
              <Hand size={14} />
              {t("computer.handBack")}
            </button>
          </div>
        )}
        {advanced && phase === "vm" && (control.held || !bannerTakesControl) && (
          <button
            onClick={() => void takeControl(control.held)}
            disabled={controlPending || !liveTarget}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            title={control.held ? t("computer.openLiveDesktop") : t("computer.takeControlTitle")}
          >
            {controlPending ? <Loader2 size={14} className="animate-spin" /> : control.held ? <Maximize2 size={14} /> : <Hand size={14} />}
            {t(control.held ? "computer.fullScreen" : "computer.takeControl")}
          </button>
        )}
        {advanced && canManageVm && phase === "vm" && vmStatus?.mode === "per-bot" && (
          <button
            onClick={() => void runVmAction("vm-delete")}
            disabled={pending !== null || profileBot.busy}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-danger/30 py-2 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50"
            title={profileBot.busy ? t("computer.deleteVmBlocked") : t("computer.deleteVmTitle", { name: bot.name })}
          >
            {pending === "vm-delete" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            {t("computer.deleteVm")}
          </button>
        )}
        {!advanced && (cloudPreviewReady || phase === "vm") && (
          <div className="mt-3 flex gap-2" data-testid="computer-actions">
            {!control.held && !bannerTakesControl && (
              <button
                type="button"
                onClick={() => void takeControl()}
                disabled={controlPending || pending === "join" || (phase === "vm" && !liveTarget)}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-50"
                title={t("computer.takeControlTitle")}
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
                {t("computer.takeControl")}
              </button>
            )}
            <button
              type="button"
              onClick={() => void takeControl(true)}
              disabled={pending === "join" || (!control.held && controlPending) || (phase === "vm" && !liveTarget)}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              title={t("computer.openLiveDesktop")}
            >
              <Maximize2 size={14} />
              {t("computer.fullScreen")}
            </button>
            {cloudPreviewReady && canManageCloud && (cloudBackend === "vps" || boatState !== "archived") && (
              <button
                type="button"
                onClick={() => run("sleep")}
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
        {advanced && cloudPreviewReady && (
          <div className="mt-3 flex gap-2">
            {!control.held && !bannerTakesControl && (
              <button
                onClick={() => void takeControl()}
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
                onClick={() => void takeControl(true)}
                disabled={pending === "join"}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : liveTarget ? <Maximize2 size={14} /> : <Monitor size={14} />}
                {t(liveTarget ? "computer.fullScreen" : "computer.openLiveDesktop")}
              </button>
            )}
            {canManageCloud && (cloudBackend === "vps" || boatState !== "archived") && (
              <button
                onClick={() => run("sleep")}
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

        {advanced ? <>
          <div className="mt-4 rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">{t("computer.worksOn")}</div>
            <p className="mt-1 text-[12px] leading-5 text-ink-secondary">
              {t(state.config?.cloudHome ? "computer.worksOnHintCloudHome" : "computer.worksOnHint")}
            </p>
          <div role="group" aria-label={t("computer.destinationAria")} className="mt-3 grid auto-rows-fr grid-cols-2 gap-2">
            {placeOptions.map(({ mode, labelKey, descriptionKey, Icon, selected, managedBy, disabled, unavailableTitle, issue, view }) => (
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
                  {managedBy ?? (issue ? view.short : t(descriptionKey))}
                </span>
              </button>
            ))}
          </div>
          {liveTask?.surface && (
            <p className="mt-2 text-[11.5px] leading-5 text-ink-secondary" data-testid="place-pinned-note">
              {t("place.pinnedNote", { place: t(placeLabelKey(liveTask.surface)) })}
            </p>
          )}
          <div className="mt-3 border-t border-hairline/40 pt-3 text-[11.5px] leading-5 text-ink-secondary" aria-live="polite" data-testid="place-line">
            {worksOnView.line}
            {placeActionButton(worksOnView, "mt-1 block font-medium text-accent hover:underline")}
          </div>
          {profileBot.computer === "cloud" && (
            <CloudBackendPicker
              compact
              value={cloudBackend}
              onChange={(backend) => updateComputerSelection({ cloudBackend: backend })}
            />
          )}
        </div>

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
              {placeOptions.map(({ mode, Icon, selected, disabled, unavailableTitle, simpleLabel, issue, view }) => (
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
                  {issue && <span className="w-full truncate text-[10.5px] leading-3 text-ink-secondary">{view.short}</span>}
                </button>
              ))}
            </div>
            <div className="mt-3 text-[11.5px] leading-5 text-ink-secondary" data-testid="place-line">
              {worksOnView.line}
              {placeActionButton(worksOnView, "mt-1 block font-medium text-accent hover:underline")}
            </div>
            {heldPin && (
              <div className="mt-2 flex items-center gap-2">
                <p className="min-w-0 flex-1 text-[11.5px] leading-5 text-ink-secondary" data-testid="place-pinned-note">
                  {t("place.pinnedNoteSimple", {
                    place: placeOptions.find(({ mode }) => mode === heldPin)?.simpleLabel ?? t(placeLabelKey(heldPin)),
                  })}
                </p>
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
