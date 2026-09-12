/**
 * Windows uses the Window Controls Overlay: titleBarStyle "hidden" removes
 * the native title bar while titleBarOverlay keeps the caption buttons,
 * which Windows draws over the top-right of the app header. The renderer
 * shifts that header's icon row out from under the 26px-tall overlay
 * (ChatView/GroupView) and marks the headers as window drag regions.
 */
export function windowChromeOptions(platform) {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } };
  }
  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#070707", symbolColor: "#b5b5b5", height: 26 },
    };
  }
  return {};
}
