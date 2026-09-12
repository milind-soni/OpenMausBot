/**
 * Windows hides the native title bar entirely: titleBarStyle "hidden" without
 * a titleBarOverlay removes the caption buttons too, so the renderer draws
 * them (WindowCaptionButtons.tsx) with the app's own colors and hover states.
 * The WCO overlay API cannot style hover, which is why it is not used.
 */
export function windowChromeOptions(platform) {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } };
  }
  if (platform === "win32") {
    return { titleBarStyle: "hidden" };
  }
  return {};
}
