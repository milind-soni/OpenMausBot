// The bot's computer, in the right-side slot. Where it runs decides the
// whole flow: explicit cloud → provision the box on open (idempotent). This
// panel carries no screen image: while Astra drives, a border-beam rides the
// frame, and the live desktop stays a separate, user-initiated window. Nothing
// here polls, decodes, or renders a screenshot, so the panel paints at once.
// Auto only reads an existing Box's state: opening this panel never creates,
// wakes, bootstraps, or opens one, regardless of engine.
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { BorderBeam } from "border-beam";
import { ThinkingOrb } from "thinking-orbs";
import {
  CalendarClock,
  Columns2,
  Box,
  Check,
  Cloud,
  Sparkles,
  Globe,
  Hand,
  Loader2,
  Monitor,
  Moon,
  Power,
  Settings,
  Smartphone,
  X,
} from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import type { CloudBackend } from "../../server/contracts.ts";
import { ApiKeyRow } from "./ApiKeys";
import { cn } from "@/lib/cn";
import { usePageVisible } from "@/lib/page-visible";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { RoutinesSection } from "./bot-settings/RoutinesSection";
import { routineRunLabel, routineRunTone } from "@/lib/routine-display";
import { AndroidDevicePanel, useAndroidUsbDevices } from "./AndroidDevicePanel";
import { BrowserPanel } from "./BrowserPanel";
import { browserAvailable, browserUnavailableReason, builtInBrowserEnabled } from "@/lib/feature-flags";
import { transitionComputerControlLease, type ComputerControlAction } from "@/lib/computer-control";
import { LinuxLocalControl } from "./LinuxLocalControl";
import { MacLocalControl } from "./MacLocalControl";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import {
  astraDriving,
  autoSelectsLocalComputer,
  instanceSupportsLocalComputer,
  localComputerDisabledReason,
  localComputerSelectable,
  persistedComputerSelectionMatches,
  resolveBoxPanelAction,
  cloudDesktopReady,
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
  | "ready"
  | "vm"
  | "vm-unavailable"
  | "vps-unconfigured"
  | "vps-incompatible"
  | "vps-stopped"
  | "local"
  | "local-unavailable"
  | "auto-unavailable"
  | "show-ready-box"
  | "show-sleeping-box"
  | "show-pending-box"
  | "browser"
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
  // makes it wide enough to actually read a page in the Browser tab.
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
  const { state, dispatch, flushBotPatches } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const localAvailable = capabilities.localComputer.available;
  const isLinux = capabilities.host.platform === "linux";
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = localComputerSelectable({ capabilities, providerSupportsLocal });
  const [localAutoWarningTarget, setLocalAutoWarningTarget] = useState<string | null>(null);
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const [phase, setPhase] = useState<Phase>("checking");
  const [persistedComputerSelection, setPersistedComputerSelection] = useState<{
    botId: string;
    computer: Bot["computer"];
    cloudBackend: CloudBackend;
  } | null>(null);
  const [resolvedComputerSelection, setResolvedComputerSelection] = useState<{
    botId: string;
    computer: Bot["computer"];
    cloudBackend: CloudBackend;
  } | null>(null);
  const cloudBackend = bot.cloudBackend ?? "box";
  const computerSelectionPersisted = Boolean(
    persistedComputerSelection
      && persistedComputerSelection.botId === bot.id
      && persistedComputerSelection.computer === bot.computer
      && persistedComputerSelection.cloudBackend === cloudBackend,
  );
  const computerStatusCurrent = Boolean(
    resolvedComputerSelection
      && resolvedComputerSelection.botId === bot.id
      && resolvedComputerSelection.computer === bot.computer
      && resolvedComputerSelection.cloudBackend === cloudBackend,
  );
  const cloudPreviewReady = cloudDesktopReady({
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
    setPhase("checking");
    dispatch({ type: "updateBot", botId: bot.id, patch });
  }, [bot.id, dispatch]);
  useEffect(() => {
    let alive = true;
    setPersistedComputerSelection(null);
    void flushBotPatches(bot.id).then((persistedBot) => {
      if (!alive) return;
      if (persistedBot && !persistedComputerSelectionMatches({
        computer: bot.computer,
        cloudBackend,
        persistedBot,
      })) return;
      setPersistedComputerSelection({
        botId: bot.id,
        computer: bot.computer,
        cloudBackend,
      });
    });
    return () => {
      alive = false;
    };
  }, [bot.id, bot.computer, cloudBackend, flushBotPatches]);
  const [boxState, setBoxState] = useState<string | null>(null);
  // The Local VM's interactive noVNC viewer (passworded, autoconnect). The
  // preview below is a periodic screenshot that swallows clicks — this URL is
  // the only way a person can actually drive the VM.
  const [vmViewerUrl, setVmViewerUrl] = useState<string | null>(null);
  const [vmStatus, setVmStatus] = useState<LocalVmStatus | null>(null);
  const [vpsStatus, setVpsStatus] = useState<VpsComputerStatus | null>(null);
  const [pending, setPending] = useState<
    "join" | "sleep" | "provision" | "vps-replace" | "vm-create" | "vm-recreate" | "vm-delete" | null
  >(null);
  const [controlPending, setControlPending] = useState(false);
  const [error, setError] = useState<Error | string | null>(null);
  const errorText = panelErrorText(error);
  const [panelView, setPanelView] = useState<ComputerPanelView>(() => readComputerPanelView(bot.id));
  const androidStatus = useAndroidUsbDevices();
  const androidConnected = androidStatus.devices.length > 0;
  // Keep installation reachable before the engine is ready. Actual browser
  // operations below still require browserAvailableHere.
  const browserAvailableHere = browserAvailable(state.config);
  const browserEnabled = builtInBrowserEnabled(state.config) && bot.browser !== false
    && (browserAvailableHere || state.config?.browserEngine?.installable === true);
  // bumped when a Box API key is saved inline, to re-run the spin-up flow
  const [retry, setRetry] = useState(0);
  const vmReadinessAttempts = useRef(0);
  const selectedInstance = state.instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  );
  // "Works on: Browser" needs the same things as the browser switch minus
  // the switch itself — picking it turns the switch on. The box-native
  // Computer engine runs inside the box, so it has no browser-only mode.
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

  useEffect(() => {
    setPanelView(readComputerPanelView(bot.id));
  }, [bot.id]);

  useEffect(() => {
    if ((!androidConnected && panelView === "android") || (!browserEnabled && panelView === "browser")) {
      setPanelView("computer");
      writeComputerPanelView(bot.id, "computer");
    }
  }, [androidConnected, bot.id, browserEnabled, panelView]);
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
  // resolve the mode on open; box endpoints are only ever hit on the
  // cloud path, so local/off can never render a JSON error as an image
  useEffect(() => {
    // Other tabs own their surfaces. Do not provision a VM or wake a box
    // while reading routine history.
    if (panelView !== "computer") return;
    let alive = true;
    setResolvedComputerSelection(null);
    setPhase("checking");
    setVmViewerUrl(null);
    setVmStatus(null);
    setVpsStatus(null);
    setError(null);
    // The selection may be optimistic for up to the profile debounce. Never
    // let it choose a provider until the PATCH lane confirms server state.
    if (!computerSelectionPersisted) return;

    if (bot.computer === "off") {
      setPhase("off");
      return;
    }
    // Browser-only bots own no desktop: the Browser tab is their whole
    // screen, so this tab must not wake a box or start host capture.
    if (bot.computer === "browser") {
      setPhase("browser");
      return;
    }
    if (bot.computer === "local") {
      if (!providerSupportsLocal) {
        setError(new LocalizedPanelError("computer.err.localEngine"));
      }
      setPhase(capabilitiesReady && localAvailable && providerSupportsLocal ? "local" : "local-unavailable");
      return;
    }
    if (bot.computer === "vm") {
      if (!vmSupported) {
        setError(new LocalizedPanelError("computer.err.vmEngine"));
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
            setError(canCreateHere ? null : new LocalizedPanelError(
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
      const autoLocal =
        !isLinux && bot.computer !== "cloud" && capabilitiesReady && localSelectable;
      if (!vpsSupported) {
        if (autoLocal) setPhase("local");
        else {
          setError(new LocalizedPanelError("computer.err.vpsEngine"));
          setPhase("error");
        }
        return;
      }
      api(`/api/bots/${bot.id}/computer`)
        .then((rawStatus) => {
          if (!alive) return;
          const status: VpsComputerStatus = rawStatus;
          setVpsStatus(status);
          setResolvedComputerSelection({
            botId: bot.id,
            computer: bot.computer,
            cloudBackend,
          });
          if (!status.configured) {
            if (autoLocal) setPhase("local");
            else {
              setError(new LocalizedPanelError("computer.err.vpsAlias"));
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
              if (result.ready) {
                setResolvedComputerSelection({
                  botId: bot.id,
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
          if (autoLocal) {
            setPhase("local");
            return;
          }
          setBoxState(status.container ?? null);
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
    // Explicit Cloud may create/wake its Box. Auto is observation-only here:
    // even a ready Box and the box-native engine stay free of POSTs until the
    // person deliberately chooses Cloud.
    api(`/api/bots/${bot.id}/computer`)
      .then((status) => {
        if (!alive) return;
        const autoLocal = autoSelectsLocalComputer({
          platform: capabilities.host.platform,
          computer: bot.computer,
          capabilitiesReady,
          localSelectable,
        });
        const action = resolveBoxPanelAction({
          computer: bot.computer,
          configured: Boolean(status.configured),
          boxState: typeof status.box?.state === "string" ? status.box.state : null,
          canUseCloud: cloudSupported,
          autoLocal,
        });
        setResolvedComputerSelection({
          botId: bot.id,
          computer: bot.computer,
          cloudBackend,
        });
        if (action !== "ensure-box") {
          if (action === "show-ready-box" || action === "show-sleeping-box" || action === "show-pending-box") {
            setBoxState(typeof status.box?.state === "string" ? status.box.state : null);
          }
          setPhase(action);
          return;
        }
        setPhase("starting");
        return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((r) => {
          if (!alive) return;
          setBoxState(r.state ?? null);
          setResolvedComputerSelection({
            botId: bot.id,
            computer: bot.computer,
            cloudBackend,
          });
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
    selectedInstance?.driverKind,
    vmSupported,
    cloudSupported,
    vpsSupported,
    state.config?.vps?.sshAlias,
    panelView,
    computerSelectionPersisted,
  ]);

  // No screenshot is fetched, polled, or decoded here. What remains is one
  // probe in local mode: the first real capture is what makes macOS raise its
  // Screen Recording prompt (there is no reliable pre-grant flow on macOS
  // 15+), so a denial has to be discovered by trying. The frame itself is
  // thrown away — only the fact of the capture is used, to offer the Settings
  // repair path instead of spinning.
  const pageVisible = usePageVisible();
  const [localMisses, setLocalMisses] = useState(0);
  useEffect(() => {
    if (panelView !== "computer" || phase !== "local" || !window.ogb || isLinux || !pageVisible) return;
    let alive = true;
    setLocalMisses(0);
    const probe = async () => {
      try {
        const captured = await window.ogb!.screenFrame();
        if (alive && !captured) setLocalMisses((n) => n + 1);
      } catch {
        if (alive) setLocalMisses((n) => n + 1);
      }
    };
    void probe();
    return () => {
      alive = false;
    };
  }, [panelView, phase, isLinux, pageVisible, bot.id]);

  // who-is-driving: SSE keeps this fresh; the mount fetch covers a panel
  // opened after the last frame (e.g. an app reload mid-hold)
  const control = state.computerControl[bot.id] ?? { held: false, helpReason: null };
  // The beam rides the frame for exactly the window where the agent is at the
  // wheel and nothing has taken it back — a bot that is merely selected, or a
  // person driving, gets no beam.
  const driving = astraDriving({ held: control.held === true, busy: bot.busy === true });
  // Mirror the who-is-driving state onto the live-desktop window: main injects
  // the beam stylesheet into the viewer while this bot holds the computer, so
  // the full-screen view glows exactly while Astra drives it.
  useEffect(() => {
    const bridge = window.ogb?.desktopViewer;
    if (!bridge?.setDriving) return;
    void bridge.setDriving(bot.id, driving).catch(() => {});
    return () => {
      // unmount / bot switch: make sure the beam never outlives its owner
      void bridge.setDriving(bot.id, false).catch(() => {});
    };
  }, [bot.id, driving]);
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
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
      if (cloudPreviewReady) {
        const result = await api(`/api/bots/${bot.id}/computer/join`, { method: "POST" });
        viewerUrl = result.joinUrl?.constructor === String ? String(result.joinUrl) : null;
      }
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
        await api(`/api/bots/${bot.id}/computer/viewer-close`, { method: "POST", body: "{}" }).catch(() => {});
      }
      setError(e instanceof Error ? e : String(e));
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
          if (result.ready) {
            if (bot.computer === "cloud") {
              setResolvedComputerSelection({ botId: bot.id, computer: bot.computer, cloudBackend });
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
          ? t("computer.confirm.deleteVm", { name: bot.name })
          : t("computer.confirm.replaceVm", { name: bot.name }),
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
      setBoxState(result.container ?? null);
      if (result.ready && bot.computer === "cloud") {
        setResolvedComputerSelection({ botId: bot.id, computer: bot.computer, cloudBackend });
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
    window.sessionStorage.setItem("astra.settings.section", "computer");
    dispatch({ type: "toggleAppSettings", open: true });
  };

  const openConnectionSettings = () => {
    dispatch({ type: "toggleAppSettings", open: true, section: "connections" });
  };

  const emptyState = {
    checking: t("computer.phase.checking"),
    starting: t("computer.phase.starting"),
    unconfigured: t("computer.phase.unconfigured"),
    "auto-unavailable": t("computer.phase.autoUnavailable"),
    "show-ready-box": t("computer.phase.showReadyBox"),
    "show-sleeping-box": t("computer.phase.showSleepingBox"),
    "show-pending-box": t("computer.phase.showPendingBox"),
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
      className="animate-panel-in relative flex h-full shrink-0 flex-col border-l border-hairline/40 bg-panel"
      style={{ width: panelWidth }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("computer.resizeAria")}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40"
      />
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: true, section: "access" })}
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          title={t("computer.botSettings")}
        >
          <Settings size={18} />
        </button>
        {(
          <div className="mx-2 flex min-w-0 flex-wrap overflow-hidden rounded-lg border border-hairline/40" data-tour="computer-tabs" aria-label="Bot panel view">
            <button
              onClick={() => selectPanelView("computer")}
              aria-pressed={panelView === "computer"}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 text-[12.5px]",
                panelView === "computer" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              <Monitor size={13} /> {t("computer.tab.computer")}
            </button>
            <button
              type="button"
              onClick={() => selectPanelView("routines")}
              aria-pressed={panelView === "routines"}
              className={cn("flex items-center gap-1.5 border-l border-hairline/40 px-2.5 py-1 text-[12.5px]", panelView === "routines" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink")}
            ><CalendarClock size={13} />{t("computer.tab.routines")}</button>
            {androidConnected && (
            <button
              onClick={() => selectPanelView("android")}
              aria-pressed={panelView === "android"}
              className={cn(
                "flex items-center gap-1.5 border-l border-hairline/40 px-2.5 py-1 text-[12.5px]",
                panelView === "android" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              <Smartphone size={13} /> {t("computer.tab.android")}
            </button>
            )}
            {browserEnabled && (
            <button
              data-tour="computer-browser"
              onClick={() => {
                setError(null);
                selectPanelView("browser");
              }}
              aria-pressed={panelView === "browser"}
              className={cn(
                "flex items-center gap-1.5 border-l border-hairline/40 px-2.5 py-1 text-[12.5px]",
                panelView === "browser" ? "bg-control text-ink" : "text-ink-secondary hover:text-ink",
              )}
            >
              <Globe size={13} /> {t("computer.tab.browser")}
            </button>
            )}
          </div>
        )}
        <button
          onClick={() => dispatch({ type: "toggleComputer", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      {panelView === "routines" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <RoutinesSection key={bot.id} bot={bot} routines={botRoutines} runs={state.routineRuns} defaultRunOn={cloudRoutineReady ? "cloud" : "astra"} />
        </div>
      ) : panelView === "browser" && browserEnabled ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
          <BrowserPanel bot={bot} />
          {errorText && (
            <div role="alert" className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {errorText}
            </div>
          )}
        </div>
      ) : panelView === "android" && androidConnected ? (
        <div className="flex-1 overflow-y-auto px-4 pt-2">
          <AndroidDevicePanel status={androidStatus} />
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto px-5 pb-5">
          {/* {name}'s screen, marked rather than mirrored: the beam rides the
              frame while the agent drives, and the live desktop is a separate
              window this panel never renders. */}
          <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
            <span>{t("computer.screenOf", { name: bot.name })}</span>
            {driving && <span className="text-[11px]">{t("vm.state.inUse")}</span>}
            {phase === "local" && <span className="text-[11px]">{t("computer.badge.local")}</span>}
            {phase === "vm" && <span className="text-[11px]">{t("vm.dest.vm")}</span>}
            {(phase === "show-ready-box" || phase === "show-sleeping-box" || phase === "show-pending-box") && (
              <span className="text-[11px]">{t("computer.badge.autoBox")}</span>
            )}
            {computerStatusCurrent && bot.computer === "cloud" && cloudBackend === "vps" && (phase === "ready" || phase === "starting") && <span className="text-[11px]">{t("computer.badge.vps")}</span>}
        </div>
        <BorderBeam
          size="md"
          colorVariant={driving ? "colorful" : "mono"}
          strength={driving ? 0.85 : 0.3}
          active={driving && !reducedMotion}
          className="block w-full rounded-xl"
        >
        <div className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
          {driving ? (
            <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 px-6 text-center">
              <ThinkingOrb state={control.helpReason ? "connecting" : "working"} size={64} paused={reducedMotion} />
              <span className="text-[12px] text-ink-secondary">
                {t("computer.astraDriving", { name: bot.name })}
              </span>
            </div>
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
                {cloudPreviewReady
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
                    : emptyState[phase]}
              </span>
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
              {(phase === "show-ready-box" || phase === "show-sleeping-box" || phase === "show-pending-box") && (
                <button
                  type="button"
                  onClick={() => updateComputerSelection({ computer: "cloud" })}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {phase === "show-sleeping-box"
                    ? t("computer.chooseCloudWake")
                    : phase === "show-ready-box"
                      ? t("computer.chooseCloudOpen")
                      : t("computer.chooseCloudManage")}
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
              {computerStatusCurrent && (phase === "vps-unconfigured" || phase === "vps-stopped") && (
                <button
                  onClick={openConnectionSettings}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {t("computer.openVpsSettings")}
                </button>
              )}
              {computerStatusCurrent && (phase === "vps-stopped" || (phase === "vps-unconfigured" && vpsStatus?.configured)) &&
                (bot.computer === "cloud" || bot.autoStartVps) && (
                <button
                  onClick={() => run("provision")}
                  disabled={pending === "provision"}
                  className="mt-1 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50"
                >
                  {pending === "provision" && <Loader2 size={13} className="mr-1.5 inline animate-spin" />}
                  {phase === "vps-stopped" ? t("computer.startVps") : t("computer.prepareVps")}
                </button>
              )}
              {computerStatusCurrent && phase === "vps-incompatible" && vpsStatus?.managed &&
                (bot.computer === "cloud" || bot.autoStartVps) && (
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
        </BorderBeam>

        {errorText && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {errorText}
          </div>
        )}
        {phase === "unconfigured" && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <div className="mb-3 text-[13px] text-ink-secondary">
              {t("computer.addBoxKey")}
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

        {phase === "vm" &&
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
        {(cloudPreviewReady || phase === "vm") && control.helpReason && !control.held && (
          <div className="mt-3 rounded-xl border border-warning/25 bg-warning/10 p-4">
            <div className="text-[13px] leading-relaxed text-warning">
              <b>{bot.name}</b> {t("computer.askedHands")} {control.helpReason}
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() =>
                  phase === "vm" || cloudPreviewReady ? void openDesktop() : controlAction("take")
                }
                disabled={controlPending || pending === "join"}
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
        {(cloudPreviewReady || phase === "vm") && control.held && (
          <div className="mt-3 rounded-xl border border-accent/25 bg-accent/10 p-4">
            <div className="text-[13px] leading-relaxed text-ink">
              {t("computer.youHaveWheel")}
              {cloudPreviewReady && ` ${t("computer.useOpenDesktop")}`}
              {phase === "vm" && ` ${t("computer.useOpenDesktopVm")}`}
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
        {phase === "vm" && vmViewerUrl && control.held && (
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
        {phase === "vm" && !control.held && !control.helpReason && (
          <button
            onClick={() => void openDesktop()}
            disabled={controlPending || pending === "join" || !vmViewerUrl}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            title={t("computer.takeControlVmTitle")}
          >
            {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <Hand size={14} />}
            {t("computer.takeControl")}
          </button>
        )}
        {phase === "vm" && vmStatus?.mode === "per-bot" && (
          <button
            onClick={() => void runVmAction("vm-delete")}
            disabled={pending !== null || bot.busy}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-danger/30 py-2 text-[13px] text-danger hover:bg-danger/10 disabled:opacity-50"
            title={bot.busy ? t("computer.deleteVmBlocked") : t("computer.deleteVmTitle", { name: bot.name })}
          >
            {pending === "vm-delete" ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
            {t("computer.deleteVm")}
          </button>
        )}
        {/* Cloud-only actions */}
        {cloudPreviewReady && (
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
            {(cloudBackend === "vps" || boxState !== "archived") && (
              <button
                onClick={() => run("sleep")}
                disabled={pending === "sleep"}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title={t("computer.sleepTitle")}
              >
                {pending === "sleep" ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}
                {t("vm.cloud.sleep")}
              </button>
            )}
          </div>
        )}

        <LinuxLocalControl />
        <MacLocalControl />

        {/* Computer source */}
          <div className="mt-4 rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">{t("computer.worksOn")}</div>
            <p className="mt-1 text-[12px] leading-5 text-ink-secondary">
              {t("computer.worksOnHint")}
            </p>
          <div role="group" aria-label={t("computer.destinationAria")} className="mt-3 grid auto-rows-fr grid-cols-2 gap-2">
            {([
              [null, "vm.dest.auto", "computer.dest.autoDesc", Sparkles],
              ["cloud", "vm.dest.cloud", "computer.dest.cloudDesc", Cloud],
              ["vm", "vm.dest.vm", "computer.dest.vmDesc", Box],
              ["local", "vm.dest.local", "computer.dest.localDesc", Monitor],
              ["browser", "vm.dest.browser", "computer.dest.browserDesc", Globe],
              ["off", "vm.dest.off", "computer.dest.offDesc", Power],
            ] as const).map(([mode, labelKey, descriptionKey, Icon]) => {
                const selected = mode === null ? !bot.computer : bot.computer === mode;
                const disabled =
                  (mode === "cloud" && !cloudSupported) ||
                  (mode === "vm" && !vmSupported) ||
                  (mode === "local" && !localSelectable) ||
                  (mode === "browser" && !browserSelectable);
                const unavailableTitle =
                  mode === "vm" && !vmSupported
                    ? t("computer.unavailableVm")
                    : mode === "cloud" && !cloudSupported
                      ? t("computer.unavailableCloud")
                      : mode === "local" && !localSelectable
                        ? localDisabledReason ?? t("computer.unavailableLocal")
                        : mode === "browser"
                          ? browserSelectable ? t("computer.browserOnlyTitle") : browserDisabledReason
                          : undefined;
                return (
              <button
                key={mode ?? "auto"}
                disabled={disabled}
                title={unavailableTitle}
                onClick={() => {
                  if ((mode === null && bot.computer === undefined) || mode === bot.computer) return;
                  if (mode === "local" && approvalModeFor(bot) === "auto") {
                    setLocalAutoWarningTarget(bot.id);
                  }
                  // a browser-only bot must actually have its browser: flip
                  // the per-bot switch on with the destination
                  else if (mode === "browser") updateComputerSelection({ computer: mode, browser: true });
                  else updateComputerSelection({ computer: mode });
                }}
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
                  {disabled ? t("computer.unavailableHere") : t(descriptionKey)}
                </span>
              </button>
                );
            })}
          </div>
          {bot.computer === "cloud" && (
            <>
              <CloudBackendPicker
                compact
                value={cloudBackend}
                vpsSupported={vpsSupported}
                onChange={(backend) => updateComputerSelection({ cloudBackend: backend })}
              />
            </>
          )}
          {bot.computer !== "cloud" && (
            <div className="mt-3 border-t border-hairline/40 pt-3 text-[11.5px] leading-5 text-ink-secondary" aria-live="polite">
              {!bot.computer ? (
                cloudBackend === "vps" && bot.autoStartVps
                  ? t("computer.hint.vpsAuto")
                  : localSelectable && !isLinux
                    ? t("computer.hint.autoLocal")
                    : t("computer.hint.autoCloud")
              ) : bot.computer === "vm" ? (
                <>
                  {t("computer.hint.vm")}
                  <button type="button" onClick={openVmSettings} className="mt-1 block font-medium text-accent hover:underline">
                    {t("computer.vmSettingsLink")}
                  </button>
                </>
              ) : bot.computer === "local" ? (
                t("computer.hint.local")
              ) : bot.computer === "browser" ? (
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
