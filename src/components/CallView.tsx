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
import { AudioLines, Check, ChevronDown, Loader2, Phone, PhoneOff, X } from "lucide-react";

import { useStore, visibleMessages, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { currentCall, deferCallCleanup, endCall, startCall, useOnCall } from "@/lib/call";
import { CALL_MODES, callModeHint, setCallMode, useCallMode, type CallMode } from "@/lib/call-mode";
import { NO, YES } from "../../shared/call-consent";
import { dismissKeyPrompt, hangUpLiveCall, isLiveCallRunning, startLiveCall, useLiveMedia } from "@/lib/live-call-media";
import { t } from "@/lib/i18n";
import { speaker } from "@/lib/tts";
import { localSystemVoiceActive } from "@/lib/local-voice";
import { useSpeech } from "@/lib/tts/useSpeech";
import { usePushToTalk } from "@/lib/push-to-talk";
import { BotAvatar } from "./Avatar";
import { navigateThreadMenu } from "./BotProjects";
import { LiveKeySetup } from "./LiveKeySetup";
import { liveLineHeldElsewhere } from "./LiveCallBar";
import { isRoutineApproval, isSkillApproval, pendingApprovals, spokenApprovalPrompt } from "./PendingApproval";
import { track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { callCapabilityHelp } from "@/lib/call-capability";
import { VoiceSetupDialog } from "./VoiceSetupDialog";

type Phase = "listening" | "sending" | "working" | "speaking";
const CALL_ENDPOINT_MS = 850;

/** Where a call button sits: the header's icon row (rooms), or the composer's
 * action row (a bot's chat), where it is a filled circle the size of Send and
 * its help opens upward, away from the bottom edge of the window. */
export type CallButtonPlacement = "header" | "composer";

export function CallButton({ bot, placement = "header" }: { bot: Bot; placement?: CallButtonPlacement }) {
  return (
    <CallTargetButton
      placement={placement}
      targetId={bot.id}
      targetName={bot.name}
      threadId={bot.threadId}
      voices={[bot.voice]}
      setupBotId={bot.id}
      requireExplicitVoices={false}
      liveCapable
      onStart={(mode) => track("call_started", { driver: bot.modelSelection?.instanceId, mode })}
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
}: {
  placement?: CallButtonPlacement;
  targetId: string;
  targetName: string;
  /** The thread a Live call joins (the chat on screen). Live needs it. */
  threadId?: string;
  voices: Array<string | undefined>;
  /** The agent whose voice the set-up pop-up edits when voice is missing
   * (rooms choose a member). */
  setupBotId?: string;
  /** Rooms cannot rely on one workspace fallback for multiple speakers. */
  requireExplicitVoices: boolean;
  /** One-to-one calls can also run as a Live (GPT-Live) call, which needs
   * neither on-device dictation nor a configured voice. */
  liveCapable?: boolean;
  /** A call started, in this mode (analytics). The call itself is started
   * here: Take turns opens the overlay, Live goes to the call bar. */
  onStart: (mode: CallMode) => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const media = useLiveMedia();
  const liveThreadId = liveCapable ? threadId : undefined;
  const canLive = liveThreadId !== undefined;
  // This window's Live call with this target. The media module also marks
  // the target as on a call (startCall), so check Live first.
  const liveRunning = isLiveCallRunning(media.phase);
  const onLiveCall = canLive && liveRunning && media.botId === targetId;
  // One call at a time: a Live call with someone else blocks this button
  // (a second Live call cannot start, and Take turns would talk over it).
  const liveElsewhere = liveRunning && media.botId !== targetId;
  const onCall = useOnCall() === targetId;
  const active = onCall || onLiveCall;
  // Paired to another computer, the voice engine and its key stay on the
  // host, and the pairing takes agent changes only through the profile route
  // the remote agent settings save with. There, voice set-up opens those
  // settings, as it always did, instead of the pop-up.
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
  const mode = useCallMode();
  const liveMode = canLive && mode === "live";
  const turnsReady = capabilitiesReady && supported && voiceReady;
  const unavailable = !active && !liveElsewhere && !liveMode && !turnsReady;
  const voiceSetupRequired = capabilitiesReady && supported && !voiceReady;
  const liveConfigured = Boolean(state.config?.live?.configured);
  // On the person's Cloud, the Live key is saved there, not on this computer.
  const cloudHome = state.config?.cloudHome === true;
  const [helpOpen, setHelpOpen] = useState(false);
  // Voice set-up opens over the chat instead of the bot's full settings.
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false);
  // In a room the pop-up moves on to the next member without a voice; once
  // every member has one it stays on the last, instead of jumping back to
  // the first member (the room's fallback).
  const [voiceSetupBotId, setVoiceSetupBotId] = useState(setupBotId);
  if (voiceSetupRequired && setupBotId !== voiceSetupBotId) setVoiceSetupBotId(setupBotId);
  const shownSetupBotId = voiceSetupRequired ? setupBotId : voiceSetupBotId;
  const setupBot = shownSetupBotId ? state.bots.find((candidate) => candidate.id === shownSetupBotId) : undefined;
  const helpMotion = useMenuMotion(Boolean(unavailable && helpOpen));
  const [menuOpen, setMenuOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  // the harness answered "no key" to this window's call attempt (the key was
  // removed, or this window's config was stale): ask for it here too
  const keyPopover = canLive && !active && (keyOpen || (media.needsKey && media.botId === targetId));
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const keyRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const menuId = useId();
  const keyId = useId();
  const elsewhereName = liveElsewhere ? state.bots.find((candidate) => candidate.id === media.botId)?.name : undefined;
  const composer = placement === "composer";
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
    setKeyOpen(false);
    dismissKeyPrompt(targetId);
  }, [targetId]);

  // The "no key" answer belongs to this chat's call attempt: leaving the
  // chat drops it, so it never reopens (and takes focus) on a later visit.
  useEffect(() => () => dismissKeyPrompt(targetId), [targetId]);

  /** Start a call in this mode. Live never opens the overlay: the media
   * module marks the call and the call bar shows it. */
  const start = (next: CallMode) => {
    setHelpOpen(false);
    setMenuOpen(false);
    if (next === "live" && liveThreadId !== undefined) {
      if (!liveConfigured) {
        setKeyOpen(true);
        return;
      }
      setKeyOpen(false);
      onStart("live");
      void startLiveCall({ botId: targetId, threadId: liveThreadId, cloudHome });
      return;
    }
    if (!turnsReady) {
      setHelpOpen(true);
      return;
    }
    onStart("turns");
    startCall(targetId);
  };

  const popoverOpen = helpOpen || menuOpen || keyPopover;
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

  // Keyboard users land in the key field when the prompt opens, not when a
  // prompt that was already open is shown again.
  const keyShown = useRef(keyPopover);
  useEffect(() => {
    const opened = keyPopover && !keyShown.current;
    keyShown.current = keyPopover;
    if (opened) keyRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [keyPopover]);

  const opensKey = liveMode && !active && (!liveConfigured || keyPopover);
  // Another device (a phone, another window) holds the one Live line: no
  // button that would start a Live call here, as on the iPhone. The remote
  // bar in that call's chat says who is on the line and can hang up. Take
  // turns never uses the Live line, so its call, and the Hang up of one
  // already running, stay.
  if (liveMode && !onCall && liveLineHeldElsewhere(media, state.liveCall)) return null;
  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        ref={buttonRef}
        disabled={liveElsewhere || (onLiveCall && media.phase === "ending")}
        onClick={() => {
          if (onLiveCall) {
            void hangUpLiveCall();
            return;
          }
          if (onCall) return endCall(targetId);
          if (keyPopover) {
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
        aria-expanded={unavailable ? helpOpen : opensKey ? keyPopover : undefined}
        aria-controls={unavailable ? helpId : opensKey ? keyId : undefined}
        aria-label={label}
        title={label}
        data-call-button={placement}
        className={cn(
          "relative flex shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-60",
          composer ? "size-8" : "size-9",
          active
            ? "bg-danger text-white hover:brightness-110"
            : composer
              ? unavailable
                ? "bg-control text-ink-tertiary hover:text-ink-secondary"
                : "bg-control text-ink hover:bg-raised"
              : unavailable
                ? "text-ink-tertiary hover:bg-raised hover:text-ink-secondary"
                : "text-ink-secondary hover:bg-raised hover:text-ink",
        )}
      >
        {active
          ? <PhoneOff size={composer ? 15 : 17} />
          : composer ? <AudioLines size={16} aria-hidden="true" /> : <Phone size={17} />}
        {unavailable && (
          <span className="absolute right-1 top-1 size-1.5 rounded-full bg-warning ring-2 ring-app" aria-hidden="true" />
        )}
      </button>
      {canLive && (
        <button
          ref={chevronRef}
          type="button"
          // a mode is picked before a call, not during one
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
          className={cn("-ml-1 flex w-4 items-center justify-center rounded-full text-ink-secondary transition-colors hover:text-ink disabled:opacity-40", composer ? "h-8" : "h-9")}
        >
          <ChevronDown size={13} className={cn("transition-transform", menuOpen && "rotate-180")} />
        </button>
      )}

      {menuOpen && (
        <CallModeMenu
          id={menuId}
          mode={mode}
          placement={placement}
          cloudHome={cloudHome}
          onClose={closePopovers}
          onChoose={(next) => {
            // picking a mode remembers it and starts a call in it
            setCallMode(next);
            start(next);
          }}
        />
      )}

      {keyPopover && liveThreadId !== undefined && (
        <div
          ref={keyRef}
          id={keyId}
          className={cn("animate-pop-in absolute right-0 z-30 w-[340px] max-w-[90vw] rounded-xl shadow-2xl", composer ? "bottom-full mb-1.5" : "top-full mt-1.5")}
        >
          <LiveKeySetup
            key={`${targetId}:${liveThreadId}`}
            compact
            onSaved={() => {
              setKeyOpen(false);
              onStart("live");
              void startLiveCall({ botId: targetId, threadId: liveThreadId, cloudHome });
            }}
          />
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
          {capabilityHelp?.action === "choose-local-workspace" && (
            <button
              type="button"
              onClick={() => {
                setHelpOpen(false);
                void window.ogb?.workspaces?.menu();
              }}
              className="mt-2.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
            >
              Choose This computer
            </button>
          )}
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
                  // In a room the agent is a member: open its chat first.
                  if (setupBot.id !== targetId) dispatch({ type: "select", id: setupBot.id });
                  dispatch({ type: "toggleSettings", open: true, section: "voice" });
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

/** The menu under the call button's chevron: Take turns or Live. */
export function CallModeMenu({ id, mode, onChoose, onClose, placement = "header", cloudHome = false }: {
  id: string;
  mode: CallMode;
  placement?: CallButtonPlacement;
  /** On the person's Cloud: the Live hint says the key stays there. */
  cloudHome?: boolean;
  onChoose: (mode: CallMode) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // keyboard users land on the current mode
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
      className={cn("animate-pop-in absolute right-0 z-30 w-[280px] rounded-xl border border-hairline bg-panel p-1.5 text-left shadow-2xl", placement === "composer" ? "bottom-full mb-1.5" : "top-full mt-1.5")}
    >
      {CALL_MODES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="menuitemradio"
          aria-checked={mode === entry.id}
          onClick={() => onChoose(entry.id)}
          className={cn(
            "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-raised focus-visible:bg-raised",
            mode === entry.id && "bg-raised/60",
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-ink">{t(entry.label)}</span>
            <span className="mt-0.5 block text-[11.5px] leading-[1.4] text-ink-secondary">{callModeHint(entry.id, { cloudHome })}</span>
          </span>
          {mode === entry.id && <Check size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}

export function CallOverlay({ bot }: { bot: Bot }) {
  const active = useOnCall() === bot.id;
  const media = useLiveMedia();
  // A Live call lives in the call bar; only Take turns uses the overlay.
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
    };
    // busy/approval are intentionally initial snapshots. Their live changes
    // are handled below without tearing down native event listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, bot.threadId, dispatch, hush, listen, move, sayThenListen]);

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

  // Escape hangs up; space interrupts whatever is being said
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
        <div className="flex items-center gap-2 text-[13.5px] text-ink-secondary">
          {(phase === "working" || phase === "sending") && <Loader2 size={13} className="animate-spin" />}
          {status}
        </div>
      </div>

      {/* one line, whichever is current: what you're saying, or what it is */}
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

      <div className="flex items-center gap-3">
        {speaker.isSpeaking() && (
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
        )}
        <button
          onClick={() => endCall(bot.id)}
          className="flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"
        >
          <PhoneOff size={16} /> Hang up
        </button>
      </div>

      <div className="text-[11.5px] text-ink-tertiary">
        Hold Control + Option to talk · Space interrupts · Esc hangs up
      </div>
    </>
  );
}
