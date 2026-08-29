import { useEffect, useState } from "react";
import { Volume2 } from "lucide-react";

import { api, useStore, type Bot } from "@/state/store";
import { speaker } from "@/lib/tts";
import { cn } from "@/lib/cn";

const SAMPLE = "Morning. Overnight the tests went green, and I left two notes for you in the thread.";

/** Per-agent voice choice only. Provider credentials belong to workspace Settings. */
export function VoiceSettings({
  bot,
  onPatch,
}: {
  bot: Bot;
  onPatch: (patch: Partial<Pick<Bot, "voice" | "speakReplies">>) => void;
}) {
  const { state } = useStore();
  const tts = state.config?.tts;
  const [voices, setVoices] = useState<Array<{ id: string; label: string; description?: string }>>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = Boolean(tts?.configured);

  useEffect(() => {
    if (!configured) {
      setVoices([]);
      return;
    }
    let alive = true;
    setLoadingVoices(true);
    api("/api/tts/voices")
      .then((response: { voices?: typeof voices; error?: string }) => {
        if (!alive) return;
        setVoices(response.voices ?? []);
        if (response.error) setError(response.error);
      })
      .catch(() => alive && setVoices([]))
      .finally(() => alive && setLoadingVoices(false));
    return () => { alive = false; };
  }, [configured]);

  if (!tts) return null;
  const selectedVoice = bot.voice ?? "";
  const ready = configured && Boolean(selectedVoice || tts.voice);

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[15px] font-medium text-ink">Voice</div>
        {!configured ? <span className="text-[11.5px] text-ink-secondary">Set up in workspace Settings</span> : null}
      </div>

      {configured ? (
        <div className="mt-3 flex gap-2">
          <select
            value={selectedVoice}
            onChange={(event) => onPatch({ voice: event.target.value })}
            aria-label={`${bot.name}'s voice`}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none"
          >
            <option value="">{loadingVoices ? "Loading voices…" : tts.voice ? "Workspace default" : "Pick a voice"}</option>
            {selectedVoice && !voices.some((voice) => voice.id === selectedVoice) ? <option value={selectedVoice}>Current agent voice</option> : null}
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.label}{voice.description ? ` — ${voice.description}` : ""}
              </option>
            ))}
          </select>
          <button
            onClick={() => void speaker.speak(SAMPLE, { voiceId: bot.voice, botId: bot.id })}
            disabled={!ready}
            title={ready ? "Hear this voice" : "Pick a voice first"}
            aria-label="Hear this voice"
            className="inline-flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            <Volume2 size={14} /> Try
          </button>
        </div>
      ) : (
        <div className="mt-2 text-[12.5px] text-ink-secondary">Connect a workspace voice provider to choose a voice here.</div>
      )}

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/40 pt-4">
        <div>
          <div className="text-[13px] font-medium text-ink">Read replies aloud</div>
          <div className="mt-0.5 text-[11.5px] text-ink-secondary">Speak this agent's completed replies.</div>
        </div>
        <button
          role="switch"
          aria-checked={Boolean(bot.speakReplies)}
          aria-label="Read this agent's replies aloud"
          onClick={() => onPatch({ speakReplies: !bot.speakReplies })}
          className={cn("relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors", bot.speakReplies ? "bg-accent" : "bg-control")}
        >
          <span className={cn("absolute top-[3px] size-5 rounded-full bg-white transition-all", bot.speakReplies ? "left-[21px]" : "left-[3px]")} />
        </button>
      </div>
      {error ? <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div> : null}
    </div>
  );
}
