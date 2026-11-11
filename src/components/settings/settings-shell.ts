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
}

export const SettingsShellContext = createContext<SettingsShell | null>(null);

export function useSettingsShell(): SettingsShell {
  const shell = useContext(SettingsShellContext);
  if (!shell) throw new Error("useSettingsShell outside Settings");
  return shell;
}
