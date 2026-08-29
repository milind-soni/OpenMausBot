const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const DEFAULT_TITLE_BAR_OVERLAY = Object.freeze({
  color: "#070707",
  symbolColor: "#b5b5b5",
  height: 40,
});

/**
 * Validate the renderer-provided skin colors at the IPC boundary before they
 * reach Electron's native Windows title bar API.
 */
export function titleBarOverlayForColors(value) {
  if (
    !HEX_COLOR.test(value?.background ?? "") ||
    !HEX_COLOR.test(value?.foreground ?? "")
  ) {
    throw new TypeError("Invalid title-bar colors.");
  }
  return { color: value.background, symbolColor: value.foreground, height: 40 };
}
