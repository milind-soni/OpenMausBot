import { Columns2, Grid2X2, LayoutPanelLeft, PanelsTopLeft, Rows2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { currentPreset, emptyPane, paneIds, presetSize, type PanePreset } from "@/state/pane-layout";
import { workspaceLayout } from "@/state/fork-panel";
import { useStore } from "@/state/store";
import { SidebarPopoverMenu } from "./SidebarPopoverMenu";

export function PaneLayoutMenu() {
  const { state, dispatch } = useStore();
  const layout = workspaceLayout(state);
  const occupied = paneIds(layout).filter(id => !emptyPane(id)).length;
  const icons = { columns: Columns2, rows: Rows2, stack: LayoutPanelLeft, grid: Grid2X2 };
  const items = (Object.keys(icons) as PanePreset[]).map(preset => {
    const Icon = icons[preset];
    const disabled = presetSize[preset] < occupied;
    return { key: preset, label: t(`chat.${preset}`), checked: currentPreset(layout) === preset, icon: <Icon size={16} />, disabled,
      subtitle: disabled ? t("chat.presetTooSmall") : undefined,
      onSelect: () => dispatch({ type: "presetPanes", preset }) };
  });
  return <div className="flex shrink-0 justify-end border-b border-hairline bg-app px-2">
    <SidebarPopoverMenu items={items} ariaLabel={t("chat.layout")} align="end"
      triggerClassName="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-ink-secondary hover:bg-raised focus-visible:ring-1 focus-visible:ring-focus"
      renderTrigger={() => <><PanelsTopLeft size={14} />{t("chat.layout")}</>} />
  </div>;
}
