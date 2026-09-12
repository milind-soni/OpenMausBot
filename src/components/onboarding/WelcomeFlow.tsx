// The welcome flow: one card, one guide, a handful of beats. The card is the
// same element for the whole flow and morphs between beats with the View
// Transitions API (the card, the mascot and the title keep their names, so
// the browser moves and resizes them instead of cross-fading two cards).
// The guide mascot is mounted once so its face engine carries over; beats
// borrow it through setMascot/bump rather than rendering their own.
//
// Nothing here can brick the app: every beat is skippable, Escape skips the
// whole tour, and completion is written to the workspace config. A failed
// write still dismisses this visit, but may require retrying on the next launch.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { MausAvatar } from "@/components/Avatar";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { setEmailGateDone, track } from "@/lib/analytics";
import { brand } from "@/lib/brand";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { MausMotion, MausState } from "@/lib/mascot";
import {
  beatWidth,
  beatsFor,
  completionPatch,
  nextBeat,
  previousBeat,
  type BeatId,
} from "@/lib/onboarding";
import { api, useStore, type Bot } from "@/state/store";
import { EnginesBeat } from "./beats/EnginesBeat";
import { HelloBeat } from "./beats/HelloBeat";
import { MeetYourBotBeat } from "./beats/MeetYourBotBeat";
import { PermissionsBeat } from "./beats/PermissionsBeat";
import { PhoneBeat } from "./beats/PhoneBeat";
import { QuietButton } from "./beats/shared";
import { withViewTransition } from "./view-transition";
import { ProgressDots } from "./ProgressDots";
import { FeatureReel } from "./reel/FeatureReel";

/** The guide's resting face per beat; beats may override it as they learn
 * more (the engines beat looks proud or curious once the harness answers). */
const MASCOT_FOR_BEAT: Record<BeatId, MausState> = {
  hello: "happy",
  reel: "curious",
  engines: "searching",
  permissions: "listening",
  phone: "sending",
  bot: "celebrate",
};

function beatTitle(beat: BeatId): string | null {
  switch (beat) {
    case "hello":
      return t("onboarding.welcome", { app: brand().name });
    case "engines":
      return t("onboarding.engines.title");
    case "permissions":
      return t("onboarding.perms.title");
    case "bot":
      return t("onboarding.bot.title");
    case "reel":
      return t("onboarding.reel.title");
    case "phone":
      return t("onboarding.phone.title");
  }
}

type Motion = Exclude<MausMotion, "none">;

