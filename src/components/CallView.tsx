// Call mode — the bot on the line.
//
// The loop is deliberately HALF-DUPLEX: the microphone is live only when
// the bot is not speaking. The dictation helper is Apple's SFSpeechRecognizer
// running on raw AVAudioEngine input with no acoustic echo cancellation, so
// a mic left open through playback transcribes the bot's own voice back into
// the conversation and the two of them talk forever. Interrupting is a tap
// or Escape instead, which is honest and cannot feed back. (Full-duplex
// barge-in needs AEC on the capture path — a follow-up, not a footnote.)
//
// Turn-taking uses a small silence endpointer in the native helper. Apple's
// buffer-backed recognizer does not finalize on silence by itself: the helper
// has to end the audio stream, which then produces the final transcript.
//
// The other half of making a call bearable is narration. An agent turn is
// 5-60 seconds of tool calls; silence that long reads as a dropped call. So
// every activity chip the harness narrates (`tool.spoken`) is read aloud as
// it happens, which is why waiting feels like listening to someone work
// rather than listening to nothing.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Phone, PhoneOff, X } from "lucide-react";
import { ThinkingOrb } from "thinking-orbs";

import { useStore, visibleMessages, type Bot } from "@/state/store";
import { currentCall, deferCallCleanup, endCall, startCall, useOnCall } from "@/lib/call";
import { speaker } from "@/lib/tts";
import { localSystemVoiceActive } from "@/lib/local-voice";
import { useSpeech } from "@/lib/tts/useSpeech";
import { useCallTalk } from "@/lib/push-to-talk";
import { BotAvatar } from "./Avatar";
import { isRoutineApproval, isSkillApproval, pendingApprovals, spokenApprovalPrompt } from "./PendingApproval";
import { cn } from "@/lib/cn";
import { track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { createOfflineCallStt } from "@/lib/offline-call-stt";
import { Liquid } from "liquid-gooey";
import { MetalFx } from "metal-fx";

/** Spoken answers to a permission card. Anything else is read as a reply
 * to the bot, not as consent — an approval must never be granted by a
 * sentence that merely contained the word "sure". */
const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|approve|approved|fine|please do)\b/i;
const NO = /^(no|nope|don'?t|do not|stop|deny|denied|cancel|never|skip it)\b/i;

type Phase = "listening" | "sending" | "working" | "speaking";
const CALL_ENDPOINT_MS = 850;

export function CallButton({ bot }: { bot: Bot }) {
  return (
    <CallTargetButton
      targetId={bot.id}
      targetName={bot.name}
      voices={[bot.voice]}
      setupBotId={bot.id}
      requireExplicitVoices={false}
      onStart={() => track("call_started", { driver: bot.modelSelection?.instanceId })}
    />
  );
}

export function CallTargetButton({
  targetId,
  targetName,
  voices,
  setupBotId,
  requireExplicitVoices,
  onStart,
}: {
  targetId: string;
  targetName: string;
  voices: Array<string | undefined>;
  /** Agent profile to open when voice setup is missing (rooms choose a member). */
  setupBotId?: string;
  /** Rooms cannot rely on one workspace fallback for multiple speakers. */
  requireExplicitVoices: boolean;
  onStart: () => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const active = useOnCall() === targetId;
  const supported =
    (capabilities.dictation.available && Boolean(window.ogb?.speechStart)) ||
    Boolean(window.ogb?.handyTranscribeFile);
  const localVoice = localSystemVoiceActive();
  const configured = localVoice || Boolean(state.config?.tts?.configured);
  const everyTargetHasVoice = voices.length > 0 && voices.every((voice) => Boolean(voice));
  const voiceReady =
    localVoice ||
    (configured && (requireExplicitVoices ? everyTargetHasVoice : Boolean(state.config?.tts?.ready || everyTargetHasVoice)));
  const unavailable = !active && (!capabilitiesReady || !supported || !voiceReady);
  const voiceSetupRequired = capabilitiesReady && supported && !voiceReady;
  const [helpOpen, setHelpOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const helpId = useId();
  const label = active
    ? `Hang up on ${targetName}`
    : !capabilitiesReady
      ? "Checking call availability"
      : !supported
        ? "Calls need the desktop app with offline dictation"
        : !configured
          ? "Set up a voice in an agent profile to make calls"
          : !voiceReady
            ? "Pick a voice in an agent profile to make calls"
            : `Call ${targetName}`;

  const reason = !capabilitiesReady
    ? "Checking whether this device can make calls."
    : !supported
      ? "Offline calls need Handy. Set its path in Settings → Voice & Handy."
        : !configured
          ? "Choose an offline Piper voice, a built-in Mac voice, or configure ElevenLabs for call playback."
          : !voiceReady
            ? voices.length > 1
              ? "Give every group member a voice before starting a group call."
              : "Choose a voice before starting a call."
            : "";

  useEffect(() => {
    if (!helpOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setHelpOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHelpOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [helpOpen]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        onClick={() => {
          if (active) return endCall(targetId);
          if (unavailable) {
            setHelpOpen((open) => !open);
            return;
          }
          onStart();
          startCall(targetId);
        }}
        aria-expanded={unavailable ? helpOpen : undefined}
        aria-controls={unavailable ? helpId : undefined}
        aria-label={label}
        title={label}
        className={cn(
          "relative flex size-9 items-center justify-center rounded-full transition-colors",
          active
            ? "bg-danger text-white hover:brightness-110"
            : unavailable
              ? "text-ink-secondary/50 hover:bg-raised hover:text-ink-secondary"
              : "text-ink-secondary hover:bg-raised hover:text-ink",
        )}
      >
        {active ? <PhoneOff size={17} /> : <Phone size={17} />}
        {unavailable && (
          <span className="absolute right-1 top-1 size-1.5 rounded-full bg-warning ring-2 ring-app" aria-hidden="true" />
        )}
      </button>

      {unavailable && helpOpen && (
        <div
          id={helpId}
          role="group"
          aria-label="Call unavailable"
          className="animate-pop-in absolute right-0 z-30 mt-1.5 w-[280px] rounded-xl border border-hairline bg-panel p-3 text-left shadow-2xl"
        >
          <div className="text-[13px] font-medium text-ink">Call unavailable</div>
          <div className="mt-1 text-[12px] leading-[1.45] text-ink-secondary">{reason}</div>
          {voiceSetupRequired && (
            <button
              type="button"
              onClick={() => {
                setHelpOpen(false);
                if (setupBotId && setupBotId !== targetId) dispatch({ type: "select", id: setupBotId });
                dispatch({ type: "toggleSettings", open: true, section: "voice" });
              }}
              className="mt-2.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
            >
              Open agent settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function CallOverlay({ bot }: { bot: Bot }) {
  const active = useOnCall() === bot.id;
  if (!active) return null;
  return <Call bot={bot} />;
}


function Call({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const speech = useSpeech();
  const initialPhase: Phase = bot.busy ? "working" : "listening";
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState<string | null>(null);
  // The chrome ring and the liquid cluster are both motion. Under the OS
  // reduced-motion preference the ring holds still and the pieces keep their
  // places; the call itself must never depend on an animation.
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  const messages = visibleMessages(bot);
  const approval = pendingApprovals(messages)[0];
  const question = messages.find(
    (message) =>
      message.kind === "options" &&
      message.card?.requestId &&
      !message.card.tool &&
      !message.card.answered &&
      !message.card.dismissed,
  );

  // Everything already on screen when the call starts has been read or
  // ignored — a call must not open by reciting the backlog.
  const spokenIds = useRef<Set<string>>(new Set());
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    for (const m of messages) spokenIds.current.add(m.id);
  }

  // the approval we last asked about aloud, so a card that stays open
  // while the user thinks is not re-read every render
  const askedApproval = useRef<{
    requestId: string;
    routine: boolean;
    skill: boolean;
    submitted: boolean;
  } | null>(null);
  const askedQuestion = useRef<{ requestId: string; messageId: string } | null>(null);
  const phaseRef = useRef<Phase>(initialPhase);
  const alive = useRef(true);
  const sayGeneration = useRef(0);

  /** Change the rendered phase and the synchronous phase used by native
   * callbacks together. React state alone is too late: the helper can exit
   * in the same tick as a final transcript or an intentional mute. */
  const move = useCallback((next: Phase) => {
    phaseRef.current = next;
    if (alive.current) setPhase(next);
  }, []);

  const hush = useCallback(() => {
    void window.ogb?.speechStop();
    // Keep microphone input muted throughout playback.
    offlineSttRef.current?.setMuted(true);
  }, []);

  const offlineSttRef = useRef<ReturnType<typeof createOfflineCallStt> | null>(null);
  const stopOfflineStt = useCallback(() => {
    offlineSttRef.current?.stop();
    offlineSttRef.current = null;
  }, []);
  const ensureOfflineStt = useCallback(() => {
    if (offlineSttRef.current) return offlineSttRef.current;
    if (window.ogb?.platform === "darwin") return null; // Apple Speech's call
    const session = createOfflineCallStt({
      onUtterance: (said) => {
        // Late decodes must not interrupt playback or submit another turn.
        if (!alive.current || currentCall() !== bot.id || phaseRef.current !== "listening") return;
        setHeard(said);
        handleUtterance(said);
      },
      onError: (message) => {
        if (alive.current && currentCall() === bot.id) setNote(message);
      },
    });
    offlineSttRef.current = session;
    return session;
    // session callbacks close over refs only (alive, currentCall(), and
    // the stable handleUtterance captured below); the deps list keeps the
    // closure honest without re-creating the session every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  const talkStart = useCallback(() => {
    if (!alive.current || currentCall() !== bot.id) return;
    // An interruption is speech, not silence: cut the agent off in the same
    // tick. Bumping the generation invalidates the in-flight say(), so the
    // call cannot resume the sentence it was reading.
    if (phaseRef.current === "speaking") {
      sayGeneration.current += 1;
      speaker.stop();
    }
    move("listening");
    const offline = ensureOfflineStt();
    if (offline) {
      offline.setMuted(false);
      // The user owns the end of this turn (the release finalizes it), so the
      // silence endpointer must not ship a half sentence at the first pause.
      offline.holdTurn(true);
      void offline.start().catch((error: unknown) => {
        if (!alive.current || currentCall() !== bot.id) return;
        const message = error instanceof Error ? error.message : String(error);
        setNote(
          /permission|denied/i.test(message)
            ? "Microphone access was denied — allow it, then hold Space to talk."
            : "The microphone couldn't start. Check Microphone access, then hold Space to talk.",
        );
      });
      return;
    }
    void window.ogb?.speechStart({ endpointMs: CALL_ENDPOINT_MS }).catch(() => {
      if (alive.current && currentCall() === bot.id) {
        setNote("The microphone couldn't start. Check Microphone and Speech Recognition access.");
      }
    });
  }, [bot.id, ensureOfflineStt, move]);

  const talkEnd = useCallback(() => {
    const offline = offlineSttRef.current;
    if (offline) {
      // finalize → onUtterance → handleUtterance sends the turn, exactly as an
      // endpointed utterance would.
      offline.finishTurn();
      return;
    }
    void window.ogb?.speechFinish?.();
  }, []);

  // The talk key owns the space bar while this call is up: hold it to talk,
  // and hold it during the agent's own sentence to cut that sentence off.
  const talking = useCallTalk({
    isCallLive: () => alive.current && currentCall() === bot.id,
    onTalkStart: talkStart,
    onTalkEnd: talkEnd,
  });

  const listen = useCallback(() => {
    if (!alive.current || currentCall() !== bot.id) return;
    move("listening");
    setHeard("");
    setNote(null);
    // Handy handles offline listening on non-macOS desktops.
    const offline = ensureOfflineStt();
    if (offline) {
      offline.setMuted(false);
      void offline.start().catch((error) => {
        stopOfflineStt();
        if (alive.current && currentCall() === bot.id) {
          const message = error instanceof Error ? error.message : String(error);
          setNote(/permission|denied/i.test(message) ? "Microphone access was denied — allow it, then call again." : message);
        }
      });
      return;
    }
    // Native on-device recognition remains available on macOS.
    void window.ogb?.speechStart({ endpointMs: CALL_ENDPOINT_MS }).catch(() => {
      if (alive.current && currentCall() === bot.id) {
        setNote("The microphone couldn't start. Check Microphone and Speech Recognition access.");
      }
    });
  }, [bot.id, ensureOfflineStt, move, stopOfflineStt]);

  /** Speak, with the microphone closed for the duration (see the header
   * comment — an open mic during playback is a feedback loop). */
  const say = useCallback(
    async (text: string) => {
      if (!alive.current || currentCall() !== bot.id) return false;
      const mine = ++sayGeneration.current;
      // Move first. stopSpeech() finishes asynchronously, and its close must
      // never observe an old "listening" phase and reopen the mic.
      move("speaking");
      hush();
      await speaker.speak(text, { botId: bot.id, voiceId: bot.voice });
      return alive.current && currentCall() === bot.id && sayGeneration.current === mine;
    },
    [bot.id, bot.voice, hush, move],
  );

  const sayThenListen = useCallback(
    async (text: string) => {
      const stillMine = await say(text);
      if (stillMine && phaseRef.current === "speaking") listen();
    },
    [listen, say],
  );

  // Navigating away from this bot hangs up. Without ownership checking, the
  // overlay disappeared but `currentCall()` remained set and auto-speak was
  // permanently disabled for a call nobody could see.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sayGeneration.current += 1;
      // StrictMode immediately remounts effects once in development. A
      // microtask distinguishes that probe from real navigation: the probe
      // has set alive=true again before this runs; a genuine unmount has not.
      deferCallCleanup(bot.id, () => alive.current);
    };
  }, [bot.id]);

  // ── the microphone ───────────────────────────────────────────────────
  const handleUtterance = useCallback(
    (said: string) => {
      setHeard(said);

      const open = askedApproval.current;
      if (open) {
        if (open.submitted) {
          move("working");
          hush();
          return;
        }
        if (YES.test(said) || NO.test(said)) {
          const allow = YES.test(said);
          if (allow && open.skill) {
            setHeard("");
            void sayThenListen("Open this chat to review the complete skill before enabling it. You can say no now to deny it.");
            return;
          }
          // Keep this request claimed until the server's durable card patch
          // arrives. Clearing it here lets a render in that network gap read
          // and submit the same approval again.
          open.submitted = true;
          move("working");
          hush();
          setHeard("");
          dispatch({
            type: "decideRequest",
            threadId: bot.threadId,
            requestId: open.requestId,
            behavior: allow ? "allow" : "deny",
            message: allow ? undefined : "Denied by the user, on a call.",
            onError: (error: string) => {
              const pending = askedApproval.current;
              if (
                !alive.current ||
                currentCall() !== bot.id ||
                pending?.requestId !== open.requestId ||
                !pending.submitted
              ) return;
              pending.submitted = false;
              const detail = error.trim().slice(0, 240);
              const decision = open.routine ? "routine decision" : "approval";
              void sayThenListen(
                `I couldn't save that ${decision}${detail ? `: ${detail}` : "."} Please try again.`,
              );
            },
          });
          return;
        }
        // not a decision — leave the card up and say so rather than
        // guessing consent from an ambiguous sentence
        void sayThenListen("Sorry — is that a yes or a no?");
        return;
      }

      const openQuestion = askedQuestion.current;
      if (openQuestion) {
        askedQuestion.current = null;
        dispatch({ type: "answerCard", botId: bot.id, threadId: bot.threadId, messageId: openQuestion.messageId, answer: said });
        move("working");
        return;
      }

      move("sending");
      dispatch({ type: "send", botId: bot.id, text: said, threadId: bot.threadId });
    },
    [bot.id, bot.threadId, dispatch, hush, move, sayThenListen],
  );

  useEffect(() => {
    const bridge = window.ogb;
    if (!bridge) return;
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (!alive.current || currentCall() !== bot.id || phaseRef.current !== "listening") return;
      if (line.error) {
        setNote("Dictation stopped unexpectedly. Check Microphone and Speech Recognition access.");
        return;
      }
      if (typeof line.text !== "string") return;
      setHeard(line.text);
      if (line.partial !== false) return;
      // final result — Apple's recognizer decided the turn ended
      const said = line.text.trim();
      if (!said) return listen();
      handleUtterance(said);
    });
    const offEnd = bridge.onSpeechEnd(({ code, reason }) => {
      if (!alive.current || currentCall() !== bot.id) return;
      if (code === 2) {
        if (!offlineSttRef.current) setNote("Offline speech recognition is unavailable in this build.");
        return;
      }
      if (code === 1) {
        setNote(
          reason === "helper-build-failed"
            ? "The dictation helper couldn't be built. Install Apple's Command Line Tools and try again."
            : "Dictation needs Microphone + Speech Recognition access in System Settings.",
        );
        return;
      }
      // the helper exits after every final result; if we are still meant
      // to be listening, that means the user's turn ended — start the next
      if (phaseRef.current === "listening") listen();
    });
    if (bot.busy && !approval && !question) move("working");
    else listen();
    return () => {
      offTranscript();
      offEnd();
      void window.ogb?.speechStop();
      stopOfflineStt();
    };
    // busy/approval are intentionally initial snapshots. Their live changes
    // are handled below without tearing down native event listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, bot.threadId, dispatch, handleUtterance, listen, move, stopOfflineStt]);

  // ── narrate the work, speak the answer, read the approvals ───────────
  useEffect(() => {
    // The request may be resolved from the normal approval UI or by another
    // client while this call is open. Do not keep treating future speech as
    // an answer to a card that no longer exists.
    let resumeAfterRoutine = false;
    if (askedApproval.current && approval?.requestId !== askedApproval.current.requestId) {
      resumeAfterRoutine = askedApproval.current.routine && askedApproval.current.submitted;
      askedApproval.current = null;
    }
    if (askedQuestion.current && question?.card?.requestId !== askedQuestion.current.requestId) {
      askedQuestion.current = null;
    }
    if (!approval && !question && bot.busy && phaseRef.current === "listening") {
      move("working");
      hush();
    }
    if (resumeAfterRoutine && !approval && !question && !bot.busy) {
      listen();
      return;
    }
    // Nothing may reopen capture or narrate new work while the server is
    // durably settling this exact decision.
    if (askedApproval.current?.submitted) return;
    if (approval && askedApproval.current?.requestId !== approval.requestId && phase !== "speaking") {
      askedApproval.current = {
        requestId: approval.requestId,
        routine: isRoutineApproval(approval),
        skill: isSkillApproval(approval),
        submitted: false,
      };
      spokenIds.current.add(approval.message.id);
      const skillPrompt = approval.message.card?.skillRequest?.action === "update"
        ? `${bot.name} wants to update a learned skill. Open this chat to review the complete skill before replacing the current version. You can say no to deny it.`
        : `${bot.name} wants to enable a new learned skill. Open this chat to review the complete skill before enabling it. You can say no to deny it.`;
      void sayThenListen(isSkillApproval(approval) ? skillPrompt : spokenApprovalPrompt(approval, bot.name));
      return;
    }
    if (
      question?.card?.requestId &&
      askedQuestion.current?.requestId !== question.card.requestId &&
      phase !== "speaking"
    ) {
      askedQuestion.current = { requestId: question.card.requestId, messageId: question.id };
      spokenIds.current.add(question.id);
      const detail = question.card.subtitle.trim();
      const choices = question.card.options.length
        ? ` The options are ${question.card.options.join(", ")}.`
        : "";
      void sayThenListen(`${bot.name} asks: ${detail}${/[.!?]$/.test(detail) ? "" : "."}${choices}`);
      return;
    }
    const fresh = messages.filter((m) => !spokenIds.current.has(m.id));
    if (!fresh.length) return;
    // only the newest of each kind matters: a burst of tool chips should
    // not queue thirty seconds of narration behind the actual answer
    const reply = [...fresh].reverse().find((m) => m.role === "bot" && m.kind === "text" && m.text?.trim());
    const chip = [...fresh].reverse().find((m) => m.kind === "activity" && m.tool?.spoken);
    for (const m of fresh) spokenIds.current.add(m.id);

    if (reply?.text) {
      void sayThenListen(reply.text);
    } else if (chip?.tool?.spoken && phase === "working") {
      void say(chip.tool.spoken).then((stillMine) => {
        if (stillMine && phaseRef.current === "speaking") move("working");
      });
    }
  }, [messages, approval, question, phase, bot.busy, bot.name, hush, listen, move, say, sayThenListen]);

  // busy is the harness's word for "a turn is running"
  useEffect(() => {
    if (bot.busy) {
      // An open approval deliberately keeps the mic live for yes/no. Every
      // other busy phase is half-duplex and must close capture.
      if (phaseRef.current !== "speaking" && !askedApproval.current && !askedQuestion.current) {
        move("working");
        hush();
      }
    } else if (
      phaseRef.current === "working" &&
      !askedApproval.current &&
      !askedQuestion.current &&
      !speaker.isSpeaking()
    ) {
      // A failed/cancelled turn may have no reply to trigger the normal
      // speak-then-listen path. Recover the call instead of staying stuck.
      listen();
    }
  }, [bot.busy, hush, listen, move]);

  // Escape hangs up. The space bar is deliberately NOT handled here: useCallTalk
  // owns it (hold to talk, hold during a sentence to interrupt), and two
  // handlers on one key would both fire on the same press.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      endCall(bot.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bot.id]);

  const mascotState =
    phase === "listening" ? "listening" : phase === "speaking" ? "sending" : phase === "sending" ? "thinking" : "working";
  const status =
    phase === "listening"
      ? talking
        ? "Talking — release Space to send"
        : "Listening — hold Space to talk"
      : phase === "sending"
        ? "One moment"
        : phase === "speaking"
          ? bot.name
          : "Working";

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-app/95 backdrop-blur-sm">
      <button
        onClick={() => endCall(bot.id)}
        aria-label="Hang up"
        className="absolute right-5 top-5 rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        <X size={18} />
      </button>

      <BotAvatar bot={bot} state={mascotState} size={220} animated trackPointer />

      <div className="flex flex-col items-center gap-1.5 text-center">
        <div className="text-[20px] font-medium text-ink">{bot.name}</div>
        <div className="flex items-center gap-2 text-[13.5px] text-ink-secondary">
          {phase === "sending" || phase === "working" ? (
            <ThinkingOrb state={phase === "sending" ? "connecting" : "searching"} size={20} />
          ) : phase === "listening" && heard ? (
            <ThinkingOrb state="listening" size={20} />
          ) : null}
          {status}
        </div>
      </div>

      {/* one line, whichever is current: what you're saying, or what it is */}
      <div className="min-h-[3.5rem] max-w-[560px] px-6 text-center text-[15px] leading-relaxed text-ink">
        {phase === "listening" ? (
          heard || (
            <span className="text-ink-secondary">
              {talking ? "Release Space to send…" : "Say something… hold Space to talk"}
            </span>
          )
        ) : (
          speech.caption
        )}
      </div>

      {note && (
        <div className="flex max-w-[460px] flex-col items-center gap-2 text-center text-[12.5px] text-warning">
          <span>{note}</span>
          <button
            onClick={listen}
            className="rounded-full border border-warning/40 px-3 py-1.5 text-[12px] hover:bg-warning/10"
          >
            Try microphone again
          </button>
        </div>
      )}
      {speech.error && <div className="max-w-[420px] text-center text-[12.5px] text-danger">{speech.error}</div>}

      {/* The call's controls as one liquid mass: pieces merge where they meet,
          and the talk pill — the gesture that actually drives the call — wears
          the chrome ring. `strength` tracks the talk state so the ring is lit
          while the user is speaking and dim when the agent has the floor. */}
      <Liquid
        blur={6}
        contrast={18}
        fill="var(--color-panel)"
        shadow="0 2px 10px rgba(0,0,0,.45)"
        className="flex items-center gap-2.5"
      >
        {speaker.isSpeaking() && (
          <Liquid.Item transition="bouncy">
            <button
              onClick={() => {
                sayGeneration.current += 1;
                speaker.stop();
                listen();
              }}
              className="rounded-full border border-hairline/50 px-4 py-2 text-[13.5px] text-ink hover:bg-raised"
            >
              Interrupt
            </button>
          </Liquid.Item>
        )}
        <Liquid.Item transition="bouncy" delay={40}>
          <MetalFx
            variant="button"
            preset="chromatic"
            strength={talking ? 1 : 0.35}
            paused={reducedMotion}
            className="rounded-full"
          >
            <div
              aria-live="polite"
              className={cn("px-5 py-2.5 text-[13.5px]", talking ? "text-ink" : "text-ink-secondary")}
            >
              {talking ? "Talking — release Space" : "Hold Space to talk"}
            </div>
          </MetalFx>
        </Liquid.Item>
        <Liquid.Item transition="bouncy" delay={80}>
          <button
            onClick={() => endCall(bot.id)}
            className="flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"
          >
            <PhoneOff size={16} /> Hang up
          </button>
        </Liquid.Item>
      </Liquid>

      <div className="text-[11.5px] text-ink-secondary/70">
        Hold Space to talk · Space also interrupts · Esc hangs up
      </div>
    </div>
  );
}
