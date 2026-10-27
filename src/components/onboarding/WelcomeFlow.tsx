import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { CloudOffer } from "../../../electron/cloud-home.mjs";
import { MausAvatar } from "@/components/Avatar";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { setEmailGateDone, track } from "@/lib/analytics";
import { brand } from "@/lib/brand";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { MausMotion, MausState } from "@/lib/mascot";
import { detectSetupWithin, localSetupImport, setupImportApi, type SetupImportClient } from "@/lib/setup-import";
import {
  aiWorks,
  beatWidth,
  beatsFor,
  completionPatch,
  flowProgress,
  markWelcomeFinished,
  nextBeat,
  previousBeat,
  resumeBeat,
  showWelcome,
  type BeatId,
} from "@/lib/onboarding";
import { clearWelcomeDraft, readWelcomeDraft, saveWelcomeDraft, type WelcomeFields } from "@/lib/welcome-draft";
import { api, useStore } from "@/state/store";
import { CloudBeat, useCloudBeatOffer } from "./beats/CloudBeat";
import type { SetupDetection, SetupImportResult } from "../../../shared/setup-import";
import { EnginesBeat } from "./beats/EnginesBeat";
import { useWelcomeAi } from "./welcome-ai";
import { HelloBeat } from "./beats/HelloBeat";
import { ImportBeat } from "./beats/ImportBeat";
import { PermissionsBeat } from "./beats/PermissionsBeat";
import { QuietButton } from "./beats/shared";
import { settleWelcomeProfile, type SavedProfile } from "./save-profile";
import { withViewTransition } from "./view-transition";
import { ProgressDots } from "./ProgressDots";

const MASCOT_FOR_BEAT: Record<BeatId, MausState> = {
  hello: "happy",
  engines: "searching",
  import: "receiving",
  permissions: "listening",
  cloud: "working",
};

function beatTitle(beat: BeatId): string | null {
  switch (beat) {
    case "hello":
      return t("onboarding.welcome", { app: brand().name });
    case "engines":
      return t("onboarding.engines.title");
    case "import":
      return t("onboarding.import.title");
    case "permissions":
      return t("onboarding.perms.title");
    case "cloud":
      return t("onboarding.cloud.title");
  }
}

type Motion = Exclude<MausMotion, "none">;

/** Found later than these, the import step would land behind the person, so it is left out. */
const BEFORE_IMPORT: readonly BeatId[] = ["hello", "engines"];

