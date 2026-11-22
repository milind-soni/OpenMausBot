// A screenshot of a pane whose window does not draw: the parking window, which is never shown, or an app window that is
// minimised or hidden. Chromium draws no frame for it, so CDP's Page.captureScreenshot would wait for good. Electron's
// capturePage makes the page draw while it captures (a hidden window's page counts as visible while a capture is under
// way), and its picture is shaped as CDP's answer would be: the same pixels for the same clip and scale, whatever the
// scale factor of the screen the window is on.

/** How long the page gets to draw a fresh frame once a capture has made it visible. */
export const FRESH_FRAME_MS = 50;

/** How long the page's own ratio is waited for. */
const RATIO_READ_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether `win` draws its views now: not when minimised or hidden. */
export function windowDraws(win) {
  if (!win || win.isDestroyed?.()) return false;
  if (win.isMinimized?.()) return false;
  return win.isVisible?.() !== false;
}

/**
 * The page's own device pixel ratio, which CDP draws at and the driver divides its clip's scale by; the window's
 * screen may have another. Read from the page, else from the layout metrics' device and CSS widths.
 */
async function pageRatio(contents, css, device) {
  // A page under a dialog answers no script: the metrics answer then.
  const read = await Promise.race([
    contents.debugger.sendCommand("Runtime.evaluate", { expression: "window.devicePixelRatio", returnByValue: true }).catch(() => null),
    sleep(RATIO_READ_MS).then(() => null),
  ]);
  const value = Number(read?.result?.value);
  if (value > 0) return value;
  return css > 0 && device > 0 ? device / css : 1;
}

/** CDP's Page.captureScreenshot answer, `{ data }` in base64, for a pane that is not drawing. */
export async function captureUndrawn(contents, params = {}, { wait = sleep } = {}) {
  if (params.captureBeyondViewport) throw new Error("A whole-page screenshot needs the browser shown in the app window. Take a screenshot of the visible part instead.");
  const metrics = await contents.debugger.sendCommand("Page.getLayoutMetrics");
  const view = metrics?.cssVisualViewport ?? {};
  const css = Number(view.clientWidth);
  const ratio = await pageRatio(contents, css, Number(metrics?.visualViewport?.clientWidth));
  const clip = params.clip;
  const region = clip
    ? { x: Math.round(clip.x - (view.pageX ?? 0)), y: Math.round(clip.y - (view.pageY ?? 0)), width: Math.max(1, Math.round(clip.width)), height: Math.max(1, Math.round(clip.height)) }
    : css > 0 && Number(view.clientHeight) > 0 ? { x: 0, y: 0, width: Math.round(css), height: Math.round(Number(view.clientHeight)) } : null;
  const rect = clip ? region : undefined;
  // The first capture makes the page visible and may hold the frame it drew before; the page then draws a fresh one.
  await contents.capturePage(rect);
  contents.invalidate?.();
  await wait(FRESH_FRAME_MS);
  let image = await contents.capturePage(rect);
  if (image.isEmpty()) throw new Error("The page did not draw, so no screenshot was taken.");
  if (region) {
    const scale = clip && Number(clip.scale) > 0 ? Number(clip.scale) : 1;
    const width = Math.max(1, Math.round(region.width * scale * ratio));
    const height = Math.max(1, Math.round(region.height * scale * ratio));
    const size = image.getSize();
    if (size.width !== width || size.height !== height) image = image.resize({ width, height, quality: "good" });
  }
  const jpeg = params.format === "jpeg";
  const bytes = jpeg ? image.toJPEG(Math.min(100, Math.max(1, Math.round(Number(params.quality) || 80)))) : image.toPNG();
  return { data: bytes.toString("base64") };
}
