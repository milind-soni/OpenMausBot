// No playback during a Live call: the call's microphone would pick the note up.
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Pause, Play } from "lucide-react";

import { attachmentAudioUrl } from "@/lib/composer-attachments";
import { t } from "@/lib/i18n";
import { isLiveCallRunning, useLiveMedia } from "@/lib/live-call-media";
import { speaker } from "@/lib/tts";
import { cn } from "@/lib/cn";

export interface VoiceNoteAttachment {
  kind: "audio";
  path: string;
  mime: string;
  durationMs?: number;
  /** The words the note speaks; shown behind a collapsed Transcript, never as message body. */
  text?: string;
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
  const [duration, setDuration] = useState<number | null>(
    typeof attachment.durationMs === "number" && attachment.durationMs > 0
      ? attachment.durationMs / 1000
      : null,
  );
  const [time, setTime] = useState(0);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const transcript = attachment.text?.trim() ?? "";
  const onLiveCall = isLiveCallRunning(useLiveMedia().phase);

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
    // The element's paused state, not the flag: play events are queued, so a second click before onPlay must still
    // pause.
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (onLiveCall) return;
    // Claim before play: the Speaker's stop() silences call mode and any other note first.
    releaseRef.current?.();
    const release = speaker.claimExternalVoice(() => audio.pause());
    releaseRef.current = release;
    // A refused play() never fires pause, so the claim comes back here, if this attempt's claim is still the active
    // one.
    void audio.play().catch(() => giveBackVoice(release));
  };

  const seek = (next: number) => {
    const audio = audioRef.current;
    if (audio && Number.isFinite(next)) audio.currentTime = next;
    setTime(next);
  };

  return (
    <div
      className={cn("flex w-full flex-col rounded-xl bg-inset/60 px-3 py-2", className)}
      data-test-voice-note=""
    >
      <div className="flex w-full items-center gap-3">
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
            // A queued pause can land after playback already resumed.
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
          disabled={onLiveCall && !playing}
          aria-label={playing ? t("chat.voiceNote.pause") : onLiveCall ? t("chat.voiceNote.onLiveCall") : t("chat.voiceNote.play")}
          title={playing ? t("chat.voiceNote.pause") : onLiveCall ? t("chat.voiceNote.onLiveCall") : t("chat.voiceNote.play")}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-opacity hover:opacity-90 disabled:opacity-40"
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
      {transcript && (
        <>
          <button
            type="button"
            onClick={() => setTranscriptOpen((open) => !open)}
            data-test-voice-note-transcript=""
            aria-expanded={transcriptOpen}
            className="mt-1 flex items-center gap-0.5 self-start text-[11.5px] text-ink-secondary transition-colors hover:text-ink"
          >
            <ChevronRight size={12} aria-hidden="true" className={cn("transition-transform duration-150", transcriptOpen && "rotate-90")} />
            {t("chat.voiceNote.transcript")}
          </button>
          {transcriptOpen && (
            <p className="mt-1 whitespace-pre-wrap text-[13px] leading-snug text-ink">{transcript}</p>
          )}
        </>
      )}
    </div>
  );
}
