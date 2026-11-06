import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";

import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";

const INPUT_CLASS = "w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none disabled:opacity-50";
const PROVIDER_LABEL = { openai: "OpenAI", xai: "Grok (xAI)", gemini: "Gemini", openrouter: "OpenRouter", custom: "Custom" } as const;

export function AvatarImageGenerator({
  botLabel,
  disabled,
  generating,
  onGenerate,
}: {
  botLabel: string;
  disabled: boolean;
  generating: boolean;
  onGenerate: (direction: string) => Promise<void>;
}) {
  const { state, dispatch } = useStore();
  const imageGen = state.config?.imageGen;
  const [direction, setDirection] = useState("");
  const busy = disabled || generating;
  const ready = imageGen?.ready ?? imageGen?.configured === true;
  const primary = imageGen?.primary ?? (imageGen?.provider ? { provider: imageGen.provider, configured: imageGen.configured } : null);
  const inUse = primary?.configured ? primary.provider : imageGen?.fallback?.configured ? imageGen.fallback.provider : null;

  return (
    <div className="mt-5 border-t border-hairline/40 pt-4">
      <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <Sparkles size={14} className="text-accent" /> {t("botIdentity.ai.generateWith")}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-secondary">
        {ready && inUse ? t("botIdentity.ai.usingProvider", { provider: PROVIDER_LABEL[inUse] }) : t("botIdentity.ai.noProvider")}{" "}
        <button
          type="button"
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "imageGeneration" })}
          className="cursor-pointer text-accent hover:underline"
        >
          {t("botIdentity.ai.openImageSettings")}
        </button>
      </p>

      <textarea
        value={direction}
        disabled={busy || !ready}
        onChange={(event) => setDirection(event.target.value.slice(0, 400))}
        maxLength={400}
        placeholder={t("botIdentity.ai.directionPlaceholder", { name: botLabel })}
        aria-label={t("botIdentity.ai.directionLabel")}
        className={`${INPUT_CLASS} mt-3 min-h-[72px] resize-none`}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-[11px] tabular-nums text-ink-secondary">{direction.length}/400</span>
        <button
          type="button"
          onClick={() => {
            if (!busy && ready) void onGenerate(direction.trim());
          }}
          disabled={busy || !ready}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {generating ? t("botIdentity.ai.generating") : t("botIdentity.ai.generate")}
        </button>
      </div>
    </div>
  );
}
