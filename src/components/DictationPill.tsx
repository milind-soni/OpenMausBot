// Status surfaces for dictation, bottom-center:
//   - hold-Ctrl+Space clipboard dictation (a border-beam glow marks the
//     live hold, since it ends the moment the keys release);
//   - the "Luna" wake word: armed indicator, live partials while a
//     wake-triggered transcript is captured, and errors.
// Renders nothing in the browser/dev (no bridge) and when there is nothing
// to show.
import { useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { BorderBeam } from "border-beam";
import { ThinkingOrb } from "thinking-orbs";

import { t } from "@/lib/i18n";
import { useClipboardDictation } from "@/lib/clipboard-dictation";
import { createWakeWordSession, wakeWordSupported, WakeWordController } from "@/lib/wake-word";
import { speaker } from "@/lib/tts";
import { currentCall } from "@/lib/call";
import { useStore } from "@/state/store";

export function DictationPill() {
  const { state } = useStore();
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<number | undefined>(undefined);

  const flash = (message: string) => {
    window.clearTimeout(noteTimer.current);
    setNote(message);
    noteTimer.current = window.setTimeout(() => setNote(null), 5000);
  };

  const active = useClipboardDictation(
    (text) => {
      const write = window.ogb?.writeClipboardText?.(text);
      if (!write) {
        flash("Clipboard unavailable");
        return;
      }
      write
        .then((result) => flash(result.written ? `Copied: ${text}` : "Clipboard unavailable"))
        .catch(() => flash("Clipboard unavailable"));
    },
    (message) => flash(message),
  );

  // Wake word: owned here so the detector lives exactly as long as the pill
  // (which is mounted for the whole app session). Suspension follows the
  // speaker and the call state; a detection starts one wake session whose
  // partials render in place of the idle indicator.
  const wakeEnabled = state.config?.features?.wakeWord === true && wakeWordSupported();
  const [wakeArmed, setWakeArmed] = useState(false);
  const [wakeActive, setWakeActive] = useState(false);
  const [wakeTranscribing, setWakeTranscribing] = useState(false);
  const [wakePartial, setWakePartial] = useState("");
  const wakeSessionRef = useRef<ReturnType<typeof createWakeWordSession> | null>(null);
  const controllerRef = useRef<WakeWordController | null>(null);

  useEffect(() => {
    if (!wakeEnabled) return;
    const wakeSession = createWakeWordSession({
      onActiveChange: (next) => {
        setWakeActive(next);
        if (!next) {
          setWakePartial("");
          setWakeTranscribing(false);
        }
      },
      onPartial: setWakePartial,
      onTranscribing: () => setWakeTranscribing(true),
      onError: (message) => flash(message),
    });
    wakeSessionRef.current = wakeSession;
    const controller = new WakeWordController({
      onDetected: () => {
        setWakePartial("");
        wakeSession.start();
      },
      onError: (message) => flash(message),
      onArmedChange: setWakeArmed,
    });
    controllerRef.current = controller;
    void (async () => {
      try {
        const accessKey = await window.ogb?.picovoiceAccessKey?.();
        if (!accessKey) {
          // No key yet: tell the user once instead of a silently dead toggle.
          flash(t("wake.noAccessKey"));
          return;
        }
        await controller.prepare(accessKey);
        await controller.arm();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        flash(/permission|denied/i.test(message) ? t("wake.micDenied") : t("wake.trainFailed"));
      }
    })();
    return () => {
      wakeSession.dispose();
      wakeSessionRef.current = null;
      void controller.dispose();
      controllerRef.current = null;
    };
  }, [wakeEnabled]);

  // Suspension: the bot speaking or a call owns the mic. The wake session
  // stops its capture too — a transcript half-caught under the bot's voice
  // would be wrong on both sides.
  useEffect(() => {
    if (!wakeEnabled) return;
    const sync = () => {
      const suspend = speaker.isSpeaking() || currentCall() !== null;
      controllerRef.current?.setSuspended(suspend);
      if (suspend) wakeSessionRef.current?.stop();
    };
    sync();
    const unsubscribe = speaker.subscribe(sync);
    const interval = window.setInterval(sync, 500);
    return () => {
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [wakeEnabled]);

  useEffect(() => () => window.clearTimeout(noteTimer.current), []);

  const wakeListening = wakeActive && wakePartial.length > 0;
  if (!active && !note && !(wakeEnabled && wakeArmed) && !wakeListening && !wakeTranscribing) return null;

  return (
    <BorderBeam size="line" colorVariant={active ? "colorful" : "mono"} strength={active ? 0.9 : 0.45} active={active || wakeActive} className="animate-panel-in fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-hairline/40 bg-panel px-3.5 py-1.5 text-[12.5px] text-ink shadow-2xl shadow-black/50">
      {active ? (
        <span className="flex items-center gap-2">
          <Mic size={13} className="text-accent" /> Recording… release to copy
        </span>
      ) : wakeTranscribing ? (
        <span className="flex items-center gap-2 text-ink-secondary">
          <ThinkingOrb state="weaving" size={20} /> {t("wake.transcribing")}
        </span>
      ) : wakeListening ? (
        <span className="flex max-w-[420px] items-center gap-2 truncate" title={wakePartial}>
          <ThinkingOrb state="listening" size={20} paused={Boolean(speaker.isSpeaking())} /> {wakePartial}
        </span>
      ) : wakeActive ? (
        <span className="flex items-center gap-2 text-ink-secondary">
          <ThinkingOrb state="listening" size={20} /> {t("wake.detected")}
        </span>
      ) : wakeEnabled && wakeArmed ? (
        <span className="flex items-center gap-2 text-ink-secondary">
          <Mic size={13} className="text-ink-secondary" /> “Luna”
        </span>
      ) : (
        <span className="block max-w-[420px] truncate" title={note ?? ""}>
          {note}
        </span>
      )}
    </BorderBeam>
  );
}
