// The foot of the sidebar. Vopwe trim: Routines, Triggers, Apps and Team map
// moved to the profile menu and Settings. This keeps only the guided tour
// anchor so existing tours do not break, plus upstream's Apps button that
// lives at the end of the profile row. The collapsible Tools header props
// are accepted and ignored: there are no rows left to fold.
import { Puzzle } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { useStore } from "@/state/store";

/** Apps, as a round icon button at the end of the profile row. */
export function SidebarAppsButton() {
  const { state, dispatch } = useStore();
  const label = t("sidebar.nav.apps");
  return (
    <button
      type="button"
      data-tour="nav-apps"
      data-sidebar-nav="apps"
      onClick={() => dispatch({ type: "togglePlugins", open: true })}
      aria-label={label}
      title={label}
      aria-pressed={state.pluginsOpen}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors",
        state.pluginsOpen ? "bg-raised text-accent" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
      )}
    >
      <Puzzle size={18} />
    </button>
  );
}

export function SidebarFooterNav({
  density,
  collapsed = false,
  onToggleCollapsed,
}: {
  density: SidebarDensity;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  void density;
  void collapsed;
  void onToggleCollapsed;
  return (
    <nav data-tour="tools" aria-label={t("sidebar.tools")} className="flex flex-col gap-0.5" />
  );
}
