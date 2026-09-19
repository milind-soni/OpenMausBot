// The bot's computer, in the right-side slot. Where it runs decides the
// whole flow: explicit cloud → provision the box on open (idempotent) and preview
// via SSE frames or a ~4s screenshot poll. macOS local mode keeps the legacy
// in-panel capture. Linux local mode is an automation readiness state and its
// separate preview remains explicitly user-initiated. Auto only reads an
// existing Box's state: opening this panel never creates, wakes, bootstraps
// or opens one. A conversation's selected surface owns its preview;
// its profile default owns lifecycle actions and the Works on picker.
// An inherited team Box is shown as a shared resource, managed from Team map;
// it must never fall back to this host or become a private Cloud selection.
import { useState } from "react";
import { useStore, type Bot } from "@/state/store";
import { useCaptionChrome, useDesktopCapabilities } from "./DesktopCapabilities";
import { browserAvailable, builtInBrowserEnabled } from "@/lib/feature-flags";
import { shouldPollCloudPreview } from "@/lib/local-computer";
import type { LocalVmStatus, VpsComputerStatus } from "@/lib/computer-panel-phase";
import { AndroidDevicePanel, useAndroidUsbDevices } from "./AndroidDevicePanel";
import { BrowserPanel } from "./BrowserPanel";
import { LinuxLocalControl } from "./LinuxLocalControl";
import { LocalScreenPreview } from "./LocalScreenPreview";
import { MacLocalControl } from "./MacLocalControl";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { RoutinesSection } from "./bot-settings/RoutinesSection";

import { panelErrorText } from "./computer-panel/panelError";
import type { PendingAction } from "./computer-panel/types";
import { usePanelWidth } from "./computer-panel/usePanelWidth";
import { useComputerSelection } from "./computer-panel/useComputerSelection";
import { useComputerPanelView } from "./computer-panel/useComputerPanelView";
import { useComputerStatus } from "./computer-panel/useComputerStatus";
import { useComputerPreview } from "./computer-panel/useComputerPreview";
import { useComputerControl } from "./computer-panel/useComputerControl";
import { useComputerActions } from "./computer-panel/useComputerActions";
import { PanelHeader } from "./computer-panel/PanelHeader";
import { ScreenPreview } from "./computer-panel/ScreenPreview";
import { PanelBanners } from "./computer-panel/PanelBanners";
import { ControlActions } from "./computer-panel/ControlActions";
import { WorksOnSection } from "./computer-panel/WorksOnSection";

