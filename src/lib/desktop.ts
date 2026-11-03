const browserCapabilities: DesktopCapabilities = {
  host: {
    platform: "other",
    label: "Browser",
    session: "unknown",
    packaged: false,
  },
  windowChrome: "native",
  screenPreview: {
    available: false,
    interaction: "none",
    reasonCode: "desktop-app-required",
  },
  dictation: {
    available: false,
    engine: "none",
    onDevice: false,
    reasonCode: "desktop-app-required",
  },
  localComputer: {
    available: false,
    support: "unsupported",
    enabled: false,
    status: "unavailable",
    reasonCode: "desktop-app-required",
  },
};

let cached: DesktopCapabilities | null = null;
let cacheRevision = 0;

export function initialDesktopCapabilities(): DesktopCapabilities {
  const platform = typeof window === "undefined" ? undefined : window.ogb?.platform;
  if (!platform) return browserCapabilities;
  const isMac = platform === "darwin";
  const dictation: DesktopCapabilities["dictation"] = {
    available: isMac,
    engine: isMac ? "apple-speech" : "none",
    onDevice: isMac,
  };
  if (!isMac) dictation.reasonCode = "unsupported-platform";
  return {
    ...browserCapabilities,
    host: {
      ...browserCapabilities.host,
      platform: platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "other",
      label: platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform === "win32" ? "Windows" : "Desktop",
    },
    windowChrome: isMac ? "mac-inset" : platform === "win32" ? "win-caption" : "native",
    dictation,
  };
}

export async function loadDesktopCapabilities(): Promise<DesktopCapabilities> {
  if (cached) return cached;
  if (!window.ogb?.getCapabilities) return browserCapabilities;
  const revisionAtStart = cacheRevision;
  let loaded: DesktopCapabilities;
  try {
    loaded = await window.ogb.getCapabilities();
  } catch {
    loaded = browserCapabilities;
  }
  // An IPC push may have delivered newer readiness meanwhile; never let this older response replace it.
  if (cacheRevision !== revisionAtStart && cached) return cached;
  cached = loaded;
  return cached;
}

export function desktopCapabilitiesNow(): DesktopCapabilities {
  return cached ?? initialDesktopCapabilities();
}

export function cacheDesktopCapabilities(capabilities: DesktopCapabilities): DesktopCapabilities {
  cacheRevision += 1;
  cached = capabilities;
  return capabilities;
}

/** The desktop bridge that saves a switch with its approval reset to Ask. A paired desktop has none: its own app runs no
 * server behind that bridge, so the host takes the switch over HTTP. */
export function askResetBridge() {
  return typeof window === "undefined" || window.ogb?.remoteClient?.active ? undefined : window.ogb?.approvals;
}
