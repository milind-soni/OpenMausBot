// The overlays slice: what the shell's modal/panel family remembers —
// which surfaces are open, in open order, plus each overlay's section.
// Pure state and logic only; store.tsx owns the action union and delegates
// the overlay cases here.
import type { Action, AppSettingsSection, BotSettingsSection } from "./store";

/** Every modal/panel surface the shell tracks. Several can be open at once —
 *  bot settings deliberately keeps the computer and inspector panels up, and
 *  the shortcuts sheet stacks over anything — so the slice keeps an ordered
 *  list rather than a single value. */
export type OverlayKind =
  | "settings"
  | "plugins"
  | "newBot"
  | "computer"
  | "inspector"
  | "appSettings"
  | "shortcuts"
  | "welcome"
  | "tour";

/** The section (or plugins surface) an openOverlay action names. */
export type OverlaySection = AppSettingsSection | BotSettingsSection | "apps" | "mcp";

export interface OverlaysState {
  /** Open overlays in open order, most recent last. */
  open: OverlayKind[];
  /** Which tab the Plugins panel opens on; "mcp" when a bot's tools
   *  sent the user there to add a server. Remembered across close/reopen. */
  pluginsSurface: "apps" | "mcp";
  appSettingsSection: AppSettingsSection;
  botSettingsSection: BotSettingsSection;
  /** True only when the open action named a section — accordion expands that row. */
  botSettingsExpandAccordion: boolean;
}

/** Whether an overlay is currently open. */
export function overlayOpen(state: { overlays: OverlaysState }, kind: OverlayKind): boolean {
  return state.overlays.open.includes(kind);
}

/** Overlays each kind closes when it opens — exactly the exclusivity the old
 *  per-flag toggles enforced. Bot settings deliberately leaves the computer
 *  and inspector panels open (their own controls open bot settings); the
 *  shortcuts sheet closes nothing and only welcome/plugins/newBot dismiss it. */
const OVERLAY_EXCLUDES: Record<OverlayKind, readonly OverlayKind[]> = {
  settings: ["appSettings"],
  plugins: ["settings", "appSettings", "newBot", "shortcuts"],
  newBot: ["settings", "appSettings", "plugins", "shortcuts"],
  computer: ["settings", "inspector", "appSettings"],
  inspector: ["settings", "computer", "appSettings"],
  appSettings: ["settings", "computer", "inspector", "plugins"],
  shortcuts: [],
  tour: ["appSettings"],
  welcome: ["appSettings", "shortcuts"],
};

/** showRoutines/showTeamMap replace the chat surface, so the panels living in
 *  it close; the modals (new bot, shortcuts, welcome, tour) do not. */
export const VIEW_SWITCH_OVERLAYS: readonly OverlayKind[] = ["settings", "computer", "inspector", "appSettings", "plugins"];

export function withoutOverlays(overlays: OverlaysState, kinds: readonly OverlayKind[]): OverlaysState {
  return { ...overlays, open: overlays.open.filter((kind) => !kinds.includes(kind)) };
}

/** The openOverlay/closeOverlay cases of the store reducer, over the overlays
 *  slice alone. `selectionChanged` carries the one app-state fact the settings
 *  case needs — whether openOverlay is switching to a different bot (which
 *  resets the remembered bot settings section); store.tsx passes it. */
export function overlaysReducer(overlays: OverlaysState, action: Action, selectionChanged = false): OverlaysState {
  switch (action.type) {
    case "openOverlay": {
      if (action.kind === "settings") {
        // A targeted settings link opens that bot without navigating to chat
        // or marking its conversations read, even when another panel is open.
        const open = action.open ?? (action.botId !== undefined || !overlays.open.includes("settings"));
        if (!open) {
          // Closing only folds the accordion; the remembered section and the
          // computer/inspector panels stay as they are.
          return {
            ...overlays,
            open: overlays.open.filter((kind) => kind !== "settings"),
            botSettingsSection:
              (action.section as BotSettingsSection | undefined) ??
              (selectionChanged ? "overview" : overlays.botSettingsSection),
            botSettingsExpandAccordion: false,
          };
        }
        return {
          ...overlays,
          // Preserve the computer and inspector surfaces; their own controls
          // can open bot settings. App settings are mutually exclusive.
          open: [...overlays.open.filter((kind) => kind !== "settings" && kind !== "appSettings"), "settings"],
          botSettingsSection:
            (action.section as BotSettingsSection | undefined) ??
            (selectionChanged ? "overview" : overlays.botSettingsSection),
          // Mascot / bare open omits `section` → accordion stays fully collapsed.
          // Deep links expand that row even when the panel is already open.
          botSettingsExpandAccordion: action.section !== undefined,
        };
      }
      const open = action.open ?? !overlays.open.includes(action.kind);
      if (!open) {
        return {
          ...overlays,
          open: overlays.open.filter((kind) => kind !== action.kind),
        };
      }
      const excluded = OVERLAY_EXCLUDES[action.kind];
      const openList = overlays.open.filter((kind) => !excluded.includes(kind));
      return {
        ...overlays,
        open: openList.includes(action.kind) ? openList : [...openList, action.kind],
        ...(action.kind === "plugins" && action.section !== undefined
          ? { pluginsSurface: action.section as "apps" | "mcp" }
          : {}),
        ...(action.kind === "appSettings" && action.section !== undefined
          ? { appSettingsSection: action.section as AppSettingsSection }
          : {}),
      };
    }
    case "closeOverlay": {
      return {
        ...overlays,
        open: overlays.open.filter((kind) => kind !== action.kind),
        // Only the settings accordion has close-time side effects.
        ...(action.kind === "settings" ? { botSettingsExpandAccordion: false } : {}),
      };
    }
    default:
      return overlays;
  }
}
