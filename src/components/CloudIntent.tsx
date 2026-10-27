import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, CalendarCheck, Eye, Newspaper, Search, type LucideIcon } from "lucide-react";
import { MausAvatar } from "@/components/Avatar";
import { engineReady } from "@/components/EngineLibrary";
import { staggerIndex } from "@/components/onboarding/beats/shared";
import { withViewTransition } from "@/components/onboarding/view-transition";
import { track } from "@/lib/analytics";
import { brand } from "@/lib/brand";
import { CLOUD_INTENT_ASKED, CLOUD_INTENT_GIVEN } from "@/lib/cloud-setup";
import { dismissCloudIntent, markIntentSent, reopenCloudIntent, setPendingIntent, setupMessage, useCloudIntent } from "@/lib/cloud-intent";
import { cn } from "@/lib/cn";
import { restoreComposerDraft } from "@/lib/drafts";
import { t } from "@/lib/i18n";
import { sendKeyLabel, sendsMessage, useSendKey } from "@/lib/send-key";
import type { MausMotion, MausState } from "@/lib/mascot";
import type { OnboardingStatus } from "@/lib/onboarding";
import type { LocaleKey } from "@/locales";
import { api, useStore, type Action, type AppState } from "@/state/store";

const IDEAS: Array<{ id: string; icon: LucideIcon; label: LocaleKey; text: LocaleKey }> = [
  { id: "digest", icon: Newspaper, label: "cloudIntent.idea.digest", text: "cloudIntent.idea.digestText" },
  { id: "watch", icon: Eye, label: "cloudIntent.idea.watch", text: "cloudIntent.idea.watchText" },
  { id: "research", icon: Search, label: "cloudIntent.idea.research", text: "cloudIntent.idea.researchText" },
  { id: "plan", icon: CalendarCheck, label: "cloudIntent.idea.plan", text: "cloudIntent.idea.planText" },
];

export function rememberIntent(record: OnboardingStatus | undefined, ids: string[], dispatch: (action: Action) => void): void {
  const seen = record?.hintsSeen ?? [];
  if (ids.every((id) => seen.includes(id))) return;
  const hintsSeen = [...new Set([...seen, ...ids])];
  void api("/api/config", { method: "PUT", body: JSON.stringify({ onboarding: { hintsSeen } }) })
    .then((config) => dispatch({ type: "configStatus", config })).catch(() => {});
}

export function startCloudSetup(job: string, state: Pick<AppState, "bots" | "selectedId">, dispatch: (action: Action) => void): boolean {
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId && !candidate.hidden) ?? state.bots.find((candidate) => !candidate.hidden);
  if (!bot) return false;
  const text = setupMessage(job);
  const root = document.documentElement;
  root.dataset.cloudIntentMorph = "";
  const transition = withViewTransition(() => {
    // Same frame as the send: the setup card must never see the job as not given in between.
    markIntentSent(bot.id);
    dispatch({ type: "showChat" });
    dispatch({ type: "select", id: bot.id });
    dispatch({
      type: "send", botId: bot.id, text, sendId: crypto.randomUUID(), threadId: bot.threadId,
      onError: () => restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text, attachments: [] }),
    });
  });
  const tidy = () => { delete root.dataset.cloudIntentMorph; };
  if (transition) void transition.finished.finally(tidy);
  else tidy();
  track("cloud_setup_started");
  return true;
}

