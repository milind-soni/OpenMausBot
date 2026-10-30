/** On Windows titleBarStyle "hidden" without titleBarOverlay removes the caption buttons too, so the renderer draws them:
 * the WCO overlay API cannot style hover. */
/** The canvas colour a window paints before the renderer loads: the light or dark theme's, so neither flashes the other. */
export function windowBackground(prefersDark) {
  return prefersDark ? "#121212" : "#fcfcfc";
}

/** macOS: the traffic lights (14px) centred in the page's 28px top bar (src/components/WindowFrameBar.tsx), 12px in. */
export function windowChromeOptions(platform) {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 7 } };
  }
  if (platform === "win32") {
    return { titleBarStyle: "hidden" };
  }
  return {};
}
