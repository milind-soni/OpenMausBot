import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, ApiError, useStore, type Bot } from "@/state/store";
import { usePageVisible } from "@/lib/page-visible";
import { isRemoteScreenshotContention } from "@/lib/remote-desktop";
import type { CloudBackend } from "../../../shared/wire";
import type { ComputerPanelView } from "@/lib/computer-panel-view";
import { LocalizedPanelError, type Phase } from "./panelError";
import type { PendingAction } from "./types";

/** The panel's screen frames: live SSE seeds, the cloud screenshot poll,
 * and the VM/local capture loops. Only frames received during this
 * connection may replace its preview. */
export function useComputerPreview({
  bot,
  profileBot,
  panelView,
  phase,
  previewRetry,
  computerStatusCurrent,
  cloudPreviewReady,
  threadPath,
  cloudBackend,
  viewerOpen,
  pending,
  controlPending,
  isLinux,
  polledFrame,
  vmFrame,
  vmViewerUrl,
  localFrame,
  setError,
  setPolledFrame,
  setPreviewError,
  setPreviewRefreshing,
  setVmFrame,
  setLocalFrame,
}: {
  bot: Bot;
  profileBot: Bot;
  panelView: ComputerPanelView;
  phase: Phase;
  previewRetry: number;
  computerStatusCurrent: boolean;
  cloudPreviewReady: boolean;
  threadPath: (suffix: string) => string;
  cloudBackend: CloudBackend;
  viewerOpen: boolean;
  pending: PendingAction;
  controlPending: boolean;
  isLinux: boolean;
  polledFrame: { png: string; mime: string } | null;
  vmFrame: string | null;
  vmViewerUrl: string | null;
  localFrame: string | null;
  setError: Dispatch<SetStateAction<Error | string | null>>;
  setPolledFrame: Dispatch<SetStateAction<{ png: string; mime: string } | null>>;
  setPreviewError: Dispatch<SetStateAction<Error | string | null>>;
  setPreviewRefreshing: Dispatch<SetStateAction<boolean>>;
  setVmFrame: Dispatch<SetStateAction<string | null>>;
  setLocalFrame: Dispatch<SetStateAction<string | null>>;
}) {
  const { state } = useStore();
  const pageVisible = usePageVisible();
  const screen = state.screens[bot.id];
  const live = screen?.threadId === bot.threadId || (!screen?.threadId && (profileBot.tasks?.length ?? 0) <= 1)
    ? screen : undefined;
  const latestLive = useRef({ frame: live, at: 0 });
  const previewBusy = useRef(bot.busy);
  useEffect(() => { previewBusy.current = bot.busy; }, [bot.busy]);
  useEffect(() => {
    if (!cloudPreviewReady) {
      latestLive.current = { frame: live, at: 0 };
      return;
    }
    if (latestLive.current.frame === live) return;
    latestLive.current = { frame: live, at: 0 };
    if (cloudPreviewReady && live) {
      latestLive.current.at = Date.now();
      setPolledFrame(live);
      setPreviewError(null);
      setPreviewRefreshing(false);
    }
  }, [live, cloudPreviewReady, setPolledFrame, setPreviewError, setPreviewRefreshing]);

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
      if (previewBusy.current && Date.now() - latestLive.current.at < 10_000) return;
      inFlight = true;
      retryDelay = null;
      const startedAt = Date.now();
      try {
        const { png, format } = await api(threadPath("computer/screenshot"), {
          method: "POST",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
        });
        if (!controller.signal.aborted && latestLive.current.at <= startedAt) {
          if (typeof png !== "string" || !png.trim()) throw new LocalizedPanelError("computer.err.emptyFrame");
          setPolledFrame({ png, mime: format === "jpeg" ? "image/jpeg" : "image/png" });
          setPreviewError(null);
          setPreviewRefreshing(false);
          contentionSince = null;
        }
      } catch (e) {
        if (!controller.signal.aborted && latestLive.current.at <= startedAt) {
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
  }, [panelView, cloudPreviewReady, threadPath, cloudBackend, viewerOpen, pageVisible, pending, controlPending, previewRetry, setPreviewError, setPreviewRefreshing, setPolledFrame]);

  // Local VM preview comes directly from Cua Driver through the harness. It
  // does not use the password-protected noVNC viewer or cloud endpoints.
  useEffect(() => {
    if (panelView !== "computer" || phase !== "vm" || !computerStatusCurrent || viewerOpen || !pageVisible) return;
    const controller = new AbortController();
    let inFlight = false;
    const shoot = async () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        const { image } = await api(threadPath("local-computer/screenshot"), { method: "POST", signal: controller.signal });
        if (!controller.signal.aborted && typeof image === "string") {
          setVmFrame(image);
          setError(null);
        }
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        inFlight = false;
      }
    };
    void shoot();
    const timer = window.setInterval(() => void shoot(), bot.busy ? 3000 : 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [panelView, phase, computerStatusCurrent, threadPath, viewerOpen, pageVisible, bot.busy, setError, setVmFrame]);

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
  }, [panelView, phase, computerStatusCurrent, isLinux, pageVisible, bot.busy, bot.id, bot.threadId, setLocalFrame]);

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
      ((phase === "vm" && vmViewerUrl) || cloudPreviewReady),
  );

  return { localMisses, frameSrc, previewOpensDesktop, latestLive };
}
