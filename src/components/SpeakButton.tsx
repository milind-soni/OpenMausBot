import { Loader2, Square, Volume2 } from "lucide-react";

import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import type { ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ACTION_ICON } from "@/components/MessageActions";

/** Read one message aloud. Hover-revealed beside the copy control, and it
 * becomes a stop button while this message is the one speaking — the same
 * button, because "speak" and "shut up" are the same intent twice.
 *
 * Without a key it stays visible but disabled, saying what it needs: a
 * hidden button is a feature nobody discovers. It sits in every answer, so
 * it takes the speech settings and this device's voice choice from its row
 * instead of following the whole store. */
type SpeakArgs = {
  text: string;
  botId?: string;
  messageId: string;
  voiceId?: string;
  /** The server's speech settings (`config.tts`). */
  tts: ConfigStatus["tts"];
  /** A paired Mac reads aloud with its own voices ("This Mac"). */
  localVoice: boolean;
};

/** What reading one message aloud needs, for the button and the menu row. */
export function useSpeakAction({ text, botId, messageId, voiceId, tts, localVoice }: SpeakArgs) {
  const speech = useSpeech();
  const configured = localVoice || Boolean(tts?.configured);
  const ready = localVoice || (configured && Boolean(voiceId || tts?.voice));
  const mine = speech.messageId === messageId && speech.status !== "idle";
  const preparing = mine && speech.status === "preparing";
  const label = !configured
    ? t((tts?.provider ?? "elevenlabs") === "elevenlabs" ? "chat.speak.needsKey" : "chat.speak.needsSetup")
    : !ready
      ? t("chat.speak.needsVoice")
    : mine
      ? t("chat.speak.stop")
      : t("chat.speak.read");
  const toggle = () => {
    if (mine) return speaker.stop();
    void speaker.speak(text, { botId, messageId, voiceId });
  };
  return { ready, mine, preparing, label, toggle };
}

export function SpeakButton({ className, ...args }: SpeakArgs & { className?: string }) {
  const { ready, mine, preparing, label, toggle } = useSpeakAction(args);
  return (
    <button
      onClick={toggle}
      disabled={!ready}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-md p-1.5 text-ink-secondary transition-opacity hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-secondary",
        // stays visible while speaking — a stop button you have to hunt for
        // is not a stop button
        mine ? "text-accent opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100",
        className,
      )}
    >
      {preparing ? <Loader2 {...ACTION_ICON} className="animate-spin" /> : mine ? <Square {...ACTION_ICON} className="fill-current" /> : <Volume2 {...ACTION_ICON} />}
    </button>
  );
}
