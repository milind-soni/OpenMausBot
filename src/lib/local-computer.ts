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

/** Whether the Runs-on “This computer” control should be clickable.
 *  macOS keeps the destination available even before CUA has a grant, so
 *  the user can pick it and then approve Accessibility / Screen Recording
 *  instead of finding a grayed-out button. */
export function localComputerSelectable({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): boolean {
  if (!providerSupportsLocal) return false;
  if (capabilities.localComputer.available) return true;
  // macOS and Windows both keep the destination clickable before the driver
  // is live, so the user can pick it and then finish the permission/setup
  // step instead of hunting for why the button is greyed out.
  return capabilities.host.platform === "darwin" || capabilities.host.platform === "win32";
}

export function localComputerDisabledReason({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): string | null {
  if (!providerSupportsLocal) {
    return "The selected provider cannot request approvals for local computer actions.";
  }
  if (capabilities.localComputer.available) return null;
  if (capabilities.host.platform === "linux") {
    if (capabilities.localComputer.reasonCode === "linux-wayland-seat-safety-blocked") {
      return "Local computer control is not available on Wayland yet. Sign out and choose Ubuntu on Xorg to use This computer.";
    }
    if (capabilities.localComputer.reasonCode === "wayland-compositor-unsupported") {
      return "Wayland local control is currently limited to GNOME. Xorg remains available on supported desktops.";
    }
    if (!capabilities.localComputer.enabled) {
      return "Enable the local control beta and complete the Cua Driver checks first.";
    }
    return capabilities.localComputer.message ?? "Cua Driver is not ready for local control.";
  }
  if (capabilities.host.label === "Browser") {
    return "Local computer control requires the desktop app.";
  }
  if (capabilities.host.platform === "win32") {
    return "The bundled Cua Driver could not start. Restart OpenMausBot and check Diagnostics if it still fails.";
  }
  return "CUA Driver is not ready for local computer control.";
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

/** A Boat state the panel can attach to and poll. */
export function isReadyBoatState(state: string | null | undefined): boolean {
  return typeof state === "string" && READY_BOAT_STATES.has(state);
}
const SLEEPING_BOAT_STATES = new Set(["archived", "stopped"]);

/** Mirror the turn router's Boat choice without letting a passive panel open
 * mutate infrastructure. Opening the panel never creates, wakes, bootstraps,
 * or opens a Boat: with Cloud computer chosen the bot's first computer call
 * starts it, and the panel says so (cloud-new, cloud-asleep) next to the
 * person's own button to start it now. Auto only reports an existing Boat's
 * current state. This is deliberately independent of the engine: every engine
 * needs an explicit Cloud choice before anything may provision. */
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
  /** A turn is running on this bot: the server refuses provision/sleep
   * with 409 while the turn owns the boat, and the turn itself creates or
   * wakes the boat it needs. */
  busy?: boolean;
}): BoatPanelAction {
  // A team's explicit grant wins over Auto's private-Boat/local fallback.
  // This panel reports it; paid lifecycle and shared access stay in Team map.
  if (computer === undefined && teamComputer) return "team-boat";
  const explicitCloud = computer === "cloud";

  if (!configured) {
    if (explicitCloud) return "unconfigured";
    return autoLocal ? "local" : "auto-unavailable";
  }
  if (explicitCloud) {
    if (!canUseCloud) return "auto-unavailable";
    // A ready boat is shown as-is (mid-turn its frames already stream in).
    if (boatState && READY_BOAT_STATES.has(boatState)) return "attach-ready-boat";
    // Mid-turn the panel only watches: anything else is the turn's to start
    // on its first computer call, and so is a boat already starting.
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

/** What the panel shows while it watches a conversation's cloud computer
 * (busy-boat). A missing or sleeping computer is started only by the bot's
 * first computer call, so there is nothing to wait for: the panel says what
 * it found, without a spinner. Only a computer that is really starting spins:
 * a turn bringing it up, or one still coming up after a turn. */
export function busyBoatView(boatState: string | null, busy: boolean): {
  line: "computer.cloud.new" | "computer.cloud.asleep" | "computer.phase.busyBoat" | "computer.phase.starting";
  spinner: boolean;
} {
  if (!boatState) return { line: "computer.cloud.new", spinner: false };
  if (SLEEPING_BOAT_STATES.has(boatState)) return { line: "computer.cloud.asleep", spinner: false };
  return { line: busy ? "computer.phase.busyBoat" : "computer.phase.starting", spinner: true };
}

/** A stale ready phase can survive one render while the selected bot or its
 * destination changes. Keep every cloud preview POST behind the durable,
 * explicit Cloud choice as well as the resolved phase. */
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

/** A computer effect may render optimistic profile state while its PATCH is
 * still in flight. Provider work is safe only when the settled server bot
 * confirms the same destination and backend that this render expects. */
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
