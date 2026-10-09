// Shown on an OMB Cloud home in place of a chat until one of the person's own
// engines is signed in (docs/cloud-pro.md; lib/onboarding cloudSignInDue).
// Cloud Pro includes no AI: the person brings a Claude, ChatGPT or Grok
// account, or an API key. Each choice opens the setup that already exists for
// it: the paste-code Claude sign-in and the Codex and Grok device codes
// (EngineSetup, the card the model picker shows), or the model-provider keys
// in Settings → Connections. Grok is offered only where this Cloud computer
// has the Grok CLI. Once an engine can run, the chat takes this screen's place.
//
// It borrows the welcome flow's look: the guide mascot, copy that rises in a
// beat at a time, and choices that open in place. A first job given before
// any AI (CloudIntent) waits at the top; once an engine can run, the screen
// says so for a moment and hands the job to the chat as a `/setup` request.
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Info, KeyRound, RefreshCw } from "lucide-react";
import { MausAvatar } from "@/components/Avatar";
import { startCloudSetup } from "@/components/CloudIntent";
import { engineReady } from "@/components/EngineLibrary";
import { EngineSetup } from "@/components/EngineSetup";
import { ProviderMark } from "@/components/ProviderIcons";
import { staggerIndex } from "@/components/onboarding/beats/shared";
import { brand } from "@/lib/brand";
import { reopenCloudIntent, setPendingIntent, useCloudIntent } from "@/lib/cloud-intent";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { MausMotion, MausState } from "@/lib/mascot";
import { withViewTransition } from "@/components/onboarding/view-transition";
import { useStore, type InstanceInfo } from "@/state/store";

type Choice = "claude" | "codex" | "grok";
type ChoiceKind = "claudeAgent" | "codex" | "grokAgent";

/** The person's own engine of that kind: not a local-model or read-only one. */
export function cloudEngine(instances: readonly InstanceInfo[], driverKind: ChoiceKind): InstanceInfo | undefined {
  return instances.find((instance) => instance.driverKind === driverKind && instance.access !== "custom" && !instance.readOnly);
}

