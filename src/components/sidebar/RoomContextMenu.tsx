import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ClipboardCopy, FolderPlus, Pencil, Trash2, X } from "lucide-react";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { nextRename } from "@/lib/rename";

export function RoomContextMenu({
  menu,
  onClose,
  onMoveToSection,
}: {
  menu: { groupId: string; x: number; y: number };
  onClose: () => void;
  onMoveToSection: (groupId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const remoteClient = window.ogb?.remoteClient?.active === true;
  const group = state.groups.find((g) => g.id === menu.groupId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group?.name ?? "");
  const menuRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    setMeasured({
      top: Math.max(8, Math.min(menu.y, window.innerHeight - height - 8)),
      left: Math.max(8, Math.min(menu.x, window.innerWidth - width - 8)),
    });
  }, [menu.x, menu.y]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menuRef.current?.querySelector<HTMLButtonElement>("button[role='menuitem']:not([disabled])")?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-room-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!group) return null;
  const isBotChat = Boolean(group.dm);
  const saveRename = () => {
    const name = nextRename(group.name, draft);
    if (name) dispatch({ type: "patchGroup", groupId: group.id, patch: { name } });
    onClose();
  };
  const top = measured?.top ?? Math.min(menu.y, window.innerHeight - 204);
  const left = measured?.left ?? Math.min(menu.x, window.innerWidth - 240);
  return createPortal(
    <div
      data-room-menu
      data-sidebar
      ref={menuRef}
      role="menu"
      aria-label={t("sidebar.room.menuAria")}
      style={{ top, left }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>("button[role='menuitem']:not([disabled])"),
        );
        if (buttons.length === 0) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
      }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60"
    >
      {!remoteClient && (renaming ? (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={draft}
            maxLength={100}
            aria-label={t("sidebar.room.renameAria", { name: group.name })}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 rounded-lg bg-raised px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={saveRename}
            aria-label={isBotChat ? t("sidebar.room.saveChatName") : t("sidebar.room.saveChannelName")}
            title={t("common.save")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={isBotChat ? t("sidebar.room.cancelChatRename") : t("sidebar.room.cancelChannelRename")}
            title={t("common.cancel")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          role="menuitem"
          onClick={() => {
            setDraft(group.name);
            setRenaming(true);
          }}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
        >
          <Pencil size={16} className="text-ink-secondary" />
          {isBotChat ? t("sidebar.room.renameChat") : t("sidebar.room.renameChannel")}
        </button>
      ))}
      {!remoteClient && !isBotChat && (
        <button
          role="menuitem"
          onClick={() => {
            onClose();
            onMoveToSection(group.id);
          }}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
        >
          <FolderPlus size={16} className="text-ink-secondary" />
          {t("sidebar.section.moveToContext")}
        </button>
      )}
      <button
        role="menuitem"
        onClick={() => {
          void navigator.clipboard?.writeText(group.threadId);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <ClipboardCopy size={16} className="text-ink-secondary" />
        {t("sidebar.copyConversationId")}
      </button>
      {!remoteClient && <button
        role="menuitem"
        onClick={() => {
          dispatch({ type: "deleteGroup", groupId: group.id });
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/70"
      >
        <Trash2 size={16} />
        {isBotChat ? t("sidebar.room.deleteChat") : t("sidebar.room.deleteChannel")}
      </button>}
    </div>,
    document.body,
  );
}

