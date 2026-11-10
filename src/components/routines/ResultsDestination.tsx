import { useId } from "react";
import { RESULTS_JUST_ME } from "../../../shared/routines";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { useTeamPeople } from "@/state/team-people";
import { Select } from "../Select";

export function ResultsDestination({ bot, value, allowCurrent = false, team, onChange }: {
  bot?: Bot;
  value: string | null | undefined;
  allowCurrent?: boolean;
  /** A Team Cloud, where the routine reports to the person alone or to the bot's shared chat; read from the app when unset. */
  team?: boolean;
  onChange: (threadId: string | null | undefined) => void;
}) {
  const id = useId(), people = useTeamPeople();
  if (team ?? people !== null) return <TeamResultsDestination id={id} bot={bot} value={value} allowCurrent={allowCurrent} onChange={onChange} />;
  const tasks = (bot?.tasks ?? []).filter((task) => !task.routineRunId);
  const selectedMissing = typeof value === "string" && !tasks.some((task) => task.threadId === value);
  const groups = [...(bot?.projects ?? []), { id: "", name: t("folder.none") }];
  return <div className="min-w-0 space-y-1.5">
    <label htmlFor={id} className="block text-[12px] font-medium text-ink">{t("routines.results.label")}</label>
    <Select className="w-full" id={id} aria-describedby={`${id}-help`} disabled={!bot} value={value ?? (value === null ? "new" : "current")}
      onChange={(event) => onChange(event.target.value === "new" ? null : event.target.value === "current" ? undefined : event.target.value)}>
      {allowCurrent && <option value="current">{t("routines.results.keep")}</option>}
      <option value="new">{t("routines.results.main")}</option>
      {selectedMissing && <option value={value!} disabled>{t("routines.results.unavailable")}</option>}
      {groups.map((group) => {
        const members = tasks.filter((task) => group.id ? task.projectId === group.id : !bot?.projects?.some((project) => project.id === task.projectId));
        return members.length ? <optgroup key={group.id} label={group.name}>
          {members.map((task) => <option key={task.threadId} value={task.threadId}>{task.title}</option>)}
        </optgroup> : null;
      })}
    </Select>
    <p id={`${id}-help`} className="text-[11px] leading-relaxed text-ink-secondary">{t("routines.results.mainHelp")}</p>
  </div>;
}

function TeamResultsDestination({ id, bot, value, allowCurrent, onChange }: {
  id: string; bot?: Bot; value: string | null | undefined; allowCurrent: boolean; onChange: (threadId: string | null | undefined) => void;
}) {
  const ownChat = typeof value === "string" && Boolean(bot?.tasks?.some((task) => task.threadId === value && task.private === true));
  const selected = value === undefined && allowCurrent ? "current" : value === RESULTS_JUST_ME || ownChat ? "me" : "shared";
  return <div className="min-w-0 space-y-1.5">
    <label htmlFor={id} className="block text-[12px] font-medium text-ink">{t("routines.results.label")}</label>
    <Select className="w-full" id={id} aria-describedby={`${id}-help`} disabled={!bot} value={selected}
      onChange={(event) => onChange(event.target.value === "current" ? undefined : event.target.value === "me" ? (ownChat ? value : RESULTS_JUST_ME) : bot?.mainThreadId ?? null)}>
      {selected === "current" && <option value="current">{t("routines.results.keep")}</option>}
      <option value="me">{t("routines.results.justMe")}</option>
      <option value="shared">{t("task.sharedChat")}</option>
    </Select>
    <p id={`${id}-help`} className="text-[11px] leading-relaxed text-ink-secondary">{t("routines.results.teamHelp")}</p>
  </div>;
}
