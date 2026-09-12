// The reel beat: six short scenes, under a minute in all, answering "what
// is this thing?". Each plays once and advances; the last holds until
// Continue. The guide reacts to each scene's cues, and the dots let the
// user replay any scene.
import { useState } from "react";
import { withViewTransition } from "../view-transition";
import { ProgressDots } from "../ProgressDots";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { PrimaryButton, staggerIndex, type BeatProps } from "../beats/shared";
import { REEL, sceneFor } from "./scenes";

function copyKey(id: string, part: "title" | "body"): LocaleKey {
  return `onboarding.reel.${id}.${part}` as LocaleKey;
}

export function FeatureReel({ onNext, setMascot }: BeatProps) {
  const ids = REEL;
  const [index, setIndex] = useState(0);
  const [round, setRound] = useState(0);
  const id = ids[index] ?? ids[0];
  const last = index >= ids.length - 1;
  const Scene = sceneFor(id);
  if (!Scene) return null;

  const advance = () => {
    if (last) return;
    withViewTransition(() => setIndex(index + 1));
  };

  return (
    <div className="stagger flex min-h-0 flex-col">
      <div key={`${id}-${round}`} className="animate-rise mt-4 aspect-[8/5] w-full overflow-hidden rounded-xl border border-hairline/40">
        <Scene playing label={t(copyKey(id, "title"))} onEnded={advance} onCue={setMascot} />
      </div>
      <div key={id} className="animate-rise mt-4" style={staggerIndex(1)}>
        <h2 className="text-[17px] font-semibold text-ink">{t(copyKey(id, "title"))}</h2>
        <p className="mt-1 text-[13.5px] leading-relaxed text-ink-secondary">{t(copyKey(id, "body"))}</p>
      </div>

      <div className="mt-4 flex justify-center">
        <ProgressDots
          items={ids.map((sceneId) => ({ id: sceneId, label: t(copyKey(sceneId, "title")) }))}
          index={index}
          label={t("onboarding.reel.scenes")}
          onSelect={(i) =>
            withViewTransition(() => {
              setIndex(i);
              setRound((r) => r + 1);
            })
          }
        />
      </div>

      <PrimaryButton onClick={last ? onNext : advance} className="mt-4">
        {last ? t("onboarding.continue") : t("onboarding.reel.next")}
      </PrimaryButton>
    </div>
  );
}
