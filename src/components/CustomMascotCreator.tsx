import { useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Check, Loader2, PawPrint, X } from "lucide-react";

import { t } from "@/lib/i18n";
import { useStore, type Bot, type BotAnnouncement } from "@/state/store";
import { useBotEditor } from "./bot-settings/BotEditorContext";
import {
  createCustomMascotFitContext,
  measureCustomMascotFit,
  suggestCustomMascotAnchor,
  type CustomMascotFitContext,
} from "../../shared/custom-mascot-fitting";
import { customMascotSilhouette, FACE_BOX, type CursorSilhouette } from "./CursorAvatar";
import { MausAvatar } from "./Avatar";
import {
  MAX_NATIVE_MASCOT_SCALE,
  MAX_CUSTOM_MASCOT_NAME,
  MIN_CUSTOM_MASCOT_SCALE,
  customMascotDefinitionOf,
  normalizeCustomMascotDefinition,
  normalizeMascotName,
  selectedCustomMascot,
  type CustomMascotAnchor,
  type CustomMascotDefinition,
  type CustomMascotShape,
} from "../../shared/mascot-profile";
import { importCustomMascotSvg, MAX_SVG_BYTES } from "@/lib/custom-mascot-svg";

interface MascotDraft extends CustomMascotDefinition {
  fitContext: CustomMascotFitContext | null;
}

interface CustomMascotCreatorProps {
  bot: Bot;
  disabled?: boolean;
  onSelectionStart?: () => void;
  onClose: () => void;
}

function draftFromImport(imported: ReturnType<typeof importCustomMascotSvg>): MascotDraft {
  let fitContext: CustomMascotFitContext | null = null;
  let anchor: CustomMascotAnchor = {
    x: FACE_BOX / 2,
    y: FACE_BOX / 2,
    scale: MIN_CUSTOM_MASCOT_SCALE,
  };

  try {
    fitContext = createCustomMascotFitContext(imported.outline);
  } catch {
    fitContext = null;
  }
  if (fitContext) {
    try {
      anchor = suggestCustomMascotAnchor(fitContext);
    } catch {
      anchor = {
        x: FACE_BOX / 2,
        y: FACE_BOX / 2,
        scale: MIN_CUSTOM_MASCOT_SCALE,
      };
    }
  }

  return { ...imported, anchor, fitContext };
}

