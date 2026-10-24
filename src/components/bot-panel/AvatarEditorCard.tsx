import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ImagePlus, Loader2, PawPrint, Trash2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { colorSwatch, MAUS_COLOR_LABEL, MAUS_COLOR_NAMES, PICKABLE_STATES, type MausState } from "@/lib/mascot";
import type { Bot } from "@/state/store";
import { MASCOT_BODIES, MASCOT_BODY_IDS } from "../../../shared/mascot-bodies";
import { HALLOWEEN_BODIES, HALLOWEEN_BODY_IDS } from "../../../shared/halloween-bodies";
import { isHalloweenBody, type BotBodyId } from "../../../shared/bot-body";
import { useHalloweenDressed, wornBody } from "@/lib/halloween-dress";
import { MausAvatar } from "../Avatar";
import { CustomMascotCreator } from "../CustomMascotCreator";
import { AvatarImageGenerator } from "../AvatarImageGenerator";
import { AvatarFraming, OrganizationAvatarIcons, RESET_MASCOT_PATCH, useAvatarImage, type AvatarPatch } from "../avatar-editing";
import { Segmented } from "./rows";
import { selectedCustomMascot } from "../../../shared/mascot-profile";

export type AvatarEditorTab = "bot" | "generate" | "upload";

const TABS: ReadonlyArray<readonly [AvatarEditorTab, LocaleKey]> = [
  ["bot", "botPanel.avatar.tabBot"],
  ["generate", "botPanel.avatar.tabGenerate"],
  ["upload", "botPanel.avatar.tabUpload"],
];

const IMAGE_CROPS = ["circle", "rounded", "square"] as const;
const CROP_KEY: Record<(typeof IMAGE_CROPS)[number], LocaleKey> = {
  circle: "botPanel.avatar.circle",
  rounded: "botPanel.avatar.rounded",
  square: "botPanel.avatar.square",
};

const FACE_KEY: Partial<Record<MausState, LocaleKey>> = {
  idle: "botPanel.face.idle",
  happy: "botPanel.face.happy",
  curious: "botPanel.face.curious",
  drowsy: "botPanel.face.drowsy",
  working: "botPanel.face.working",
  thinking: "botPanel.face.thinking",
  listening: "botPanel.face.listening",
  sleeping: "botPanel.face.sleeping",
  suspicious: "botPanel.face.suspicious",
  proud: "botPanel.face.proud",
};

const faceLabel = (state: MausState) => {
  const key = FACE_KEY[state];
  return key ? t(key) : state;
};

