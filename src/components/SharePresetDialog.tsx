import { Check, Loader2, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { t, tFromServer } from "@/lib/i18n";
import { describePart, describeSkip, preparePictures, saveShareFile, type ShareSkip } from "@/lib/team-share";
import { api } from "@/state/store";
import type { NewBotDefaults } from "../../shared/new-bot-defaults";
import type { PackageDocument, PackageSummary } from "../../shared/package-format";

/** POST /api/teams/export with kind "library": a preset file. */
export interface PresetShareResponse {
  document: PackageDocument;
  filename: string;
  redacted: string[];
  skipped: ShareSkip[];
  summary: PackageSummary;
}

export interface PresetShareChoices {
  name: string;
  description?: string;
  release?: string;
  notes?: string;
  includeNotes: boolean;
  picture?: string;
  dryRun?: boolean;
}

/** The request body for a preset file. Pure, for tests. */
export function presetShareBody(choices: PresetShareChoices): Record<string, unknown> {
  const text = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);
  return {
    format: "package",
    version: 2,
    kind: "library",
    name: text(choices.name),
    presetName: text(choices.name),
    presetDescription: text(choices.description),
    release: text(choices.release),
    notes: text(choices.notes),
    includeMemory: choices.includeNotes,
    ...(choices.picture ? { presetAvatar: choices.picture } : {}),
    ...(choices.dryRun ? { dryRun: true } : {}),
  };
}