export function CustomMascotCreator({ bot, disabled = false, onSelectionStart, onClose }: CustomMascotCreatorProps) {
  const { state, dispatch } = useStore();
  const { request } = useBotEditor();
  const fileRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<MascotDraft | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);

  const fit = useMemo(() => {
    if (!draft?.fitContext) return null;
    try {
      return measureCustomMascotFit(draft.fitContext, draft.anchor);
    } catch {
      return null;
    }
  }, [draft?.fitContext, draft?.anchor]);
  const fits = Boolean(fit?.fits);
  const normalizedName = draft ? normalizeMascotName(draft.name) : "";
  const ownShapes = bot.mascotProfile?.shapes ?? [];
  const selectedShape = selectedCustomMascot(bot.mascotProfile);
  const otherShapes = state.bots.flatMap((sourceBot) =>
    sourceBot.id === bot.id
      ? []
      : (sourceBot.mascotProfile?.shapes ?? []).map((shape) => ({ bot: sourceBot, shape })),
  );
  const previewSilhouette: CursorSilhouette | undefined = draft
    ? { name: draft.name || t("mascot.creator.preview"), anchor: draft.anchor, outline: draft.outline }
    : undefined;

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || disabled || importing || saving) return;
    if (file.size > MAX_SVG_BYTES) {
      setImportError(t("mascot.creator.importError"));
      setSaveError(null);
      return;
    }

    setImporting(true);
    setImportError(null);
    setSaveError(null);
    try {
      const imported = importCustomMascotSvg(await file.text(), file.name);
      setDraft(draftFromImport(imported));
    } catch {
      setImportError(t("mascot.creator.importError"));
    } finally {
      setImporting(false);
    }
  };

  const saveDefinition = async (shape: CustomMascotDefinition, closeOnSuccess: boolean) => {
    if (disabled || saving) return;
    onSelectionStart?.();
    setSaving(true);
    setSaveError(null);
    try {
      const result = await request<{ bot: BotAnnouncement }>("/api/bots/" + bot.id + "/mascot-shapes", {
        method: "POST",
        body: JSON.stringify({ shape }),
      });
      dispatch({ type: "botPatched", bot: result.bot });
      if (closeOnSuccess) onClose();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = () => {
    if (!draft || !fits || !normalizedName) return;
    try {
      const shape = normalizeCustomMascotDefinition({
        name: normalizedName,
        outline: draft.outline,
        anchor: draft.anchor,
      });
      void saveDefinition(shape, true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  };

  const selectShape = (shape: CustomMascotShape) => {
    void saveDefinition(customMascotDefinitionOf(shape), false);
  };

  const updateAnchor = (patch: Partial<CustomMascotAnchor>) => {
    setDraft((current) => current ? { ...current, anchor: { ...current.anchor, ...patch } } : current);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <section
      aria-label={t("mascot.creator.title")}
      onKeyDown={handleKeyDown}
      className="mt-3 rounded-xl border border-hairline/50 bg-inset p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <PawPrint size={15} aria-hidden="true" />
          <span>{t("mascot.creator.title")}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("mascot.creator.close")}
          title={t("mascot.creator.close")}
          className="flex size-7 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <p className="mb-3 text-[12px] leading-relaxed text-ink-secondary">
        {t("mascot.creator.help")}
      </p>

      <input
        ref={fileRef}
        type="file"
        accept=".svg,image/svg+xml"
        className="sr-only"
        aria-label={t("mascot.creator.chooseSvg")}
        onChange={(event) => void importFile(event)}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        autoFocus
        disabled={disabled || importing || saving}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-control px-3 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50"
      >
        {importing ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <PawPrint size={14} aria-hidden="true" />}
        {importing ? t("mascot.creator.importing") : t("mascot.creator.chooseSvg")}
      </button>

      {importError && (
        <div role="alert" className="mt-2 flex items-start justify-between gap-2 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-[12px] text-danger">
          <span>{importError}</span>
          <button
            type="button"
            onClick={() => setImportError(null)}
            aria-label={t("mascot.creator.dismissError")}
            className="shrink-0 rounded p-0.5 hover:bg-danger/10"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}

      {draft && (
        <div className="mt-3 space-y-3">
          <label className="block text-[12px] font-medium text-ink">
            {t("mascot.creator.name")}
            <input
              type="text"
              autoFocus
              maxLength={MAX_CUSTOM_MASCOT_NAME}
              value={draft.name}
              disabled={disabled || saving}
              onChange={(event) => setDraft((current) => current ? { ...current, name: event.target.value } : current)}
              className="mt-1 block w-full rounded-lg border border-hairline/50 bg-card px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent-border"
            />
          </label>

          <div className="rounded-lg border border-hairline/40 bg-card p-3">
            <div className="mb-1 text-center text-[11px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
              {t("mascot.creator.preview")}
            </div>
            <div className="flex justify-center py-1">
              <MausAvatar
                color={bot.color}
                silhouette={previewSilhouette}
                state="bouncing"
                size={136}
                animated
                label={t("mascot.creator.preview")}
              />
            </div>
          </div>

          <fieldset disabled={disabled || saving} className="space-y-2">
            <legend className="mb-1 text-[12px] font-medium text-ink">{t("mascot.creator.facePlacement")}</legend>
            <label className="block text-[11.5px] text-ink-secondary">
              <span className="mb-1 flex justify-between gap-3">
                <span>{t("mascot.creator.faceX")}</span>
                <span className="tabular-nums">{Math.round(draft.anchor.x)}</span>
              </span>
              <input
                type="range"
                min={0}
                max={FACE_BOX}
                step={1}
                value={draft.anchor.x}
                aria-label={t("mascot.creator.faceX")}
                onChange={(event) => updateAnchor({ x: Number(event.target.value) })}
                className="w-full accent-accent"
              />
            </label>
            <label className="block text-[11.5px] text-ink-secondary">
              <span className="mb-1 flex justify-between gap-3">
                <span>{t("mascot.creator.faceY")}</span>
                <span className="tabular-nums">{Math.round(draft.anchor.y)}</span>
              </span>
              <input
                type="range"
                min={0}
                max={FACE_BOX}
                step={1}
                value={draft.anchor.y}
                aria-label={t("mascot.creator.faceY")}
                onChange={(event) => updateAnchor({ y: Number(event.target.value) })}
                className="w-full accent-accent"
              />
            </label>
            <label className="block text-[11.5px] text-ink-secondary">
              <span className="mb-1 flex justify-between gap-3">
                <span>{t("mascot.creator.faceSize")}</span>
                <span className="tabular-nums">{Math.round(draft.anchor.scale * 100)}%</span>
              </span>
              <input
                type="range"
                min={MIN_CUSTOM_MASCOT_SCALE}
                max={MAX_NATIVE_MASCOT_SCALE}
                step={0.005}
                value={draft.anchor.scale}
                aria-label={t("mascot.creator.faceSize")}
                onChange={(event) => updateAnchor({ scale: Number(event.target.value) })}
                className="w-full accent-accent"
              />
            </label>
          </fieldset>

          <div
            role={fits ? "status" : "alert"}
            className={"rounded-lg px-2.5 py-2 text-[12px] " + (fits ? "bg-success/10 text-success" : "bg-danger/5 text-danger")}
          >
            {fits ? (
              <span className="flex items-center gap-1.5"><Check size={13} aria-hidden="true" />{t("mascot.creator.faceFits")}</span>
            ) : (
              t("mascot.creator.fitError")
            )}
          </div>

          <button
            type="button"
            onClick={saveDraft}
            disabled={disabled || saving || !fits || !normalizedName}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
            {saving ? t("mascot.creator.saving") : t("mascot.creator.save")}
          </button>
        </div>
      )}

      {saveError && (
        <div role="alert" className="mt-2 flex items-start justify-between gap-2 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-[12px] text-danger">
          <span>{saveError}</span>
          <button
            type="button"
            onClick={() => setSaveError(null)}
            aria-label={t("mascot.creator.dismissError")}
            className="shrink-0 rounded p-0.5 hover:bg-danger/10"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="mt-4 border-t border-hairline/40 pt-3">
        <div className="mb-2 text-[12px] font-medium text-ink">{t("mascot.creator.saved")}</div>
        {ownShapes.length === 0 ? (
          <div className="text-[11.5px] text-ink-secondary">{t("mascot.creator.noSaved")}</div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {ownShapes.map((shape) => (
              <button
                key={shape.id}
                type="button"
                disabled={disabled || saving}
                aria-pressed={selectedShape?.id === shape.id}
                aria-label={t("mascot.creator.useShape", { name: shape.name })}
                onClick={() => selectShape(shape)}
                className="flex min-w-0 items-center gap-2 rounded-lg border border-hairline/40 bg-card px-2 py-1.5 text-left text-[11.5px] text-ink hover:bg-control disabled:opacity-50"
              >
                <MausAvatar color={bot.color} silhouette={customMascotSilhouette(shape)} size={32} animated={false} trackPointer={false} label={shape.name} />
                <span className="truncate">{shape.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 border-t border-hairline/40 pt-3">
        <div className="mb-2 text-[12px] font-medium text-ink">{t("mascot.creator.fromOthers")}</div>
        {otherShapes.length === 0 ? (
          <div className="text-[11.5px] text-ink-secondary">{t("mascot.creator.noOthers")}</div>
        ) : (
          <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
            {otherShapes.map(({ bot: sourceBot, shape }) => (
              <button
                key={sourceBot.id + ":" + shape.id}
                type="button"
                disabled={disabled || saving}
                aria-label={t("mascot.creator.copyShape", { name: shape.name, bot: sourceBot.name })}
                onClick={() => selectShape(shape)}
                className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-hairline/40 bg-card px-2 py-1.5 text-left text-[11.5px] text-ink hover:bg-control disabled:opacity-50"
              >
                <MausAvatar color={sourceBot.color} silhouette={customMascotSilhouette(shape)} size={32} animated={false} trackPointer={false} label={shape.name} />
                <span className="min-w-0 flex-1 truncate">{shape.name}</span>
                <span className="max-w-[40%] shrink-0 truncate text-ink-secondary">{sourceBot.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
