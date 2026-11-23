import { useEffect } from "react";
import { HardDrive } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { readRoomCardHidden } from "@/lib/room-card";
import { settleSeen, storageFullness, storageNotice } from "@/lib/storage-report";
import { rememberStorageSeen, useStorageReport, useStorageSeen } from "@/lib/use-storage-report";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStoreDispatch } from "@/state/store-select";
import { useCloudRoom } from "./CloudRoomCard";

/** The sidebar reads the report a little after launch, then this often: the report itself changes every few hours. */
const FIRST_READ_MS = 5_000;
const READ_EVERY_MS = 30 * 60_000;

/** One quiet line where the sidebar's foot already says how this place is doing: never a card, a pop-up or a sound. */
export function StorageNoticeLine({ band, percent, onOpen, className }: { band: "near" | "full"; percent: number; onOpen: () => void; className?: string }) {
  const words = t("storageNotice.line", { percent: String(percent) });
  return (
    <div role="status" data-storage-notice={band} className={cn("flex min-w-0", className)}>
      <button type="button" onClick={onOpen} title={t("storageNotice.open")}
        className={cn("flex min-w-0 items-center gap-1.5 rounded-md text-start text-[12px] leading-4 focus-visible:outline-2 focus-visible:outline-focus",
          band === "full" ? "font-medium text-danger hover:underline" : "text-warning hover:underline")}>
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

function Shown({ band, percent, className }: { band: "near" | "full"; percent: number; className?: string }) {
  const dispatch = useStoreDispatch();
  if (useRoomCardOnDisk()) return null;
  return <StorageNoticeLine band={band} percent={percent} className={className} onOpen={() => dispatch({ type: "toggleAppSettings", open: true, section: "storage" })} />;
}

/** At 80% and again at 90% full, once per crossing: opening Settings → Storage is seeing it, and it comes back only after usage
 * falls well under the line and crosses it again. Only an owner or admin, never a paired client, reads the report. */
export function StorageNotice({ className }: { className?: string }) {
  const admin = useOwnerOrAdmin() === true;
  const client = typeof window !== "undefined" && window.ogb?.remoteClient?.active === true;
  const read = useStorageReport({ enabled: admin && !client, delayMs: FIRST_READ_MS, everyMs: READ_EVERY_MS, background: true });
  const [seen] = useStorageSeen();
  const percent = read.status === "ready" ? storageFullness(read.answer)?.percent ?? null : null;
  useEffect(() => {
    if (percent === null) return;
    const settled = settleSeen(seen, percent);
    if (settled !== seen) rememberStorageSeen(settled);
  }, [percent, seen]);
  const band = storageNotice(percent, seen);
  if (!band || percent === null) return null;
  return <Shown band={band} percent={percent} className={className} />;
}
