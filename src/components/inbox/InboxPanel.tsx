// On a Team Cloud: the person's whole inbox in the right panel as one list, newest first, a dot on what waits on them,
// each line a dense row that reads in full in the panel. At phone width it is a sheet over the chat.
import { useEffect, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { InboxRow } from "../../../shared/inbox";
import { t } from "@/lib/i18n";
import { PHONE_LAYOUT, useMediaQuery } from "@/lib/use-media-query";
import { closeInbox, readInboxLine, readInboxRow, useInboxPanel, useInboxView } from "@/state/inbox";
import { InboxReading } from "./InboxReading";
import { InboxRowItem } from "./InboxRow";
import { listedRows } from "./inbox-view";
import { useInboxActions } from "./use-inbox-actions";

export function InboxPanel() {
  const view = useInboxView();
  const panel = useInboxPanel();
  const phone = useMediaQuery(PHONE_LAYOUT);
  const { run } = useInboxActions(view);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    if (panel.reading) readInboxLine(null);
    else closeInbox();
  };
  const reading = panel.reading ? view?.rows.find((row) => row.id === panel.reading) : undefined;
  const open = (row: InboxRow) => { readInboxRow(row); readInboxLine(row.id); };
  const rows = listedRows(view);
  const body = (
    <>
      <div className="flex items-center gap-1.5 border-b border-hairline/40 px-3.5 py-2.5">
        <h2 className="flex-1 text-[14px] font-semibold text-ink">{t("inbox.panel.title")}</h2>
        <button type="button" onClick={closeInbox} aria-label={t("common.close")} title={t("common.close")}
          className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink">
          <X size={14} />
        </button>
      </div>
      {reading && view ? <InboxReading view={view} row={reading} now={now} /> : (
        <div role="list" data-inbox-list aria-label={t("inbox.panel.title")} className="min-h-0 flex-1 overflow-y-auto">
          {rows.length === 0
            ? <p className="px-4 py-8 text-center text-[13px] text-ink-secondary">{t("inbox.empty")}</p>
            : rows.map((row) => <InboxRowItem key={row.id} row={row} now={now} onOpen={open} onAction={run} />)}
        </div>
      )}
    </>
  );
  if (phone) {
    return createPortal(
      <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40" onMouseDown={(event) => { if (event.target === event.currentTarget) closeInbox(); }}>
        <section role="dialog" aria-modal="true" aria-label={t("inbox.panel.title")} data-inbox-panel="sheet" onKeyDown={onKeyDown}
          className="animate-pop-in motion-reduce:animate-none flex max-h-[85dvh] min-h-[50dvh] flex-col overflow-hidden rounded-t-2xl border-t border-hairline/50 bg-panel pb-[env(safe-area-inset-bottom)]">
          {body}
        </section>
      </div>,
      document.body,
    );
  }
  return (
    <aside aria-label={t("inbox.panel.title")} data-inbox-panel="side" onKeyDown={onKeyDown}
      className="animate-panel-in motion-reduce:animate-none flex h-full w-[380px] max-w-full shrink-0 flex-col border-l border-hairline/40 bg-panel max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-30">
      {body}
    </aside>
  );
}
