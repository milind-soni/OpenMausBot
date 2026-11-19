import { useEffect, useId, useRef, useState } from "react";
import { FolderOpen, Loader2, Trash2 } from "lucide-react";

import type { TeamTemplate, TemplateDetails } from "../../shared/share-card";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { relativeTime } from "@/lib/memory";
import { addImport, addedLine, folderFiles, previewImport, removeTeamTemplate, teamTemplates, type ImportSource } from "@/lib/template-share";
import { useStore } from "@/state/store";
import { SETTINGS_INPUT } from "./SettingsPrimitives";
import { TemplateDetailsBody, TemplateModal, useTeamTemplatesOwner } from "./TemplateCard";

/** "From Acme's templates": each one's name, kind, who added it and when; opening one previews it, and its owner or an
 * admin can remove it. */
function TeamTemplateList({ team, onOpen, disabled }: { team: string; onOpen: (slug: string) => void; disabled: boolean }) {
  const [templates, setTemplates] = useState<TeamTemplate[] | null>(null);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const headingId = useId();
  useEffect(() => {
    let live = true;
    teamTemplates().then((answer) => { if (live) setTemplates(answer.templates); }, () => { if (live) setTemplates([]); });
    return () => { live = false; };
  }, []);
  const remove = async (slug: string) => {
    setRemoving(slug);
    setError("");
    try {
      await removeTeamTemplate(slug);
      setTemplates((current) => (current ?? []).filter((one) => one.slug !== slug));
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("templateImport.failed"));
    } finally {
      setRemoving(null);
    }
  };
  if (!templates?.length) return null;
  return (
    <section aria-labelledby={headingId} data-team-templates className="mt-4">
      <h3 id={headingId} dir="auto" className="text-[13px] font-medium text-ink">{t("templateImport.fromTeam", { team })}</h3>
      <ul className="mt-1.5 flex flex-col">
        {templates.map((one) => (
          <li key={one.slug} data-team-template={one.slug} className="group flex min-w-0 items-center gap-1 rounded-md hover:bg-ink/[0.06]">
            <button type="button" onClick={() => onOpen(one.slug)} disabled={disabled || removing !== null} className="min-w-0 flex-1 px-1.5 py-1.5 text-start">
              <span className="flex min-w-0 items-center gap-2">
                <span dir="auto" className="min-w-0 truncate text-[13px] text-ink">{one.name}</span>
                <span className="ui-chip shrink-0 bg-ink/[0.06] text-ink-secondary">{t(one.scope === "bot" ? "templateImport.kindBot" : "templateImport.kindDepartment")}</span>
              </span>
              <span dir="auto" className="block truncate text-[12px] text-ink-tertiary">
                {one.addedBy ? t("templateImport.addedBy", { name: one.addedBy, when: relativeTime(one.addedAt) }) : t("templateImport.addedAt", { when: relativeTime(one.addedAt) })}
              </span>
            </button>
            <button type="button" onClick={() => void remove(one.slug)} disabled={disabled || removing !== null} aria-label={t("templateImport.remove", { name: one.name })} title={t("templateImport.remove", { name: one.name })}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-tertiary hover:text-ink">
              {removing === one.slug ? <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <Trash2 size={14} aria-hidden="true" />}
            </button>
          </li>
        ))}
      </ul>
      {error && <p role="alert" dir="auto" className="mt-1.5 text-[12px] text-danger">{error}</p>}
    </section>
  );
}

/** Import: paste a GitHub link or choose a folder, see what it brings, then Add. `onAdded` gets the line to show. */
export function ImportDialog({ initialUrl, onClose, onAdded }: { initialUrl?: string; onClose: () => void; onAdded: (line: string) => void }) {
  const { dispatch } = useStore();
  const [url, setUrl] = useState(initialUrl ?? "");
  const [source, setSource] = useState<ImportSource | null>(null);
  const [details, setDetails] = useState<TemplateDetails | null>(null);
  const [busy, setBusy] = useState<"preview" | "add" | null>(null);
  const [error, setError] = useState("");
  const folderInput = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const fieldId = useId();
  const pick = window.ogb?.remoteClient?.active ? undefined : window.ogb?.pickFolder;
  const team = useTeamTemplatesOwner();

  const preview = async (next: ImportSource) => {
    setBusy("preview");
    setError("");
    try {
      setDetails(await previewImport(next));
      setSource(next);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("templateImport.failed"));
    } finally {
      setBusy(null);
    }
  };

  const previewRef = useRef(preview);
  previewRef.current = preview;
  useEffect(() => {
    if (initialUrl?.trim()) void previewRef.current({ url: initialUrl.trim() });
  }, [initialUrl]);

  const chooseFolder = async () => {
    if (!pick) return folderInput.current?.click();
    const path = await pick();
    if (path) await preview({ path });
  };

  const add = async () => {
    if (!source || busy) return;
    setBusy("add");
    setError("");
    try {
      onAdded(addedLine(await addImport(source, dispatch)));
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("templateImport.failed"));
    } finally {
      setBusy(null);
    }
  };

  const back = () => { setDetails(null); setSource(null); setError(""); };
  const spinner = <Loader2 size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />;

  return (
    <TemplateModal title={details ? details.name : t("templateImport.title")} labelledBy={titleId} onClose={() => { if (busy !== "add") onClose(); }}
      footer={details ? <>
        <button type="button" className="ui-button ui-button-md" onClick={back} disabled={busy !== null}>{t("templateImport.back")}</button>
        <button type="button" data-import-add className="ui-button ui-button-md ui-button-primary" onClick={() => void add()} disabled={busy !== null}>
          {busy === "add" && spinner}{t(busy === "add" ? "templateImport.adding" : "templateImport.add")}
        </button>
      </> : <button type="button" className="ui-button ui-button-md" onClick={onClose}>{t("common.cancel")}</button>}>
      {details ? <TemplateDetailsBody details={details} /> : (
        <form data-import-form onSubmit={(event) => { event.preventDefault(); if (url.trim()) void preview({ url: url.trim() }); }}>
          <label htmlFor={fieldId} className="text-[13px] font-medium text-ink">{t("templateImport.linkLabel")}</label>
          <div className="mt-1.5 flex gap-2">
            <input id={fieldId} dir="auto" autoFocus value={url} onChange={(event) => setUrl(event.target.value)} inputMode="url" spellCheck={false}
              className={cn(SETTINGS_INPUT, "min-w-0 flex-1")} />
            <button type="submit" className="ui-button ui-button-md" disabled={!url.trim() || busy !== null}>
              {busy === "preview" && spinner}{t("templateImport.open")}
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary">
            <span>{t("templateImport.or")}</span>
            <button type="button" data-import-folder className="ui-button ui-button-md" onClick={() => void chooseFolder()} disabled={busy !== null}>
              <FolderOpen size={14} aria-hidden="true" />{t("templateImport.chooseFolder")}
            </button>
          </div>
          <input ref={folderInput} type="file" hidden multiple {...{ webkitdirectory: "" }} onChange={(event) => {
            const files = event.currentTarget.files;
            if (!files?.length) return;
            void folderFiles(files).then((read) => preview({ files: read }), (cause: unknown) => setError(cause instanceof Error ? cause.message : t("templateImport.failed")));
            event.currentTarget.value = "";
          }} />
          {team && <TeamTemplateList team={team} disabled={busy !== null} onOpen={(slug) => void preview({ library: slug })} />}
        </form>
      )}
      {error && <p role="alert" dir="auto" className="mt-3 text-[13px] text-danger">{error}</p>}
    </TemplateModal>
  );
}
