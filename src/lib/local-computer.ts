import { t } from "./i18n";
import type { Bot, InstanceInfo } from "@/state/store";

export function instanceSupportsLocalComputer(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): boolean {
  const capabilities = instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  )?.capabilities;
  return capabilities?.localComputerMcp === true || capabilities?.computerMcp === true;
}

export function localComputerSelectable({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): boolean {
  if (!providerSupportsLocal) return false;
  if (capabilities.localComputer.available) return true;
  return capabilities.host.platform === "darwin" || capabilities.host.platform === "win32";
}

/** Why a bot can't use this computer, in words for the person: what to do, never the parts underneath. */
export function localComputerDisabledReason({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): string | null {
  if (!providerSupportsLocal) return t("computer.problem.localAiCannot");
  if (capabilities.localComputer.available) return null;
  if (capabilities.host.platform === "linux") {
    if (capabilities.localComputer.reasonCode === "linux-wayland-seat-safety-blocked") return t("computer.problem.localWaylandBlocked");
    if (capabilities.localComputer.reasonCode === "wayland-compositor-unsupported") return t("computer.problem.localWaylandDesktop");
    if (!capabilities.localComputer.enabled) return t("computer.problem.localTurnOn");
    return capabilities.localComputer.message ?? t("computer.problem.localNotReady");
  }
  if (capabilities.host.label === "Browser") return t("computer.problem.localNeedsApp");
  if (capabilities.host.platform === "win32") return t("computer.problem.localWindows");
  return t("computer.problem.localMac");
}

export type BoatPanelAction =
  | "cloud-new"
  | "cloud-asleep"
  | "attach-ready-boat"
  | "busy-boat"
  | "team-boat"
  | "show-ready-boat"
  | "show-sleeping-boat"
  | "show-pending-boat"
  | "local"
  | "unconfigured"
  | "auto-unavailable";

const READY_BOAT_STATES = new Set(["idle", "ready", "running"]);

export function isReadyBoatState(state: string | null | undefined): boolean {
  return typeof state === "string" && READY_BOAT_STATES.has(state);
}
const SLEEPING_BOAT_STATES = new Set(["archived", "stopped"]);

/** A passive panel open never provisions: nothing creates, wakes or opens a Boat without an explicit Cloud choice. */
export function resolveBoatPanelAction({
  computer,
  configured,
  boatState,
  canUseCloud,
  autoLocal,
  teamComputer = false,
  busy = false,
}: {
  computer: Bot["computer"];
  configured: boolean;
  boatState: string | null;
  canUseCloud: boolean;
  autoLocal: boolean;
  teamComputer?: boolean;
  busy?: boolean;
}): BoatPanelAction {
  if (computer === undefined && teamComputer) return "team-boat";
  const explicitCloud = computer === "cloud";

  if (!configured) {
    if (explicitCloud) return "unconfigured";
    return autoLocal ? "local" : "auto-unavailable";
  }
  if (explicitCloud) {
    if (!canUseCloud) return "auto-unavailable";
    if (boatState && READY_BOAT_STATES.has(boatState)) return "attach-ready-boat";
    if (busy || (boatState && !SLEEPING_BOAT_STATES.has(boatState))) return "busy-boat";
    return boatState ? "cloud-asleep" : "cloud-new";
  }
  if (canUseCloud && boatState) {
    if (READY_BOAT_STATES.has(boatState)) return "show-ready-boat";
    if (SLEEPING_BOAT_STATES.has(boatState)) return "show-sleeping-boat";
    return "show-pending-boat";
  }
  return autoLocal ? "local" : "auto-unavailable";
}

export function busyBoatView(boatState: string | null, busy: boolean): {
  line: "computer.cloud.new" | "computer.cloud.asleep" | "computer.phase.busyBoat" | "computer.phase.starting";
  spinner: boolean;
} {
  if (!boatState) return { line: "computer.cloud.new", spinner: false };
  if (SLEEPING_BOAT_STATES.has(boatState)) return { line: "computer.cloud.asleep", spinner: false };
  return { line: busy ? "computer.phase.busyBoat" : "computer.phase.starting", spinner: true };
}

/** A stale ready phase can survive one render, so preview POSTs also need the durable, explicit Cloud choice. */
export function shouldPollCloudPreview(
  {
    computer,
    cloudBackend,
    phase,
    botId,
    resolvedBotId,
    resolvedComputer,
    resolvedCloudBackend,
  }: {
    computer: Bot["computer"];
    cloudBackend: NonNullable<Bot["cloudBackend"]>;
    phase: string;
    botId: string;
    resolvedBotId: string | null;
    resolvedComputer: Bot["computer"] | null;
    resolvedCloudBackend: Bot["cloudBackend"] | null;
  },
): boolean {
  return computer === "cloud"
    && phase === "ready"
    && resolvedBotId === botId
    && resolvedComputer === "cloud"
    && resolvedCloudBackend === cloudBackend;
}

/** Provider work only once the settled server bot confirms the destination and backend this render expects. */
export function persistedComputerSelectionMatches({
  computer,
  cloudBackend,
  persistedBot,
}: {
  computer: Bot["computer"];
  cloudBackend: NonNullable<Bot["cloudBackend"]>;
  persistedBot: Pick<Bot, "computer" | "cloudBackend">;
}): boolean {
  return persistedBot.computer === computer
    && (persistedBot.cloudBackend ?? "box") === cloudBackend;
}

export function autoSelectsLocalComputer({
  platform,
  computer,
  capabilitiesReady,
  localSelectable,
}: {
  platform: DesktopCapabilities["host"]["platform"];
  computer: Bot["computer"];
  capabilitiesReady: boolean;
  localSelectable: boolean;
}): boolean {
  return platform !== "linux" && computer !== "cloud" && capabilitiesReady && localSelectable;
}
