import { useRef, useState } from "react";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";

import { type Group } from "@/state/store";
import { imageAttachmentFromFile } from "@/lib/composer-attachments";
import { cn } from "@/lib/cn";
import {
  BOT_AVATAR_CROPS,
  botAvatarUrlFromStoredPath,
  type BotAvatarCrop,
} from "../../shared/bot-avatar";
import { GroupAvatar } from "./Avatar";

type AvatarPatch = Partial<Pick<Group, "avatarCrop" | "avatarUrl">>;

const CROP_LABEL = {
  mascot: "Mascot", // We won't show mascot option for groups
  circle: "Circle",
  rounded: "Rounded",
  square: "Square",
} satisfies Record<BotAvatarCrop, string>;

export function GroupProfileAvatarCard({
  group,
  onPatch,
}: {
  group: Group;
  onPatch: (patch: AvatarPatch) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const crop = group.avatarCrop ?? "rounded";
  const cropRef = useRef(crop);
  cropRef.current = crop;

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
      onPatch({ avatarUrl, avatarCrop: latestCrop === "mascot" ? "rounded" : latestCrop });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const removeImage = () => {
    setError(null);
    onPatch({ avatarUrl: null, avatarCrop: "rounded" });
  };

  // Group crops: exclude mascot
  const availableCrops = BOT_AVATAR_CROPS.filter(c => c !== "mascot");

  return (
    <div className="overflow-hidden rounded-xl border border-hairline/40 bg-card">
      <div className="flex items-center justify-between border-b border-hairline/40 px-3 py-2.5">
        <span className="rounded-lg bg-control px-3 py-1.5 text-[14px] font-medium text-ink">Avatar</span>
      </div>

      <div className="p-3">
        <div className="flex justify-center py-3">
          <GroupAvatar group={group} size={112} />
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
            disabled={uploading}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
            Upload image
          </button>
          {group.avatarUrl && (
            <button
              type="button"
              onClick={removeImage}
              disabled={uploading}
              aria-label="Remove custom avatar image"
              title="Remove custom image"
              className="flex size-10 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <div className="mt-1.5 text-[11.5px] text-ink-secondary">PNG, JPEG, GIF, or WebP · up to 10 MB</div>

        {group.avatarUrl && (
          <>
            <div className="mb-2 mt-4 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              Shape
            </div>
            <div className="grid grid-cols-3 overflow-hidden rounded-lg border border-hairline/40">
              {availableCrops.map((candidate, index) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={crop === candidate}
                  onClick={() => onPatch({ avatarCrop: candidate })}
                  className={cn(
                    "py-1.5 text-[12.5px]",
                    index > 0 && "border-l border-hairline/40",
                    crop === candidate ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                  )}
                >
                  {CROP_LABEL[candidate]}
                </button>
              ))}
            </div>
          </>
        )}

        {error && <div role="alert" className="mt-3 text-[12px] text-danger">{error}</div>}
      </div>
    </div>
  );
}
