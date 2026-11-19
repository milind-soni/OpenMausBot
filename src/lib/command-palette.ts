export const COMMAND_PALETTE_OPEN_EVENT = "omb:open-command-palette";

export function openCommandPalette() {
  window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT));
}
