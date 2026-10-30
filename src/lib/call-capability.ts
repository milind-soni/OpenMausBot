import { t } from "@/lib/i18n";

export type CallCapabilityHelp = {
  label: string;
  reason: string;
};

const turnsNeedMac = (): CallCapabilityHelp => ({
  label: t("call.capability.turnsNeedMac"),
  reason: t("call.capability.turnsNeedMacReason"),
});

const turnsOnThisComputer = (): CallCapabilityHelp => ({
  label: t("call.capability.turnsOnThisComputer"),
  reason: t("call.capability.turnsOnThisComputerReason"),
});

export function callCapabilityHelp(
  capabilities: DesktopCapabilities,
  speechServiceAvailable: boolean,
): CallCapabilityHelp | null {
  if (!capabilities.dictation.available) {
    switch (capabilities.dictation.reasonCode) {
      case "remote-server":
        return capabilities.host.platform === "darwin" ? turnsOnThisComputer() : turnsNeedMac();
      case "desktop-app-required":
      case "unsupported-platform":
        return turnsNeedMac();
      default:
        return {
          label: t("call.capability.unavailable"),
          reason: t("call.capability.unavailableReason"),
        };
    }
  }
  if (!speechServiceAvailable) {
    return {
      label: t("call.capability.serviceUnavailable"),
      reason: t("call.capability.serviceUnavailableReason"),
    };
  }
  return null;
}
