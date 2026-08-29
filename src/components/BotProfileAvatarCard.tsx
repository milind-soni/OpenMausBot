import { ImagePlus, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import type { Bot } from "@/state/store";
import { imageAttachmentFromFile } from "@/lib/composer-attachments";
import type { MausMotion, MausState } from "@/lib/mascot";
import { botAvatarUrlFromStoredPath } from "../../shared/bot-avatar";
import { BotAvatar } from "./Avatar";

type AvatarPatch = Partial<Pick<Bot, "avatarCrop" | "avatarUrl" | "color" | "mascotExpression">>;

/** A small everyday icon interface. Product theming and image credentials live elsewhere. */
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
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const saved = await imageAttachmentFromFile(file);
      if (!saved) throw new Error("Choose a PNG, JPEG, GIF, or WebP image");
      const avatarUrl = botAvatarUrlFromStoredPath(saved.path);
      if (!avatarUrl) throw new Error("The uploaded image could not be used as an avatar");
      onPatch({ avatarUrl, avatarCrop: "circle" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="rounded-2xl border border-hairline/40 bg-card p-4">
      <div className="flex items-center gap-4">
        <BotAvatar
          bot={bot}
          state={activeState}
          size={72}
          motion={mascotMotion?.kind ?? "none"}
          motionKey={mascotMotion?.nonce ?? 0}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-ink">Agent icon</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            Upload an image or use the Agent Centipede role glyph.
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
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
              disabled={uploading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {uploading ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />}
              {bot.avatarUrl ? "Replace" : "Upload"}
            </button>
            <button
              type="button"
              onClick={() => onPatch({ avatarUrl: null, avatarCrop: "glyph", color: "green", mascotExpression: null })}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink"
            >
              <RotateCcw size={13} /> Use glyph
            </button>
            {bot.avatarUrl ? (
              <button
                type="button"
                onClick={() => onPatch({ avatarUrl: null, avatarCrop: "glyph" })}
                aria-label="Remove custom agent icon"
                title="Remove custom image"
                className="inline-flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-danger"
              >
                <Trash2 size={13} />
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {error ? <div role="alert" className="mt-3 text-[12px] text-danger">{error}</div> : null}
    </div>
  );
}
