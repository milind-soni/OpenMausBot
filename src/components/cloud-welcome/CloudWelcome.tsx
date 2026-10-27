import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Minus } from "lucide-react";
import { useCloudSendNotice } from "@/components/CloudSendStrip";
import { countedList } from "@/lib/cloud-send";
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
import { hintSeen, type OnboardingStatus } from "@/lib/onboarding";
import { useShowThreads } from "@/lib/thread-preferences";
import type { LocaleKey } from "@/locales";
import type { CloudSendNotice } from "../../../electron/cloud-send.mjs";
import { openBot, useStore } from "@/state/store";
import { useCloudName } from "./parts";
import { WelcomeBring, type BringOutcome } from "./WelcomeBring";
import { WelcomeDone, WelcomeEngine, WelcomeFiles } from "./WelcomeSteps";

const STEP_TEXT: Record<WelcomeStep, { title: LocaleKey; hint: LocaleKey }> = {
  bring: { title: "cloudWelcome.step.bring", hint: "cloudWelcome.step.bringHint" },
  engine: { title: "cloudSetup.engine.title", hint: "cloudWelcome.step.engineHint" },
  files: { title: "cloudWelcome.step.files", hint: "cloudWelcome.step.filesHint" },
};

/** Sends that carry everything (bots, skills, logins, settings and chats); one login or one item is not one. "first"
 * and "auto": an older desktop's sends by itself. */
const WHOLE_SENDS = new Set(["button", "my-cloud", "menu", "move", "first", "auto"]);

/** What came over from this computer, for the Bring step: "sent" once a whole send went through (`last` says what
 * arrived); "sending" while one runs, or while an older desktop that sends by itself has not sent yet; null otherwise
 * (none yet, a whole send failed, or a desktop too old to say, which sends no `whole`), which keeps the choice to copy
 * or start fresh. */
export function sentHere(notice: CloudSendNotice | null | undefined): { state: "sending" | "sent"; last: CloudSendNotice["last"] } | null {
  if (!notice || notice.whole === undefined) return null;
  const last = notice.last;
  const whole = Boolean(last && WHOLE_SENDS.has(last.reason));
  if (notice.running && WHOLE_SENDS.has(notice.runningReason ?? "")) return { state: "sending", last };
  if (whole && !last!.error) return { state: "sent", last };
  if (notice.auto === true && !whole) return { state: "sending", last };
  return null;
}

/** How a step shows on the rail. Bring your stuff is done only once something came over: started fresh with nothing
 * from this computer (moves not on yet, say), it shows as skipped, and while things come over, as on its way. */
