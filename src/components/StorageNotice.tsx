import { useEffect } from "react";
import { HardDrive } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { readRoomCardHidden } from "@/lib/room-card";
import { settleSeen, storageBand, storageFullness, storageNotice, storageScope } from "@/lib/storage-report";
import { markStorageNoticeShown, rememberStorageSeen, storageNoticeShownThisLaunch, useStorageReport, useStorageSeen } from "@/lib/use-storage-report";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStoreDispatch } from "@/state/store-select";
import { useCloudRoom } from "./CloudRoomCard";

/** The sidebar reads the report a little after launch, then this often: the report itself changes every few hours. */
const FIRST_READ_MS = 5_000;
const READ_EVERY_MS = 30 * 60_000;

/** One quiet line where the sidebar's foot already says how this place is doing: never a card, a pop-up or a sound. Amber at
 * both lines (90% and over in medium weight): the avatar's red dot sits right under it, and two reds would stack. Settings →
 * Storage keeps red for 90% and over. */
export function StorageNoticeLine({ band, percent, onOpen, className }: { band: "near" | "full"; percent: number; onOpen: () => void; className?: string }) {
  const words = t("storageNotice.line", { percent: String(percent) });
  return (
    <div role="status" data-storage-notice={band} className={cn("flex min-w-0", className)}>
      <button type="button" onClick={onOpen} title={t("storageNotice.open")}
        className={cn("flex min-w-0 items-center gap-1.5 rounded-md text-start text-[12px] leading-4 focus-visible:outline-2 focus-visible:outline-focus",
          "text-warning hover:underline", band === "full" && "font-medium")}>
        <HardDrive size={13} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{words}</span>
      </button>
    </div>
  );
}

/** The Admin's own disk card (with its Upgrade) says the same thing: while it is up, this line keeps out of its way. */
function useRoomCardOnDisk(): boolean {
  const { snapshot } = useCloudRoom();
  const room = snapshot?.status === "paid" ? snapshot.room : null;
  return Boolean(room && room.cause.kind === "disk" && readRoomCardHidden() !== room.id);
}

function Shown({ scope, band, percent, className }: { scope: string; band: "near" | "full"; percent: number; className?: string }) {
  const dispatch = useStoreDispatch();
  const yielded = useRoomCardOnDisk();
  useEffect(() => { if (!yielded) markStorageNoticeShown(scope, band); }, [yielded, scope, band]);
  if (yielded) return null;
  return <StorageNoticeLine band={band} percent={percent} className={className} onOpen={() => dispatch({ type: "toggleAppSettings", open: true, section: "storage" })} />;
}

/** At 80% and again at 90% full, once per crossing: shown for one launch (or until Settings → Storage is opened), and back only
 * after usage falls well under the line and crosses it again. Only an owner or admin, never a paired client, reads the report. */
export function StorageNotice({ className }: { className?: string }) {
  const admin = useOwnerOrAdmin() === true;
  const client = typeof window !== "undefined" && window.ogb?.remoteClient?.active === true;
  const read = useStorageReport({ enabled: admin && !client, delayMs: FIRST_READ_MS, everyMs: READ_EVERY_MS, background: true });
  const answer = read.status === "ready" ? read.answer : null;
  const scope = answer ? storageScope(answer) : null;
  const seen = useStorageSeen(scope);
  const percent = answer ? storageFullness(answer)?.percent ?? null : null;
  useEffect(() => {
    if (percent === null || scope === null) return;
    const settled = settleSeen(seen, percent);
    if (settled !== seen) rememberStorageSeen(scope, settled);
  }, [percent, seen, scope]);
  const fresh = storageNotice(percent, seen);
  const kept = scope === null ? null : storageNoticeShownThisLaunch(scope);
  const band = fresh ?? (percent !== null && kept !== null && kept !== "ok" && storageBand(percent) === kept ? kept : null);
  if (!band || percent === null || scope === null) return null;
  return <Shown scope={scope} band={band} percent={percent} className={className} />;
}
