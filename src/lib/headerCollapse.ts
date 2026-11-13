/**
 * Pure functions and types for container-width-driven header collapse in ChatView and GroupView.
 */

export interface HeaderCollapseState {
  /** Width >= 640px: full model label, button labels, all secondary actions visible */
  isSpacious: boolean;
  /** Width 520px - 639px: icon-only Preview/Tasks buttons, compact model label, secondary actions visible */
  isCompact: boolean;
  /** Width < 520px: secondary actions move into More (•••) menu, compact model label */
  isTight: boolean;
  /** Width < 440px: model label shrinks to iconOnly */
  isVeryTight: boolean;
  /** How the ModelPicker should render its trigger */
  modelMode: "full" | "compact" | "iconOnly";
  /** Whether "Preview" and "Tasks" text labels should be displayed next to their icons */
  showButtonsText: boolean;
  /** Whether secondary actions (Schedule, Computer, Room Activity) should move into the More menu */
  collapseSecondaryToMenu: boolean;
}

export function resolveHeaderCollapse(width: number): HeaderCollapseState {
  const isSpacious = width >= 640;
  const isCompact = width < 640 && width >= 520;
  const isTight = width < 520;
  const isVeryTight = width < 440;

  return {
    isSpacious,
    isCompact,
    isTight,
    isVeryTight,
    modelMode: isVeryTight ? "iconOnly" : isTight || isCompact ? "compact" : "full",
    showButtonsText: isSpacious,
    collapseSecondaryToMenu: isTight,
  };
}
