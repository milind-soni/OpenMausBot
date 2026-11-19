import type { Action } from "@/state/store";
import { type SearchHit } from "./settings-index";

export function openSettingsSearchHit(hit: SearchHit, dispatch: (action: Action) => void) {
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
  dispatch({ type: "toggleAppSettings", open: true, section: entry.page, anchor: entry.anchor });
}
