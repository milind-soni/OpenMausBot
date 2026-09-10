import { t } from "@/lib/i18n";
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
  return capabilities.host.platform === "darwin";
}

export function localComputerDisabledReason({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): string | null {
  if (!providerSupportsLocal) {
    return t("localComputer.providerUnsupported");
  }
  if (capabilities.localComputer.available) return null;
  if (capabilities.host.platform === "linux") {
    if (capabilities.localComputer.reasonCode === "linux-wayland-seat-safety-blocked") {
      return t("localComputer.waylandBlocked");
    }
    if (capabilities.localComputer.reasonCode === "wayland-compositor-unsupported") {
      return t("localComputer.waylandGnomeOnly");
    }
    if (!capabilities.localComputer.enabled) {
      return t("localComputer.enableBeta");
    }
    return capabilities.localComputer.message ?? t("localComputer.cuaNotReady");
  }
  if (capabilities.host.label === "Browser") {
    return t("localComputer.desktopRequired");
  }
  return t("localComputer.cuaNotReadyLocal");
}

export function linuxAutoDescription(): string {
  return t("localComputer.linuxAuto");
}

export type BoxPanelAction =
  | "ensure-box"
  | "show-ready-box"
  | "show-sleeping-box"
  | "show-pending-box"
  | "local"
  | "unconfigured"
  | "auto-unavailable";

const READY_BOX_STATES = new Set(["idle", "ready", "running"]);
const SLEEPING_BOX_STATES = new Set(["archived", "stopped"]);

/** Mirror the turn router's Box choice without letting a passive panel open
 * mutate infrastructure. Auto only reports an existing Box's current state;
 * it never creates, wakes, bootstraps, or opens one. This is deliberately
 * independent of the engine: even the box-native Computer engine needs an
 * explicit Cloud choice before the panel may provision. */
export function resolveBoxPanelAction({
  computer,
  configured,
  boxState,
  canUseCloud,
  autoLocal,
}: {
  computer: Bot["computer"];
  configured: boolean;
  boxState: string | null;
  canUseCloud: boolean;
  autoLocal: boolean;
}): BoxPanelAction {
  const explicitCloud = computer === "cloud";

  if (!configured) {
    if (explicitCloud) return "unconfigured";
    return autoLocal ? "local" : "auto-unavailable";
  }
  if (explicitCloud) return canUseCloud ? "ensure-box" : "auto-unavailable";
  if (canUseCloud && boxState) {
    if (READY_BOX_STATES.has(boxState)) return "show-ready-box";
    if (SLEEPING_BOX_STATES.has(boxState)) return "show-sleeping-box";
    return "show-pending-box";
  }
  return autoLocal ? "local" : "auto-unavailable";
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
