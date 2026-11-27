import { useEffect, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { jevRoomRoutingOn } from "@/lib/group-routing";
import { useStore } from "@/state/store";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { t } from "@/lib/i18n";
import { newRoomName, newRoomResponder } from "../../shared/new-room";
import { BotPickerList } from "./BotPickerList";

/** Sidebar → New group chat: pick the bots and start chatting. */
export function NewRoomPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const dialogRef = useRef<HTMLDivElement>(null);
  const bots = state.bots.filter((b) => !b.hidden);
  useModalDialog(dialogRef, onClose);
  useEffect(() => dialogRef.current?.querySelector<HTMLButtonElement>("button[role=checkbox]")?.focus(), []);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const create = () => {
    const members = [...picked].flatMap((id) => bots.filter((bot) => bot.id === id));
    if (!members.length) return;
    const memberIds = members.map((bot) => bot.id);
    const sections = new Set(members.map((bot) => bot.section?.trim() ?? ""));
    const section = sections.size === 1 ? [...sections][0] || undefined : undefined;
    dispatch({
      type: "createGroup",
      memberIds,
      name: newRoomName(members.map((bot) => bot.name), state.groups.map((group) => group.name)),
      section,
      setup: { bulletin: "", defaultResponder: newRoomResponder(memberIds, jevRoomRoutingOn(state.config)) },
    });
    track("room_created", { members: memberIds.length, context: Boolean(section) });
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="new-room-title"
        className="w-[340px] max-w-full rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl outline-none">
        <div id="new-room-title" className="mb-3 text-[15px] font-semibold text-ink">{t("sidebar.newChannel.title")}</div>
        <BotPickerList
          bots={bots}
          picked={picked}
          onToggle={toggle}
          emptyHint={t("sidebar.newChannel.emptyHint")}
        />
        <button
          onClick={create}
          disabled={!picked.size}
          className="mt-3 w-full rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          {picked.size === 0
            ? t("sidebar.newChannel.create")
            : picked.size === 1
              ? t("sidebar.newChannel.createOne")
              : t("sidebar.newChannel.createMany", { count: picked.size })}
        </button>
      </div>
    </div>
  );
}
