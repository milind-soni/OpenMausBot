import { WorkspaceChatContext } from "@/state/workspace-chat-context";
import { MAIN_PANE } from "@/state/pane-layout";
import { useContext } from "react";
import { Columns2, MoreHorizontal, Rows2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { useOptionalStoreRef } from "@/state/store-ref";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import { MENU_ITEM } from "./menu-recipe";

export function useSelectThreadPane(ownerId: string) {
  const store = useOptionalStoreRef();
  const primary = useContext(WorkspaceChatContext);
  return (threadId: string): boolean => {
    const panes = store?.state().workspacePanes;
    if (!panes || !primary || !store) return false;
    const pane = document.querySelector<HTMLElement>(`[data-workspace-thread="${CSS.escape(threadId)}"]`);
    if (pane) {
      (pane.querySelector<HTMLElement>('[data-tour="composer"] textarea:not(:disabled)') ?? pane).focus();
      return true;
    }
    if (panes.focused === MAIN_PANE) return false;
    const kind = store.state().groups.some((group) => group.id === ownerId) ? "group" : "bot";
    store.dispatch({ type: "openForkPanel", kind, ownerId, threadId, split: "replace" });
    return true;
  };
}

type Target = { ownerId: string; threadId: string };

function usePaneOptions({ ownerId, threadId }: Target): SidebarMenuItem[] {
  const primary = useContext(WorkspaceChatContext);
  const store = useOptionalStoreRef();
  if (!primary || !store || primary === threadId || store.state().workspacePanes?.panels[threadId]) return [];
  return (["beside", "below"] as const).map((split) => ({
    key: split,
    label: t(split === "beside" ? "chat.openBeside" : "chat.openBelow"),
    icon: split === "beside" ? <Columns2 size={16} /> : <Rows2 size={16} />,
    onSelect: () => {
      const kind = store.state().groups.some((group) => group.id === ownerId) ? "group" : "bot";
      store.dispatch({ type: "openForkPanel", kind, ownerId, threadId, split, focusComposer: true });
    },
  }));
}

export function OpenPaneActions({ ownerId, threadId, onClose, menu }: Target & { onClose: () => void; menu?: boolean }) {
  return usePaneOptions({ ownerId, threadId }).map((item) =>
    <button type="button" key={item.key} role={menu ? "menuitem" : undefined} className={MENU_ITEM + " text-ink hover:bg-menu-hover"}
      onClick={() => { onClose(); item.onSelect(); }}>{item.icon}{item.label}</button>);
}

export function ThreadSplitMenu({ ownerId, threadId, title, hideable }: Target & { title: string; hideable: boolean }) {
  const items = usePaneOptions({ ownerId, threadId });
  if (!items.length) return null;
  return <div data-thread-split-menu="" className={`absolute ${hideable ? "end-7" : "end-1"} opacity-0 group-hover/label:opacity-100 group-focus-within/label:opacity-100`}
    onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <SidebarPopoverMenu items={items} ariaLabel={t("task.actions", { title })} align="end"
      triggerClassName="flex size-6 items-center justify-center rounded-md bg-app text-ink-secondary hover:bg-raised focus-visible:ring-1 focus-visible:ring-focus"
      renderTrigger={() => <MoreHorizontal size={14} />} />
  </div>;
}