export function ComputerPanel({
  bot: profileBot,
  onOpenVmWorkspace,
}: {
  bot: Bot;
  onOpenVmWorkspace?: (botId: string) => void;
}) {
  // Docked flush under the Windows caption corner: drop the header 16px.
  const { padClass } = useCaptionChrome();
  const { panelWidth, onResizeStart, onResizeMove, onResizeEnd, separatorRef, separatorWidth, onSeparatorKeyDown } = usePanelWidth();
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const localAvailable = capabilities.localComputer.available;
  const isLinux = capabilities.host.platform === "linux";
  const {
    liveTask,
    livePlace,
    bot,
    viewerConnectionKey,
    viewerConnection,
    placeLive,
    threadPath,
    canManageCloud,
    canManageVm,
    providerSupportsLocal,
    localSelectable,
    localDisabledReason,
    phase,
    setPhase,
    error,
    setError,
    retry,
    setRetry,
    resolvedComputerSelection,
    setResolvedComputerSelection,
    setTeamComputer,
    computerSelectionPersisted,
    computerStatusCurrent,
    currentTeamComputer,
    cloudBackend,
    updateComputerSelection,
    surfaceReady,
    vmReadinessAttempts,
    selectedInstance,
    vmSupported,
    vpsSupported,
    cloudSupported,
  } = useComputerSelection({ profileBot, capabilities });
  const androidStatus = useAndroidUsbDevices();
  const androidConnected = androidStatus.devices.length > 0;
  // Keep installation reachable before the engine is ready. Actual browser
  // operations below still require browserAvailableHere.
  const browserAvailableHere = browserAvailable(state.config);
  const browserEnabled = builtInBrowserEnabled(state.config) && bot.browser !== false
    && (browserAvailableHere || state.config?.browserEngine?.installable === true);
  const { panelView, selectPanelView, viewerOpen } = useComputerPanelView({
    bot,
    browserEnabled,
    androidConnected,
    viewerConnectionKey,
  });
  const [boxState, setBoxState] = useState<string | null>(null);
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
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [localAutoWarningTarget, setLocalAutoWarningTarget] = useState<string | null>(null);
  const errorText = panelErrorText(error);
  useComputerStatus({
    bot,
    profileBot,
    panelView,
    capabilitiesReady,
    localAvailable,
    providerSupportsLocal,
    localSelectable,
    isLinux,
    vmSupported,
    cloudSupported,
    vpsSupported,
    canManageCloud,
    computerSelectionPersisted,
    surfaceReady,
    threadPath,
    cloudBackend,
    retry,
    phase,
    selectedInstance,
    vmReadinessAttempts,
    setPhase,
    setError,
    setRetry,
    setBoxState,
    setVmStatus,
    setVpsStatus,
    setVmViewerUrl,
    setPolledFrame,
    setPreviewError,
    setVmFrame,
    setLocalFrame,
    setResolvedComputerSelection,
    setTeamComputer,
  });
  const cloudPreviewReady = computerStatusCurrent && shouldPollCloudPreview({
    computer: bot.computer,
    cloudBackend,
    phase,
    botId: bot.id,
    resolvedBotId: resolvedComputerSelection?.botId ?? null,
    resolvedComputer: resolvedComputerSelection?.computer ?? null,
    resolvedCloudBackend: resolvedComputerSelection?.cloudBackend ?? null,
  });
  const { control, controlPending, setControlPending, controlAction, transitionControl } = useComputerControl({
    botId: bot.id,
    panelView,
    setError,
  });
  const { localMisses, frameSrc, previewOpensDesktop, latestLive } = useComputerPreview({
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
  });
  const { openDesktop, run, runVmAction, replaceVpsComputer } = useComputerActions({
    bot,
    viewerConnectionKey,
    viewerConnection,
    cloudPreviewReady,
    cloudBackend,
    threadPath,
    vmViewerUrl,
    control,
    transitionControl,
    vmReadinessAttempts,
    setControlPending,
    setPending,
    setError,
    setPhase,
    setBoxState,
    setVmStatus,
    setVpsStatus,
    setResolvedComputerSelection,
    setRetry,
  });
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

  const openBotSettings = () => {
    // Keep the panel/modal states exclusive at this entry point. That
    // removes the still-mounted Computer panel from the settings
    // dialog's focus path, and dismissing Settings returns directly
    // to the conversation that opened it.
    dispatch({ type: "closeOverlay", kind: "computer" });
    dispatch({ type: "openOverlay", kind: "settings", open: true, section: "access" });
  };
  const closePanel = () => dispatch({ type: "closeOverlay", kind: "computer" });
  const selectBrowserView = () => {
    setError(null);
    selectPanelView("browser");
  };
  const retryPreview = (discardFrame: boolean) => {
    latestLive.current.at = 0;
    if (discardFrame) setPolledFrame(null);
    setPreviewError(null);
    setPreviewRefreshing(true);
    setPreviewRetry((n) => n + 1);
  };
  const onApiKeySaved = (configured: boolean) => {
    if (configured) setRetry((n) => n + 1);
  };
  const openVmSettings = () => {
    window.sessionStorage.setItem("openmausbot.settings.section", "computer");
    dispatch({ type: "openOverlay", kind: "appSettings", open: true });
  };

  const openConnectionSettings = () => {
    dispatch({ type: "openOverlay", kind: "appSettings", open: true, section: "connections" });
  };

  return (
    <>
    <aside
      className="animate-panel-in relative flex h-full shrink-0 flex-col border-l border-hairline/40 bg-panel"
      style={{ width: panelWidth }}
    >
      <PanelHeader
        padClass={padClass}
        panelView={panelView}
        selectPanelView={selectPanelView}
        placeLive={placeLive}
        livePlace={livePlace}
        androidConnected={androidConnected}
        browserEnabled={browserEnabled}
        onOpenBotSettings={openBotSettings}
        onSelectBrowser={selectBrowserView}
        onClose={closePanel}
        onResizeStart={onResizeStart}
        onResizeMove={onResizeMove}
        onResizeEnd={onResizeEnd}
        separatorRef={separatorRef}
        separatorWidth={separatorWidth}
        onSeparatorKeyDown={onSeparatorKeyDown}
      />

      {panelView === "routines" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <RoutinesSection key={bot.id} bot={bot} routines={botRoutines} runs={state.routineRuns} defaultRunOn={cloudRoutineReady ? "cloud" : "maus"} />
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
        <ScreenPreview
          bot={bot}
          phase={phase}
          isLinux={isLinux}
          currentTeamComputer={currentTeamComputer}
          boxState={boxState}
          cloudPreviewReady={cloudPreviewReady}
          frameSrc={frameSrc}
          previewOpensDesktop={previewOpensDesktop}
          previewError={previewError}
          previewRefreshing={previewRefreshing}
          previewRetry={previewRetry}
          pending={pending}
          controlPending={controlPending}
          localMisses={localMisses}
          vmStatus={vmStatus}
          vpsStatus={vpsStatus}
          canManageVm={canManageVm}
          canManageCloud={canManageCloud}
          computerStatusCurrent={computerStatusCurrent}
          cloudBackend={cloudBackend}
          browserEnabled={browserEnabled}
          localDisabledReason={localDisabledReason}
          onOpenDesktop={() => void openDesktop()}
          onRetry={retryPreview}
          selectPanelView={selectPanelView}
          updateComputerSelection={updateComputerSelection}
          run={run}
          runVmAction={runVmAction}
          replaceVpsComputer={() => void replaceVpsComputer()}
          openVmSettings={openVmSettings}
          openConnectionSettings={openConnectionSettings}
          onShowTeamMap={() => dispatch({ type: "showTeamMap" })}
          onRefreshStatus={() => setRetry((n) => n + 1)}
        />
        <PanelBanners
          bot={bot}
          phase={phase}
          vmStatus={vmStatus}
          pending={pending}
          errorText={errorText}
          onApiKeySaved={onApiKeySaved}
          onOpenConnectionSettings={openConnectionSettings}
          onOpenVmWorkspace={onOpenVmWorkspace}
        />
        <ControlActions
          bot={bot}
          profileBotBusy={profileBot.busy}
          phase={phase}
          control={control}
          controlPending={controlPending}
          pending={pending}
          cloudPreviewReady={cloudPreviewReady}
          cloudBackend={cloudBackend}
          boxState={boxState}
          vmViewerUrl={vmViewerUrl}
          vmStatus={vmStatus}
          canManageVm={canManageVm}
          canManageCloud={canManageCloud}
          currentTeamComputer={currentTeamComputer}
          onOpenDesktop={() => void openDesktop()}
          onControlAction={controlAction}
          onRunVmAction={runVmAction}
          onRun={run}
        />

        {phase !== "team-box" && (bot.computer !== undefined || computerStatusCurrent) && <>
          <LocalScreenPreview />
          <LinuxLocalControl />
          <MacLocalControl />
        </>}

        <WorksOnSection
          profileBot={profileBot}
          bot={bot}
          liveTask={liveTask}
          cloudBackend={cloudBackend}
          cloudSupported={cloudSupported}
          vmSupported={vmSupported}
          vpsSupported={vpsSupported}
          localSelectable={localSelectable}
          localDisabledReason={localDisabledReason}
          isLinux={isLinux}
          currentTeamComputer={currentTeamComputer}
          selectedInstance={selectedInstance}
          onUpdateComputerSelection={updateComputerSelection}
          onWarnLocalAuto={setLocalAutoWarningTarget}
          openVmSettings={openVmSettings}
          botRoutines={botRoutines}
          activeRoutineRun={activeRoutineRun}
          onSelectRoutines={() => selectPanelView("routines")}
        />
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
