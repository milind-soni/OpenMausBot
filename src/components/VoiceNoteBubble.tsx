// One voice note in the transcript: a play button, a scrub bar, and the
// clip's length. Playback rides the Speaker's one-voice rule — pressing
// play claims the window's voice, so call-mode speech (or another note)
// takes over by pausing this element rather than talking over it.
import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

import { attachmentAudioUrl } from "@/lib/composer-attachments";
import { t } from "@/lib/i18n";
import { speaker } from "@/lib/tts";
import { cn } from "@/lib/cn";

/** The wire's audio attachment shape (shared/wire.ts): a parked clip plus
 * the server's duration estimate, used until the element loads metadata. */
export interface VoiceNoteAttachment {
  kind: "audio";
  path: string;
  mime: string;
  durationMs?: number;
}

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function VoiceNoteBubble({
  attachment,
  className,
}: {
  attachment: VoiceNoteAttachment;
  className?: string;
}) {
  const url = attachmentAudioUrl(attachment.path);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const [playing, setPlaying] = useState(false);
  // metadata estimate first, real duration once the element loads it
  const [duration, setDuration] = useState<number | null>(
    typeof attachment.durationMs === "number" && attachment.durationMs > 0
      ? attachment.durationMs / 1000
      : null,
  );
  const [time, setTime] = useState(0);

  // Release the claim on unmount: a gone bubble cannot be paused again, and
  // the singleton must not keep a callback into a dead element.
  useEffect(() => () => releaseRef.current?.(), []);

  if (!url) return null;

  const giveBackVoice = (release?: () => void) => {
    if (release && releaseRef.current !== release) return;
    releaseRef.current?.();
    releaseRef.current = null;
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    // the element's own paused state, not the playing flag: media play
    // events are queued, so a second click before onPlay fires must still
    // read as "playing" and pause instead of claiming and playing again
    if (!audio.paused) {
      audio.pause();
      return;
    }
    // claim before play: the Speaker's stop() path silences call mode and
    // any other note first, then this element takes the voice
    releaseRef.current?.();
    const release = speaker.claimExternalVoice(() => audio.pause());
    releaseRef.current = release;
    // a refused play() never fires pause, so the claim comes back here —
    // but only if this attempt's claim is still the active one
    void audio.play().catch(() => giveBackVoice(release));
  };

  const seek = (next: number) => {
    const audio = audioRef.current;
    if (audio && Number.isFinite(next)) audio.currentTime = next;
    setTime(next);
  };

  return (
    <div
      className={cn("flex w-full items-center gap-3 rounded-xl bg-inset/60 px-3 py-2", className)}
      data-test-voice-note=""
    >
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const loaded = event.currentTarget.duration;
          if (Number.isFinite(loaded) && loaded > 0) setDuration(loaded);
        }}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={(event) => {
          // a queued pause can land after playback already resumed; only
          // a pause that stuck gives the voice back
          if (!event.currentTarget.paused) return;
          setPlaying(false);
          giveBackVoice();
        }}
        onEnded={() => {
          setPlaying(false);
          giveBackVoice();
        }}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? t("chat.voiceNote.pause") : t("chat.voiceNote.play")}
        title={playing ? t("chat.voiceNote.pause") : t("chat.voiceNote.play")}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-opacity hover:opacity-90"
      >
        {playing ? <Pause size={13} className="fill-current" /> : <Play size={13} className="translate-x-px fill-current" />}
      </button>
      <input
        type="range"
        aria-label={t("chat.voiceNote.seek")}
        min={0}
        max={duration ?? 0}
        step={0.1}
        value={Math.min(time, duration ?? time)}
        onChange={(event) => seek(Number(event.currentTarget.value))}
        disabled={!duration}
        className="h-1 flex-1 accent-accent"
      />
      <span className="shrink-0 text-[11px] tabular-nums text-ink-secondary">
        {clock(time)} / {duration === null ? "--:--" : clock(duration)}
      </span>
    </div>
  );
}
