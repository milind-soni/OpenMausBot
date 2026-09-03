/**
 * Keep native window chrome outside the renderer content on Windows and Linux.
 * macOS retains the inset traffic-light treatment used by the app header.
 */
export function windowChromeOptions(platform) {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 16 },
    };
  }
  return { frame: true };
}
