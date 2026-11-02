// Half-duplex: the dictation helper is Apple's SFSpeechRecognizer on raw AVAudioEngine input with no echo cancellation,
// so a mic open during playback transcribes the bot's own voice back. The buffer-backed recognizer does not finalize on
// silence; the helper ends the stream.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AudioLines, Check, ChevronDown, Loader2, Phone, PhoneOff, X } from "lucide-react";

import { useShowThreads } from "@/lib/thread-preferences";
import { openBot, useStore, visibleMessages, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { currentCall, deferCallCleanup, endCall, startCall, useOnCall } from "@/lib/call";
import { CALL_MODES, callModeHint, effectiveCallMode, setCallMode, useCallMode, type CallMode } from "@/lib/call-mode";
import { NO, YES } from "../../shared/call-consent";
import { dismissStartPrompt, hangUpLiveCall, isLiveCallRunning, startLiveCall, useLiveMedia } from "@/lib/live-call-media";
import { t } from "@/lib/i18n";
import { speaker } from "@/lib/tts";
import { localSystemVoiceActive } from "@/lib/local-voice";
import { useSpeech } from "@/lib/tts/useSpeech";
import { usePushToTalk } from "@/lib/push-to-talk";
import { BotAvatar } from "./Avatar";
import { navigateThreadMenu } from "./BotProjects";
import { LiveKeyNeeded } from "./LiveKeyNeeded";
import { liveLineHeldElsewhere } from "./LiveCallBar";
import { isRoutineApproval, isSkillApproval, pendingApprovals, spokenApprovalPrompt } from "./PendingApproval";
import { callStarted } from "@/lib/product-events";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { callCapabilityHelp, type CallCapabilityHelp } from "@/lib/call-capability";
import { onCallStartRequest } from "@/lib/call-start-request";
import { VoiceSetupDialog } from "./VoiceSetupDialog";
import { openBotSettings } from "./bot-panel/panel-link";
import { MENU_SHEET } from "./menu-recipe";

type Phase = "listening" | "sending" | "working" | "speaking";
const CALL_ENDPOINT_MS = 850;

/** `panel`: the small round button beside the bot in its panel, with no chevron. It leaves the composer's + menu to the
 * composer's own button: two buttons answering it would start two calls. */
export type CallButtonPlacement = "header" | "composer" | "panel";

/** `fill` (Simple composer): a round button in that colour with its glyph in `ink`, and no chevron; the + menu picks the
 * call mode. */
/** `inverse` (phone composer): a round ink-coloured button with an app-coloured glyph: white on Midnight, dark on Meadow. */
export function CallButton({ bot, placement = "header", fill, ink, inverse }: { bot: Bot; placement?: CallButtonPlacement; fill?: string; ink?: string; inverse?: boolean }) {
  const { state } = useStore();
  return (
    <CallTargetButton
      placement={placement}
      fill={fill}
      ink={ink}
      inverse={inverse}
      targetId={bot.id}
      targetName={bot.name}
      threadId={bot.threadId}
      voices={[bot.voice]}
      setupBotId={bot.id}
      requireExplicitVoices={false}
      liveCapable
      onStart={(mode) => callStarted(state.instances, bot.modelSelection?.instanceId, mode)}
    />
  );
}

export function CallTargetButton({
  targetId,
  targetName,
  threadId,
  voices,
  setupBotId,
  requireExplicitVoices,
  liveCapable = false,
  onStart,
  placement = "header",
  fill,
  ink = "#ffffff",
  inverse,
}: {
  placement?: CallButtonPlacement;
  fill?: string;
  ink?: string;
  inverse?: boolean;
  targetId: string;
  targetName: string;
  threadId?: string;
  voices: Array<string | undefined>;
  setupBotId?: string;
  requireExplicitVoices: boolean;
  liveCapable?: boolean;
  onStart: (mode: CallMode) => void;
}) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const media = useLiveMedia();
  const liveThreadId = liveCapable ? threadId : undefined;
  const canLive = liveThreadId !== undefined;
  // Check Live first: startCall also marks the target as on a call.
  const liveRunning = isLiveCallRunning(media.phase);
  const onLiveCall = canLive && liveRunning && media.botId === targetId;
  const liveElsewhere = liveRunning && media.botId !== targetId;
  const onCall = useOnCall() === targetId;
  const active = onCall || onLiveCall;
  const remoteClient = globalThis.window?.ogb?.remoteClient?.active === true;
  const capabilityHelp = capabilitiesReady
    ? callCapabilityHelp(capabilities, Boolean(window.ogb?.speechStart))
    : null;
  const supported = capabilitiesReady && !capabilityHelp;
  const localVoice = localSystemVoiceActive();
  const configured = localVoice || Boolean(state.config?.tts?.configured);
  const everyTargetHasVoice = voices.length > 0 && voices.every((voice) => Boolean(voice));
  const voiceReady =
    localVoice ||
    (configured && (requireExplicitVoices ? everyTargetHasVoice : Boolean(state.config?.tts?.ready || everyTargetHasVoice)));
  const turnsHere = !capabilitiesReady || capabilities.dictation.available;
  const mode = effectiveCallMode(useCallMode(), { turnsHere, canLive });
  const liveMode = canLive && mode === "live";
  const turnsReady = capabilitiesReady && supported && voiceReady;
  const unavailable = !active && !liveElsewhere && !liveMode && !turnsReady;
  const lineHeldElsewhere = liveMode && !onCall && liveLineHeldElsewhere(media, state.liveCall);
  const voiceSetupRequired = capabilitiesReady && supported && !voiceReady;
  const cloudHome = state.config?.cloudHome === true;
  const [helpOpen, setHelpOpen] = useState(false);
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false);
  const [voiceSetupBotId, setVoiceSetupBotId] = useState(setupBotId);
  if (voiceSetupRequired && setupBotId !== voiceSetupBotId) setVoiceSetupBotId(setupBotId);
  const shownSetupBotId = voiceSetupRequired ? setupBotId : voiceSetupBotId;
  const setupBot = shownSetupBotId ? state.bots.find((candidate) => candidate.id === shownSetupBotId) : undefined;
  const helpMotion = useMenuMotion(Boolean(unavailable && helpOpen));
  const [menuOpen, setMenuOpen] = useState(false);
  const startPrompt = canLive && !active && media.needsKey && media.botId === targetId;
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const keyRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const menuId = useId();
  const keyId = useId();
  const elsewhereName = liveElsewhere ? state.bots.find((candidate) => candidate.id === media.botId)?.name : undefined;
  const composer = placement === "composer";
  const round = Boolean(fill) || Boolean(inverse) || placement === "panel";
  const label = active
    ? t("call.hangUpOn", { name: targetName })
    : liveElsewhere
      ? elsewhereName ? t("call.live.pill", { name: elsewhereName }) : t("call.live.badge")
      : liveMode
      ? t("call.live.callWith", { name: targetName })
      : !capabilitiesReady
      ? "Checking call availability"
      : !supported
        ? capabilityHelp?.label ?? "Call unavailable"
        : !configured
          ? "Set up a voice in an agent profile to make calls"
          : !voiceReady
            ? "Pick a voice in an agent profile to make calls"
            : `Call ${targetName}`;

  const reason = !capabilitiesReady
    ? "Checking whether this device can make calls."
    : capabilityHelp
      ? capabilityHelp.reason
        : !configured
          ? "Set up ElevenLabs, Fish Audio, Chatterbox, or a built-in Mac voice so the bot can speak during calls."
          : !voiceReady
            ? voices.length > 1
              ? "Give every group member a voice before starting a group call."
              : "Choose a voice before starting a call."
            : "";

  const closePopovers = useCallback(() => {
    setHelpOpen(false);
    setMenuOpen(false);
    dismissStartPrompt(targetId);
  }, [targetId]);

  useEffect(() => () => dismissStartPrompt(targetId), [targetId]);

  const start = (next: CallMode) => {
    setHelpOpen(false);
    setMenuOpen(false);
    if (next === "live" && liveThreadId !== undefined) {
      onStart("live");
      void startLiveCall({ botId: targetId, threadId: liveThreadId });
      return;
    }
    if (!turnsReady) {
      setHelpOpen(true);
      return;
    }
    onStart("turns");
    startCall(targetId);
  };

  // The Simple composer's + menu: the same choice as this button's own call-mode menu, which it replaces there.
  const requestedStart = useRef<(next: CallMode) => void>(() => {});
  requestedStart.current = (next) => {
    // Hidden below while Live's line is held on another device: the + menu must not start a second call either.
    if (active || liveElsewhere || (next === "live" && !canLive) || lineHeldElsewhere) return;
    closePopovers();
    setCallMode(next);
    start(next);
  };
  const answersPlusMenu = placement !== "panel";
  useEffect(() => answersPlusMenu ? onCallStartRequest(targetId, (next) => requestedStart.current(next)) : undefined, [targetId, answersPlusMenu]);

  const popoverOpen = helpOpen || menuOpen || startPrompt;
  useEffect(() => {
    if (!popoverOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) closePopovers();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closePopovers();
      (menuOpen ? chevronRef : buttonRef).current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [popoverOpen, menuOpen, closePopovers]);

  const keyShown = useRef(startPrompt);
  useEffect(() => {
    const opened = startPrompt && !keyShown.current;
    keyShown.current = startPrompt;
    if (opened) keyRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [startPrompt]);

  if (lineHeldElsewhere) return null;
  return (
    <div ref={rootRef} className="relative flex items-center gap-0.5">
      <button
        ref={buttonRef}
        disabled={liveElsewhere || (onLiveCall && media.phase === "ending")}
        onClick={() => {
          if (onLiveCall) {
            void hangUpLiveCall();
            return;
          }
          if (onCall) return endCall(targetId);
          if (startPrompt) {
            closePopovers();
            return;
          }
          if (unavailable) {
            setMenuOpen(false);
            setHelpOpen((open) => !open);
            return;
          }
          start(liveMode ? "live" : "turns");
        }}
        aria-expanded={unavailable ? helpOpen : startPrompt ? true : undefined}
        aria-controls={unavailable ? helpId : startPrompt ? keyId : undefined}
        aria-label={label}
        title={label}
        data-call-button={placement}
        style={fill && !active ? { backgroundColor: fill, color: ink } : undefined}
        className={cn(
          "relative flex shrink-0 items-center justify-center disabled:opacity-60",
          round ? "rounded-full transition-[color,background,filter]" : "rounded-l-3xl rounded-r-lg active:rounded-3xl transition-[color,background,border-radius]",
          composer && fill ? "size-7" : composer || placement === "panel" ? "size-8" : "size-9",
          active
            ? "bg-danger text-white hover:brightness-110"
            : inverse
              ? "bg-ink text-app hover:opacity-90 max-md:size-9"
            : fill
              ? "hover:brightness-110"
            : placement === "panel"
              ? unavailable ? "bg-ink/[0.06] text-ink-tertiary hover:text-ink-secondary" : "bg-ink/[0.06] text-ink hover:bg-ink/[0.11]"
            : composer
              ? unavailable
                ? "bg-control text-ink-tertiary hover:text-ink-secondary"
                : "bg-control text-ink hover:bg-raised-hover"
              : unavailable
                ? "text-ink-tertiary hover:bg-raised-hover hover:text-ink-secondary"
                : "text-ink-secondary hover:bg-raised-hover hover:text-ink",
        )}
      >
        {active
          ? <PhoneOff size={composer || round ? 15 : 17} />
          : composer ? fill ? <AudioLines size={15} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" /> : <AudioLines size={16} aria-hidden="true" /> : <Phone size={round ? 15 : 17} />}
        {unavailable && (
          <span className="absolute right-1 top-1 size-1.5 rounded-full bg-warning ring-2 ring-app" aria-hidden="true" />
        )}
      </button>
      {canLive && !round && (
        <button
          ref={chevronRef}
          type="button"
          disabled={active || liveElsewhere}
          onClick={() => {
            const opening = !menuOpen;
            closePopovers();
            setMenuOpen(opening);
          }}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          aria-label={t("call.mode.menu")}
          title={t("call.mode.menu")}
          className={cn(
              "grid place-content-center",
              "bg-control w-8 hover:bg-raised-hover text-ink-secondary hover:text-ink disabled:opacity-40 transition-colors",
              "rounded-l-lg rounded-r-3xl active:rounded-3xl transition-[color,background,border-radius]",
              composer ? "h-8" : "h-9"
            )}
        >
          <ChevronDown size={13} className={cn("transition-transform", menuOpen && "rotate-180")} />
        </button>
      )}

      {menuOpen && (
        <CallModeMenu
          id={menuId}
          mode={mode}
          turnsUnavailable={turnsHere ? null : capabilityHelp}
          placement={placement}
          cloudHome={cloudHome}
          onClose={closePopovers}
          onChoose={(next) => {
            setCallMode(next);
            start(next);
          }}
        />
      )}

      {startPrompt && (
        <div
          ref={keyRef}
          id={keyId}
          className={cn("animate-pop-in absolute right-0 z-30 w-[340px] max-w-[90vw] rounded-xl shadow-2xl", composer ? "bottom-full mb-1.5" : "top-full mt-1.5")}
        >
          <LiveKeyNeeded />
        </div>
      )}

      {helpMotion.shown && (
        <div
          id={helpId}
          role="group"
          aria-label="Call unavailable"
          className={cn("absolute right-0 z-30 w-[280px]", composer ? "bottom-full mb-1.5" : "mt-1.5", "rounded-xl border border-hairline bg-panel p-3 text-left shadow-2xl", helpMotion.className)} {...helpMotion.exitProps}
        >
          <div className="text-[13px] font-medium text-ink">Call unavailable</div>
          <div className="mt-1 text-[12px] leading-[1.45] text-ink-secondary">{reason}</div>
          {canLive && (
            <button
              type="button"
              onClick={() => {
                setCallMode("live");
                start("live");
              }}
              className="mt-2.5 mr-2 rounded-lg border border-hairline px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-raised"
              title={callModeHint("live", { cloudHome })}
            >
              {t("call.live.startInstead")}
            </button>
          )}
          {voiceSetupRequired && setupBot && (
            <button
              type="button"
              aria-haspopup={remoteClient ? undefined : "dialog"}
              data-voice-setup-open
              onClick={() => {
                setHelpOpen(false);
                if (remoteClient) {
                  if (setupBot.id !== targetId) openBot(dispatch, setupBot, showThreads);
                  openBotSettings(dispatch, "voice");
                  return;
                }
                setVoiceSetupOpen(true);
              }}
              className="mt-2.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink hover:brightness-110"
            >
              {t("call.voiceSetup.open")}
            </button>
          )}
        </div>
      )}

      {voiceSetupOpen && setupBot && (
        <VoiceSetupDialog
          bot={setupBot}
          callName={targetName}
          ready={supported && voiceReady}
          returnFocusRef={buttonRef}
          onClose={() => setVoiceSetupOpen(false)}
          onStartCall={() => {
            setVoiceSetupOpen(false);
            start("turns");
          }}
        />
      )}
    </div>
  );
}

export function CallModeMenu({ id, mode, onChoose, onClose, placement = "header", cloudHome = false, turnsUnavailable = null }: {
  id: string;
  mode: CallMode;
  turnsUnavailable?: CallCapabilityHelp | null;
  placement?: CallButtonPlacement;
  cloudHome?: boolean;
  onChoose: (mode: CallMode) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, []);
  return (
    <div
      ref={ref}
      id={id}
      role="menu"
      aria-label={t("call.mode.menu")}
      onKeyDown={(event) => {
        if (event.key === "Tab") onClose();
        else navigateThreadMenu(event);
      }}
      className={cn("animate-pop-in absolute right-0 z-30 w-[280px] text-left", MENU_SHEET, placement === "composer" ? "bottom-full mb-1.5" : "top-full mt-1.5")}
    >
      {CALL_MODES.map((entry) => {
        const unavailable = entry.id === "turns" ? turnsUnavailable : null;
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitemradio"
            aria-checked={mode === entry.id}
            // aria-disabled, not disabled: arrow keys skip a disabled item, so its reason would never be read out.
            aria-disabled={unavailable ? true : undefined}
            onClick={() => {
              if (!unavailable) onChoose(entry.id);
            }}
            className={cn(
              "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-menu-hover aria-disabled:cursor-default aria-disabled:hover:bg-transparent",
              mode === entry.id && "bg-menu-active",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className={cn("block text-[14px] leading-[18px]", unavailable ? "text-ink-tertiary" : "text-ink")}>{t(entry.label)}</span>
              <span className="mt-0.5 block text-[12px] leading-[1.4] text-ink-secondary">
                {unavailable ? `${unavailable.label}. ${unavailable.reason}` : callModeHint(entry.id, { cloudHome })}
              </span>
            </span>
            {mode === entry.id && <Check size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

export function CallOverlay({ bot }: { bot: Bot }) {
  const active = useOnCall() === bot.id;
  const media = useLiveMedia();
  const onLiveCall = media.botId === bot.id && isLiveCallRunning(media.phase);
  if (!active || onLiveCall) return null;
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-app/95 backdrop-blur-sm">
      <Call key="turns" bot={bot} />
    </div>
  );
}

function Call({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const speech = useSpeech();
  const initialPhase: Phase = bot.busy ? "working" : "listening";
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const pushToTalk = usePushToTalk(bot.id, phase === "listening", () => {
    setNote("Push to talk couldn't start. Check Microphone and Speech Recognition access.");
  });

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

  const spokenIds = useRef<Set<string>>(new Set());
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    for (const m of messages) spokenIds.current.add(m.id);
  }

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

  /** React state alone is too late: the helper can exit in the same tick as a final transcript or a mute. */
  const move = useCallback((next: Phase) => {
    phaseRef.current = next;
    if (alive.current) setPhase(next);
  }, []);

  const hush = useCallback(() => {
    void window.ogb?.speechStop();
  }, []);

  const listen = useCallback(() => {
    if (!alive.current || currentCall() !== bot.id) return;
    move("listening");
    setHeard("");
    setNote(null);
    void window.ogb?.speechStart({ endpointMs: CALL_ENDPOINT_MS }).catch(() => {
      if (alive.current && currentCall() === bot.id) {
        setNote("The microphone couldn't start. Check Microphone and Speech Recognition access.");
      }
    });
  }, [bot.id, move]);

  const say = useCallback(
    async (text: string) => {
      if (!alive.current || currentCall() !== bot.id) return false;
      const mine = ++sayGeneration.current;
      // Move first: stopSpeech() closes asynchronously and must never observe an old "listening" phase and reopen the
      // mic.
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

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sayGeneration.current += 1;
      // StrictMode remounts effects once in development; a microtask tells that probe from real navigation.
      deferCallCleanup(bot.id, () => alive.current);
    };
  }, [bot.id]);

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
      const said = line.text.trim();
      if (!said) return listen();

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
          // Stay claimed until the server's card patch arrives, or a render in that gap submits the same approval
          // again.
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
    });
    const offEnd = bridge.onSpeechEnd(({ code, reason }) => {
      if (!alive.current || currentCall() !== bot.id) return;
      if (code === 2) {
        setNote("Calls need macOS dictation, which isn't available here yet.");
        return;
      }
      if (code === 1) {
        setNote(
          reason === "helper-build-failed"
            ? "The dictation helper couldn't be built. Install Apple's Command Line Tools and try again."
            : reason === "dictation-disabled"
              ? "Turn on Dictation in System Settings → Keyboard, then try again."
              : reason === "speech-not-authorized"
                ? "Allow Speech Recognition in System Settings → Privacy & Security, then try again."
                : "Dictation couldn't start. Try again.",
        );
        return;
      }
      if (phaseRef.current === "listening") listen();
    });
    if (bot.busy && !approval && !question) move("working");
    else listen();
    return () => {
      offTranscript();
      offEnd();
      void window.ogb?.speechStop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, bot.threadId, dispatch, hush, listen, move, sayThenListen]);

  useEffect(() => {
    // The card may be resolved elsewhere (the approval UI, another client) while this call is open.
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

  useEffect(() => {
    if (bot.busy) {
      // An open approval keeps the mic live for yes/no; every other busy phase is half-duplex and must close capture.
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
      listen();
    }
  }, [bot.busy, hush, listen, move]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        endCall(bot.id);
      } else if (e.code === "Space" && speaker.isSpeaking()) {
        e.preventDefault();
        sayGeneration.current += 1;
        speaker.stop();
        listen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bot.id, listen]);

  const mascotState =
    phase === "listening" ? "listening" : phase === "speaking" ? "sending" : phase === "sending" ? "thinking" : "working";
  const status =
    phase === "listening"
      ? pushToTalk
        ? "Push to talk"
        : "Listening"
      : phase === "sending"
        ? "One moment"
        : phase === "speaking"
          ? bot.name
          : "Working";

  return (
    <>
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
        <div className="flex items-center gap-2 text-[14px] text-ink-secondary">
          {(phase === "working" || phase === "sending") && <Loader2 size={13} className="animate-spin" />}
          {status}
        </div>
      </div>

      <div className="min-h-[3.5rem] max-w-[560px] px-6 text-center text-[15px] leading-relaxed text-ink">
        {phase === "listening" ? (
          heard || (
            <span className="text-ink-secondary">
              {pushToTalk ? "Release Control + Option to send…" : "Say something…"}
            </span>
          )
        ) : (
          speech.caption
        )}
      </div>

      {note && (
        <div className="flex max-w-[460px] flex-col items-center gap-2 text-center text-[13px] text-warning">
          <span>{note}</span>
          <button
            onClick={listen}
            className="rounded-full border border-warning/40 px-3 py-1.5 text-[12px] hover:bg-warning/10"
          >
            Try microphone again
          </button>
        </div>
      )}
      {speech.error && <div className="max-w-[420px] text-center text-[13px] text-danger">{speech.error}</div>}

      <div className="flex items-center gap-3">
        {speaker.isSpeaking() && (
          <button
            onClick={() => {
              sayGeneration.current += 1;
              speaker.stop();
              listen();
            }}
            className="rounded-full border border-hairline/50 px-4 py-2 text-[14px] text-ink hover:bg-raised"
          >
            Interrupt
          </button>
        )}
        <button
          onClick={() => endCall(bot.id)}
          className="flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"
        >
          <PhoneOff size={16} /> Hang up
        </button>
      </div>

      <div className="text-[12px] text-ink-tertiary">
        Hold Control + Option to talk · Space interrupts · Esc hangs up
      </div>
    </>
  );
}
