/**
 * Frameless window with overlay controls on Windows.
 * titleBarOverlay keeps native min/max/close buttons but removes the
 * default title bar, so the renderer draws its own header.
 */
export function windowChromeOptions(platform) {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } };
  }
  if (platform === "win32") {
    return {
      frame: false,
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#070707", symbolColor: "#b5b5b5", height: 32 },
    };
  }
  return {};
}
