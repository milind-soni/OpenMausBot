import { useId } from "react";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";

/** A destination is just an existing conversation, not another execution mode. */
export function ResultsDestination({ bot, value, allowCurrent = false, onChange }: {
  bot?: Bot;
  value: string | null | undefined;
  allowCurrent?: boolean;
  onChange: (threadId: string | null | undefined) => void;
}) {
  const id = useId();
  const tasks = (bot?.tasks ?? []).filter((task) => !task.routineRunId);
  const selectedMissing = typeof value === "string" && !tasks.some((task) => task.threadId === value);
  const groups = [...(bot?.projects ?? []), { id: "", name: t("folder.none") }];
  return <div className="min-w-0 space-y-1.5">
    <label htmlFor={id} className="block text-[12px] font-medium text-ink">{t("routines.results.label")}</label>
    <select id={id} aria-describedby={`${id}-help`} disabled={!bot} value={value ?? (value === null ? "new" : "current")}
      onChange={(event) => onChange(event.target.value === "new" ? null : event.target.value === "current" ? undefined : event.target.value)}
      className="w-full min-w-0 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12.5px] text-ink outline-none focus:border-accent disabled:opacity-50">
      {allowCurrent && <option value="current">{t("routines.results.keep")}</option>}
      <option value="new">{t("routines.results.new")}</option>
      {selectedMissing && <option value={value!} disabled>{t("routines.results.unavailable")}</option>}
      {groups.map((group) => {
        const members = tasks.filter((task) => group.id ? task.projectId === group.id : !bot?.projects?.some((project) => project.id === task.projectId));
        return members.length ? <optgroup key={group.id} label={group.name}>
          {members.map((task) => <option key={task.threadId} value={task.threadId}>{task.title}</option>)}
        </optgroup> : null;
      })}
    </select>
    <p id={`${id}-help`} className="text-[11px] leading-relaxed text-ink-secondary">{t("routines.results.help")}</p>
  </div>;
}
