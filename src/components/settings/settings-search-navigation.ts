import { setAdvancedMode } from "@/lib/interface-mode";
import type { Action } from "@/state/store";
import { needsAdvanced, type SearchHit, type SettingsContext } from "./settings-index";

export function openSettingsSearchHit(hit: SearchHit, ctx: SettingsContext, dispatch: (action: Action) => void) {
  const { entry } = hit;
  if (entry.jump) {
    dispatch({ type: "toggleAppSettings", open: false });
    switch (entry.jump) {
      case "apps": dispatch({ type: "togglePlugins", open: true }); break;
      case "automations": dispatch({ type: "showRoutines", view: "list" }); break;
      case "shortcuts": dispatch({ type: "toggleShortcuts", open: true }); break;
      case "bot": dispatch({ type: "toggleSettings", open: true }); break;
    }
    return;
  }
  if (hit.advanced || needsAdvanced(entry, ctx)) setAdvancedMode(true);
  dispatch({ type: "toggleAppSettings", open: true, section: entry.page, anchor: entry.anchor });
}
