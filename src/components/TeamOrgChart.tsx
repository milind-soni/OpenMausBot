// The Team map's "Who reports to whom" on a Team Cloud: people across the top, each with their Chief of Staff and the
// bots that report to them by department. A bot's Reports to… button changes its owner: the same `reportsTo` the
// sidebar's face edits.
import { useMemo, useSyncExternalStore } from "react";
import { Crown, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { buildOrgChart, type OrgColumn } from "@/lib/team-org-chart";
import { type Action, type Bot } from "@/state/store";
import { mayChangeOwner, ownerOf, useTeamPeople, type TeamPeople } from "@/state/team-people";
import { BotAvatar } from "./Avatar";
import { PersonFace, requestOwnerPick } from "./TeamOwner";

export type MapMode = "departments" | "people";

let mode: MapMode = "departments";
const listeners = new Set<() => void>();
export function setMapMode(next: MapMode): void {
  mode = next;
  for (const listener of listeners) listener();
}
export function useMapMode(): MapMode {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); }, () => mode, () => mode);
}
/** The department menu's "See who reports to whom": the Team map, in this view. */
export function showWhoReportsToWhom(dispatch: (action: Action) => void): void {
  setMapMode("people");
  dispatch({ type: "showTeamMap" });
}

export function MapModeToggle() {
  const current = useMapMode();
  const option = (value: MapMode, label: string) => (
    <button type="button" aria-pressed={current === value} onClick={() => setMapMode(value)}
      className={cn("rounded-md px-2.5 py-1 text-[12px] font-medium", current === value ? "bg-panel text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}>{label}</button>
  );
  return <div role="group" aria-label={t("canvas.title")} className="flex items-center gap-0.5 rounded-lg bg-control p-0.5">
    {option("departments", t("orgChart.mode.departments"))}{option("people", t("orgChart.mode.people"))}
  </div>;
}

function BotRow({ bot, team }: { bot: Bot; team: TeamPeople }) {
  const movable = mayChangeOwner(bot, team);
  return (
    <div data-org-bot={bot.id} className="group flex items-center gap-2 rounded-lg border border-hairline/40 bg-card px-2 py-1.5">
      <BotAvatar bot={bot} size={24} motion="none" motionKey={0} animated={false} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{bot.name}</span>
      {bot.chiefOfStaff && <Crown size={12} className="shrink-0 text-accent" aria-label={t("orgChart.chief")} />}
      {movable && <button type="button" aria-label={t("owner.change", { bot: bot.name })} title={t("owner.change", { bot: bot.name })}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          requestOwnerPick({ botId: bot.id, current: ownerOf(bot, team)?.email ?? null, x: rect.left, y: rect.bottom + 4 });
        }}
        className="flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100"><UserRound size={13} /></button>}
    </div>
  );
}

function Column({ column, team }: { column: OrgColumn<Bot>; team: TeamPeople }) {
  const person = column.person;
  const empty = !column.chief && column.departments.length === 0;
  return (
    <section data-org-person={person?.email ?? ""} aria-label={person ? person.name : t("orgChart.noOwner")}
      className="flex w-[248px] shrink-0 flex-col gap-3 rounded-2xl border border-hairline/40 bg-panel p-3">
      <header className="flex items-center gap-2.5">
        {person ? <PersonFace person={person} size={30} /> : <span aria-hidden="true" className="inline-flex size-[30px] items-center justify-center rounded-full border border-dashed border-ink-secondary/60 text-ink-secondary">?</span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold text-ink">{person ? (person.you ? t("owner.you", { name: person.name }) : person.name) : t("orgChart.noOwner")}</span>
          <span className="block truncate text-[12px] text-ink-secondary">{person ? person.email : t("orgChart.noOwnerHint")}</span>
        </span>
      </header>
      {person && (column.chief
        ? <div className="flex flex-col gap-1"><span className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">{t("orgChart.chief")}</span>
            <BotRow bot={column.chief} team={team} /></div>
        : <span className="text-[12px] text-ink-tertiary">{t("orgChart.noChief")}</span>)}
      {column.departments.map((department) => (
        <div key={department.key} data-org-department={department.key} className="flex flex-col gap-1">
          <span className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">{department.key || t("teamSettings.general")}</span>
          {department.bots.map((bot) => <BotRow key={bot.id} bot={bot} team={team} />)}
        </div>
      ))}
      {person && empty && <span className="text-[12px] text-ink-secondary">{t("orgChart.empty", { name: person.name })}</span>}
    </section>
  );
}

export function TeamOrgChart({ bots }: { bots: Bot[] }) {
  const team = useTeamPeople();
  const columns = useMemo(() => (team ? buildOrgChart(bots, team.people) : []), [bots, team]);
  if (!team) return null;
  return (
    <div role="region" aria-label={t("orgChart.mode.people")} data-org-chart className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-6">
      <div className="flex items-start gap-4">
        {columns.map((column) => <Column key={column.person?.email ?? "nobody"} column={column} team={team} />)}
      </div>
    </div>
  );
}
