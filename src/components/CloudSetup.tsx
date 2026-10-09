// The setup checklist on an OMB Cloud home (docs/cloud-pro.md, "Setup
// checklist"): one quiet card from the Cloud's first open until an engine is
// signed in and a bot has finished a turn there, or until the person hides
// it. Each step's state is read from the Cloud or this app (lib/cloud-setup),
// never ticked by hand, and each action opens what already exists: the
// first-job question (CloudIntent), the engine sign-in, Copy this computer
// here. No dialogs. Desktop and self-hosted installs never see it; they keep the welcome
// flow, and an empty one gets the same Copy this computer here card.
//
// The step to do now leads, under a segment per step that fills as the Cloud
// reports each one done; every other step sits below it on one line, and any
// not done is one click from leading. The guide mascot says when it is over.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, ChevronDown, Cloud, Minus } from "lucide-react";
import { MausAvatar } from "@/components/Avatar";
import { cloudMoveOffer, CloudMoveSuggestion, moveNextSteps, useCloudMove } from "@/components/CloudMove";
import { engineReady } from "@/components/EngineLibrary";
import { staggerIndex } from "@/components/onboarding/beats/shared";
import { withViewTransition } from "@/components/onboarding/view-transition";
import { brand } from "@/lib/brand";
import { cloudIntentDue, cloudIntentShown, jobRoutine, reopenCloudIntent, useCloudIntent } from "@/lib/cloud-intent";
import { cn } from "@/lib/cn";
import { CLOUD_INTENT_GIVEN, CLOUD_SETUP_HIDDEN, CLOUD_SETUP_MOVE_SKIPPED, cloudSetupItems, cloudSetupStage, type CloudSetupItem, type CloudSetupStep } from "@/lib/cloud-setup";
import { t } from "@/lib/i18n";
import type { MausMotion } from "@/lib/mascot";
import { hintSeenPatch, type WelcomeViewer } from "@/lib/onboarding";
import type { LocaleKey } from "@/locales";
import type { Routine } from "@/lib/routines";
import { api, useStore } from "@/state/store";

const TITLE: Record<CloudSetupStep, LocaleKey> = {
  cloud: "cloudSetup.cloud.title", job: "cloudSetup.job.title", engine: "cloudSetup.engine.title", plan: "cloudSetup.plan.title", move: "cloudSetup.move.title",
};

/** Minimized is this device's convenience; hiding is the Cloud's record. */
const COLLAPSED_KEY = "omb.cloudSetup.collapsed";
function storedCollapsed(): boolean {
  try { return globalThis.localStorage?.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
}
function storeCollapsed(collapsed: boolean) {
  try { globalThis.localStorage?.setItem(COLLAPSED_KEY, collapsed ? "1" : "0"); } catch { /* private window */ }
}

// The app's floating surface (menus, popovers), lifted off the sidebar it sits over.
const CARD = "fixed bottom-4 left-4 z-40 max-h-[calc(100dvh-32px)] w-[300px] max-w-[calc(100vw-32px)] origin-bottom-left overflow-y-auto rounded-2xl border border-hairline/50 bg-menu text-ink shadow-[0_18px_48px_-16px_rgba(0,0,0,0.55),0_4px_12px_-6px_rgba(0,0,0,0.3)]";
const PRIMARY = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12.5px] font-medium text-white transition-transform duration-150 ease-out active:scale-[0.97]";

/** When a routine runs next, in the person's words: "today at 8:00",
 * "tomorrow at 8:00", or a weekday and time within the week. */
function nextRunLabel(at: number | null, now = Date.now()): string | null {
  if (!at) return null;
  const when = new Date(at), today = new Date(now);
  const days = Math.round((new Date(when).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86_400_000);
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 0) return t("cloudSetup.ready.today", { time });
  if (days === 1) return t("cloudSetup.ready.tomorrow", { time });
  return t("cloudSetup.ready.on", { day: when.toLocaleDateString([], { weekday: "long" }), time });
}

/** The last beat: the Cloud has done what setup was for. With a first job,
 * that is its routine, named with its next run and one click to run it now,
 * so the first result need not wait for the schedule. Seen once, in the
 * session that finished it; it leaves by itself after a while. */