export function railStatus(record: OnboardingStatus | undefined, step: WelcomeStep, sent: ReturnType<typeof sentHere>): "done" | "skipped" | "bringing" | "todo" {
  if (step !== "bring") return welcomeStepFinished(record, step) ? "done" : "todo";
  if (sent?.state === "sent") return "done";
  const skipped = hintSeen(record, CLOUD_SETUP_MOVE_SKIPPED);
  if (welcomeStepFinished(record, step) && !skipped) return "done";
  if (sent?.state === "sending") return "bringing";
  return skipped ? "skipped" : "todo";
}

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
  const visible = state.bots.filter((bot) => !bot.hidden);
  const bot = visible.find((candidate) => candidate.chiefOfStaff) ?? visible[0] ?? null;
  const cloudHasWork = visible.length > 1 || state.groups.length > 0;
  const sendBridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudSendPage;
  // An older app still offers Copy this computer by hand: it moves bots here by itself only once updated.
  const older = Boolean(sendBridge && window.ogb && "cloudMove" in window.ogb);
  const [notice] = useCloudSendNotice(sendBridge);
  const sent = sentHere(notice);
  // Main answers at once; until it does, no choice is shown that it may take back a moment later.
  const [noticeLate, setNoticeLate] = useState(false);
  useEffect(() => {
    if (!sendBridge) return;
    const timer = setTimeout(() => setNoticeLate(true), 1500);
    return () => clearTimeout(timer);
  }, [sendBridge]);
  const asking = Boolean(sendBridge) && notice === undefined && !noticeLate;

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

  // This computer's things come over by themselves: the welcome moves on at once, with nothing to choose or press, and
  // ticks Bring your stuff only once they have come over.
  const movedOn = useRef(false);
  useEffect(() => {
    if (!sent || welcomeStepFinished(record, "bring")) return;
    const arrived = sent.state === "sent" ? [welcomeStepHint("bring")] : [];
    if (arrived.length) remember(arrived);
    if (view === "bring" && !movedOn.current) {
      movedOn.current = true;
      go(welcomeViewAfter(withEarlyHints(record, arrived), "bring"), false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent?.state]);

  const remember = (ids: string[]) => { void saveWelcomeHints(state.config?.onboarding, ids, dispatch); };
  /** `focus`: the person moved here, so the step's heading takes focus; not when the welcome moves on by itself. */
  const go = (next: WelcomeView, focus = true) => {
    navigated.current = focus;
    setView(next);
  };
  const finish = (step: WelcomeStep, extra: string[] = [], focus = true) => {
    const ids = [welcomeStepHint(step), ...extra];
    remember(ids);
    go(welcomeViewAfter(withEarlyHints(record, ids), step), focus);
  };
  const finishBring = (outcome: BringOutcome) => finish("bring", outcome === "skipped" ? [CLOUD_SETUP_MOVE_SKIPPED] : []);
  const end = (reason: "done" | "skipped") => {
    track("cloud_welcome_ended", { reason, at: view });
    remember([CLOUD_WELCOME_DONE]);
    endWelcomeHere();
  };

  const sayHi = () => {
    end("done");
    dispatch({ type: "showChat" });
    if (bot) openBot(dispatch, bot, showThreads);
  };
  const giveJob = () => {
    if (!bot) return;
    end("done");
    dispatch({ type: "showChat" });
    dispatch({ type: "select", id: bot.id });
    reopenCloudIntent(true);
  };

  let content;
  if (view === "bring" && asking) content = null;
  else if (view === "bring") {
    content = <WelcomeBring name={name} team={Boolean(state.config?.team)} desktop={Boolean(sendBridge)} older={older} cloudHasWork={cloudHasWork} sent={sent && { state: sent.state, arrived: sent.state === "sent" && sent.last ? countedList(sent.last.sent) : null }} headingRef={heading}
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
        <p className="mt-1 px-1.5 text-[13px] leading-relaxed text-ink-secondary">{t("cloudWelcome.intro")}</p>
        <div className="mt-3 flex items-center justify-between gap-2 @2xl/welcome:mt-4 @2xl/welcome:flex-1 @2xl/welcome:flex-col @2xl/welcome:items-stretch @2xl/welcome:justify-start">
          <ol className="flex min-w-0 gap-1 @2xl/welcome:flex-col @2xl/welcome:gap-1.5">
            {WELCOME_STEPS.map((step, index) => {
              const status = railStatus(record, step, sent);
              const finished = status === "done", bringing = status === "bringing", skipped = status === "skipped";
              const current = view === step;
              return <li key={step} className="min-w-0">
                <button type="button" data-welcome-rail={step} data-finished={finished || undefined} data-bringing={bringing || undefined} data-skipped={skipped || undefined} aria-current={current ? "step" : undefined} onClick={() => go(step)}
                  className={cn("flex w-full min-w-0 items-center gap-2 rounded-full text-left transition-colors duration-150 motion-reduce:transition-none @2xl/welcome:items-start @2xl/welcome:gap-2.5 @2xl/welcome:rounded-[10px] @2xl/welcome:p-2.5",
                    current ? "bg-raised py-1.5 pl-1.5 pr-3" : "p-1.5 hover:bg-raised/60")}>
                  <span aria-hidden="true" className={cn("flex size-[22px] shrink-0 items-center justify-center rounded-full border-[1.5px] text-[12px] font-semibold tabular-nums",
                    finished ? "check-in border-success bg-success" : current ? "border-accent text-accent-text" : "border-ink-secondary/40 text-ink-secondary")}>
                    {finished ? <Check size={12} strokeWidth={3} /> : bringing ? <Loader2 size={12} strokeWidth={2.5} className="animate-spin" /> : skipped ? <Minus size={11} strokeWidth={3} /> : index + 1}
                  </span>
                  <span className={cn("min-w-0", !current && "sr-only @2xl/welcome:not-sr-only")}>
                    <span className={cn("block truncate text-[13px] font-medium @2xl/welcome:whitespace-normal @2xl/welcome:text-[14px]", current ? "text-ink" : "text-ink-secondary")}>{t(STEP_TEXT[step].title)}</span>
                    <span className="hidden text-[12px] text-ink-tertiary @2xl/welcome:block">{t(STEP_TEXT[step].hint)}</span>
                  </span>
                  <span className="sr-only"> ({t(finished ? "cloudSetup.stepDone" : skipped ? "cloudSetup.skipped" : "cloudSetup.stepTodo")})</span>
                </button>
              </li>;
            })}
          </ol>
          {view !== "done" && <button type="button" onClick={() => end("skipped")}
            className="shrink-0 rounded-md px-1.5 py-1 text-[13px] text-ink-secondary transition-colors hover:text-ink motion-reduce:transition-none @2xl/welcome:mt-auto @2xl/welcome:self-start">
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