/** After a step changes, Next, Continue and Back wait this long (and for the card's morph), so a double click moves one step. */
export const STEP_HOLD_MS = 450;
/** ...but never longer than this, should a transition never report that it finished. */
const STEP_HOLD_CAP_MS = 3_000;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function WelcomeFlow({
  onDone,
  replay = false,
  initialBeat: requestedBeat,
  embedded = false,
  dictation,
  entrance = "arrive",
  hosted = false,
  onOpenOrganisation,
  cloudOffer,
  setupImport,
}: {
  onDone: () => void;
  replay?: boolean;
  initialBeat?: BeatId;
  embedded?: boolean;
  dictation?: boolean;
  entrance?: Motion;
  hosted?: boolean;
  onOpenOrganisation?: () => void;
  /** The preview's stand-in for the Admin's offer (the Cloud beat); the app reads its own. */
  cloudOffer?: CloudOffer | null;
  /** Where the import step looks; the desktop app's own window looks on its own server. `detection` skips the look. */
  setupImport?: { client: SetupImportClient; detection?: SetupDetection } | null;
}) {
  const { state, dispatch } = useStore();
  // A first run keeps its step and typed fields in this browser as it goes, so a reload resumes it; a replay starts over.
  // A hosted workspace's greeting asks nothing, and its browser may hold another person's draft.
  const keepsDraft = !replay && !embedded && !hosted;
  const [resumed] = useState(() => (keepsDraft ? readWelcomeDraft() : null));
  const initialBeat = requestedBeat ?? resumed?.beat;
  const [fields, setFields] = useState<WelcomeFields>(() => ({ name: resumed ? resumed.name : state.config?.profile?.name ?? "" }));
  const { capabilities } = useDesktopCapabilities();
  const offer = useCloudBeatOffer(hosted, cloudOffer);
  const importClient = setupImport === undefined ? (localSetupImport(hosted) ? setupImportApi : null) : setupImport?.client ?? null;
  const [detection, setDetection] = useState<SetupDetection | null>(setupImport?.detection ?? null);
  const [importResult, setImportResult] = useState<SetupImportResult | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const aiStepShown = useRef(initialBeat === "engines");
  // An AI already works only once it answered a test message; OpenCode's free backup never counts.
  const workingAi = useWelcomeAi(state.instances, !hosted);
  const aiReady = !aiStepShown.current && aiWorks(workingAi);
  const beats = beatsFor({ dictation: dictation ?? capabilities.dictation.available, hosted, setupImport: detection !== null, cloud: offer !== null, aiReady });
  const [beat, setBeat] = useState<BeatId>(() => {
    const first = resumeBeat(beats, initialBeat);
    // Opened on Connect an AI (a reload resuming there or after it): it stays, though a working AI turns up meanwhile.
    if (first === "engines") aiStepShown.current = true;
    return first;
  });
  // A saved step offered only once something loads (the import look, the Cloud offer) is opened when it arrives.
  const resumeTo = useRef(initialBeat && !beats.includes(initialBeat) ? initialBeat : null);
  const [moving, setMoving] = useState(false);
  const movingNow = useRef(false);
  const [mascot, setMascot] = useState<MausState>(MASCOT_FOR_BEAT[beat]);
  const [motion, setMotion] = useState<{ kind: Motion; key: number }>({ kind: "blink", key: 0 });
  const cardRef = useRef<HTMLDivElement>(null);
  const finishing = useRef(false);
  const beatNow = useRef(beat);
  const savedProfile = useRef<SavedProfile>({ current: state.config?.profile }).current;
  const live = useRef({ beats, fields });
  live.current = { beats, fields };

  const bump = useCallback((kind: Motion) => setMotion((m) => ({ kind, key: m.key + 1 })), []);

  // One frame late: a motion issued in the avatar's mounting commit is lost.
  useEffect(() => {
    const frame = requestAnimationFrame(() => bump(entrance));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    beatNow.current = beat;
    track("onboarding_step", { step: beat, replay });
  }, [beat, replay]);

  useEffect(() => {
    if (keepsDraft && !finishing.current) saveWelcomeDraft({ beat, ...fields });
  }, [keepsDraft, beat, fields]);

  // A Cloud sheet opened over the welcome never switches the window away from it (CloudAddDialog).
  useEffect(() => (embedded ? undefined : showWelcome()), [embedded]);
  // Looked for once, from the first beat; nothing found in time leaves the step out.
  useEffect(() => {
    if (!importClient || detection) return;
    const look = detectSetupWithin(importClient);
    void look.found.then((found) => {
      if (found && BEFORE_IMPORT.includes(beatNow.current)) setDetection(found);
    });
    return look.cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every step change holds Next, Continue and Back until the new step has arrived: a second click lands on its buttons.
  const moveTo = useCallback(
    (target: BeatId) => {
      movingNow.current = true;
      setMoving(true);
      resumeTo.current = null;
      beatNow.current = target;
      if (target === "engines") aiStepShown.current = true;
      const transition = withViewTransition(() => {
        setBeat(target);
        setMascot(MASCOT_FOR_BEAT[target]);
      });
      bump("switch");
      const arrived = Promise.all([transition?.finished.catch(() => {}), delay(STEP_HOLD_MS)]);
      void Promise.race([arrived, delay(STEP_HOLD_CAP_MS)]).then(() => {
        movingNow.current = false;
        setMoving(false);
      });
    },
    [bump],
  );
  // Only from the step on screen, and never while a step is still arriving.
  const go = useCallback(
    (from: BeatId, target: BeatId) => {
      if (!movingNow.current && beatNow.current === from) moveTo(target);
    },
    [moveTo],
  );

  // The saved step, once offered, unless the person has already started using the welcome (resumeTo is then gone).
  const offered = beats.join(" ");
  useEffect(() => {
    const target = resumeTo.current;
    if (!target || movingNow.current || !live.current.beats.includes(target)) return;
    moveTo(target);
  }, [offered, moveTo]);

  const finish = useCallback(
    async (reason: "completed" | "skipped") => {
      if (finishing.current) return;
      finishing.current = true;
      track("onboarding_completed", { reason, at: beat, replay });
      setEmailGateDone("submitted");
      if (!replay && !embedded) markWelcomeFinished();
      if (keepsDraft) clearWelcomeDraft();
      // What the greeting typed is kept however the welcome ends (Maybe later, Skip, Escape); a hosted greeting types nothing.
      if (!hosted) void settleWelcomeProfile(live.current.fields, savedProfile, dispatch).catch(() => {});
      onDone();
      try {
        const config = await api("/api/config", { method: "PUT", body: JSON.stringify(completionPatch()), signal: AbortSignal.timeout(10_000) });
        dispatch({ type: "configStatus", config });
      } catch {
      }
    },
    [beat, dispatch, onDone, replay, embedded, keepsDraft, hosted],
  );

  const previous = previousBeat(beats, beat);
  const advanceFrom = useCallback(
    (from: BeatId) => {
      if (movingNow.current || beatNow.current !== from) return;
      const target = nextBeat(live.current.beats, from);
      if (target) go(from, target);
      else void finish("completed");
    },
    [go, finish],
  );
  const advance = useCallback(() => advanceFrom(beat), [advanceFrom, beat]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    resumeTo.current = null;
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

  useEffect(() => {
    const card = cardRef.current;
    if (moving || !card || card.contains(document.activeElement)) return;
    const target =
      card.querySelector<HTMLElement>("[autofocus], input, textarea, select") ??
      card.querySelector<HTMLElement>("[data-primary]") ??
      card;
    target.focus({ preventScroll: true });
  }, [beat, moving]);

  const hello = beat === "hello";
  const title = beatTitle(beat);
  const logo = hello ? brand().logo : undefined;
  const beatProps = { onNext: advance, onSkip: advance, setMascot, bump };
  const { current, total } = flowProgress(beats, beat);
  const skip = (className: string) => (
    <QuietButton onClick={() => void finish("skipped")} className={className}>
      {t("onboarding.skipSetup")}
    </QuietButton>
  );

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
        onPointerDown={() => { resumeTo.current = null; }}
        className="welcome-card relative flex max-h-full w-full flex-col overflow-y-auto rounded-2xl border border-hairline/40 bg-panel p-5 sm:p-8 shadow-[0_30px_80px_-28px_rgba(0,0,0,0.45),0_8px_24px_-12px_rgba(0,0,0,0.25)] outline-none"
        style={{ maxWidth: beatWidth(beat) }}
      >
        {hello && skip("absolute right-4 top-4")}

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
            <h1 className={cn("welcome-title min-w-0 font-semibold text-ink [overflow-wrap:anywhere]", hello ? "mt-4 text-center text-[20px]" : "flex-1 text-[18px]")}>
              {title}
            </h1>
          )}
          {/* In the title's row, never over it: a long title (or a narrow phone) wraps beside Skip. */}
          {!hello && skip("shrink-0 self-start")}
        </div>

        <div key={beat} inert={moving} aria-busy={moving} className={cn("flex flex-col", beat === "engines" ? "min-h-0" : "shrink-0")}>
          {beat === "hello" && <HelloBeat {...beatProps} hosted={hosted} fields={fields} onFields={setFields} saved={savedProfile} />}
          {beat === "engines" && <EnginesBeat {...beatProps} hosted={hosted} onOpenOrganisation={onOpenOrganisation} />}
          {beat === "import" && detection && importClient && (
            <ImportBeat
              {...beatProps}
              detection={detection}
              client={importClient}
              result={importResult}
              onResult={(result) => setImportResult((stored) => stored ?? result)}
              onBusy={setImportBusy}
            />
          )}
          {beat === "permissions" && <PermissionsBeat {...beatProps} />}
          {beat === "cloud" && offer && <CloudBeat {...beatProps} offer={offer} />}
        </div>

        {total > 1 && (
          <div className="mt-6 flex shrink-0 items-center justify-between">
            {previous ? (
              <QuietButton onClick={() => go(beat, previous)} disabled={importBusy || moving} className="disabled:opacity-50">{t("onboarding.back")}</QuietButton>
            ) : (
              <span />
            )}
            <ProgressDots items={beats.map((id) => ({ id }))} index={current - 1} />
            <span className="text-[11px] text-ink-secondary" aria-live="polite">
              {t("onboarding.progress", { current, total })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
