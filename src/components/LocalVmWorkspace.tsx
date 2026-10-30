import {
  AlertTriangle,
  Hand,
  Loader2,
  Monitor,
  RefreshCw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { api, useStore, type Action, type Bot } from "@/state/store";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { parseComputerHelp, transitionComputerControlLease } from "@/lib/computer-control";
import {
  initialLocalVmWorkspaceSlots,
  nativeViewOverlayIntersects,
  readyLocalVmViewerUrl,
  reconcileLocalVmWorkspaceSlots,
  releaseLocalVmWorkspaceControl,
  sanitizeLocalVmWorkspaceStatus,
  selectLocalVmWorkspaceSlot,
  switchLocalVmWorkspaceControl,
  type LocalVmWorkspaceControlPort,
  type LocalVmWorkspaceControlSnapshot,
  type LocalVmWorkspaceSlots,
  type LocalVmWorkspaceStatus,
} from "@/lib/local-vm-workspace";
import { z } from "zod";
import { Select } from "./Select";
import { productName } from "@/lib/brand";

const SLOT_CONTEXTS = ["local-vm-workspace:left", "local-vm-workspace:right"] as const;

type WorkspaceDispatch = (action: Action) => void;

const controlSnapshotSchema = z.object({
  held: z.boolean(),
  helpReason: z.string().nullable(),
  help: z.unknown().optional().transform(parseComputerHelp),
  owned: z.boolean().optional(),
  acquired: z.boolean().optional(),
  released: z.boolean().optional(),
});

interface LocalVmWorkspaceProps {
  primaryBotId: string;
  overlayOpen: boolean;
  onClose(): void;
  onOpenComputer(botId: string): void;
}

async function requestComputerControl(
  botId: string,
  action: "take" | "release",
  controlLeaseId: string,
): Promise<LocalVmWorkspaceControlSnapshot> {
  const result = await api(`/api/bots/${botId}/computer/control`, {
    method: "POST",
    body: JSON.stringify({ action, controlLeaseId }),
  });
  const parsed = controlSnapshotSchema.safeParse(result);
  if (!parsed.success) throw new Error("invalid-control-snapshot");
  return parsed.data;
}

async function readComputerControl(botId: string): Promise<LocalVmWorkspaceControlSnapshot> {
  const parsed = controlSnapshotSchema.safeParse(
    await api(`/api/bots/${botId}/computer/control`),
  );
  if (!parsed.success) throw new Error("invalid-control-snapshot");
  return parsed.data;
}

function bestEffortRelease(botId: string, controlLeaseId: string) {
  void fetch(`/api/bots/${botId}/computer/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "release", controlLeaseId }),
    keepalive: true,
  }).then(async (response) => {
    if (!response.ok) return;
    // The server lease is the source of truth: clear Electron only after the workspace-owned release was accepted.
  }).catch(() => {});
}

async function setNativeBrowserControl(_botId: string, _held: boolean): Promise<boolean> {
  return true;
}

function dispatchControl(
  dispatch: WorkspaceDispatch,
  botId: string,
  snapshot: LocalVmWorkspaceControlSnapshot,
) {
  dispatch({
    type: "computerControl",
    botId,
    held: snapshot.held,
    helpReason: snapshot.helpReason,
    help: snapshot.help ?? null,
  });
}

function elementBounds(ref: RefObject<HTMLDivElement | null>): DesktopWorkspaceBounds | null {
  const rect = ref.current?.getBoundingClientRect();
  if (!rect || rect.width < 1 || rect.height < 1) return null;
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

const NATIVE_VIEW_OVERLAY_SELECTOR = [
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="menu"]',
  "[popover]",
  "[data-native-view-overlay]",
  ".fixed",
  ".absolute",
].join(",");

/**
 * Electron's native views always paint above the renderer, so any intersecting overlay or popover counts, portals
 * included.
 */
function rendererOverlayIntersectsNativeView() {
  const hosts = [...document.querySelectorAll<HTMLElement>("[data-native-view-host]")];
  const hostRects = hosts
    .map((host) => host.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (hostRects.length === 0) return false;

  const candidates = [...document.querySelectorAll<HTMLElement>(NATIVE_VIEW_OVERLAY_SELECTOR)]
    .filter(
      (candidate) =>
        !hosts.some(
          (host) => candidate === host || candidate.contains(host) || host.contains(candidate),
        ),
    )
    .map((candidate) => {
      const style = window.getComputedStyle(candidate);
      const explicitlyOverlay =
        candidate.matches(
          '[aria-modal="true"], [role="dialog"], [role="menu"], [popover], [data-native-view-overlay]',
        );
      const zIndex = Number.parseInt(style.zIndex, 10);
      return {
        rect: candidate.getBoundingClientRect(),
        explicit: explicitlyOverlay,
        visible:
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0,
        zIndex: Number.isFinite(zIndex) ? zIndex : null,
      };
    });
  return nativeViewOverlayIntersects(hostRects, candidates);
}

function useNativeViewObscured(explicit: boolean) {
  const [domOverlay, setDomOverlay] = useState(false);
  useEffect(() => {
    let frame = 0;
    const read = () => setDomOverlay(rendererOverlayIntersectsNativeView());
    const scheduleRead = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        read();
      });
    };
    read();
    const observer = new MutationObserver(scheduleRead);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style", "aria-hidden", "aria-modal", "role", "open", "popover"],
    });
    const resizeObserver = new ResizeObserver(scheduleRead);
    resizeObserver.observe(document.body);
    for (const host of document.querySelectorAll<HTMLElement>("[data-native-view-host]")) {
      resizeObserver.observe(host);
    }
    const overlayEvents = [
      "toggle",
      "animationstart",
      "animationend",
      "transitionstart",
      "transitionend",
    ] as const;
    for (const eventName of overlayEvents) {
      document.addEventListener(eventName, scheduleRead, true);
    }
    window.addEventListener("resize", scheduleRead);
    window.addEventListener("scroll", scheduleRead, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver.disconnect();
      for (const eventName of overlayEvents) {
        document.removeEventListener(eventName, scheduleRead, true);
      }
      window.removeEventListener("resize", scheduleRead);
      window.removeEventListener("scroll", scheduleRead, true);
    };
  }, []);
  return explicit || domOverlay;
}

function statusLabel(status: LocalVmWorkspaceStatus | null, nativeStatus: DesktopWorkspaceState["status"]) {
  if (!status) return "Checking VM";
  if (status.container === "missing") return "VM not created";
  if (status.container === "stopped") return "VM stopped";
  if (!status.ready) return "VM unavailable";
  if (nativeStatus === "error") return "Viewer unavailable";
  if (nativeStatus !== "ready") return "Connecting viewer";
  return "Live · watch-only";
}

interface LocalVmPaneProps {
  index: 0 | 1;
  bot: Bot | null;
  bots: Bot[];
  otherBotId: string | null;
  obscured: boolean;
  active: boolean;
  heldElsewhere: boolean;
  controlPending: boolean;
  onSelect(botId: string | null): void;
  onTake(botId: string): void;
  onRelease(): void;
  onOpenComputer(botId: string): void;
}

function LocalVmPane({
  index,
  bot,
  bots,
  otherBotId,
  obscured,
  active,
  heldElsewhere,
  controlPending,
  onSelect,
  onTake,
  onRelease,
  onOpenComputer,
}: LocalVmPaneProps) {
  const contextId = SLOT_CONTEXTS[index];
  const botId = bot?.id ?? null;
  const botName = bot?.name ?? t("vm.workspace.localVm");
  const viewportRef = useRef<HTMLDivElement>(null);
  const operationRef = useRef<Promise<void>>(Promise.resolve());
  const obscuredRef = useRef(obscured);
  const [retry, setRetry] = useState(0);
  const [status, setStatus] = useState<LocalVmWorkspaceStatus | null>(null);
  const [nativeState, setNativeState] = useState<DesktopWorkspaceState>({
    contextId,
    open: false,
    status: "closed",
    interactive: false,
  });
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async (signal?: AbortSignal) => {
    if (!botId) return;
    try {
      const raw = await api(`/api/bots/${botId}/local-computer`, { signal });
      if (!signal?.aborted) setStatus(sanitizeLocalVmWorkspaceStatus(raw));
    } catch {
    }
  }, [botId]);
  const refreshStatusRef = useRef(refreshStatus);
  useEffect(() => {
    refreshStatusRef.current = refreshStatus;
  }, [refreshStatus]);

  useEffect(() => {
    obscuredRef.current = obscured;
  }, [obscured]);

  useEffect(() => {
    const bridge = window.ogb?.desktopWorkspace;
    return bridge?.onState((next) => {
      if (next.contextId !== contextId) return;
      setNativeState(next);
      if (next.status === "error" || next.status === "closed") void refreshStatusRef.current();
    });
  }, [contextId]);

  useEffect(() => {
    const bridge = window.ogb?.desktopWorkspace;
    let alive = true;
    const controller = new AbortController();
    setStatus(null);
    setError(null);
    setNativeState({ contextId, open: false, status: "closed", interactive: false });

    const run = async () => {
      if (bridge) await bridge.close(contextId).catch(() => {});
      if (!alive || !botId) return;
      if (!bridge) {
        setError(t("vm.workspace.desktopRequired"));
        return;
      }
      try {
        const raw = await api(`/api/bots/${botId}/local-computer`, {
          signal: controller.signal,
        });
        if (!alive) return;
        const safeStatus = sanitizeLocalVmWorkspaceStatus(raw);
        setStatus(safeStatus);
        const viewerUrl = readyLocalVmViewerUrl(raw);
        if (!safeStatus.ready || !viewerUrl) return;

        // Hidden or minimized Electron windows may suspend animation frames.
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          const timer = setTimeout(finish, 100);
          requestAnimationFrame(() => {
            clearTimeout(timer);
            finish();
          });
        });
        if (!alive) return;
        const bounds = elementBounds(viewportRef);
        if (!bounds) throw new Error("layout-unavailable");
        const next = await bridge.open({
          contextId,
          url: viewerUrl,
          title: `${botName}'s Local VM`,
          bounds,
        });
        if (!alive) {
          await bridge.close(contextId).catch(() => {});
          return;
        }
        setNativeState(next);
        await bridge.layout([
          { contextId, bounds, visible: !obscuredRef.current && next.open },
        ]);
      } catch (cause) {
        if (!alive || controller.signal.aborted) return;
        setError(
          cause instanceof Error && cause.message === "layout-unavailable"
            ? t("vm.workspace.layoutUnavailable")
            : t("vm.workspace.connectFailed"),
        );
      }
    };

    operationRef.current = operationRef.current.catch(() => {}).then(run);
    return () => {
      alive = false;
      controller.abort();
      if (bridge) {
        operationRef.current = operationRef.current
          .catch(() => {})
          .then(() => bridge.close(contextId).then(() => undefined).catch(() => {}));
      }
    };
  }, [botId, botName, contextId, retry]);

  useEffect(() => {
    if (!botId) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => void refreshStatus(controller.signal), 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [botId, refreshStatus]);

  const updateLayout = useCallback(() => {
    const bridge = window.ogb?.desktopWorkspace;
    const bounds = elementBounds(viewportRef);
    if (!bridge || !bounds || !nativeState.open) return;
    void bridge
      .layout([{ contextId, bounds, visible: !obscured }])
      .catch(() => setError(t("vm.workspace.positionFailed")));
  }, [contextId, nativeState.open, obscured]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(updateLayout);
    observer.observe(element);
    window.addEventListener("resize", updateLayout);
    const frame = requestAnimationFrame(updateLayout);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", updateLayout);
    };
  }, [updateLayout]);

  const label = statusLabel(status, nativeState.status);
  const canDrive = Boolean(bot && status?.ready && nativeState.status === "ready" && nativeState.open);

  return (
    <section
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-panel",
        active ? "border-accent/80 shadow-[0_0_0_1px_rgb(var(--accent)/0.35)]" : "border-hairline/50",
      )}
    >
      <div className="flex min-h-[68px] items-center gap-3 border-b border-hairline/40 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <label className="sr-only" htmlFor={`local-vm-slot-${index}`}>
            Local VM for pane {index + 1}
          </label>
          <Select size="sm" className="w-full"
            id={`local-vm-slot-${index}`}
            value={bot?.id ?? ""}
            onChange={(event) => onSelect(event.target.value || null)}
            disabled={controlPending}
          >
            <option value="">{t("vm.workspace.chooseBot")}</option>
            {bots.map((candidate) => (
              <option key={candidate.id} value={candidate.id} disabled={candidate.id === otherBotId}>
                {candidate.name}
              </option>
            ))}
          </Select>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-secondary">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                active
                  ? "bg-accent"
                  : nativeState.status === "ready"
                    ? "bg-success"
                    : nativeState.status === "error"
                      ? "bg-danger"
                      : "bg-ink-secondary/50",
              )}
            />
            {active ? t("vm.workspace.youHaveControl") : heldElsewhere ? t("vm.workspace.controlElsewhere") : label}
          </div>
        </div>
        {bot && active ? (
          <button
            type="button"
            onClick={onRelease}
            disabled={controlPending}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-2.5 py-2 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            {controlPending ? <Loader2 size={13} className="animate-spin" /> : <Hand size={13} />}
            {t("vm.workspace.handBack")}
          </button>
        ) : bot ? (
          <button
            type="button"
            onClick={() => onTake(bot.id)}
            disabled={!canDrive || controlPending || heldElsewhere}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-raised px-2.5 py-2 text-[12px] text-ink hover:bg-raised-hover disabled:opacity-45"
            title={t("vm.workspace.takeControlTitle")}
          >
            {controlPending ? <Loader2 size={13} className="animate-spin" /> : <Hand size={13} />}
            {heldElsewhere ? t("vm.workspace.heldElsewhere") : t("vm.workspace.takeControl")}
          </button>
        ) : null}
      </div>

      <div
        ref={viewportRef}
        data-native-view-host
        className="relative min-h-0 flex-1 bg-[#070707]"
      >
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
          {!bot ? (
            <div className="flex max-w-[260px] flex-col items-center gap-2 text-ink-secondary">
              <Monitor size={22} />
              <span className="text-[12px]">{t("vm.workspace.chooseAnother")}</span>
            </div>
          ) : !status && !error ? (
            <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
              <Loader2 size={15} className="animate-spin" /> {t("vm.workspace.checking", { name: bot.name })}
            </div>
          ) : status?.ready && nativeState.status !== "error" && !error ? (
            <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
              <Loader2 size={15} className="animate-spin" /> {t("vm.workspace.connecting")}
            </div>
          ) : (
            <div className="flex max-w-[300px] flex-col items-center gap-3 text-ink-secondary">
              <AlertTriangle size={21} className="text-warning" />
              <div className="text-[12px] leading-relaxed">
                {error ??
                  (status?.container === "missing"
                    ? t("vm.workspace.notCreated", { name: bot.name })
                    : status?.container === "stopped"
                      ? t("vm.workspace.stopped", { name: bot.name })
                      : t("vm.workspace.notReady", { name: bot.name }))}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setRetry((value) => value + 1)}
                  className="flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[12px] text-ink hover:bg-raised-hover"
                >
                  <RefreshCw size={13} /> {t("vm.workspace.retryStatus")}
                </button>
                <button
                  type="button"
                  onClick={() => onOpenComputer(bot.id)}
                  className="rounded-lg bg-raised px-3 py-2 text-[12px] text-ink hover:bg-raised-hover"
                >
                  {t("vm.workspace.openComputer")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function LocalVmWorkspace({
  primaryBotId,
  overlayOpen,
  onClose,
  onOpenComputer,
}: LocalVmWorkspaceProps) {
  const { state, dispatch } = useStore();
  const { dragProps } = useCaptionChrome();
  const eligibleBots = useMemo(
    () => state.bots.filter((bot) => bot.computer === "vm" && !bot.hidden),
    [state.bots],
  );
  const [slots, setSlots] = useState<LocalVmWorkspaceSlots>(() =>
    initialLocalVmWorkspaceSlots(state.bots, primaryBotId),
  );
  const slotsRef = useRef(slots);
  const [controlledBotId, setControlledBotId] = useState<string | null>(null);
  const controlledBotIdRef = useRef<string | null>(null);
  const controlLeaseIdRef = useRef<string | null>(null);
  const controlLeaseId = controlLeaseIdRef.current ?? crypto.randomUUID();
  controlLeaseIdRef.current = controlLeaseId;
  // A second discrete event can arrive before React commits the disabled buttons, so the mutation itself is guarded.
  const controlBusyRef = useRef(false);
  const mountedRef = useRef(true);
  const [controlPending, setControlPending] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const obscured = useNativeViewObscured(overlayOpen);

  useEffect(() => {
    slotsRef.current = slots;
  }, [slots]);

  const controlPort = useMemo<LocalVmWorkspaceControlPort>(
    () => ({
      async take(botId) {
        const snapshot = await transitionComputerControlLease({
          action: "take",
          syncNativeBrowser: true,
          requestControl: (action) => requestComputerControl(botId, action, controlLeaseId),
          setNativeBrowserControl: (held) => setNativeBrowserControl(botId, held),
        });
        dispatchControl(dispatch, botId, snapshot);
        if (snapshot.held && snapshot.owned === true) controlledBotIdRef.current = botId;
        else if (controlledBotIdRef.current === botId) controlledBotIdRef.current = null;
        return snapshot;
      },
      async release(botId) {
        const snapshot = await transitionComputerControlLease({
          action: "release",
          syncNativeBrowser: true,
          requestControl: (action) => requestComputerControl(botId, action, controlLeaseId),
          setNativeBrowserControl: (held) => setNativeBrowserControl(botId, held),
        });
        dispatchControl(dispatch, botId, snapshot);
        if (controlledBotIdRef.current === botId) controlledBotIdRef.current = null;
        return snapshot;
      },
      async setInteractive(contextId) {
        const bridge = window.ogb?.desktopWorkspace;
        if (!bridge) throw new Error(t("vm.workspace.bridgeUnavailable"));
        return bridge.setInteractive(contextId);
      },
    }),
    [controlLeaseId, dispatch],
  );

  useEffect(() => {
    setSlots((current) => {
      const next = reconcileLocalVmWorkspaceSlots(current, state.bots);
      return next[0] === current[0] && next[1] === current[1] ? current : next;
    });
  }, [state.bots]);

  // Opening is read-only: a hold may belong to the legacy viewer or another surface, so observe it, never silently
  // release it.
  useEffect(() => {
    let alive = true;
    const readSelected = async () => {
      for (const botId of slots) {
        if (!botId) continue;
        try {
          const snapshot = await readComputerControl(botId);
          if (alive) dispatchControl(dispatch, botId, snapshot);
        } catch {
        }
      }
    };
    void readSelected();
    return () => {
      alive = false;
    };
  }, [dispatch, slots]);

  useEffect(() => {
    const controlled = controlledBotIdRef.current;
    if (!controlled || slots.includes(controlled)) return;
    void releaseLocalVmWorkspaceControl(controlPort, controlled)
      .then(() => {
        setControlledBotId(null);
      })
      .catch(() => {
        setControlError(t("vm.workspace.handoffFailed"));
      });
  }, [controlPort, slots]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const controlled = controlledBotIdRef.current;
      const bridge = window.ogb?.desktopWorkspace;
      if (!bridge) {
        if (controlled) bestEffortRelease(controlled, controlLeaseId);
        return;
      }
      void bridge
        .setInteractive(null)
        .catch(() => {})
        .then(() => {
          if (controlled) bestEffortRelease(controlled, controlLeaseId);
          return bridge.close();
        })
        .catch(() => {});
    };
  }, [controlLeaseId]);

  const contextForBot = useCallback(
    (botId: string) => {
      const index = slotsRef.current.indexOf(botId);
      return index < 0 ? null : SLOT_CONTEXTS[index];
    },
    [],
  );

  const handBack = useCallback(async () => {
    const current = controlledBotIdRef.current;
    if (!current) return true;
    if (controlBusyRef.current) return false;
    controlBusyRef.current = true;
    setControlPending(true);
    setControlError(null);
    try {
      await releaseLocalVmWorkspaceControl(controlPort, current);
      setControlledBotId(null);
      return true;
    } catch {
      setControlError(`${productName()} could not hand control back. The view stayed open.`);
      return false;
    } finally {
      controlBusyRef.current = false;
      setControlPending(false);
    }
  }, [controlPort]);

  const takeControl = useCallback(
    async (botId: string) => {
      if (controlBusyRef.current || controlledBotIdRef.current === botId) return;
      const bridge = window.ogb?.desktopWorkspace;
      const contextId = contextForBot(botId);
      if (!bridge || !contextId) return;
      controlBusyRef.current = true;
      setControlPending(true);
      setControlError(null);
      try {
        const alignedPort: LocalVmWorkspaceControlPort = {
          ...controlPort,
          async setInteractive(nextContextId) {
            if (nextContextId && contextForBot(botId) !== nextContextId) {
              throw new Error(t("vm.workspace.paneChanged"));
            }
            return controlPort.setInteractive(nextContextId);
          },
        };
        const result = await switchLocalVmWorkspaceControl(
          alignedPort,
          controlledBotIdRef.current,
          botId,
          contextId,
        );
        setControlledBotId(null);
        if (result.status === "held-elsewhere") {
          setControlError(t("vm.workspace.alreadyControlled"));
          return;
        }
        if (!mountedRef.current) {
          await releaseLocalVmWorkspaceControl(controlPort, botId).catch(() => {});
          return;
        }
        setControlledBotId(botId);
      } catch {
        setControlledBotId(controlledBotIdRef.current);
        setControlError("Control could not switch safely. Any remaining hold stayed paused.");
      } finally {
        controlBusyRef.current = false;
        setControlPending(false);
      }
    },
    [contextForBot, controlPort],
  );

  const selectSlot = useCallback(
    async (index: 0 | 1, botId: string | null) => {
      if (controlBusyRef.current) return;
      const current = slotsRef.current[index];
      if (current === botId) return;
      if (current && controlledBotIdRef.current === current) {
        const released = await handBack();
        if (!released) return;
      }
      setSlots((existing) => selectLocalVmWorkspaceSlot(existing, index, botId));
    },
    [handBack],
  );

  const closeWorkspace = useCallback(async () => {
    if (controlledBotIdRef.current && !(await handBack())) return;
    onClose();
  }, [handBack, onClose]);

  const openComputer = useCallback(
    async (botId: string) => {
      if (controlledBotIdRef.current && !(await handBack())) return;
      onOpenComputer(botId);
    },
    [handBack, onOpenComputer],
  );

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      <header {...dragProps} className="flex min-h-[60px] items-center gap-3 border-b border-hairline/40 px-5 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <Monitor size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14px] font-semibold text-ink">{t("vm.workspace.viewTitle")}</h1>
          <p className="truncate text-[12px] text-ink-secondary">
            Two live desktops · one active controller · watch-only by default
          </p>
        </div>
        <button
          type="button"
          onClick={() => void closeWorkspace()}
          disabled={controlPending}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          aria-label="Close private desktop view"
        >
          <X size={18} />
        </button>
      </header>

      {controlError && (
        <div className="mx-3 mt-3 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          <AlertTriangle size={14} className="shrink-0" /> {controlError}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 p-3">
        {([0, 1] as const).map((index) => {
          const botId = slots[index];
          const bot = eligibleBots.find((candidate) => candidate.id === botId) ?? null;
          return (
            <LocalVmPane
              key={SLOT_CONTEXTS[index]}
              index={index}
              bot={bot}
              bots={eligibleBots}
              otherBotId={slots[index === 0 ? 1 : 0]}
              obscured={obscured}
              active={Boolean(bot && controlledBotId === bot.id)}
              heldElsewhere={Boolean(
                bot && state.computerControl[bot.id]?.held && controlledBotId !== bot.id
              )}
              controlPending={controlPending}
              onSelect={(next) => void selectSlot(index, next)}
              onTake={(id) => void takeControl(id)}
              onRelease={() => void handBack()}
              onOpenComputer={(id) => void openComputer(id)}
            />
          );
        })}
      </div>
    </main>
  );
}
