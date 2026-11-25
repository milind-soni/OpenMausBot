import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { Select } from "../Select";
import type { ThreadFilter, ThreadOwner, ThreadStatus } from "./thread-filter";

const STATUSES: ReadonlyArray<{ status: ThreadStatus; label: LocaleKey }> = [
  { status: "working", label: "inbox.filter.working" },
  { status: "waiting", label: "inbox.filter.waiting" },
  { status: "finished", label: "inbox.filter.finished" },
];

/** Two pickers above the Inbox's conversation lists: whose conversations, and in what state. */
export function ThreadFilterBar({ owners, filter, onChange }: {
  owners: readonly ThreadOwner[]; filter: ThreadFilter; onChange(filter: ThreadFilter): void;
}) {
  return (
    <div data-inbox-thread-filter className="flex items-center gap-2 border-t border-hairline/40 px-[13px] py-2">
      <Select variant="quiet" size="sm" className="min-w-0 flex-1" data-inbox-filter-owner aria-label={t("inbox.filter.owner")}
        value={filter.owner?.key ?? ""} onChange={(event) => onChange({ ...filter, owner: owners.find((owner) => owner.key === event.target.value) })}>
        <option value="">{t("inbox.filter.allOwners")}</option>
        {owners.map((owner) => <option key={owner.key} value={owner.key}>{owner.name}</option>)}
      </Select>
      <Select variant="quiet" size="sm" className="min-w-0 flex-1" data-inbox-filter-status aria-label={t("inbox.filter.status")}
        value={filter.status ?? ""} onChange={(event) => onChange({ ...filter, status: STATUSES.find((one) => one.status === event.target.value)?.status })}>
        <option value="">{t("inbox.filter.allStatus")}</option>
        {STATUSES.map((one) => <option key={one.status} value={one.status}>{t(one.label)}</option>)}
      </Select>
    </div>
  );
}