function CloudReady({ routine, onDone }: { routine?: Routine; onDone: () => void }) {
  const { dispatch } = useStore();
  const [motion, setMotion] = useState<{ kind: MausMotion; key: number }>({ kind: "none", key: 0 });
  const [leaving, setLeaving] = useState(false);
  const [run, setRun] = useState<"idle" | "starting" | "started" | "failed">("idle");
  useEffect(() => {
    // One frame late, as in WelcomeFlow: a motion issued in the mounting commit is lost.
    const frame = requestAnimationFrame(() => setMotion({ kind: "celebrate", key: 1 }));
    // Longer with something to do on it.
    const timer = setTimeout(() => setLeaving(true), routine ? 20_000 : 9000);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Out on the pop-out's 200ms, then gone.
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(onDone, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);
  const runNow = () => {
    if (!routine || run === "starting") return;
    setRun("starting");
    dispatch({
      type: "runRoutine", routineId: routine.id,
      onStarted: () => { setRun("started"); setTimeout(() => setLeaving(true), 1800); },
      onError: () => setRun("failed"),
    });
  };
  const next = routine ? nextRunLabel(routine.nextRunAt) : null;
  return <aside aria-labelledby="cloud-ready-title" data-cloud-setup-ready className={cn(CARD, "flex flex-col items-center p-5 pt-6 text-center", leaving ? "animate-pop-out" : "animate-spot-in")}>
    <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-[radial-gradient(60%_100%_at_50%_0%,color-mix(in_oklab,var(--color-success)_16%,transparent),transparent)]" />
    <MausAvatar color="green" state="celebrate" motion={motion.kind} motionKey={motion.key} size={56} label={brand().name} />
    <div role="status" className="relative">
      <h2 id="cloud-ready-title" className="mt-3 text-[15px] font-semibold">{t("cloudSetup.ready.title")}</h2>
      {routine
        ? <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">
            <span className="font-medium text-ink">{routine.name}</span>
            {next ? <> {t("cloudSetup.ready.runs", { when: next })}</> : null}
          </p>
        : <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{t("cloudSetup.ready.body")}</p>}
      {run === "failed" && <p role="alert" className="mt-1.5 text-[12px] text-danger">{t("cloudSetup.ready.runFailed")}</p>}
    </div>
    {routine
      ? <div className="relative mt-4 flex w-full flex-col gap-2">
          <button type="button" onClick={runNow} disabled={run === "starting" || run === "started"}
            className={run === "started"
              ? "inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-success/15 text-[12.5px] font-medium text-success"
              : cn(PRIMARY, "h-9 w-full justify-center")}>
            {run === "started" ? <><Check size={14} strokeWidth={2.5} aria-hidden="true" />{t("cloudSetup.ready.running")}</> : t("cloudSetup.ready.runNow")}
          </button>
          <button type="button" className="py-1 text-[12px] text-ink-secondary transition-colors hover:text-ink" onClick={() => setLeaving(true)}>{t("cloudSetup.ready.later")}</button>
        </div>
      : <button type="button" className="ui-button relative mt-4 w-full" onClick={() => setLeaving(true)}>{t("cloudSetup.ready.done")}</button>}
  </aside>;
}

export function CloudSetup({ viewer }: { viewer: WelcomeViewer | null }) {
  const { state, dispatch } = useStore();
  const [hidden, setHidden] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveSkipped, setMoveSkipped] = useState(false);
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  const [finale, setFinale] = useState(false);
  const wasShown = useRef(false);
  // One step open at a time: the first one not done, or the one chosen.
  const [chosen, setChosen] = useState<CloudSetupStep | null>(null);
  const intent = useCloudIntent();
  const record = state.config?.onboarding;
  // Not now on the move, and a first job given (waiting or sent), show at
  // once, before the Cloud's record answers.
  const early: string[] = [];
  if (moveSkipped) early.push(CLOUD_SETUP_MOVE_SKIPPED);
  if (intent.pending || intent.sent) early.push(CLOUD_INTENT_GIVEN);
  const onboarding = early.length && record ? { ...record, hintsSeen: [...record.hintsSeen, ...early] } : record;
  // The first job is set up once its bot has a routine; the finale names it.
  const routine = jobRoutine(state.routines, intent.sent);
  const facts = {
    viewer, connected: state.connected, enginesKnown: state.instances.length > 0,
    engineReady: state.instances.some(engineReady), onboarding, planned: Boolean(routine),
  };
  const stage = hidden ? "hidden" : cloudSetupStage(facts);
  const shown = stage === "shown";
  const moveBridge = shown ? window.ogb?.cloudMove : undefined;
  const move = useCloudMove(moveBridge);
  // Finished here, in this session: say so once. A Cloud that opens already
  // done, or a checklist that was hidden, goes quietly.
  useEffect(() => {
    if (stage === "shown") wasShown.current = true;
    else if (stage === "done" && wasShown.current) { wasShown.current = false; setFinale(true); }
  }, [stage]);
  if (finale) return <CloudReady routine={routine} onDone={() => setFinale(false)} />;
  // Anywhere but the checklist (any other server, or the checklist hidden or
  // finished): the one-time Copy this computer here card, which shows only
  // when main suggests it. Not while this page is still finding out what it is.
  if (!shown) return stage === "waiting" || !viewer ? null : <CloudMoveSuggestion />;

  const items = cloudSetupItems({
    ...facts,
    move: moveBridge && move.overview ? { phase: move.state.phase, action: move.state.action, suggest: move.overview.suggest } : null,
  });
  const moveItem = items.find((item) => item.id === "move");
  const todo = items.filter((item) => item.status === "todo");
  const current = (todo.find((item) => item.id === chosen) ?? todo[0])?.id;
  const remember = (id: string) => {
    const patch = hintSeenPatch(record, id);
    if (patch) void api("/api/config", { method: "PUT", body: JSON.stringify(patch) })
      .then((config) => dispatch({ type: "configStatus", config })).catch(() => {});
  };
  const hide = () => {
    setHidden(true);
    // Bringing bots over is one of these steps, so hiding setup is its Not now too.
    if (moveBridge && moveItem?.status === "todo") void moveBridge.dismiss().catch(() => {});
    remember(CLOUD_SETUP_HIDDEN);
  };
  // The question already fills the chat pane: the step need not offer it.
  const asking = state.activeView === "chat" && cloudIntentShown(cloudIntentDue({ ...facts, reopened: false }), intent);
  const askAgain = () => withViewTransition(() => { reopenCloudIntent(true); dispatch({ type: "showChat" }); });
  // The chat where the bot is setting itself up.
  const jobBot = intent.sent?.botId;
  const openJobChat = () => {
    dispatch({ type: "showChat" });
    if (jobBot) dispatch({ type: "select", id: jobBot });
  };
  const hint = (key: LocaleKey) => <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{t(key)}</p>;
  const action = (label: LocaleKey, onClick: () => void) => <button type="button" className={PRIMARY} onClick={onClick}>{t(label)}<ArrowRight size={13} aria-hidden="true" /></button>;

  /** What the current step says, and the one thing it asks for. */
  const details = (id: CloudSetupStep): { body: ReactNode; act?: ReactNode } => {
    // In the chat view the sign-in is already what the window shows.
    if (id === "engine") return { body: hint("cloudSetup.engine.hint"), act: state.activeView !== "chat" && action("cloudSetup.engine.action", () => dispatch({ type: "showChat" })) };
    if (id === "move") {
      if (!moveBridge) return { body: null };
      // Open once asked for, and while a move is under way or has stopped.
      if (moveOpen || (moveItem?.status === "todo" && move.state.phase !== "idle")) {
        return { body: cloudMoveOffer(move, { notNow: () => { setMoveSkipped(true); remember(CLOUD_SETUP_MOVE_SKIPPED); } }) };
      }
      return { body: hint("cloudSetup.move.hint"), act: action("cloudSetup.move.action", () => setMoveOpen(true)) };
    }
    if (id === "job") return { body: hint("cloudSetup.job.hint"), act: !asking && action("cloudSetup.job.action", askAgain) };
    if (id === "plan") return { body: hint("cloudSetup.plan.hint"), act: action("cloudSetup.plan.action", openJobChat) };
    return { body: null };
  };

  const mark = (item: CloudSetupItem) => {
    if (item.status === "done") return <span className="check-in mt-px flex size-4 shrink-0 items-center justify-center rounded-full bg-success text-white">
      <Check size={10} strokeWidth={3.5} aria-hidden="true" />
    </span>;
    if (item.status === "skipped") return <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-ink-secondary/45 text-ink-secondary">
      <Minus size={9} strokeWidth={3} aria-hidden="true" />
    </span>;
    return <span className="mt-px size-4 shrink-0 rounded-full border-[1.5px] border-ink-secondary/45" />;
  };
  // Every other step, one line each: a step not done is one click from being the current one.
  const row = (item: CloudSetupItem, index: number) => {
    const pending = item.status === "todo";
    const title = <span className="min-w-0 flex-1 text-[12.5px] leading-[18px]">
      {t(TITLE[item.id])}
      {item.status === "skipped"
        ? <span> · {t("cloudSetup.skipped")}</span>
        : <span className="sr-only"> ({t(pending ? "cloudSetup.stepTodo" : "cloudSetup.stepDone")})</span>}
    </span>;
    return <li key={item.id} data-cloud-setup-step={item.id} data-status={item.status} className="animate-rise" style={staggerIndex(index)}>
      {pending
        ? <button type="button" onClick={() => setChosen(item.id)} className="-mx-2 flex w-[calc(100%+16px)] items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-ink transition-colors hover:bg-raised/70">{mark(item)}{title}</button>
        : <div className="-mx-2 flex items-start gap-2.5 px-2 py-1.5 text-ink-secondary">{mark(item)}{title}</div>}
      {/* Moved: what does not run yet on the Cloud, and the phone. */}
      {item.id === "move" && item.status === "done" && moveNextSteps(move.state).map(line => <p key={line} className="ml-[26px] text-[12px] leading-relaxed text-ink-secondary">{line}</p>)}
    </li>;
  };
  // The main pane already shows this step: the question, or the sign-in in
  // the chat view. The card points there instead of saying it all again.
  const inChat = state.activeView === "chat" && !asking;
  const onScreen = (id: CloudSetupStep) => (id === "job" && asking) || (id === "engine" && inChat)
    || (id === "plan" && inChat && (!jobBot || state.selectedId === jobBot));
  // The one step to do now, with what it asks for.
  const focus = (id: CloudSetupStep) => {
    const here = onScreen(id);
    const { body, act } = here ? { body: null, act: null } : details(id);
    return <div key={id} data-cloud-setup-step={id} data-status="todo" className="animate-rise mt-4">
      <h3 className="text-[14px] font-semibold leading-snug text-ink [text-wrap:balance]">{t(TITLE[id])}</h3>
      {here
        ? <p className="mt-1.5 flex items-center gap-1.5 text-[12px] font-medium text-accent"><span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />{t("cloudSetup.onScreen")}</p>
        : body}
      {act && <div className="mt-3.5 flex">{act}</div>}
    </div>;
  };
  const finished = items.filter((item) => item.status === "done").length;
  const done = items.filter((item) => item.status !== "todo").length;
  const progress = t("cloudSetup.progress", { done, total: items.length });
  const toggle = () => { setCollapsed(!collapsed); storeCollapsed(!collapsed); };
  const others = items.filter((item) => item.id !== current);

  return <aside aria-labelledby="cloud-setup-title" data-cloud-setup className={cn(CARD, "animate-spot-in p-4")}>
    <div className="flex items-center gap-2">
      <Cloud size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
      <h2 id="cloud-setup-title" className="min-w-0 flex-1 truncate text-[13px] font-semibold">{t("cloudSetup.title")}</h2>
      <span aria-hidden="true" className="shrink-0 text-[12px] tabular-nums text-ink-secondary">{progress}</span>
      {/* Minimized, the whole card opens it again. */}
      <button type="button" aria-label={t(collapsed ? "cloudSetup.expand" : "cloudSetup.collapse")} aria-expanded={!collapsed} aria-controls="cloud-setup-body" onClick={toggle}
        className={cn("ui-icon-button -mr-1.5 size-6 min-h-0 shrink-0 p-0", collapsed && "after:absolute after:inset-0 after:content-['']")}>
        <ChevronDown size={14} aria-hidden="true" className={cn("transition-transform duration-200 ease-out", collapsed && "rotate-180")} />
      </button>
    </div>
    {/* How far along, filled from the left whatever order the steps were done
        in: done in green, then skipped in grey. Which step leads does not move it. */}
    <div role="progressbar" aria-labelledby="cloud-setup-title" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done} aria-valuetext={progress} className="mt-3 flex gap-1">
      {items.map((_, index) => {
        const filled = index < done, skipped = index >= finished;
        return <span key={index} className="relative h-1 flex-1 rounded-full bg-ink-secondary/20">
          <span data-filled={filled ? "" : undefined} style={staggerIndex(index)}
            className={cn("progress-fill absolute inset-0 rounded-full", filled && skipped ? "bg-ink-secondary/50" : "bg-success")} />
        </span>;
      })}
    </div>
    {!collapsed && <div id="cloud-setup-body">
      {current ? focus(current) : <p role="status" className="animate-rise mt-4 text-[12.5px] leading-relaxed text-ink-secondary">{t("cloudSetup.working")}</p>}
      {others.length > 0 && <ol className="stagger mt-4 flex flex-col border-t border-hairline/60 pt-2.5">{others.map(row)}</ol>}
      <button type="button" className="mt-1.5 py-1 text-[12px] text-ink-secondary transition-colors hover:text-ink" onClick={hide}>{t("cloudSetup.hide")}</button>
    </div>}
  </aside>;
}
