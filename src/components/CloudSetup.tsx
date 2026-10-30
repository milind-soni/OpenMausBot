import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Check, ChevronDown, Cloud, Minus } from "lucide-react";
import { MausAvatar } from "@/components/Avatar";
import { engineReady } from "@/components/EngineLibrary";
import { staggerIndex } from "@/components/onboarding/beats/shared";
import { withViewTransition } from "@/components/onboarding/view-transition";
import { productName } from "@/lib/brand";
import { cloudIntentDue, cloudIntentShown, jobRoutine, reopenCloudIntent, useCloudIntent } from "@/lib/cloud-intent";
import { cn } from "@/lib/cn";
import { CLOUD_INTENT_GIVEN, CLOUD_SETUP_HIDDEN, cloudSetupItems, cloudSetupStage, cloudWelcomeStage, type CloudSetupItem, type CloudSetupStep } from "@/lib/cloud-setup";
import { endWelcomeHere, returnToWelcome, saveWelcomeHints, useCloudWelcome, withEarlyHints } from "@/lib/cloud-welcome";
import { t } from "@/lib/i18n";
import type { MausMotion } from "@/lib/mascot";
import { hintSeen, type WelcomeViewer } from "@/lib/onboarding";
import type { LocaleKey } from "@/locales";
import type { Routine } from "@/lib/routines";
import { useShowThreads } from "@/lib/thread-preferences";
import { openBot, useStore } from "@/state/store";

const TITLE: Record<CloudSetupStep, LocaleKey> = {
  cloud: "cloudSetup.cloud.title", job: "cloudSetup.job.title", engine: "cloudSetup.engine.title", plan: "cloudSetup.plan.title", move: "cloudWelcome.step.bring",
  files: "cloudWelcome.step.files",
};
const WELCOME_HINT: Partial<Record<CloudSetupStep, LocaleKey>> = {
  move: "cloudWelcome.compact.bring", engine: "cloudSetup.engine.hint", files: "cloudWelcome.compact.files",
};

