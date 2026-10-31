/** On Windows titleBarStyle "hidden" without titleBarOverlay removes the caption buttons too, so the renderer draws them:
 * the WCO overlay API cannot style hover. */
/** The canvas colour a window paints before the renderer loads: the light or dark theme's, so neither flashes the other. */
export function windowBackground(prefersDark) {
  return prefersDark ? "#121212" : "#fcfcfc";
}

/** macOS: where the traffic lights (14px) sit. In the frame's 28px top bar, 12px in, while the page beside the rail draws
 * that frame (src/components/WindowFrameBar.tsx); where an older page made room for them otherwise. The window opens with
 * them in the bar, and main moves them as each page says (chrome-rail.mjs). */
export const TRAFFIC_LIGHTS = { framed: { x: 12, y: 7 }, unframed: { x: 16, y: 16 } };

export function windowChromeOptions(platform) {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: TRAFFIC_LIGHTS.framed };
  }
  if (platform === "win32") {
    return { titleBarStyle: "hidden" };
  }
  return {};
}
