import type { InboxRow } from "../../../shared/inbox";
import type { InboxGroup } from "../../../shared/inbox-reason";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { InboxRowItem } from "./InboxRow";
import type { QuickAction } from "./inbox-view";

const GROUP_TITLE: Record<InboxGroup, LocaleKey> = { "for-you": "inbox.group.forYou", activity: "inbox.group.activity" };

/** The inbox's lines in two groups: For you (what waits on the person or names them), then Activity. For you shows calm
 * when it is empty and nothing else is for the person; Activity only when there is some. */
export function InboxGroups({ groups, now, current, onOpen, onAction, moreForYou = false }: {
  groups: Record<InboxGroup, InboxRow[]>;
  now: number;
  current: string | null;
  onOpen(row: InboxRow): void;
  onAction(row: InboxRow, action: QuickAction): void;
  /** Something for the person is listed further down (a fix on a team), so For you is not "all caught up". */
  moreForYou?: boolean;
}) {
  return (
    <>
      {(["for-you", "activity"] as const).map((group) => {
        const rows = groups[group];
        if (!rows.length && (group === "activity" || moreForYou)) return null;
        const heading = `inbox-group-${group}`;
        return (
          <section key={group} data-inbox-group={group} aria-labelledby={heading} className="pb-1">
            <h3 id={heading} className="px-2.5 pb-1 pt-2 text-[12px] font-medium text-ink-tertiary">{t(GROUP_TITLE[group])}</h3>
            {rows.length ? (
              <div role="list" aria-labelledby={heading} className="space-y-0.5">
                {rows.map((row) => <InboxRowItem key={row.id} row={row} now={now} current={row.id === current} onOpen={onOpen} onAction={onAction} />)}
              </div>
            ) : <p data-inbox-caught-up className="px-2.5 pb-2 text-[13px] text-ink-tertiary">{t("inbox.forYou.empty")}</p>}
          </section>
        );
      })}
    </>
  );
}
