import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Zap } from "lucide-react";

import { automationsFrom, automationSentence, automationStatus, orderAutomations, runLine, statusLine, type Automation } from "@/lib/automations";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { isRoutineProblemRun } from "@/lib/routines";
import { saveWebhookCredential, webhookCredentialStore } from "@/lib/webhook-credentials";
import { botInDepartment, filterableDepartments, GENERAL_DEPARTMENT } from "@/lib/department-filter";
import { useStore } from "@/state/store";
import { useAppTriggers } from "@/lib/app-triggers";
import { AppEventEditor } from "./automations/AppEventEditor";
import { useAllAutomationActions } from "./automations/app-actions";
import { AutomationPanel } from "./automations/AutomationPanel";
import { AutomationsCalendar } from "./automations/AutomationsCalendar";
import { LimitWarnings } from "./automations/LimitWarnings";
import { NewAutomation, type SetUpKind } from "./automations/NewAutomation";
import { FixButton, StatusMark } from "./automations/parts";
import { RoutineEditor } from "./RoutineCalendarPage";
import { Select } from "./Select";
import { Switch } from "./SettingsPrimitives";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageActions, ToolPageHeader } from "./ToolPageShell";
import { WebhookEditor } from "./WebhookTrigger";
import { schedulableBots, useTeamPeople } from "@/state/team-people";

/** The bot filter earns its place only on a long list shared by several bots. */
const FILTER_FROM = 9;