const COLLAPSED_KEY = "omb.cloudSetup.collapsed";
function storedCollapsed(): boolean {
  try { return globalThis.localStorage?.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
}
function storeCollapsed(collapsed: boolean) {
  try { globalThis.localStorage?.setItem(COLLAPSED_KEY, collapsed ? "1" : "0"); } catch {}
}

const CARD = "fixed bottom-4 left-4 z-40 max-h-[calc(100dvh-32px)] w-[300px] max-w-[calc(100vw-32px)] origin-bottom-left overflow-y-auto rounded-2xl border border-hairline/50 bg-menu text-ink shadow-[0_18px_48px_-16px_rgba(0,0,0,0.55),0_4px_12px_-6px_rgba(0,0,0,0.3)]";
const PRIMARY = "ui-button ui-button-primary shrink-0 gap-1.5 text-[13px] transition-transform duration-150 ease-out active:scale-[0.97] motion-reduce:transition-none";

function nextRunLabel(at: number | null, now = Date.now()): string | null {
  if (!at) return null;
  const when = new Date(at), today = new Date(now);
  const days = Math.round((new Date(when).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86_400_000);
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 0) return t("cloudSetup.ready.today", { time });
  if (days === 1) return t("cloudSetup.ready.tomorrow", { time });
  return t("cloudSetup.ready.on", { day: when.toLocaleDateString([], { weekday: "long" }), time });
}

function CloudReady({ routine, onDone }: { routine?: Routine; onDone: () => void }) {
  const { dispatch } = useStore();
  const [motion, setMotion] = useState<{ kind: MausMotion; key: number }>({ kind: "none", key: 0 });
  const [leaving, setLeaving] = useState(false);
  const [run, setRun] = useState<"idle" | "starting" | "started" | "failed">("idle");
  useEffect(() => {
    // One frame late: a motion issued in the avatar's mounting commit is lost.
    const frame = requestAnimationFrame(() => setMotion({ kind: "celebrate", key: 1 }));
    const timer = setTimeout(() => setLeaving(true), routine ? 20_000 : 9000);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
    <MausAvatar color="green" state="celebrate" motion={motion.kind} motionKey={motion.key} size={56} label={productName()} />
    <div role="status" className="relative">
      <h2 id="cloud-ready-title" className="mt-3 text-[15px] font-semibold">{t("cloudSetup.ready.title")}</h2>
      {routine
        ? <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
            <span className="font-medium text-ink">{routine.name}</span>
            {next ? <> {t("cloudSetup.ready.runs", { when: next })}</> : null}
          </p>
        : <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("cloudSetup.ready.body")}</p>}
      {run === "failed" && <p role="alert" className="mt-1.5 text-[12px] text-danger">{t("cloudSetup.ready.runFailed")}</p>}
    </div>
    {routine
      ? <div className="relative mt-4 flex w-full flex-col gap-2">
          <button type="button" onClick={runNow} disabled={run === "starting" || run === "started"}
            className={run === "started"
              ? "inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-success/15 text-[13px] font-medium text-success"
              : cn(PRIMARY, "min-h-9 w-full justify-center")}>
            {run === "started" ? <><Check size={14} strokeWidth={2.5} aria-hidden="true" />{t("cloudSetup.ready.running")}</> : t("cloudSetup.ready.runNow")}
          </button>
          <button type="button" className="py-1 text-[12px] text-ink-secondary transition-colors hover:text-ink" onClick={() => setLeaving(true)}>{t("cloudSetup.ready.later")}</button>
        </div>
      : <button type="button" className="ui-button relative mt-4 w-full" onClick={() => setLeaving(true)}>{t("cloudSetup.ready.done")}</button>}
  </aside>;
}

export function CloudSetup({ viewer, welcomeShown = false }: { viewer: WelcomeViewer | null; welcomeShown?: boolean }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [hidden, setHidden] = useState(false);
  const [collapsed, setCollapsed] = useState(storedCollapsed);
  const [finale, setFinale] = useState(false);
  const wasShown = useRef(false);
  const [chosen, setChosen] = useState<CloudSetupStep | null>(null);
  const intent = useCloudIntent();
  const welcome = useCloudWelcome();
  const record = withEarlyHints(state.config?.onboarding, welcome.early);
  const early: string[] = [];
  if (intent.pending || intent.sent) early.push(CLOUD_INTENT_GIVEN);
  const onboarding = withEarlyHints(record, early);
  const routine = jobRoutine(state.routines, intent.sent);
  const facts = {
    viewer, connected: state.connected, enginesKnown: state.instances.length > 0,
    engineReady: state.instances.some(engineReady), onboarding, planned: Boolean(routine), welcomeShown,
  };
  const welcomeStage = cloudWelcomeStage(facts);
  const welcoming = welcomeStage === "pending";
  const stage = hidden ? "hidden" : cloudSetupStage(facts);
  const shown = stage === "shown";
  useEffect(() => {
    if (welcoming) wasShown.current = false;
    else if (stage === "shown") wasShown.current = true;
    else if (stage === "done" && wasShown.current) { wasShown.current = false; setFinale(true); }
  }, [stage, welcoming]);
  if (finale) return <CloudReady routine={routine} onDone={() => setFinale(false)} />;
  if (!shown) return null;

  const items = cloudSetupItems(facts);
  const todo = items.filter((item) => item.status === "todo");
  const current = (todo.find((item) => item.id === chosen) ?? todo[0])?.id;
  const remember = (id: string) => {
    if (!hintSeen(record, id)) void saveWelcomeHints(state.config?.onboarding, [id], dispatch);
  };
  const hide = () => {
    setHidden(true);
    if (welcoming) endWelcomeHere();
    remember(CLOUD_SETUP_HIDDEN);
  };
  const asking = state.activeView === "chat" && cloudIntentShown(cloudIntentDue({ ...facts, reopened: false }), intent);
  const askAgain = () => withViewTransition(() => { reopenCloudIntent(true); dispatch({ type: "showChat" }); });
  const jobBot = intent.sent?.botId;
  const openJobChat = () => {
    dispatch({ type: "showChat" });
    const bot = state.bots.find((candidate) => candidate.id === jobBot);
    if (bot) openBot(dispatch, bot, showThreads);
  };
  const hint = (key: LocaleKey) => <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t(key)}</p>;
  const action = (label: LocaleKey, onClick: () => void) => <button type="button" className={PRIMARY} onClick={onClick}>{t(label)}<ArrowRight size={13} aria-hidden="true" /></button>;

  const details = (id: CloudSetupStep): { body: ReactNode; act?: ReactNode } => {
    const welcomeHint = WELCOME_HINT[id];
    if (welcoming && welcomeHint) return { body: hint(welcomeHint), act: action("cloudWelcome.compact.continue", () => {
      returnToWelcome(id === "move" ? "bring" : id);
      dispatch({ type: "showChat" });
    }) };
    if (id === "engine") return { body: hint("cloudSetup.engine.hint"), act: state.activeView !== "chat" && action("cloudSetup.engine.action", () => dispatch({ type: "showChat" })) };
    if (id === "job") return { body: hint("cloudSetup.job.hint"), act: !asking && action("cloudSetup.job.action", askAgain) };
    if (id === "plan") return { body: hint("cloudSetup.plan.hint"), act: action("cloudSetup.plan.action", openJobChat) };
    return { body: null };
  };

  const mark = (item: CloudSetupItem) => {
    if (item.status === "done") return <span className="check-in mt-px flex size-4 shrink-0 items-center justify-center rounded-full bg-success">
      <Check size={10} strokeWidth={3.5} aria-hidden="true" />
    </span>;
    if (item.status === "skipped") return <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-ink-secondary/45 text-ink-secondary">
      <Minus size={9} strokeWidth={3} aria-hidden="true" />
    </span>;
    return <span className="mt-px size-4 shrink-0 rounded-full border-[1.5px] border-ink-secondary/45" />;
  };
  const titleOf = (id: CloudSetupStep) => t(TITLE[id]);
  const row = (item: CloudSetupItem, index: number) => {
    const pending = item.status === "todo";
    const title = <span className="min-w-0 flex-1 text-[13px] leading-[18px]">
      {titleOf(item.id)}
      {item.status === "skipped"
        ? <span> · {t("cloudSetup.skipped")}</span>
        : <span className="sr-only"> ({t(pending ? "cloudSetup.stepTodo" : "cloudSetup.stepDone")})</span>}
    </span>;
    return <li key={item.id} data-cloud-setup-step={item.id} data-status={item.status} className="animate-rise" style={staggerIndex(index)}>
      {pending
        ? <button type="button" onClick={() => setChosen(item.id)} className="-mx-2 flex w-[calc(100%+16px)] items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-ink transition-colors hover:bg-raised/70">{mark(item)}{title}</button>
        : <div className="-mx-2 flex items-start gap-2.5 px-2 py-1.5 text-ink-secondary">{mark(item)}{title}</div>}
    </li>;
  };
  const inChat = state.activeView === "chat" && !asking;
  const onScreen = (id: CloudSetupStep) => (id === "job" && asking) || (id === "engine" && inChat && !facts.engineReady)
    || (id === "plan" && inChat && (!jobBot || state.selectedId === jobBot));
  const focus = (id: CloudSetupStep) => {
    const here = onScreen(id);
    const { body, act } = here ? { body: null, act: null } : details(id);
    return <div key={id} data-cloud-setup-step={id} data-status="todo" className="animate-rise mt-4">
      <h3 className="text-[14px] font-semibold leading-snug text-ink [text-wrap:balance]">{titleOf(id)}</h3>
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
      <button type="button" aria-label={t(collapsed ? "cloudSetup.expand" : "cloudSetup.collapse")} aria-expanded={!collapsed} aria-controls="cloud-setup-body" onClick={toggle}
        className={cn("ui-icon-button -mr-1.5 size-6 min-h-0 shrink-0 p-0", collapsed && "after:absolute after:inset-0 after:content-['']")}>
        <ChevronDown size={14} aria-hidden="true" className={cn("transition-transform duration-200 ease-out", collapsed && "rotate-180")} />
      </button>
    </div>
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
      {current ? focus(current) : <p role="status" className="animate-rise mt-4 text-[13px] leading-relaxed text-ink-secondary">{t("cloudSetup.working")}</p>}
      {others.length > 0 && <ol className="stagger mt-4 flex flex-col border-t border-hairline/60 pt-2.5">{others.map(row)}</ol>}
      <button type="button" className="mt-1.5 py-1 text-[12px] text-ink-secondary transition-colors hover:text-ink" onClick={hide}>{t("cloudSetup.hide")}</button>
    </div>}
  </aside>;
}
