import { useRef, useState } from "react";
import { Check, ImagePlus, Loader2, Sparkles, Trash2 } from "lucide-react";

import { api, useStore, type Bot, type ConfigStatus } from "@/state/store";
import { imageAttachmentFromFile } from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import {
  PICKABLE_STATES,
  MAUS_COLORS,
  MAUS_COLOR_NAMES,
  type MausMotion,
  type MausState,
} from "@/lib/mascot";
import {
  BOT_AVATAR_CROPS,
  botAvatarUrlFromStoredPath,
  type BotAvatarCrop,
} from "../../shared/bot-avatar";
import { BotAvatar, MausAvatar } from "./Avatar";

type AvatarPatch = Partial<
  Pick<Bot, "avatarCrop" | "avatarUrl" | "color" | "mascotExpression">
>;

const CROP_LABEL = {
  mascot: "Mascot",
  circle: "Circle",
  rounded: "Rounded",
  square: "Square",
} satisfies Record<BotAvatarCrop, string>;

export function BotProfileAvatarCard({
  bot,
  activeState,
  mascotMotion,
  onPatch,
}: {
  bot: Bot;
  activeState: MausState;
  mascotMotion: { kind: Exclude<MausMotion, "none">; nonce: number } | null;
  onPatch: (patch: AvatarPatch) => void;
}) {
  const { state, dispatch, flushBotPatches } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [imageKey, setImageKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [direction, setDirection] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const crop = bot.avatarCrop ?? "mascot";
  const cropRef = useRef(crop);
  cropRef.current = crop;
  const imageConfigured = state.config?.imageGen?.configured === true;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const saved = await imageAttachmentFromFile(file);
      if (!saved) throw new Error("Choose a PNG, JPEG, GIF, or WebP image");
      const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
      if (!avatarUrl) throw new Error("The uploaded image could not be used as an avatar");
      const latestCrop = cropRef.current;
      onPatch({ avatarUrl, avatarCrop: latestCrop === "mascot" ? "circle" : latestCrop });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeImage = () => {
    setError(null);
    onPatch({ avatarUrl: null, avatarCrop: "mascot" });
  };

  const saveImageKey = async () => {
    const key = imageKey.trim();
    if (!key) return;
    setSavingKey(true);
    setError(null);
    try {
      const status: ConfigStatus = window.ogb?.setCredential
        ? await window.ogb.setCredential("openaiImageApiKey", key)
        : await api("/api/config", {
            method: "PUT",
            body: JSON.stringify({ imageGen: { key } }),
          });
      dispatch({ type: "configStatus", config: status });
      setImageKey("");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSavingKey(false);
    }
  };

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      // Generation reads the bot's identity and crop server-side. Commit any
      // debounced profile edits first, then feed the generated avatar back
      // through the same serialized mutation lane as upload/remove.
      const cropAtStart = cropRef.current;
      await flushBotPatches(bot.id);
      const result: { avatarUrl: string; bot: Bot } = await api(`/api/bots/${bot.id}/avatar/generate`, {
        method: "POST",
        body: JSON.stringify({ prompt: direction.trim() }),
      });
      const latestCrop = cropRef.current;
      onPatch({
        avatarUrl: result.avatarUrl,
        avatarCrop:
          latestCrop === cropAtStart
            ? (result.bot.avatarCrop ?? "circle")
            : latestCrop,
      });
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : String(generateError));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-hairline/40 bg-card">
      <div className="flex items-center justify-between border-b border-hairline/40 px-3 py-2.5">
        <span className="rounded-lg bg-raised px-3 py-1.5 text-[14px] font-medium text-ink">Avatar</span>
        <button
          onClick={() => onPatch({ avatarCrop: "mascot", color: "green", mascotExpression: null })}
          className="rounded-md px-2 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          Reset mascot
        </button>
      </div>

      <div className="p-3">
        <div className="flex justify-center py-3">
          <BotAvatar
            bot={bot}
            state={activeState}
            size={112}
            motion={mascotMotion?.kind ?? "none"}
            motionKey={mascotMotion?.nonce ?? 0}
          />
        </div>

        <div className="mt-2 flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="sr-only"
            onChange={(event) => void upload(event.target.files?.[0])}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || generating}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
            Upload image
          </button>
          {bot.avatarUrl && (
            <button
              type="button"
              onClick={removeImage}
              disabled={uploading || generating}
              aria-label="Remove custom avatar image"
              title="Remove custom image"
              className="flex size-10 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-50"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <div className="mt-1.5 text-[11.5px] text-ink-secondary">PNG, JPEG, GIF, or WebP · up to 10 MB</div>

        <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
          Shape
        </div>
        <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-hairline/40">
          {BOT_AVATAR_CROPS.map((candidate, index) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={crop === candidate}
              onClick={() => onPatch({ avatarCrop: candidate })}
              className={cn(
                "py-1.5 text-[12.5px]",
                index > 0 && "border-l border-hairline/40",
                crop === candidate ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
              )}
            >
              {CROP_LABEL[candidate]}
            </button>
          ))}
        </div>

        {crop === "mascot" && (
          <>
            <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Expression
            </div>
            <div className="grid grid-cols-5 gap-2">
              {PICKABLE_STATES.map((expression) => (
                <button
                  key={expression}
                  type="button"
                  aria-pressed={activeState === expression}
                  onClick={() => onPatch({ mascotExpression: expression })}
                  className={cn(
                    "flex h-[58px] items-center justify-center rounded-xl bg-inset transition-colors hover:bg-raised",
                    activeState === expression && "ring-2 ring-accent-border",
                  )}
                  title={expression}
                  aria-label={`Use ${expression} expression`}
                >
                  <MausAvatar color={bot.color} state={expression} size={42} animated={false} />
                </button>
              ))}
            </div>

            <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Color
            </div>
            <div className="flex flex-wrap gap-2.5">
              {MAUS_COLOR_NAMES.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-pressed={bot.color === color}
                  onClick={() => onPatch({ color })}
                  className={cn(
                    "size-10 rounded-full border-2 border-transparent transition-transform hover:scale-110",
                    bot.color === color && "ring-2 ring-accent-border ring-offset-2 ring-offset-card",
                  )}
                  style={{ backgroundColor: MAUS_COLORS[color] }}
                  title={color}
                  aria-label={`Use ${color} mascot color`}
                />
              ))}
            </div>
          </>
        )}

        <div className="mt-5 border-t border-hairline/40 pt-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <Sparkles size={14} className="text-accent" /> Generate with GPT Image 2
          </div>
          <div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
            Uses a low-quality square draft to keep cost down. OpenAI bills your API account.
          </div>

          {!imageConfigured ? (
            <div className="mt-3">
              <div className="flex gap-2">
                <input
                  type="password"
                  value={imageKey}
                  onChange={(event) => setImageKey(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && void saveImageKey()}
                  placeholder="Paste OpenAI image API key"
                  aria-label="OpenAI image API key"
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void saveImageKey()}
                  disabled={savingKey || !imageKey.trim()}
                  className="flex w-[72px] items-center justify-center gap-1.5 rounded-lg bg-raised text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50"
                >
                  {savingKey ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} /> Save</>}
                </button>
              </div>
              <div className="mt-1.5 text-[11px] text-ink-secondary">Stored in the operating system's encrypted credential store in the installed app.</div>
            </div>
          ) : (
            <div className="mt-3">
              <textarea
                value={direction}
                onChange={(event) => setDirection(event.target.value.slice(0, 400))}
                maxLength={400}
                placeholder={`Optional direction, e.g. “a calm navigator inspired by ${bot.title || bot.name}”`}
                aria-label="Avatar generation direction"
                className="min-h-[72px] w-full resize-none rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[12.5px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-[11px] tabular-nums text-ink-secondary">{direction.length}/400</span>
                <button
                  type="button"
                  onClick={() => void generate()}
                  disabled={generating || uploading}
                  className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50"
                >
                  {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                  {generating ? "Generating…" : "Generate avatar"}
                </button>
              </div>
              <details className="mt-3 rounded-lg border border-hairline/40 bg-inset px-3 py-2">
                <summary className="cursor-pointer text-[11.5px] text-ink-secondary">Replace OpenAI image key</summary>
                <div className="mt-2 flex gap-2">
                  <input
                    type="password"
                    value={imageKey}
                    onChange={(event) => setImageKey(event.target.value)}
                    onKeyDown={(event) => event.key === "Enter" && void saveImageKey()}
                    placeholder="Paste replacement key"
                    aria-label="Replacement OpenAI image API key"
                    autoComplete="off"
                    className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-card px-3 py-2 text-[12px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void saveImageKey()}
                    disabled={savingKey || !imageKey.trim()}
                    className="flex w-[72px] items-center justify-center gap-1.5 rounded-lg bg-raised text-[12px] text-ink hover:bg-raised-hover disabled:opacity-50"
                  >
                    {savingKey ? <Loader2 size={13} className="animate-spin" /> : <><Check size={13} /> Save</>}
                  </button>
                </div>
              </details>
            </div>
          )}
        </div>

        {error && <div role="alert" className="mt-3 text-[12px] text-danger">{error}</div>}
      </div>
    </div>
  );
}