export function WelcomeFlow({
  bot,
  onDone,
  replay = false,
  initialBeat,
  embedded = false,
  reel = true,
  dictation,
  entrance = "arrive",
}: {
  /** The seeded bot the exit beat names; null when the roster is empty. */
  bot: Bot | null;
  onDone: () => void;
  /** Replays skip nothing but are tracked separately. */
  replay?: boolean;
  /** Preview only: open on a given beat. */
  initialBeat?: BeatId;
  /** Preview only: fill the parent instead of the viewport. */
  embedded?: boolean;
  /** The feature reel beat; the preview gallery turns it off. */
  reel?: boolean;
  /** Preview only: pretend the microphone can be asked for (or not). */
  dictation?: boolean;
  /** The guide's first motion beat on mount. */
  entrance?: Motion;
}) {
  const { dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const beats = beatsFor({ dictation: dictation ?? capabilities.dictation.available, reel });
  const [beat, setBeat] = useState<BeatId>(() => (initialBeat && beats.includes(initialBeat) ? initialBeat : "hello"));
  const [mascot, setMascot] = useState<MausState>(MASCOT_FOR_BEAT[beat]);
  const [motion, setMotion] = useState<{ kind: Motion; key: number }>({ kind: "blink", key: 0 });
  const cardRef = useRef<HTMLDivElement>(null);
  const finishing = useRef(false);

  const bump = useCallback((kind: Motion) => setMotion((m) => ({ kind, key: m.key + 1 })), []);

  // The entrance waits one frame. A spin issued in the same commit that
  // mounts the avatar lands before its engine has drawn, and the face never
  // comes back; the mascot gallery never hits this because its motions are
  // always triggered on an avatar that is already on screen.
  useEffect(() => {
    const frame = requestAnimationFrame(() => bump(entrance));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    track("onboarding_step", { step: beat, replay });
  }, [beat, replay]);

  /** Move to another beat. The View Transitions API snapshots the old card,
   * applies the state change synchronously, then animates named elements to
   * their new place; without it (or under reduced motion) the swap is instant. */
  const go = useCallback(
    (target: BeatId) => {
      withViewTransition(() => {
        setBeat(target);
        setMascot(MASCOT_FOR_BEAT[target]);
      });
      bump("switch");
    },
    [bump],
  );

  const finish = useCallback(
    async (reason: "completed" | "skipped") => {
      if (finishing.current) return;
      finishing.current = true;
      track("onboarding_completed", { reason, at: beat, replay });
      // one release of the old browser-side gate, so a downgrade stays quiet
      setEmailGateDone("submitted");
      // A slow/offline server must not trap the user behind the welcome card.
      onDone();
      try {
        const config = await api("/api/config", { method: "PUT", body: JSON.stringify(completionPatch()), signal: AbortSignal.timeout(10_000) });
        dispatch({ type: "configStatus", config });
      } catch {
        // offline or a paired client without admin scope: the caller still
        // closes the tour; it comes back next launch, which is the honest state
      }
    },
    [beat, dispatch, onDone, replay],
  );

  const next = nextBeat(beats, beat);
  const previous = previousBeat(beats, beat);
  const advance = useCallback(() => {
    if (next) go(next);
    else void finish("completed");
  }, [next, go, finish]);

  // Escape skips the tour; Tab stays inside the card.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      void finish("skipped");
      return;
    }
    if (event.key !== "Tab" || !cardRef.current) return;
    const focusable = Array.from(
      cardRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Keyboard focus lands on the beat's first real control: an autofocused
  // input where there is one, else the primary button. Never the card
  // itself, which would draw the focus ring around the whole dialog, and
  // never "Skip tour", which is first in the DOM but last in intent.
  useEffect(() => {
    const card = cardRef.current;
    if (!card || card.contains(document.activeElement)) return;
    const target =
      card.querySelector<HTMLElement>("[autofocus], input, textarea, select") ??
      card.querySelector<HTMLElement>("[data-primary]") ??
      card;
    target.focus({ preventScroll: true });
  }, [beat]);

  const hello = beat === "hello";
  const title = beatTitle(beat);
  const logo = hello ? brand().logo : undefined;
  const beatProps = { onNext: advance, onSkip: advance, setMascot, bump };
  const current = beats.indexOf(beat) + 1;

  return (
    <div
      className={cn(
        "flex items-center justify-center bg-app p-3 sm:p-8",
        embedded ? "relative h-full w-full" : "fixed inset-0 z-50",
      )}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("onboarding.dialog")}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="welcome-card relative flex max-h-full w-full flex-col overflow-y-auto rounded-2xl border border-hairline/40 bg-panel p-5 sm:p-8 shadow-[0_30px_80px_-28px_rgba(0,0,0,0.45),0_8px_24px_-12px_rgba(0,0,0,0.25)] outline-none"
        style={{ maxWidth: beatWidth(beat) }}
      >
        <QuietButton onClick={() => void finish("skipped")} className="absolute right-4 top-4">
          {t("onboarding.skipTour")}
        </QuietButton>

        <div className={cn("flex shrink-0", hello ? "flex-col items-center" : "items-center gap-3")}>
          <div className="welcome-maus flex shrink-0">
            {logo ? (
              <img src={logo} alt="" width={72} height={72} className="h-[72px] w-[72px] object-contain" />
            ) : (
              <MausAvatar
                color="green"
                state={mascot}
                motion={motion.kind}
                motionKey={motion.key}
                size={hello ? 72 : 40}
                label={brand().name}
              />
            )}
          </div>
          {title && (
            <h1 className={cn("welcome-title font-semibold text-ink", hello ? "mt-4 text-[20px]" : "text-[18px]")}>
              {title}
            </h1>
          )}
        </div>

        {/* keyed so a beat's rise-in plays once per visit, never on re-render */}
        <div key={beat} className="flex shrink-0 flex-col">
          {beat === "hello" && <HelloBeat {...beatProps} />}
          {beat === "reel" && <FeatureReel {...beatProps} />}
          {beat === "engines" && <EnginesBeat {...beatProps} />}
          {beat === "permissions" && <PermissionsBeat {...beatProps} />}
          {beat === "phone" && <PhoneBeat {...beatProps} />}
          {beat === "bot" && (
            <MeetYourBotBeat
              bot={bot}
              onFinish={() => void finish("completed")}
              setMascot={setMascot}
              bump={bump}
            />
          )}
        </div>

        <div className="mt-6 flex shrink-0 items-center justify-between">
          {previous ? (
            <QuietButton onClick={() => go(previous)}>{t("onboarding.back")}</QuietButton>
          ) : (
            <span />
          )}
          <ProgressDots items={beats.map((id) => ({ id }))} index={current - 1} />
          <span className="text-[11px] text-ink-secondary" aria-live="polite">
            {t("onboarding.progress", { current, total: beats.length })}
          </span>
        </div>
      </div>
    </div>
  );
}