/** What the preset file holds, counted by the server's own dry run. Pure, for tests. */
export function SharePresetContents({ preview, localSkips }: { preview: PresetShareResponse; localSkips: string[] }) {
  const preset = preview.document.package.presets?.[0];
  const notes = Object.keys(preset?.seed?.memory ?? {}).length;
  const rows: Array<[string, string]> = [
    [t("teamShare.part.skills"), preset?.skills?.length ? `${preset.skills.length} · ${preset.skills.join(", ")}` : "0"],
    [t("teamShare.part.notes"), notes ? String(notes) : t("teamShare.none")],
    [t("teamShare.part.pictures"), preset?.bot.appearance?.avatar ? t("teamShare.yes") : t("teamShare.none")],
  ];
  const skipped = [...localSkips, ...preview.skipped.map((skip) => describeSkip(skip, preview.document))];
  return (
    <div>
      <div className="text-[12px] font-medium text-ink-secondary">{t("teamShare.included")}</div>
      <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 rounded-xl bg-raised/45 px-4 py-3 text-[12.5px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-secondary">{label}</dt>
            <dd className="max-w-[300px] truncate text-right text-ink" title={value}>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-secondary">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-success" />
        <span>{t("presetShare.never")}</span>
      </p>
      {preview.redacted.length > 0 && (
        <div className="mt-3 rounded-xl border border-hairline px-4 py-3 text-[12.5px] text-ink-secondary">
          <div className="font-medium text-ink">{t("teamShare.redacted")}</div>
          <ul className="mt-1 list-disc pl-5">
            {preview.redacted.map((part) => <li key={part}>{describePart(part, preview.document)}</li>)}
          </ul>
        </div>
      )}
      {skipped.length > 0 && (
        <div className="mt-3 rounded-xl border border-hairline px-4 py-3 text-[12.5px] text-ink-secondary">
          <div className="font-medium text-ink">{t("teamShare.skipped")}</div>
          <ul className="mt-1 list-disc pl-5">
            {skipped.map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Share as preset…: my New bot defaults as a file of one preset bot and
 * its skills (no team). Whoever imports it picks the preset in New bot. No
 * confirm step; Save file is the decision. */
export function SharePresetDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [release, setRelease] = useState("");
  const [notes, setNotes] = useState("");
  const [includeNotes, setIncludeNotes] = useState(true);
  const [includePicture, setIncludePicture] = useState(true);
  // null while the defaults' picture is being prepared.
  const [picture, setPicture] = useState<{ dataUrl?: string; skipped: string[] } | null>(null);
  const [preview, setPreview] = useState<PresetShareResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<PresetShareResponse | null>(null);
  const [error, setError] = useState("");
  const request = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void api<{ defaults: NewBotDefaults }>("/api/bot-defaults")
      .then(async ({ defaults }) => {
        if (!cancelled && defaults.profile.name?.trim()) setName((current) => current || defaults.profile.name!.trim());
        const prepared = await preparePictures([{ id: "defaults", avatarUrl: defaults.profile.avatarUrl, avatarCrop: defaults.profile.avatarCrop }]);
        if (cancelled) return;
        setPicture({
          dataUrl: prepared.avatars.defaults,
          skipped: prepared.skipped.map((skip) => `${t("teamShare.field.picture")} — ${tFromServer(`teamShare.skip.${skip.reason}`, skip.reason)}`),
        });
      })
      .catch(() => { if (!cancelled) setPicture({ skipped: [] }); });
    return () => { cancelled = true; };
  }, []);

  const choices = (dryRun: boolean): PresetShareChoices => ({
    name, description, release, notes, includeNotes, dryRun,
    ...(includePicture && picture?.dataUrl ? { picture: picture.dataUrl } : {}),
  });

  // Live counts from the server's dry run whenever what goes in changes.
  useEffect(() => {
    if (!picture) return;
    const id = ++request.current;
    const timer = window.setTimeout(() => {
      api<PresetShareResponse>("/api/teams/export", { method: "POST", body: JSON.stringify(presetShareBody({ ...choices(true), release: undefined })) })
        .then((result) => {
          if (id !== request.current) return;
          setPreview(result);
          setError("");
          setRelease((current) => current || result.document.package.release);
        })
        .catch((cause) => {
          if (id !== request.current) return;
          setPreview(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    }, 250);
    return () => window.clearTimeout(timer);
    // Only what goes in changes the counts; names and notes do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picture, includeNotes, includePicture]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<PresetShareResponse>("/api/teams/export", { method: "POST", body: JSON.stringify(presetShareBody(choices(false))) });
      saveShareFile(result.filename, result.document);
      setSaved(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  const localSkips = includePicture ? picture?.skipped ?? [] : [];
  const field = "mt-1 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13.5px] text-ink disabled:opacity-60";
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="share-preset-title" tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel text-ink shadow-2xl outline-none"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) { event.stopPropagation(); onClose(); }
          if (event.key === "Tab") {
            const controls = dialogRef.current?.querySelectorAll<HTMLElement>("input:enabled, textarea:enabled, button:enabled");
            if (!controls?.length) return;
            const first = controls[0]!, last = controls[controls.length - 1]!;
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }}>
        <header className="flex items-start justify-between gap-3 px-6 pb-2 pt-5">
          <div>
            <h2 id="share-preset-title" className="text-[17px] font-semibold">{t("presetShare.title")}</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{t("presetShare.intro")}</p>
          </div>
          <button aria-label={t("presetShare.close")} disabled={saving} onClick={onClose} className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised"><X size={18} /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4 pt-2">
          {saved ? (
            <>
              <p className="flex items-center gap-2 text-[13.5px] font-medium text-ink"><Check size={16} className="text-success" />{t("teamShare.saved", { filename: saved.filename })}</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{t("presetShare.savedHint")}</p>
              <div className="mt-4"><SharePresetContents preview={saved} localSkips={localSkips} /></div>
            </>
          ) : (
            <>
              {preview
                ? <SharePresetContents preview={preview} localSkips={localSkips} />
                : !error && <div className="flex items-center gap-2 py-6 text-[13px] text-ink-secondary"><Loader2 size={15} className="animate-spin" />{t("presetShare.preparing")}</div>}
              <fieldset className="mt-4 space-y-2 text-[13px]" disabled={saving}>
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="size-4 accent-accent" checked={includePicture} onChange={(event) => setIncludePicture(event.target.checked)} />
                  {t("presetShare.includePicture")}
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="size-4 accent-accent" checked={includeNotes} onChange={(event) => setIncludeNotes(event.target.checked)} />
                  {t("presetShare.includeNotes")}
                </label>
              </fieldset>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="block text-[12.5px] text-ink-secondary">{t("presetShare.name")}
                  <input value={name} maxLength={100} disabled={saving} onChange={(event) => setName(event.target.value)} className={field} />
                </label>
                <label className="block text-[12.5px] text-ink-secondary">{t("teamShare.release")}
                  <input value={release} maxLength={20} disabled={saving} placeholder="1.0.0" onChange={(event) => setRelease(event.target.value)} className={field} />
                </label>
              </div>
              <label className="mt-3 block text-[12.5px] text-ink-secondary">{t("presetShare.description")}
                <input value={description} maxLength={300} disabled={saving} onChange={(event) => setDescription(event.target.value)} className={field} />
              </label>
              <label className="mt-3 block text-[12.5px] text-ink-secondary">{t("teamShare.notes")}
                <textarea value={notes} maxLength={4000} rows={2} disabled={saving} onChange={(event) => setNotes(event.target.value)} className={field} />
              </label>
            </>
          )}
        </div>

        {error && <p role="alert" className="mx-6 mb-2 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</p>}
        <footer className="flex justify-end gap-2 border-t border-hairline/35 px-6 py-3">
          {saved ? (
            <button onClick={onClose} className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white">{t("teamShare.done")}</button>
          ) : (
            <>
              <button disabled={saving} onClick={onClose} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised">{t("common.cancel")}</button>
              <button disabled={saving || !preview} onClick={() => void save()}
                className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40">
                {saving && <Loader2 size={14} className="animate-spin" />}
                {saving ? t("teamShare.saving") : t("teamShare.save")}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