export function AvatarEditorCard({ bot, activeState, onPatch, onClose }: {
  bot: Bot;
  activeState: MausState;
  onPatch: (patch: AvatarPatch) => void;
  onClose: () => void;
}) {
  const mascotRevisionRef = useRef(0);
  const generatingRevisionRef = useRef<{ revision: number } | null>(null);
  const [customMascotOpen, setCustomMascotOpen] = useState(false);
  const applyAvatarPatch = (patch: AvatarPatch) => {
    const generation = generatingRevisionRef.current;
    if (patch.avatarUrl !== undefined && generation && generation.revision !== mascotRevisionRef.current) return;
    onPatch(patch);
  };
  const image = useAvatarImage(bot, applyAvatarPatch);
  const { fileRef, crop, uploading, generating, setSavingConnection, busy, error, upload, removeImage, generate } = image;
  const showsImage = crop !== "mascot" && Boolean(bot.avatarUrl);
  const [tab, setTab] = useState<AvatarEditorTab>(showsImage ? "upload" : "bot");
  const tabsRef = useRef<HTMLDivElement>(null);
  const controlsDisabled = busy && !generating;
  const selectedCustom = selectedCustomMascot(bot.mascotProfile);
  const body = bot.mascotProfile?.selected.kind === "builtin"
    ? bot.mascotProfile.selected.bodyId
    : bot.mascotBody ?? "cursor";
  const invalidateGeneration = () => {
    mascotRevisionRef.current += 1;
  };
  const generateImage = async (direction: string) => {
    const generation = { revision: mascotRevisionRef.current };
    generatingRevisionRef.current = generation;
    try {
      await generate(direction);
    } finally {
      if (generatingRevisionRef.current === generation) generatingRevisionRef.current = null;
    }
  };
  // The card is a dialog: focus moves into it, onto the tab it opened on, so Escape and Tab work from the start.
  useEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, []);
  const pickMascot = (patch: AvatarPatch) => {
    invalidateGeneration();
    onPatch(crop === "mascot" ? patch : { ...patch, avatarCrop: "mascot" });
  };
  const costume = wornBody(body, bot.color, useHalloweenDressed());
  const dressedAs = !showsImage && !selectedCustom && costume !== body && isHalloweenBody(costume) ? HALLOWEEN_BODIES[costume].name : null;
  const bodyButton = (id: BotBodyId, name: string) => (
    <button
      key={id}
      type="button"
      disabled={controlsDisabled}
      aria-pressed={!showsImage && !selectedCustom && body === id}
      aria-label={`Use the ${name} body`}
      title={name}
      onClick={() => pickMascot({ mascotBody: id })}
      className={cn(
        "flex h-[58px] items-center justify-center rounded-xl disabled:opacity-50",
        !showsImage && !selectedCustom && body === id ? "bg-ink/[0.08] ring-[1.5px] ring-inset ring-ink/25" : "hover:bg-ink/[0.05]",
      )}
    >
      <MausAvatar color={bot.color} bodyId={id} size={40} animated={false} trackPointer={false} />
    </button>
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-label={t("botPanel.avatar.edit")}
      data-panel-avatar-editor
      onKeyDown={onKeyDown}
      className="absolute inset-x-[-6px] top-[92px] z-30 max-h-[calc(100vh-7rem)] overflow-x-hidden overflow-y-auto overscroll-contain rounded-2xl border border-ink/[0.08] bg-menu text-left shadow-2xl shadow-black/50"
    >
      <div ref={tabsRef} className="flex items-center gap-0.5 border-b border-ink/[0.06] p-2">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-avatar-tab={id}
            onClick={() => setTab(id)}
            className={cn(
              "rounded-lg px-[11px] py-[5px] text-[13px]",
              tab === id ? "bg-ink/[0.08] font-medium text-ink" : "text-ink-secondary hover:text-ink",
            )}
          >
            {t(label)}
          </button>
        ))}
        <button
          type="button"
          data-avatar-reset
          disabled={controlsDisabled}
          onClick={() => pickMascot(RESET_MASCOT_PATCH)}
          className="ml-auto rounded-lg px-[11px] py-[5px] text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50"
        >
          {t("botPanel.avatar.reset")}
        </button>
      </div>

      <div className="p-3">
        {tab === "bot" && (
          <>
            <div className="grid grid-cols-5 gap-1.5">
              {MASCOT_BODY_IDS.map((id) => bodyButton(id, MASCOT_BODIES[id].name))}
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2 px-1 pb-1.5 pt-3 text-[12px] text-ink-tertiary">
              <span>{t("botPanel.avatar.halloween")}</span>
              {dressedAs && <span data-avatar-costume>{t("botPanel.avatar.costume", { name: dressedAs })}</span>}
            </div>
            <div className="grid grid-cols-5 gap-1.5" data-halloween-bodies>
              {HALLOWEEN_BODY_IDS.map((id) => bodyButton(id, HALLOWEEN_BODIES[id].name))}
            </div>
            <div className="mt-2">
              <button
                type="button"
                data-avatar-custom-mascot
                aria-expanded={customMascotOpen}
                aria-controls={`simple-custom-mascot-creator-${bot.id}`}
                disabled={controlsDisabled}
                onClick={() => setCustomMascotOpen((open) => !open)}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-ink/[0.08] px-3 py-2 text-[12.5px] font-medium text-ink-secondary hover:bg-ink/[0.04] hover:text-ink disabled:opacity-50"
              >
                <PawPrint size={14} aria-hidden="true" />
                {t("mascot.creator.open")}
              </button>
              {customMascotOpen && (
                <div id={`simple-custom-mascot-creator-${bot.id}`}>
                  <CustomMascotCreator
                    bot={bot}
                    disabled={controlsDisabled}
                    onSelectionStart={invalidateGeneration}
                    onClose={() => setCustomMascotOpen(false)}
                  />
                </div>
              )}
            </div>
            <div className="flex flex-wrap justify-center gap-2 px-1 pb-1 pt-3.5">
              {MAUS_COLOR_NAMES.map((color) => (
                <button
                  key={color}
                  type="button"
                  disabled={controlsDisabled}
                  aria-pressed={bot.color === color}
                  aria-label={`Use ${color} mascot color`}
                  title={t(MAUS_COLOR_LABEL[color])}
                  onClick={() => pickMascot({ color })}
                  className={cn(
                    "size-6 rounded-full disabled:opacity-50",
                    bot.color === color && "ring-2 ring-ink/80 ring-offset-2 ring-offset-menu",
                  )}
                  style={{ background: colorSwatch(color) }}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-1.5 pt-2.5" role="group" aria-label={t("botPanel.avatar.face")}>
              <span className="mr-0.5 text-[12px] text-ink-tertiary">{t("botPanel.avatar.face")}</span>
              {PICKABLE_STATES.map((expression) => (
                <button
                  key={expression}
                  type="button"
                  disabled={controlsDisabled}
                  data-avatar-face={expression}
                  aria-pressed={activeState === expression}
                  onClick={() => pickMascot({ mascotExpression: expression })}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[12px] disabled:opacity-50",
                    activeState === expression ? "bg-ink/[0.15] text-ink" : "bg-ink/[0.04] text-ink-secondary hover:text-ink",
                  )}
                >
                  {faceLabel(expression)}
                </button>
              ))}
            </div>
          </>
        )}

        {tab === "generate" && (
          <div className="[&>div:first-child]:mt-0 [&>div:first-child]:border-0 [&>div:first-child]:pt-0">
            <AvatarImageGenerator
              botLabel={bot.title || bot.name}
              disabled={uploading}
              generating={generating}
              onGenerate={generateImage}
              onSavingChange={setSavingConnection}
            />
          </div>
        )}

        {tab === "upload" && (
          <>
            <OrganizationAvatarIcons busy={busy} onUpload={(file) => void upload(file)} />
            {showsImage && <AvatarFraming bot={bot} disabled={busy} onPatch={onPatch} />}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="sr-only"
              onChange={(event) => void upload(event.target.files?.[0])}
            />
            <button
              type="button"
              data-avatar-drop
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void upload(event.dataTransfer.files?.[0]);
              }}
              className="flex w-full flex-col items-center gap-1.5 rounded-xl border-[1.5px] border-dashed border-ink/15 px-3 py-6 text-center text-[13px] text-ink-secondary hover:border-ink/25 hover:text-ink disabled:opacity-50"
            >
              {uploading ? <Loader2 size={22} className="animate-spin" /> : <ImagePlus size={22} />}
              <span>{t("botPanel.avatar.drop")}</span>
              <span className="text-[11.5px] text-ink-tertiary">{t("botPanel.avatar.types")}</span>
            </button>
            <div className="mt-2.5 flex items-center gap-2.5">
              <span className="shrink-0 text-[12px] text-ink-secondary">{t("botPanel.avatar.shape")}</span>
              <Segmented
                attr="data-avatar-crop"
                label={t("botPanel.avatar.shape")}
                value={showsImage ? crop : null}
                onChange={(next) => onPatch({ avatarCrop: next })}
                options={IMAGE_CROPS.map((value) => ({ value, label: t(CROP_KEY[value]), disabled: busy || !bot.avatarUrl }))}
              />
              {bot.avatarUrl && (
                <button
                  type="button"
                  onClick={removeImage}
                  disabled={busy}
                  aria-label="Remove custom avatar image"
                  title={t("botPanel.avatar.remove")}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            {!showsImage && <p className="mt-2 text-[11.5px] text-ink-tertiary">{t("botPanel.avatar.uploadHint")}</p>}
          </>
        )}

        {error && <div role="alert" className="mt-3 text-[12px] text-danger">{error}</div>}
      </div>
    </div>
  );
}
