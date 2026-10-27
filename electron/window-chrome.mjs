/** On Windows titleBarStyle "hidden" without titleBarOverlay removes the caption buttons too, so the renderer draws them:
 * the WCO overlay API cannot style hover. */
/** The canvas colour a window paints before the renderer loads: the light or dark theme's, so neither flashes the other. */
export function windowBackground(prefersDark) {
  return prefersDark ? "#121212" : "#fcfcfc";
}

export function windowChromeOptions(platform) {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } };
  }
  if (platform === "win32") {
    return { titleBarStyle: "hidden" };
  }
  return {};
}
