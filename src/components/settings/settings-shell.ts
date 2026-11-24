import { createContext, useContext } from "react";
import type { SettingsPlace } from "./settings-context";
import type { SettingsContext, SettingsPageId } from "./settings-index";

export interface SettingsShell {
  ctx: SettingsContext;
  place: SettingsPlace;
  page: SettingsPageId;
  /** the section a link, a notice or search asked for; folds holding it open */
  anchor: string | null;
  go: (page: SettingsPageId, anchor?: string) => void;
  /** The window is phone-narrow: its own header shows the page's title and the way back. */
  narrow?: boolean;
  /** A step inside the page (Add a device's), named in the narrow header with its own way back; null gives the page back. */
  setSub?: (sub: SettingsSub | null) => void;
}

export interface SettingsSub {
  title: string;
  /** A shorter title for the narrow header, where the way back sits beside it. */
  short?: string;
  /** Where the header's back button goes, in a word or two. */
  back: string;
  onBack: () => void;
}

export const SettingsShellContext = createContext<SettingsShell | null>(null);

export function useSettingsShell(): SettingsShell {
  const shell = useContext(SettingsShellContext);
  if (!shell) throw new Error("useSettingsShell outside Settings");
  return shell;
}
