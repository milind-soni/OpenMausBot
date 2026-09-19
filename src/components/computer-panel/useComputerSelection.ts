import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, currentTaskBot, useStore, type Bot } from "@/state/store";
import { effectivePlace } from "@/lib/place";
import type { CloudBackend } from "../../../shared/wire";
import {
  instanceSupportsLocalComputer,
  localComputerDisabledReason,
  localComputerSelectable,
  persistedComputerSelectionMatches,
} from "@/lib/local-computer";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import type { Phase } from "./panelError";

/** Where this bot's current conversation works, which selection state the
 * server has confirmed, and what the Auto surface actually resolved to. The
 * profile default owns lifecycle actions; the selected conversation owns
 * the screen. */
export function useComputerSelection({
  profileBot,
  capabilities,
}: {
  profileBot: Bot;
  capabilities: ReturnType<typeof useDesktopCapabilities>["capabilities"];
}) {
  const { state, dispatch, flushBotPatches } = useStore();
  // Where this bot's current conversation works and whether a turn is acting
  // there now: the tab for that place carries the live dot.
  const liveTask = profileBot.tasks?.find((task) => task.threadId === profileBot.threadId);
  const livePlace = effectivePlace(profileBot, liveTask);
  const threadBot = currentTaskBot(profileBot);
  const connectionKey = `${profileBot.id}:${profileBot.threadId}:${livePlace}:${profileBot.cloudBackend ?? "box"}:${threadBot.modelSelection.instanceId}`;
  const [autoSurface, setAutoSurface] = useState<{ key: string; surface: Bot["computer"] } | null>(null);
  const autoSurfaceCurrent = autoSurface?.key === connectionKey;
  const surfaceReady = livePlace !== "auto" || autoSurfaceCurrent;
  // Profile defaults still belong to the Works on picker below. The screen
  // and capability checks belong to the selected conversation, not that default.
  const bot = { ...threadBot, computer: livePlace === "auto"
    ? autoSurfaceCurrent ? autoSurface.surface : undefined : livePlace };
  const viewerConnectionKey = `${bot.id}:${bot.threadId}:${bot.computer}:${bot.cloudBackend ?? "box"}`;
  const viewerConnection = useRef(viewerConnectionKey);
  useLayoutEffect(() => {
    viewerConnection.current = viewerConnectionKey;
  }, [viewerConnectionKey]);
  const placeLive = Boolean(bot.busy);
  const threadPath = useCallback((suffix: string) =>
    `/api/bots/${profileBot.id}/${suffix}?threadId=${encodeURIComponent(profileBot.threadId)}`,
  [profileBot.id, profileBot.threadId]);
  const canManageCloud = profileBot.computer === "cloud" && livePlace === "cloud";
  const canManageVm = profileBot.computer === "vm" && livePlace === "vm";
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = localComputerSelectable({ capabilities, providerSupportsLocal });
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<Error | string | null>(null);
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
  // bumped when a Box API key is saved inline, to re-run the spin-up flow
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
  const vmReadinessAttempts = useRef(0);
  useEffect(() => {
    vmReadinessAttempts.current = 0;
  }, [bot.id, bot.computer]);
  const selectedInstance = state.instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  );
  const vmSupported = Boolean(
    selectedInstance?.snapshot.state === "available" &&
      selectedInstance.capabilities?.computerMcp &&
      selectedInstance.driverKind !== "boxAgent",
  );
  const computerToolSupported = selectedInstance?.capabilities?.computerMcp === true;
  const vpsSupported = Boolean(computerToolSupported && selectedInstance?.driverKind !== "boxAgent");
  const cloudSupported = cloudBackend === "vps"
    ? vpsSupported
    : state.instances.some((instance) => instance.driverKind === "boxAgent");

  return {
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
  };
}
