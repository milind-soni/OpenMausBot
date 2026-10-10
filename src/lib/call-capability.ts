export type CallCapabilityHelp = {
  label: string;
  reason: string;
};

/** Only the Mac app listens on-device. Live calls need no on-device
 * listening, so elsewhere (a browser, a Windows or Linux app) a one-to-one
 * call is Live. */
const TURNS_NEED_MAC: CallCapabilityHelp = {
  label: "Calls where you take turns need the Mac app",
  reason: "They listen with on-device speech recognition, which only the Mac app has.",
};

/** The Mac app on a server's page (My Cloud): taking turns works on This
 * computer, whose page can listen on the Mac. No trip there is offered:
 * leaving would leave the bot being called, and this page's call is Live. */
const TURNS_ON_THIS_COMPUTER: CallCapabilityHelp = {
  label: "Calls where you take turns work on This computer",
  reason: "They listen with your Mac's own speech recognition, which only This computer can use.",
};

/** Explain why this renderer cannot take turns (or start a call at all).
 * Where it cannot take turns, a one-to-one call is Live (effectiveCallMode),
 * so this is what the call mode menu says beside Take turns. */
export function callCapabilityHelp(
  capabilities: DesktopCapabilities,
  speechServiceAvailable: boolean,
): CallCapabilityHelp | null {
  if (!capabilities.dictation.available) {
    switch (capabilities.dictation.reasonCode) {
      case "remote-server":
        return capabilities.host.platform === "darwin" ? TURNS_ON_THIS_COMPUTER : TURNS_NEED_MAC;
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
