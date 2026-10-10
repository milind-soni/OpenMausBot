import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

const ACTIONS: Record<string, LocaleKey> = {
  list_files: "lending.action.listFiles",
  read_file: "lending.action.readFile",
  write_file: "lending.action.writeFile",
  run_command: "lending.action.runCommand",
  computer_tools: "lending.action.screenTools",
  computer_call: "lending.action.screen",
  invalid: "lending.action.invalid",
};

/** This computer's own record of what a server's bots did here (Electron
 * main keeps it; a server cannot write to it). Newest first. */
export function LendingActivityList({ entries }: { entries: DesktopLendingActivity[] | null }) {
  return <div className="flex flex-col gap-2">
    <p className="font-medium text-ink">{t("lending.activity.title")}</p>
    {entries && entries.length === 0 && <p className="text-[12px] text-ink-secondary">{t("lending.activity.empty")}</p>}
    {entries && entries.length > 0 && <ul aria-label={t("lending.activity.title")} className="flex max-h-56 flex-col gap-1 overflow-y-auto text-[12px]">
      {entries.map((entry, index) => <li key={`${entry.at}-${index}`} className="flex flex-wrap gap-x-2 text-ink-secondary">
        <time dateTime={new Date(entry.at).toISOString()} className="shrink-0 tabular-nums">{new Date(entry.at).toLocaleString()}</time>
        <span className={entry.ok ? "text-ink" : "text-danger"}>{t(ACTIONS[entry.action] ?? "lending.action.other")}{entry.ok ? "" : ` · ${t("lending.activity.refused")}`}</span>
        {entry.detail && <span dir="auto" className="min-w-0 break-all">{entry.detail}</span>}
      </li>)}
    </ul>}
  </div>;
}
