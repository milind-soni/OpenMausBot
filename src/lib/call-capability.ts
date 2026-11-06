import { t } from "@/lib/i18n";

export type CallCapabilityHelp = {
  label: string;
  reason: string;
};

const turnsNeedDesktop = (): CallCapabilityHelp => ({
  label: t("call.capability.turnsNeedDesktop"),
  reason: t("call.capability.turnsNeedDesktopReason"),
});

const turnsNeedFishKey = (): CallCapabilityHelp => ({
  label: t("call.capability.turnsNeedFishKey"),
  reason: t("call.capability.turnsNeedFishKeyReason"),
});

const turnsOnThisComputerAnyOs = (): CallCapabilityHelp => ({
  label: t("call.capability.turnsOnThisComputerAnyOs"),
  reason: t("call.capability.turnsOnThisComputerAnyOsReason"),
});

const turnsOnThisComputer = (): CallCapabilityHelp => ({
  label: t("call.capability.turnsOnThisComputer"),
  reason: t("call.capability.turnsOnThisComputerReason"),
});

export function callCapabilityHelp(
  capabilities: DesktopCapabilities,
  speechServiceAvailable: boolean,
  fishKeySaved: boolean,
): CallCapabilityHelp | null {
  if (!capabilities.dictation.available) {
    switch (capabilities.dictation.reasonCode) {
      case "remote-server":
        return capabilities.host.platform === "darwin" ? turnsOnThisComputer() : turnsOnThisComputerAnyOs();
      case "desktop-app-required":
      case "unsupported-platform":
        return turnsNeedDesktop();
      default:
        return {
          label: t("call.capability.unavailable"),
          reason: t("call.capability.unavailableReason"),
        };
    }
  }
  if (capabilities.dictation.engine === "fish-audio" && !fishKeySaved) return turnsNeedFishKey();
  if (!speechServiceAvailable) {
    return {
      label: t("call.capability.serviceUnavailable"),
      reason: t("call.capability.serviceUnavailableReason"),
    };
  }
  return null;
}
