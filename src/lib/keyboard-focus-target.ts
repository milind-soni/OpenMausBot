/** Capture before moving focus into a dialog, while the opener still reflects how it was activated. */
export function keyboardFocusTarget(): HTMLElement | null {
  const target = document.activeElement;
  return target instanceof HTMLElement && target.matches(":focus-visible") ? target : null;
}
