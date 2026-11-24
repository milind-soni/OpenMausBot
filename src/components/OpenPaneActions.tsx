import { FocusedWorkspaceThread, WorkspaceLayoutContext, WorkspaceChatContext } from "@/state/workspace-chat-context";
import { emptyPane, paneIds, placePane, MAIN_PANE, type PaneEdge } from "@/state/pane-layout";
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
  const layout = useContext(WorkspaceLayoutContext);
  const focused = useContext(FocusedWorkspaceThread);
  const anchor = !focused || focused === primary ? MAIN_PANE : focused;
  const source = primary === threadId ? MAIN_PANE : threadId;
  const ids = paneIds(layout);
  if (!primary || !store) return [];
  const kind = store.state().groups.some(group => group.id === ownerId) ? "group" : "bot";
  const place = (target: string, edge: PaneEdge | "fill") => {
    if (ids.includes(source)) store.dispatch({ type: "movePane", source, target, edge });
    else store.dispatch({ type: "openForkPanel", kind, ownerId, threadId, target, edge, focusComposer: true });
  };
  const options: SidebarMenuItem[] = ids.flatMap((id, i) => emptyPane(id) ? [{
    key: id, label: t("chat.fillSlot", { number: i + 1 }), icon: <Columns2 size={16} />, onSelect: () => place(id, "fill"),
  }] : []);
  if (anchor !== source && !emptyPane(anchor)) {
    for (const [edge, label, Icon] of [
      ["right", "chat.openBeside", Columns2], ["bottom", "chat.openBelow", Rows2],
      ["left", "chat.openLeft", Columns2], ["top", "chat.openAbove", Rows2],
    ] as const) {
      options.push({ key: edge, label: t(label), icon: <Icon size={16} />,
        disabled: !placePane(layout, source, anchor, edge), onSelect: () => place(anchor, edge) });
    }
  }
  return options;
}

export function OpenPaneActions({ ownerId, threadId, onClose, menu }: Target & { onClose: () => void; menu?: boolean }) {
  return usePaneOptions({ ownerId, threadId }).map((item) =>
    <button type="button" key={item.key} disabled={item.disabled} role={menu ? "menuitem" : undefined} className={MENU_ITEM + " text-ink hover:bg-menu-hover disabled:opacity-40"}
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
