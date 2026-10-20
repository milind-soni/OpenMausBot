import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useCloudMove } from "@/components/CloudMove";
import { WindowDragStrip } from "@/components/DesktopCapabilities";
import { track } from "@/lib/analytics";
import { reopenCloudIntent } from "@/lib/cloud-intent";
import {
  CLOUD_SETUP_MOVE_SKIPPED, CLOUD_WELCOME_DONE, CLOUD_WELCOME_SHOWN, WELCOME_STEPS, welcomeStepFinished, welcomeStepHint, welcomeView, welcomeViewAfter,
  type WelcomeStep, type WelcomeView,
} from "@/lib/cloud-setup";
import { endWelcomeHere, markWelcomeSeen, saveWelcomeHints, stepAsideWelcome, takeWelcomeRequest, useCloudWelcome, withEarlyHints } from "@/lib/cloud-welcome";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { hintSeen } from "@/lib/onboarding";
import { awayFromHome, greetedBot, openElsewhere, useOneWorkspace } from "@/lib/one-workspace";
import { useShowThreads } from "@/lib/thread-preferences";
import type { LocaleKey } from "@/locales";
import { openBot, useStore } from "@/state/store";
import { useCloudName } from "./parts";
import { WelcomeBring, type BringOutcome } from "./WelcomeBring";
import { WelcomeDone, WelcomeEngine, WelcomeFiles } from "./WelcomeSteps";

const STEP_TEXT: Record<WelcomeStep, { title: LocaleKey; hint: LocaleKey }> = {
  bring: { title: "cloudWelcome.step.bring", hint: "cloudWelcome.step.bringHint" },
  engine: { title: "cloudSetup.engine.title", hint: "cloudWelcome.step.engineHint" },
  files: { title: "cloudWelcome.step.files", hint: "cloudWelcome.step.filesHint" },
};

const requestedView = (value: string | null): WelcomeView | null =>
  value === "done" || WELCOME_STEPS.includes(value as WelcomeStep) ? value as WelcomeView : null;

