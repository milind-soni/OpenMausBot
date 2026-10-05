export type CallCapabilityHelp = {
  label: string;
  reason: string;
  action?: "choose-local-workspace";
};

/** Only the Mac app listens on-device. Live calls need no on-device
 * listening, so where they are offered (a browser, a Windows or Linux app)
 * their button is the way on. */
const TURNS_NEED_MAC: CallCapabilityHelp = {
  label: "Calls where you take turns need the Mac app",
  reason: "They listen with on-device speech recognition, which only the Mac app has.",
};

/** Explain why this renderer cannot start a call. Keep the remote-workspace
 * case distinct: the installed Mac app is already present, but this page is
 * intentionally denied access to the Mac microphone. Only a Mac is offered
 * the trip to This computer: anywhere else it cannot take turns either. */
export function callCapabilityHelp(
  capabilities: DesktopCapabilities,
  speechServiceAvailable: boolean,
): CallCapabilityHelp | null {
  if (!capabilities.dictation.available) {
    switch (capabilities.dictation.reasonCode) {
      case "remote-server":
        if (capabilities.host.platform !== "darwin") return TURNS_NEED_MAC;
        return {
          label: "Calls are available on This computer",
          reason:
            "You're viewing a server. Calls use the microphone and on-device speech recognition on your Mac.",
          action: "choose-local-workspace",
        };
      case "desktop-app-required":
      case "unsupported-platform":
        return TURNS_NEED_MAC;
      default:
        return {
          label: "Calls aren't available on this device",
          reason: "This device doesn't currently provide the on-device speech recognition needed for calls.",
        };
    }
  }
  if (!speechServiceAvailable) {
    return {
      label: "The call service is unavailable",
      reason: "The speech service is unavailable in this app build. Restart or update OpenMausBot.",
    };
  }
  return null;
}