/** Automations: every schedule and every "when another app sends something", each as one plain sentence. */
export function TriggersPage({ onBack, onOpenRoom }: { onBack: () => void; onOpenRoom: (id: string) => void }) {
  const { state, dispatch } = useStore();
  const actions = useAllAutomationActions();
  const appTriggers = useAppTriggers();
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const focus = state.routinesFocus;
  const view = focus?.view === "calendar" ? "calendar" : "list";
  const [openId, setOpenId] = useState<string | null>(focus?.section !== "logs" ? focus?.routineId ?? null : null);
  const [botFilter, setBotFilter] = useState(focus?.botId ?? "all");
  const [department, setDepartment] = useState("all");
  const [newText, setNewText] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ kind: SetUpKind; id?: string; botId?: string } | null>(null);
  const routinesOnly = window.ogb?.remoteClient?.active === true;
  const visibleBots = state.bots.filter((bot) => !bot.hidden);
  const team = useTeamPeople();
  const botName = (botId: string) => state.bots.find((bot) => bot.id === botId)?.name ?? t("routines.unavailableBot");

  useEffect(() => {
    setBotFilter(focus?.botId ?? "all");
    // "Open" from a chat card or a notice names the automation: open its panel.
    if (focus?.routineId && focus.section !== "logs") setOpenId(focus.routineId);
  }, [focus]);
  useEffect(() => { backButtonRef.current?.focus({ preventScroll: true }); }, []);

  const all = useMemo(() => automationsFrom({ routines: state.routines, webhooks: routinesOnly ? [] : state.webhooks, appTriggers: appTriggers.triggers, runs: state.routineRuns, bots: state.bots }),
    [state.routines, state.webhooks, appTriggers.triggers, state.routineRuns, state.bots, routinesOnly]);
  const departments = filterableDepartments(state.bots, [...new Set([...(state.sections ?? []), ...state.bots.flatMap((bot) => bot.section ? [bot.section] : [])])]);
  const showDepartments = departments.names.length + (departments.hasGeneral ? 1 : 0) > 1;
  const activeDepartment = department === "all" || (department === GENERAL_DEPARTMENT ? departments.hasGeneral : departments.names.includes(department)) ? department : "all";
  useEffect(() => {
    if (activeDepartment === department) return;
    setDepartment("all");
    setBotFilter("all");
  }, [activeDepartment, department]);
  const inDepartment = (botId: string) => botInDepartment(state.bots.find((bot) => bot.id === botId), activeDepartment);
  const departmentBots = visibleBots.filter((bot) => botInDepartment(bot, activeDepartment));
  const showFilter = all.length >= FILTER_FROM && new Set(all.map((automation) => automation.botId)).size > 1;
  const listed = orderAutomations(all.filter((automation) => inDepartment(automation.botId) && (!showFilter || botFilter === "all" || automation.botId === botFilter)));
  const open = all.find((automation) => automation.id === openId) ?? null;
  const sentenceOf = (automation: Automation) => automationSentence(automation, botName(automation.botId));

  const editRoutine = editing?.kind === "schedule" ? state.routines.find((routine) => routine.id === editing.id) : undefined;
  const editWebhook = editing?.kind === "webhook" ? state.webhooks.find((webhook) => webhook.id === editing.id) : undefined;
  const editApp = editing?.kind === "app" ? appTriggers.triggers.find((trigger) => trigger.id === editing.id) : undefined;

  return (
    <ToolPage>
      <ToolPageHeader backLabel={t("automations.back")} onBack={onBack} backRef={backButtonRef} besideSidebar={view === "list"}>
          <h1 data-tour="automations-page" className={TOOL_PAGE_TITLE}>{t("automations.title")}</h1>
          <ToolPageActions>
            {showDepartments && (
              <Select size="sm" aria-label={t("automations.allDepartments")} value={activeDepartment} onChange={(event) => { setDepartment(event.target.value); setBotFilter("all"); }} className="max-w-[180px]">
                <option value="all">{t("automations.allDepartments")}</option>
                {departments.names.map((name) => <option key={name} value={name}>{name}</option>)}
                {departments.hasGeneral && <option value={GENERAL_DEPARTMENT}>{t("automations.generalDepartment")}</option>}
              </Select>
            )}
            {showFilter && view === "list" && (
              <Select size="sm" aria-label={t("automations.allBots")} value={botFilter} onChange={(event) => setBotFilter(event.target.value)} className="max-w-[180px]">
                <option value="all">{t("automations.allBots")}</option>
                {departmentBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
              </Select>
            )}
            <div role="group" aria-label={t("automations.view")} className="flex items-center rounded-lg border border-hairline/50 bg-panel p-0.5">
              {(["list", "calendar"] as const).map((option) => (
                <button key={option} type="button" aria-pressed={view === option} onClick={() => dispatch({ type: "showRoutines", view: option, botId: botFilter === "all" ? undefined : botFilter })}
                  className={cn("rounded-md px-3 py-1 text-[13px] font-medium", view === option ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}>
                  {option === "list" ? t("automations.list") : t("automations.calendar")}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setNewText("")} className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-semibold text-accent-ink hover:brightness-110"><Plus size={15} aria-hidden="true" />{t("automations.new")}</button>
          </ToolPageActions>
      </ToolPageHeader>

      <div className="relative flex min-h-0 flex-1">
        {view === "calendar" ? <AutomationsCalendar botFilter={botFilter} department={activeDepartment} selectedAutomationId={openId} onOpenAutomation={setOpenId} onOpenRoom={onOpenRoom} /> : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
              <LimitWarnings botFilter={showFilter ? botFilter : "all"} />
              {all.length === 0 && state.routinesLoadState !== "loading" && state.hydrated ? (
                <section aria-label={t("automations.empty.title")} className="px-6 py-16 text-center">
                  <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Zap size={22} /></div>
                  <h2 className="text-[17px] font-semibold text-ink">{t("automations.empty.title")}</h2>
                  <button type="button" onClick={() => setNewText(t("automations.empty.example"))} className="mt-3 text-[14px] text-accent-text underline-offset-2 hover:underline">{t("automations.empty.try")}</button>
                  <div><button type="button" onClick={() => setNewText("")} className="mt-6 inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-[13px] font-medium text-accent-ink hover:brightness-110"><Plus size={15} />{t("automations.new")}</button></div>
                </section>
              ) : (
                <ul aria-label={t("automations.title")} className="divide-y divide-hairline/30 overflow-hidden rounded-2xl border border-hairline/40 bg-card">
                  {listed.map((automation) => {
                    const status = automationStatus(automation);
                    const name = automation.name.trim();
                    const unseenProblem = automation.runs.find((run) => isRoutineProblemRun(run) && !run.seenAt);
                    const problemLine = unseenProblem && runLine(unseenProblem);
                    return (
                      <li key={automation.id} data-automation={automation.id} data-automation-status={status.state} className={cn("flex items-start gap-3 px-4 py-3.5", openId === automation.id && "bg-raised/60")}>
                        <StatusMark status={status} className="mt-[5px]" />
                        <div className="min-w-0 flex-1">
                          <button type="button" onClick={() => setOpenId(automation.id)} className="block text-left text-[15px] font-medium leading-snug text-ink hover:text-accent-text">{name || sentenceOf(automation)}</button>
                          {name && <div className="mt-0.5 text-[13px] text-ink">{sentenceOf(automation)}</div>}
                          {status.state === "needs-you"
                            ? <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-warning">{t("automations.needsYou", { reason: status.reason ?? "" })}<FixButton automation={automation} status={status} actions={actions} onEdit={() => setEditing({ kind: automation.kind, id: automation.id })} /></div>
                            : <div className="mt-0.5 text-[13px] text-ink-secondary">{statusLine(automation)}</div>}
                          {problemLine && <button type="button" onClick={() => setOpenId(automation.id)} className="mt-1 flex items-baseline gap-2 text-left text-[13px] text-danger">
                            <span aria-hidden="true" className="size-2 shrink-0 self-center rounded-full bg-danger" />
                            <span>{problemLine.when} {problemLine.mark} {problemLine.text}</span>
                          </button>}
                          {actions.error && actions.errorFor?.endsWith(`:${automation.id}`) && <p role="alert" className="mt-1 text-[12px] text-danger">{actions.error}</p>}
                        </div>
                        {status.state !== "done" && <Switch checked={automation.enabled} disabled={actions.busy === `toggle:${automation.id}`} aria-label={t("automations.toggle", { name: automation.name })} onClick={() => void actions.toggle(automation)} className="mt-0.5 shrink-0" />}
                      </li>
                    );
                  })}
                </ul>
              )}
              {actions.error && !listed.some((automation) => actions.errorFor?.endsWith(`:${automation.id}`)) && <p role="alert" className="mt-3 text-[12px] text-danger">{actions.error}</p>}
              <RoutineWakeBar />
            </div>
          </div>
        )}
        {open && (
          <div className="absolute inset-y-0 right-0 z-30 flex shadow-2xl lg:static lg:shadow-none">
            <AutomationPanel key={open.id} automation={open} sentence={sentenceOf(open)} onClose={() => setOpenId(null)} onDeleted={() => setOpenId(null)} onEdit={() => setEditing({ kind: open.kind, id: open.id })} />
          </div>
        )}
      </div>

      {newText !== null && (
        <NewAutomation initialText={newText} onClose={() => setNewText(null)} onSetUpYourself={(kind, botId) => { setNewText(null); setEditing({ kind, botId }); }} />
      )}
      {editing?.kind === "schedule" && (editRoutine || !editing.id) && <RoutineEditor routine={editRoutine} bots={schedulableBots(visibleBots, team, editRoutine?.botId)} initialBotId={editing.botId} plain onClose={() => setEditing(null)} />}
      {editing?.kind === "webhook" && (editWebhook || !editing.id) && (
        <WebhookEditor webhook={editWebhook} bots={visibleBots} initialBotId={editing.botId} onClose={() => setEditing(null)} onCredential={(credential, id) => { saveWebhookCredential(webhookCredentialStore(), id, credential); setOpenId(id); }} />
      )}
      {editing?.kind === "app" && (editApp || !editing.id) && <AppEventEditor trigger={editApp} bots={visibleBots} initialBotId={editing.botId} onClose={() => setEditing(null)} onSaved={(trigger) => setOpenId(trigger.id)} />}
    </ToolPage>
  );
}

/** While a Mac sleeps no schedule runs: the shell can hold it awake the hour before one is due, plugged in only. */
function RoutineWakeBar() {
  const bridge = typeof window !== "undefined" ? window.ogb?.routines : undefined;
  const [state, setState] = useState<DesktopRoutineWake | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    const load = () => bridge.wakeState().then((next) => { if (!cancelled) setState(next); }).catch(() => {});
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [bridge]);
  if (!bridge || !state) return null;
  return (
    <div className="mt-6 flex items-center justify-between gap-4 px-1 text-[12px] text-ink-secondary">
      <span>{t("automations.wake")}{state.keepAwake && state.onBattery ? ` ${t("automations.wakeBattery")}` : ""}</span>
      <Switch
        checked={state.keepAwake}
        disabled={busy}
        aria-label={t("automations.wake")}
        onClick={() => {
          setBusy(true);
          bridge.keepAwake(!state.keepAwake).then(setState).catch(() => {}).finally(() => setBusy(false));
        }}
        className="shrink-0 disabled:cursor-wait disabled:opacity-50"
      />
    </div>
  );
}