export function CloudWelcome() {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const welcome = useCloudWelcome();
  const record = withEarlyHints(state.config?.onboarding, welcome.early);
  const name = useCloudName();
  const [view, setView] = useState<WelcomeView>(() => requestedView(takeWelcomeRequest()) ?? welcomeView(record));
  const heading = useRef<HTMLHeadingElement>(null);
  const navigated = useRef(false);
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudMove;
  const move = useCloudMove(bridge);
  const copied = move.state.phase === "done" && move.state.action !== "restore";
  const visible = state.bots.filter((bot) => !bot.hidden);
  const { view: together } = useOneWorkspace();
  const { bot, elsewhere } = greetedBot(visible, (id) => awayFromHome(together, id));
  const openAtHome = () => { if (bot && together) void openElsewhere({ side: together.other.side, id: bot.id }); };
  const cloudHasWork = move.overview?.cloud ? !move.overview.cloud.empty : visible.length > 1 || state.groups.length > 0;

  useEffect(() => {
    markWelcomeSeen();
    if (!hintSeen(record, CLOUD_WELCOME_SHOWN)) remember([CLOUD_WELCOME_SHOWN]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    track("cloud_welcome_step", { step: view });
    if (!navigated.current) return;
    navigated.current = false;
    heading.current?.focus();
  }, [view]);

  const anchor = useRef<string | null>(null);
  const reanchor = useRef(false);
  useEffect(() => {
    if (!state.selectedId) return;
    if (anchor.current === null || reanchor.current) {
      anchor.current = state.selectedId;
      reanchor.current = false;
    } else if (state.selectedId !== anchor.current) stepAsideWelcome();
  }, [state.selectedId]);

  const remember = (ids: string[]) => { void saveWelcomeHints(state.config?.onboarding, ids, dispatch); };
  const go = (next: WelcomeView) => {
    navigated.current = true;
    setView(next);
  };
  const finish = (step: WelcomeStep, extra: string[] = []) => {
    const ids = [welcomeStepHint(step), ...extra];
    remember(ids);
    go(welcomeViewAfter(withEarlyHints(record, ids), step));
  };
  const finishBring = (outcome: BringOutcome) => {
    if (outcome === "copied" || outcome === "skipped") void bridge?.dismiss().catch(() => {});
    finish("bring", outcome === "skipped" ? [CLOUD_SETUP_MOVE_SKIPPED] : []);
  };
  const end = (reason: "done" | "skipped") => {
    track("cloud_welcome_ended", { reason, at: view });
    remember([CLOUD_WELCOME_DONE]);
    endWelcomeHere();
  };

  const sayHi = () => {
    end("done");
    if (elsewhere) return openAtHome();
    dispatch({ type: "showChat" });
    if (bot) openBot(dispatch, bot, showThreads);
  };
  const giveJob = () => {
    if (!bot) return;
    end("done");
    if (elsewhere) return openAtHome();
    dispatch({ type: "showChat" });
    dispatch({ type: "select", id: bot.id });
    reopenCloudIntent(true);
  };

  let content;
  if (view === "bring") {
    content = <WelcomeBring name={name} move={bridge ? move : null} cloudHasWork={cloudHasWork} headingRef={heading}
      onTeam={() => { reanchor.current = true; }}
      onFinish={finishBring} />;
  } else if (view === "engine") content = <WelcomeEngine name={name} headingRef={heading} onFinish={() => finish("engine")} />;
  else if (view === "files") content = <WelcomeFiles name={name} headingRef={heading} onFinish={() => finish("files")} />;
  else content = <WelcomeDone name={name} bot={bot} headingRef={heading} onSayHi={sayHi} onJob={giveJob} />;

  return <main data-cloud-welcome={view} className="@container/welcome relative flex h-full min-w-0 flex-1 flex-col bg-app">
    <WindowDragStrip />
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto @2xl/welcome:grid @2xl/welcome:grid-cols-[250px_minmax(0,1fr)] @2xl/welcome:grid-rows-[minmax(0,1fr)] @2xl/welcome:overflow-hidden">
      <nav aria-label={t("cloudWelcome.steps")} className="flex shrink-0 flex-col border-b border-hairline/50 bg-panel px-5 pb-4 pt-7 max-md:pt-14 @2xl/welcome:min-h-0 @2xl/welcome:overflow-y-auto @2xl/welcome:border-b-0 @2xl/welcome:border-r @2xl/welcome:px-[18px] @2xl/welcome:pb-5 @2xl/welcome:pt-[30px]">
        <h1 className="px-1.5 text-[18px] font-semibold tracking-[-0.015em] text-ink [text-wrap:balance]">{t("cloudWelcome.title", { name })}</h1>
        <p className="mt-1 px-1.5 text-[12.5px] leading-relaxed text-ink-secondary">{t("cloudWelcome.intro")}</p>
        <div className="mt-3 flex items-center justify-between gap-2 @2xl/welcome:mt-4 @2xl/welcome:flex-1 @2xl/welcome:flex-col @2xl/welcome:items-stretch @2xl/welcome:justify-start">
          <ol className="flex min-w-0 gap-1 @2xl/welcome:flex-col @2xl/welcome:gap-1.5">
            {WELCOME_STEPS.map((step, index) => {
              const finished = welcomeStepFinished(record, step) || (step === "bring" && copied);
              const current = view === step;
              return <li key={step} className="min-w-0">
                <button type="button" data-welcome-rail={step} data-finished={finished || undefined} aria-current={current ? "step" : undefined} onClick={() => go(step)}
                  className={cn("flex w-full min-w-0 items-center gap-2 rounded-full text-left transition-colors duration-150 motion-reduce:transition-none @2xl/welcome:items-start @2xl/welcome:gap-2.5 @2xl/welcome:rounded-[10px] @2xl/welcome:p-2.5",
                    current ? "bg-raised py-1.5 pl-1.5 pr-3" : "p-1.5 hover:bg-raised/60")}>
                  <span aria-hidden="true" className={cn("flex size-[22px] shrink-0 items-center justify-center rounded-full border-[1.5px] text-[11.5px] font-semibold tabular-nums",
                    finished ? "check-in border-success bg-success" : current ? "border-accent text-accent-text" : "border-ink-secondary/40 text-ink-secondary")}>
                    {finished ? <Check size={12} strokeWidth={3} /> : index + 1}
                  </span>
                  <span className={cn("min-w-0", !current && "sr-only @2xl/welcome:not-sr-only")}>
                    <span className={cn("block truncate text-[13px] font-medium @2xl/welcome:whitespace-normal @2xl/welcome:text-[13.5px]", current ? "text-ink" : "text-ink-secondary")}>{t(STEP_TEXT[step].title)}</span>
                    <span className="hidden text-[12px] text-ink-tertiary @2xl/welcome:block">{t(STEP_TEXT[step].hint)}</span>
                  </span>
                  <span className="sr-only"> ({t(finished ? "cloudSetup.stepDone" : "cloudSetup.stepTodo")})</span>
                </button>
              </li>;
            })}
          </ol>
          {view !== "done" && <button type="button" onClick={() => end("skipped")}
            className="shrink-0 rounded-md px-1.5 py-1 text-[12.5px] text-ink-secondary transition-colors hover:text-ink motion-reduce:transition-none @2xl/welcome:mt-auto @2xl/welcome:self-start">
            {t("cloudWelcome.skip")}
          </button>}
        </div>
      </nav>
      <div className="@container/step min-w-0 px-5 pb-12 pt-6 @2xl/welcome:min-h-0 @2xl/welcome:overflow-y-auto @2xl/welcome:px-10 @2xl/welcome:pt-[34px]">
        <div key={view} className="animate-rise w-full max-w-[720px]">{content}</div>
      </div>
    </div>
  </main>;
}
