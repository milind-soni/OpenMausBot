export type CallCapabilityHelp = {
  label: string;
  reason: string;
  action?: "choose-local-workspace";
};

/** Explain why this renderer cannot start a call. Keep the remote-workspace
 * case distinct: the installed Mac app is already present, but this page is
 * intentionally denied access to the Mac microphone. */
export function callCapabilityHelp(
  capabilities: DesktopCapabilities,
  speechServiceAvailable: boolean,
): CallCapabilityHelp | null {
  if (!capabilities.dictation.available) {
    switch (capabilities.dictation.reasonCode) {
      case "remote-server":
        return {
          label: "Calls are available on This computer",
          reason:
            "You're viewing a hosted workspace. Calls use the microphone and on-device speech recognition on your Mac.",
          action: "choose-local-workspace",
        };
      case "desktop-app-required":
        return {
          label: "Calls need the macOS desktop app",
          reason: "Open this workspace in OpenMausBot for macOS to make calls with on-device speech recognition.",
        };
      case "unsupported-platform":
        return {
          label: "Calls currently need macOS",
          reason: "Calls are available on macOS for now because speech recognition runs on-device.",
        };
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