export function CloudEngineSignIn() {
  const { state, dispatch, refreshInstances } = useStore();
  const [open, setOpen] = useState<Choice | null>(null);
  const [checking, setChecking] = useState(false);
  const [motion, setMotion] = useState<{ kind: MausMotion; key: number }>({ kind: "none", key: 0 });
  // The entrance waits one frame: a motion issued in the commit that mounts
  // the avatar lands before its engine has drawn (WelcomeFlow).
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMotion({ kind: "arrive", key: 1 }));
    return () => cancelAnimationFrame(frame);
  }, []);
  // A waiting first job starts once an engine can run: a beat to say so, then
  // the chat takes over with the job as its first message.
  const { pending } = useCloudIntent();
  const ready = state.instances.some(engineReady);
  const latest = useRef(state);
  latest.current = state;
  const [handing, setHanding] = useState(false);
  useEffect(() => {
    if (!pending || !ready) return;
    setHanding(true);
    setMotion({ kind: "success", key: 2 });
    const timer = setTimeout(() => {
      if (!startCloudSetup(pending, latest.current, dispatch)) setPendingIntent(null);
    }, 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, ready]);
  const recheck = async () => {
    setChecking(true);
    try {
      await refreshInstances();
    } finally {
      setChecking(false);
    }
  };
  const choices: Array<{ id: Choice; driverKind: ChoiceKind; label: string; hint: string }> = [
    { id: "claude", driverKind: "claudeAgent", label: t("cloudSignIn.claude"), hint: t("cloudSignIn.claudeHint") },
    { id: "codex", driverKind: "codex", label: t("cloudSignIn.codex"), hint: t("cloudSignIn.codexHint") },
    // Grok Build needs its CLI on this Cloud computer; an older image has none.
    ...(cloudEngine(state.instances, "grokAgent")?.snapshot.state === "available"
      ? [{ id: "grok" as const, driverKind: "grokAgent" as const, label: t("cloudSignIn.grok"), hint: t("cloudSignIn.grokHint") }]
      : []),
  ];
  // The guide looks around while the Cloud answers, listens once a way in is
  // open, and is proud the moment it connects.
  let face: MausState = "curious";
  if (handing) face = "proud";
  else if (checking) face = "searching";
  else if (open) face = "listening";

  return (
    <main data-cloud-sign-in className="relative flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(55%_100%_at_50%_0%,color-mix(in_oklab,var(--color-accent)_9%,transparent),transparent)]"
      />
      <div className="stagger relative mx-auto flex w-full max-w-[540px] flex-col px-6 pb-12 pt-[clamp(48px,10vh,112px)]">
        <div className="animate-rise flex flex-col items-center text-center" style={staggerIndex(0)}>
          <MausAvatar color="green" state={face} motion={motion.kind} motionKey={motion.key} size={64} label={brand().name} />
        </div>
        {/* The job this sign-in is for, as it will be sent. It is the same
            element as the box it was typed in, and as the composer after. */}
        {pending && (
          <figure data-cloud-intent-pending className="mt-6 rounded-2xl bg-composer px-4 pb-3 pt-2.5 ring-1 ring-composer-ring" style={{ viewTransitionName: "cloud-intent" }}>
            <figcaption className="flex items-center justify-between gap-3 text-[11.5px] text-ink-secondary">
              {t("cloudIntent.pending")}
              {!handing && (
                <button type="button" onClick={() => withViewTransition(() => reopenCloudIntent(true))} className="rounded-md px-1.5 py-0.5 font-medium text-ink-secondary transition-colors hover:bg-raised hover:text-ink">
                  {t("cloudIntent.edit")}
                </button>
              )}
            </figcaption>
            <p className="mt-1 text-[14px] leading-relaxed text-ink">
              <span className="mr-1.5 inline-flex h-[21px] items-center rounded-md bg-accent/15 px-1.5 align-[1px] text-[12.5px] font-semibold text-accent">/setup</span>
              {pending}
            </p>
            {handing && (
              <p role="status" className="animate-rise mt-2 flex items-center gap-1.5 text-[12.5px] font-medium text-success">
                <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                {t("cloudSignIn.connected")}
              </p>
            )}
          </figure>
        )}
        <h1 className={cn("animate-rise text-center text-[22px] font-semibold tracking-[-0.01em] text-ink", pending ? "mt-7" : "mt-5")} style={staggerIndex(1)}>
          {t(pending ? "cloudSignIn.titleForJob" : "cloudSignIn.title")}
        </h1>
        <p className="animate-rise mx-auto mt-2 max-w-[440px] text-center text-[13.5px] leading-relaxed text-ink-secondary" style={staggerIndex(2)}>
          {t(pending ? "cloudSignIn.introForJob" : "cloudSignIn.intro")}
        </p>

        {/* The sign-ins are one choice, side by side (two, or three where
            Grok's CLI is on this computer); the picked one opens a single
            panel underneath, pointed at its tile. */}
        <div role="group" aria-label={t("cloudSignIn.title")} inert={handing} className={cn("mt-8 grid gap-3 transition-opacity duration-300 ease-out", choices.length === 3 ? "grid-cols-3" : "grid-cols-2", handing && "opacity-40")}>
          {choices.map((choice, i) => {
            const picked = open === choice.id;
            return (
              <button
                key={choice.id}
                type="button"
                data-cloud-choice={choice.id}
                aria-expanded={picked}
                aria-controls="cloud-sign-in-panel"
                onClick={() => setOpen(picked ? null : choice.id)}
                className={cn(
                  "animate-rise group relative flex flex-col rounded-2xl border p-4 text-left transition-[border-color,background-color,box-shadow,transform] duration-200 ease-out active:scale-[0.985]",
                  picked
                    ? "border-accent/70 bg-accent/[0.07] shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_16%,transparent)]"
                    : "border-hairline/50 bg-card/50 hover:border-hairline hover:bg-card",
                )}
                style={staggerIndex(3 + i)}
              >
                <span className="flex items-start justify-between">
                  <ProviderMark driverKind={choice.driverKind} size={24} />
                  <span aria-hidden="true" className={cn("flex size-[18px] items-center justify-center rounded-full border-[1.5px] transition-colors duration-200", picked ? "border-accent bg-accent" : "border-ink-secondary/40")}>
                    <span className={cn("size-1.5 rounded-full bg-white transition-transform duration-200 ease-out", picked ? "scale-100" : "scale-0")} />
                  </span>
                </span>
                <span className="mt-5 block text-[15px] font-semibold leading-snug text-ink">{choice.label}</span>
                <span className="mt-1 block text-[12.5px] leading-snug text-ink-secondary">{choice.hint}</span>
              </button>
            );
          })}
        </div>

        {/* Connected: the way in has done its job, and steps back. */}
        {open && !handing && (() => {
          const index = choices.findIndex((candidate) => candidate.id === open);
          const choice = choices[index]!;
          const instance = cloudEngine(state.instances, choice.driverKind);
          return (
            <div id="cloud-sign-in-panel" className="step-open mt-3">
              <div className="relative rounded-2xl border border-hairline/50 bg-card px-4 pb-4 pt-4">
                {/* The pointer glides under whichever tile is picked. */}
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]" style={{ transform: `translateX(${(index / choices.length) * 100}%)` }}>
                  <span className="absolute top-0 size-3 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] border-l border-t border-hairline/50 bg-card" style={{ left: `${50 / choices.length}%` }} />
                </span>
                <div key={open} className="animate-rise">
                  {instance
                    ? <EngineSetup instance={instance} unframed />
                    : <p role="status" className="text-[12.5px] text-ink-secondary">{t("cloudSignIn.missing")}</p>}
                </div>
              </div>
            </div>
          );
        })()}

        {/* An API key is a different road: it leaves for Settings. */}
        <div className="animate-rise mt-7 flex items-center gap-3 text-[11.5px] text-ink-secondary" style={staggerIndex(3 + choices.length)}>
          <span className="h-px flex-1 bg-hairline/50" />
          {t("cloudSignIn.or")}
          <span className="h-px flex-1 bg-hairline/50" />
        </div>
        <div data-cloud-choice="api-key" className="animate-rise mt-4 flex flex-col items-center text-center" style={staggerIndex(4 + choices.length)}>
          <button
            type="button"
            onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "connections" })}
            className="group inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13.5px] font-medium text-ink transition-[background-color,transform] duration-150 ease-out hover:bg-raised/60 active:scale-[0.97]"
          >
            <KeyRound size={15} aria-hidden="true" className="text-ink-secondary" />
            {t("cloudSignIn.apiKey")}
            <ArrowUpRight size={14} aria-hidden="true" className="text-ink-secondary transition-transform duration-150 ease-out group-hover:-translate-y-px group-hover:translate-x-px" />
          </button>
          <p className="mt-1 max-w-[380px] text-[12px] leading-relaxed text-ink-secondary">{t("cloudSignIn.apiKeyHint")}</p>
        </div>

        <p role="note" className="animate-rise mx-auto mt-8 flex max-w-[440px] gap-2 text-[12px] leading-relaxed text-ink-secondary" style={staggerIndex(5 + choices.length)}>
          <Info size={13} aria-hidden="true" className="mt-[3px] shrink-0" />
          <span>{t("cloudSignIn.limits")}</span>
        </p>

        <div className="animate-rise mt-5 flex items-center justify-center gap-1.5 text-[12.5px] text-ink-secondary" style={staggerIndex(6 + choices.length)}>
          <span>{t("cloudSignIn.signedIn")}</span>
          <button
            type="button"
            onClick={() => void recheck()}
            disabled={checking}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 font-medium text-ink transition-[background-color,transform] duration-150 ease-out hover:bg-raised active:scale-[0.97] disabled:opacity-60"
          >
            <RefreshCw size={12} aria-hidden="true" className={checking ? "animate-spin" : ""} />
            {checking ? t("common.checking") : t("common.checkAgain")}
          </button>
        </div>
      </div>
    </main>
  );
}
