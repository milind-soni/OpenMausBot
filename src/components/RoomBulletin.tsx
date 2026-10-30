import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Pin } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useStore, type Group } from "@/state/store";

export function useBulletinEditor(group: Group) {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(group.bulletin);
  const settled = useRef(false);
  useEffect(() => setDraft(group.bulletin), [group.id, group.bulletin]);
  const start = () => {
    settled.current = false;
    setOpen(true);
  };
  // A blur that follows ⌘↩, Done or Escape finds the edit settled, so it neither saves twice nor saves a dropped draft.
  const save = () => {
    if (settled.current) return;
    settled.current = true;
    setOpen(false);
    if (draft !== group.bulletin) {
      dispatch({ type: "patchGroup", groupId: group.id, patch: { bulletin: draft } });
    }
  };
  const cancel = () => {
    settled.current = true;
    setDraft(group.bulletin);
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save();
    if (event.key === "Escape") cancel();
  };
  return { open, draft, setDraft, start, save, cancel, onKeyDown };
}

export function RoomBulletin({ group, remoteClient }: { group: Group; remoteClient: boolean }) {
  const bulletin = useBulletinEditor(group);
  return (
    <div className="w-full px-5">
      {bulletin.open ? (
        <div className="mb-1 rounded-lg border border-hairline/40 bg-panel p-2">
          <textarea
            autoFocus
            dir="auto"
            value={bulletin.draft}
            onChange={(e) => bulletin.setDraft(e.target.value)}
            onBlur={bulletin.save}
            onKeyDown={bulletin.onKeyDown}
            aria-label={t("room.bulletin.label")}
            placeholder={t("room.bulletin.placeholder")}
            rows={4}
            className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>
      ) : (
        <button
          disabled={remoteClient}
          onClick={() => { if (!remoteClient) bulletin.start(); }}
          className={cn("mb-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left", !remoteClient && "hover:bg-raised/40")}
          title={t("room.bulletin.title")}
        >
          <Pin size={12} className="shrink-0 text-ink-secondary" />
          <span dir="auto" className={cn("truncate text-[13px]", group.bulletin ? "text-ink-secondary" : "text-ink-tertiary")}>
            {group.bulletin.split("\n")[0] || (remoteClient ? t("room.bulletin.none") : t("room.bulletin.add"))}
          </span>
        </button>
      )}
    </div>
  );
}
