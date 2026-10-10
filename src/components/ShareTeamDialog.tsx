import { Check, Loader2, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { t, tFromServer } from "@/lib/i18n";
import {
  describePart,
  describeSkip,
  notesLine,
  preparePictures,
  requestedSkills,
  saveShareFile,
  SHARE_DIALOG_DEFAULTS,
  SHARE_VIEW_START,
  shareAnswered,
  shareRefused,
  shareRequestBody,
  tickedSkills,
  type ShareChoices,
  type ShareResponse,
  type ShareView,
} from "@/lib/team-share";
import { api, useStore } from "@/state/store";
import type { NewBotDefaults } from "../../shared/new-bot-defaults";

/** What the file will hold, counted from the server's own dry run, so the
 * numbers are exactly what Save file writes. Pure, for tests. */
export function ShareTeamContents({ preview, includeMemory, localSkips }: {
  preview: ShareResponse;
  includeMemory: boolean;
  /** Pictures the dialog could not prepare, already worded. */
  localSkips: string[];
}) {
  const pkg = preview.document.package;
  const counts = preview.summary.counts;
  const leader = pkg.team?.leader ? pkg.agents.find((agent) => agent.key === pkg.team?.leader)?.name : undefined;
  const pictures = pkg.agents.filter((agent) => agent.appearance.avatar).length;
  const notes = pkg.agents.reduce((total, agent) => total + Object.keys(agent.seed?.memory ?? {}).length, 0);
  const rows: Array<[string, string]> = [
    [t("teamShare.part.bots"), `${counts.bots} · ${preview.summary.botNames.join(", ")}`],
    [t("teamShare.part.skills"), String(counts.skills)],
    [t("teamShare.part.playbooks"), String(counts.playbooks)],
    [t("teamShare.part.rooms"), String(counts.rooms)],
    [t("teamShare.part.routines"), String(counts.routines)],
    [t("teamShare.part.brief"), pkg.team?.brief ? t("teamShare.yes") : t("teamShare.none")],
    [t("teamShare.part.leader"), leader ?? t("teamShare.none")],
    [t("teamShare.part.connections"), String(counts.connections)],
    [t("teamShare.part.pictures"), String(pictures)],
    [t("teamShare.part.notes"), includeMemory ? String(notes) : t("teamShare.none")],
    ...(counts.presets ? [[t("teamShare.part.presets"), `${counts.presets} · ${preview.summary.presetNames.join(", ")}`] as [string, string]] : []),
  ];
  const skipped = [...localSkips, ...preview.skipped.map((skip) => describeSkip(skip, preview.document))];
  return (
    <div>
      <div className="text-[12px] font-medium text-ink-secondary">{t("teamShare.included")}</div>
      <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 rounded-xl bg-raised/45 px-4 py-3 text-[12.5px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-secondary">{label}</dt>
            <dd className="max-w-[260px] truncate text-right text-ink" title={value}>{value}</dd>
          </div>
        ))}
      </dl>
      {pkg.connections?.length ? (
        // The whole address, before Save: hosted servers often carry a key
        // in it, and this is where the person can see what goes out.
        <div className="mt-3 text-[12.5px] text-ink-secondary">
          <div className="font-medium text-ink">{t("teamShare.addresses")}</div>
          <ul className="mt-1 space-y-0.5">
            {pkg.connections.map((connection) => (
              <li key={connection.key} className="break-all"><span className="text-ink">{connection.label}</span> · {connection.mcp.url}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mt-3 flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-secondary">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-success" />
        <span>{t("teamShare.never")}</span>
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

/** The skill boxes. They are drawn from the team's skill names, which come
 * back on a refused export too, so they never vanish behind an error. Pure,
 * for tests. */
export function ShareSkillChoices({ available, ticked, counted, onToggle }: {
  available: readonly string[];
  ticked: ReadonlySet<string>;
  /** The server has answered at least once. */
  counted: boolean;
  onToggle: (skill: string) => void;
}) {
  return (
    <div>
      <div className="font-medium">{t("teamShare.includeSkills")}</div>
      {counted && available.length === 0 && <p className="mt-1 text-[12px] text-ink-secondary">{t("teamShare.noSkills")}</p>}
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {available.map((skill) => (
          <label key={skill} className="flex items-center gap-1.5 text-[12.5px]">
            <input type="checkbox" className="size-3.5 accent-accent" checked={ticked.has(skill)} onChange={() => onToggle(skill)} />
            {skill}
          </label>
        ))}
      </div>
    </div>
  );
}

/** Share team…: choose what goes in, see exactly what that is, save the
 * file. No confirm step; the person's click on Save file is the decision. */
export function ShareTeamDialog({ team, onClose }: { team: string; onClose: () => void }) {
  const { state } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const teamBots = useMemo(
    () => state.bots.filter((bot) => !bot.hidden && (bot.section?.trim() ?? "") === team),
    [state.bots, team],
  );
  const botNames = useMemo(() => new Map(teamBots.map((bot) => [bot.id, bot.name])), [teamBots]);
  const [name, setName] = useState(team || t("teamLibrary.general"));
  const [tagline, setTagline] = useState("");
  const [summary, setSummary] = useState("");
  const [release, setRelease] = useState("");
  const [notes, setNotes] = useState("");
  // Pictures and starter notes start ticked (SHARE_DIALOG_DEFAULTS).
  const [includePictures, setIncludePictures] = useState<boolean>(SHARE_DIALOG_DEFAULTS.includePictures);
  const [includeMemory, setIncludeMemory] = useState<boolean>(SHARE_DIALOG_DEFAULTS.includeMemory);
  // New bot defaults are personal until shared: off unless ticked.
  const [includePreset, setIncludePreset] = useState(false);
  // The defaults' picture, prepared the first time the box is ticked.
  const [presetPicture, setPresetPicture] = useState<{ dataUrl?: string } | null>(null);
  // null = "all": whatever fits, as the server decides; a Set = exactly these.
  const [skillChoice, setSkillChoice] = useState<Set<string> | null>(null);
  const [pictures, setPictures] = useState<{ avatars: Record<string, string>; skipped: string[] } | null>(null);
  // The server's answers: counts, skill boxes and refusals (shareAnswered / shareRefused).
  const [view, setView] = useState<ShareView>(SHARE_VIEW_START);
  const { preview, available, included, error } = view;
  const setError = (message: string) => setView((current) => ({ ...current, error: message }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<ShareResponse | null>(null);
  const request = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void preparePictures(teamBots).then((result) => {
      if (cancelled) return;
      setPictures({
        avatars: result.avatars,
        skipped: result.skipped.map((skip) =>
          `${botNames.get(skip.botId) ?? skip.botId} · ${t("teamShare.field.picture")} — ${tFromServer(`teamShare.skip.${skip.reason}`, skip.reason)}`),
      });
    }).catch(() => {
      if (!cancelled) setPictures({ avatars: {}, skipped: [] });
    });
    return () => { cancelled = true; };
    // Pictures are prepared once per dialog; the bot list is stable meanwhile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!includePreset || presetPicture) return;
    let cancelled = false;
    void api<{ defaults: NewBotDefaults }>("/api/bot-defaults")
      .then(({ defaults }) => preparePictures([{ id: "defaults", avatarUrl: defaults.profile.avatarUrl, avatarCrop: defaults.profile.avatarCrop }]))
      .then((prepared) => { if (!cancelled) setPresetPicture({ dataUrl: prepared.avatars.defaults }); })
      .catch(() => { if (!cancelled) setPresetPicture({}); });
    return () => { cancelled = true; };
  }, [includePreset, presetPicture]);

  const choices = useCallback((dryRun: boolean): ShareChoices => ({
    team,
    name,
    tagline,
    summary,
    release,
    notes,
    skills: requestedSkills(skillChoice, available),
    includeMemory,
    ...(includePictures && pictures ? { avatars: pictures.avatars } : {}),
    ...(includePreset ? { includeDefaultsPreset: true, ...(includePictures && presetPicture?.dataUrl ? { presetAvatar: presetPicture.dataUrl } : {}) } : {}),
    dryRun,
  }), [team, name, tagline, summary, release, notes, skillChoice, available, includeMemory, includePictures, pictures, includePreset, presetPicture]);

  // Live counts: re-run the server's dry run whenever what goes in changes.
  useEffect(() => {
    if (!pictures) return;
    // No counts (and no Save) until the preset's picture is ready to go in.
    if (includePreset && !presetPicture) { setView((current) => ({ ...current, preview: null })); return; }
    const id = ++request.current;
    const all = skillChoice === null;
    const timer = window.setTimeout(() => {
      api<ShareResponse>("/api/teams/export", { method: "POST", body: JSON.stringify(shareRequestBody({ ...choices(true), release: undefined })) })
        .then((result) => {
          if (id !== request.current) return;
          setView((current) => shareAnswered(current, result, all));
          setRelease((current) => current || result.document.package.release);
        })
        .catch((cause) => {
          if (id !== request.current) return;
          setView((current) => shareRefused(current, cause));
        });
    }, 250);
    return () => window.clearTimeout(timer);
    // Text fields do not change the counts; only what goes in does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pictures, skillChoice, includeMemory, includePictures, includePreset, presetPicture]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<ShareResponse>("/api/teams/export", { method: "POST", body: JSON.stringify(shareRequestBody(choices(false))) });
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

  const ticked = tickedSkills(skillChoice, included, available);
  const toggleSkill = (skill: string) => {
    const next = new Set(ticked);
    if (next.has(skill)) next.delete(skill);
    else next.add(skill);
    setSkillChoice(next);
  };
  const field = "mt-1 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13.5px] text-ink disabled:opacity-60";

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="share-team-title" tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel text-ink shadow-2xl outline-none"
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
            <h2 id="share-team-title" className="text-[17px] font-semibold">{t("teamShare.title", { name: team || t("teamLibrary.general") })}</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{t("teamShare.intro")}</p>
          </div>
          <button aria-label={t("teamShare.close")} disabled={saving} onClick={onClose} className="rounded-lg p-1.5 text-ink-secondary hover:bg-raised"><X size={18} /></button>
        </header>

        {saved ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4 pt-2">
            <p className="flex items-center gap-2 text-[13.5px] font-medium text-ink"><Check size={16} className="text-success" />{t("teamShare.saved", { filename: saved.filename })}</p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{t("teamShare.savedHint")}</p>
            <div className="mt-4">
              <ShareTeamContents preview={saved} includeMemory={includeMemory} localSkips={includePictures ? pictures?.skipped ?? [] : []} />
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4 pt-2">
            {preview
              ? <ShareTeamContents preview={preview} includeMemory={includeMemory} localSkips={includePictures ? pictures?.skipped ?? [] : []} />
              : !error && <div className="flex items-center gap-2 py-6 text-[13px] text-ink-secondary"><Loader2 size={15} className="animate-spin" />{t("teamShare.preparing")}</div>}

            <fieldset className="mt-4 space-y-2 text-[13px]" disabled={saving}>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="size-4 accent-accent" checked={includePictures} onChange={(event) => setIncludePictures(event.target.checked)} />
                {t("teamShare.includePictures")}
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="size-4 accent-accent" checked={includeMemory} onChange={(event) => setIncludeMemory(event.target.checked)} />
                {t("teamShare.includeNotes")}
              </label>
              <p className="pl-6 text-[12px] leading-relaxed text-ink-secondary">{notesLine(includeMemory)}</p>
              <ShareSkillChoices available={available ?? []} ticked={ticked} counted={available !== null} onToggle={toggleSkill} />
              <label className="flex items-center gap-2 pt-1">
                <input type="checkbox" className="size-4 accent-accent" checked={includePreset} onChange={(event) => setIncludePreset(event.target.checked)} />
                {t("teamShare.includePreset")}
              </label>
              {includePreset && <p className="pl-6 text-[12px] leading-relaxed text-ink-secondary">{t("teamShare.presetHint")}</p>}
            </fieldset>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block text-[12.5px] text-ink-secondary">{t("teamShare.name")}
                <input value={name} maxLength={100} disabled={saving} onChange={(event) => setName(event.target.value)} className={field} />
              </label>
              <label className="block text-[12.5px] text-ink-secondary">{t("teamShare.release")}
                <input value={release} maxLength={20} disabled={saving} placeholder="1.0.0" onChange={(event) => setRelease(event.target.value)} className={field} />
              </label>
            </div>
            <p className="mt-1 text-[11.5px] text-ink-secondary">{t("teamShare.releaseHint")}</p>
            <label className="mt-3 block text-[12.5px] text-ink-secondary">{t("teamShare.notes")}
              <textarea value={notes} maxLength={4000} rows={2} disabled={saving} onChange={(event) => setNotes(event.target.value)} className={field} />
            </label>
            <label className="mt-3 block text-[12.5px] text-ink-secondary">{t("teamShare.tagline")}
              <input value={tagline} maxLength={160} disabled={saving} onChange={(event) => setTagline(event.target.value)} className={field} />
            </label>
            <label className="mt-3 block text-[12.5px] text-ink-secondary">{t("teamShare.summary")}
              <textarea value={summary} maxLength={2000} rows={2} disabled={saving} onChange={(event) => setSummary(event.target.value)} className={field} />
            </label>
          </div>
        )}

        {error && <p role="alert" className="mx-6 mb-2 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</p>}
        <footer className="flex justify-end gap-2 border-t border-hairline/35 px-6 py-3">
          {saved ? (
            <button onClick={onClose} className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white">{t("teamShare.done")}</button>
          ) : (
            <>
              <button disabled={saving} onClick={onClose} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised">{t("common.cancel")}</button>
              <button disabled={saving || !preview || !name.trim()} onClick={() => void save()}
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
