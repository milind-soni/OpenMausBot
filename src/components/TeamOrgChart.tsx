// The Team map's "Who reports to whom" on a Team Cloud: people across the top, each with their Chief of Staff and the
// bots that report to them by department. Dragging a bot onto a person, or its Reports to… button, changes its owner:
// the same `reportsTo` the sidebar's face edits.
import { useMemo, useState, useSyncExternalStore, type DragEvent } from "react";
import { Crown, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { buildOrgChart, type OrgColumn } from "@/lib/team-org-chart";
import { api, useStore, type Action, type Bot } from "@/state/store";
import { mayChangeOwner, ownerChanged, ownerOf, useTeamPeople, type TeamPeople } from "@/state/team-people";
import { BotAvatar } from "./Avatar";
import { PersonFace, requestOwnerPick } from "./TeamOwner";

export type MapMode = "departments" | "people";
const BOT_DRAG_TYPE = "application/x-openmausbot-org-bot";

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

function BotRow({ bot, team, onDragStart }: { bot: Bot; team: TeamPeople; onDragStart: (event: DragEvent, bot: Bot) => void }) {
  const movable = mayChangeOwner(bot, team);
  return (
    <div data-org-bot={bot.id} draggable={movable || undefined} onDragStart={movable ? (event) => onDragStart(event, bot) : undefined}
      className={cn("group flex items-center gap-2 rounded-lg border border-hairline/40 bg-card px-2 py-1.5", movable && "cursor-grab active:cursor-grabbing")}>
      <BotAvatar bot={bot} size={24} motion="none" motionKey={0} animated={false} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{bot.name}</span>
      {bot.chiefOfStaff && <Crown size={12} className="shrink-0 text-accent" aria-label={t("orgChart.chief")} />}
      {movable && <button type="button" aria-label={t("owner.change", { bot: bot.name })} title={t("owner.change", { bot: bot.name })}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          requestOwnerPick({ botIds: [bot.id], title: t("owner.pickTitle"), current: ownerOf(bot, team)?.email ?? null, x: rect.left, y: rect.bottom + 4 });
        }}
        className="flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 touch:opacity-100"><UserRound size={13} /></button>}
    </div>
  );
}

function Column({ column, team, over, onOver, onDrop, onDragStart }: {
  column: OrgColumn<Bot>; team: TeamPeople; over: boolean;
  onOver: (email: string | null) => void; onDrop: (email: string, event: DragEvent) => void; onDragStart: (event: DragEvent, bot: Bot) => void;
}) {
  const person = column.person;
  const empty = !column.chief && column.departments.length === 0;
  return (
    <section data-org-person={person?.email ?? ""} aria-label={person ? person.name : t("orgChart.noOwner")}
      onDragOver={person ? (event) => { if (event.dataTransfer.types.includes(BOT_DRAG_TYPE)) { event.preventDefault(); onOver(person.email); } } : undefined}
      onDragLeave={person ? () => onOver(null) : undefined}
      onDrop={person ? (event) => onDrop(person.email, event) : undefined}
      className={cn("flex w-[248px] shrink-0 flex-col gap-3 rounded-2xl border p-3 transition-colors", over ? "border-accent bg-accent/5" : "border-hairline/40 bg-panel")}>
      <header className="flex items-center gap-2.5">
        {person ? <PersonFace person={person} size={30} /> : <span aria-hidden="true" className="inline-flex size-[30px] items-center justify-center rounded-full border border-dashed border-ink-secondary/60 text-ink-secondary">?</span>}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold text-ink">{person ? (person.you ? t("owner.you", { name: person.name }) : person.name) : t("orgChart.noOwner")}</span>
          <span className="block truncate text-[11.5px] text-ink-secondary">{person ? person.email : t("orgChart.noOwnerHint")}</span>
        </span>
      </header>
      {person && (column.chief
        ? <div className="flex flex-col gap-1"><span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">{t("orgChart.chief")}</span>
            <BotRow bot={column.chief} team={team} onDragStart={onDragStart} /></div>
        : <span className="text-[12px] text-ink-tertiary">{t("orgChart.noChief")}</span>)}
      {column.departments.map((department) => (
        <div key={department.key} data-org-department={department.key} className="flex flex-col gap-1">
          <span className="truncate text-[10.5px] font-medium uppercase tracking-[0.08em] text-ink-tertiary">{department.key || t("teamSettings.general")}</span>
          {department.bots.map((bot) => <BotRow key={bot.id} bot={bot} team={team} onDragStart={onDragStart} />)}
        </div>
      ))}
      {person && empty && <span className="text-[12px] text-ink-secondary">{t("orgChart.empty", { name: person.name })}</span>}
    </section>
  );
}

export function TeamOrgChart({ bots }: { bots: Bot[] }) {
  const team = useTeamPeople();
  const { dispatch } = useStore();
  const [over, setOver] = useState<string | null>(null);
  const columns = useMemo(() => (team ? buildOrgChart(bots, team.people) : []), [bots, team]);
  if (!team) return null;
  const onDragStart = (event: DragEvent, bot: Bot) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(BOT_DRAG_TYPE, bot.id);
  };
  const onDrop = (email: string, event: DragEvent) => {
    event.preventDefault();
    setOver(null);
    const botId = event.dataTransfer.getData(BOT_DRAG_TYPE);
    const bot = bots.find((candidate) => candidate.id === botId);
    if (!bot || ownerOf(bot, team)?.email === email) return;
    void api<{ bot?: Bot }>(`/api/bots/${bot.id}/reports-to`, { method: "PUT", body: JSON.stringify({ email }) })
      .then((answer) => { if (answer?.bot) dispatch({ type: "botPatched", bot: answer.bot }); ownerChanged(); })
      .catch((error: unknown) => dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) }));
  };
  return (
    <div role="region" aria-label={t("orgChart.mode.people")} data-org-chart className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-6">
      <p className="text-[12px] text-ink-secondary">{t("orgChart.dropHint")}</p>
      <div className="flex items-start gap-4">
        {columns.map((column) => <Column key={column.person?.email ?? "nobody"} column={column} team={team} over={over !== null && over === column.person?.email}
          onOver={setOver} onDrop={onDrop} onDragStart={onDragStart} />)}
      </div>
    </div>
  );
}
