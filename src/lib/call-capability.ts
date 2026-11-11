import { t } from "@/lib/i18n";
import type { ConfigStatus } from "@/state/store";
import { canListenHere, serverListeningReady, speechBridge, speechRecognizer } from "./speech";

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

const turnsNeedSpeechInput = (): CallCapabilityHelp => ({
  label: t("stt.needSetup"),
  reason: t("stt.needSetupReason"),
});

const turnsOnThisComputerAnyOs = (): CallCapabilityHelp => ({
  label: t("call.capability.turnsOnThisComputerAnyOs"),
  reason: t("call.capability.turnsOnThisComputerAnyOsReason"),
});

const turnsOnThisComputer = (): CallCapabilityHelp => ({
  label: t("call.capability.turnsOnThisComputer"),
  reason: t("call.capability.turnsOnThisComputerReason"),
});

export function callCapabilityHelp(capabilities: DesktopCapabilities, config: ConfigStatus | null | undefined): CallCapabilityHelp | null {
  const recognizer = speechRecognizer(config, capabilities);
  if (!canListenHere(capabilities, config)) {
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
  if (recognizer !== "native" && !serverListeningReady(config)) return recognizer === "endpoint" ? turnsNeedSpeechInput() : turnsNeedFishKey();
  if (!speechBridge(config, capabilities)?.speechStart) {
    return {
      label: t("call.capability.serviceUnavailable"),
      reason: t("call.capability.serviceUnavailableReason"),
    };
  }
  return null;
}