export function CloudIntent() {
  const { state, dispatch } = useStore();
  const intent = useCloudIntent();
  const [job, setJob] = useState(intent.pending ?? "");
  const [idea, setIdea] = useState<string | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const [motion, setMotion] = useState<{ kind: MausMotion; key: number }>({ kind: "none", key: 0 });
  const box = useRef<HTMLTextAreaElement>(null);
  const token = useRef<HTMLSpanElement>(null);
  const [indent, setIndent] = useState(0);
  const ready = state.instances.some(engineReady);
  const record = state.config?.onboarding;
  const sendKey = useSendKey();

  // One frame late: a motion issued in the avatar's mounting commit is lost.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMotion({ kind: "arrive", key: 1 }));
    return () => cancelAnimationFrame(frame);
  }, []);
  useLayoutEffect(() => {
    if (token.current) setIndent(token.current.offsetWidth + 8);
  }, []);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 6 * 24 + 4)}px`;
  }, [job]);

  const submit = () => {
    const text = job.trim();
    if (!text) return;
    track("cloud_intent_submitted", { idea, edited: idea ? text !== t(IDEAS.find((candidate) => candidate.id === idea)!.text) : true });
    rememberIntent(record, [CLOUD_INTENT_ASKED, CLOUD_INTENT_GIVEN], dispatch);
    if (ready && startCloudSetup(text, state, dispatch)) return;
    withViewTransition(() => { setPendingIntent(text); reopenCloudIntent(false); });
  };
  const skip = () => {
    track("cloud_intent_skipped");
    rememberIntent(record, [CLOUD_INTENT_ASKED], dispatch);
    withViewTransition(dismissCloudIntent);
  };

  const latestSkip = useRef(skip);
  latestSkip.current = skip;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (box.current?.value.trim()) return;
      event.preventDefault();
      latestSkip.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const arrivedOn = useRef(state.selectedId);
  useEffect(() => {
    if (!arrivedOn.current) arrivedOn.current = state.selectedId;
    else if (state.selectedId !== arrivedOn.current) dismissCloudIntent();
  }, [state.selectedId]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (sendsMessage(event.nativeEvent, sendKey)) {
      event.preventDefault();
      submit();
    }
  };
  const pick = (id: string, text: string) => {
    setIdea(id);
    setJob(text);
    setPeek(null);
    requestAnimationFrame(() => {
      const element = box.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(text.length, text.length);
    });
  };
  const filled = job.trim().length > 0;
  let face: MausState = "happy";
  if (filled) face = "listening";
  else if (peek) face = "curious";

  return (
    <main data-cloud-intent className="relative flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[radial-gradient(55%_100%_at_50%_0%,color-mix(in_oklab,var(--color-accent)_9%,transparent),transparent)]"
      />
      <div className="stagger relative mx-auto flex w-full max-w-[620px] flex-col px-6 pb-12 pt-[clamp(48px,12vh,128px)]">
        <div className="animate-rise flex justify-center" style={staggerIndex(0)}>
          <MausAvatar color="green" state={face} motion={motion.kind} motionKey={motion.key} size={64} label={brand().name} />
        </div>
        <h1 className="animate-rise mt-5 text-center text-[24px] font-semibold tracking-[-0.015em] text-ink [text-wrap:balance]" style={staggerIndex(1)}>
          {t("cloudIntent.title")}
        </h1>
        <p className="animate-rise mx-auto mt-2 max-w-[460px] text-center text-[14px] leading-relaxed text-ink-secondary [text-wrap:pretty]" style={staggerIndex(2)}>
          {t("cloudIntent.intro")}
        </p>

        <div className="animate-rise mt-8" style={staggerIndex(3)}>
          <div
            className="relative rounded-2xl bg-composer py-3.5 pl-4 pr-14 shadow-[0_22px_50px_-30px_rgba(0,0,0,0.65)] ring-1 ring-composer-ring transition-[box-shadow] duration-200 ease-out focus-within:ring-accent/30"
            style={{ viewTransitionName: "cloud-intent" }}
          >
            <span ref={token} aria-hidden="true" className="absolute left-4 top-[15px] inline-flex h-[22px] items-center rounded-md bg-accent/[0.14] px-1.5 text-[13px] font-semibold text-accent">
              /setup
            </span>
            <textarea
              ref={box}
              autoFocus
              rows={2}
              value={job}
              onChange={(event) => { setJob(event.target.value); if (!event.target.value) setIdea(null); }}
              onKeyDown={onKeyDown}
              placeholder={peek ?? t("cloudIntent.placeholder")}
              aria-label={t("cloudIntent.title")}
              className="block min-h-12 w-full resize-none bg-transparent text-[15px] leading-6 text-ink outline-none placeholder:text-ink-tertiary"
              style={{ textIndent: indent }}
            />
            <button
              type="button"
              onClick={submit}
              disabled={!filled}
              aria-label={t("cloudIntent.send")}
              title={`${t("cloudIntent.send")} (${sendKeyLabel(sendKey)})`}
              className={cn(
                "absolute bottom-3 right-3 flex size-8 items-center justify-center rounded-full transition-[background-color,color,transform] duration-150 ease-out active:scale-95",
                filled ? "bg-accent text-white" : "bg-raised text-ink-secondary",
              )}
            >
              <ArrowUp size={16} strokeWidth={2.25} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div role="group" aria-label={t("cloudIntent.ideas")} className="mt-4 flex flex-wrap justify-center gap-2">
          {IDEAS.map((candidate, index) => {
            const Icon = candidate.icon;
            const chosen = idea === candidate.id;
            const text = t(candidate.text);
            return (
              <button
                key={candidate.id}
                type="button"
                aria-pressed={chosen}
                title={text}
                onClick={() => pick(candidate.id, text)}
                onPointerEnter={() => setPeek(text)}
                onPointerLeave={() => setPeek(null)}
                onFocus={() => setPeek(text)}
                onBlur={() => setPeek(null)}
                className={cn(
                  "animate-rise inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.97]",
                  chosen ? "border-accent/45 bg-accent/10 text-ink" : "border-hairline/50 bg-card/40 text-ink-secondary hover:border-hairline hover:bg-card hover:text-ink",
                )}
                style={staggerIndex(4 + index)}
              >
                <Icon size={13} aria-hidden="true" className={chosen ? "text-accent" : undefined} />
                {t(candidate.label)}
              </button>
            );
          })}
        </div>

        <p className="animate-rise mt-10 text-center text-[13px] leading-relaxed text-ink-secondary" style={staggerIndex(8)}>
          {t("cloudIntent.notSure")}{" "}
          <button type="button" onClick={skip} className="rounded font-medium text-ink underline decoration-ink-secondary/40 underline-offset-[3px] transition-colors hover:decoration-ink">
            {t("cloudIntent.skip")}
          </button>
          <kbd className="ml-1.5 rounded border border-hairline/60 px-1 py-px font-sans text-[11px] text-ink-secondary">Esc</kbd>
          <br />
          {t("cloudIntent.later")}
        </p>
      </div>
    </main>
  );
}
