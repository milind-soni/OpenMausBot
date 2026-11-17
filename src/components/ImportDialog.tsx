import { useEffect, useId, useRef, useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";

import type { TemplateDetails } from "../../shared/share-card";
import { t } from "@/lib/i18n";
import { addImport, addedLine, folderFiles, previewImport, type ImportSource } from "@/lib/template-share";
import { useStore } from "@/state/store";
import { TemplateDetailsBody, TemplateModal } from "./TemplateCard";

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
              className="h-8 min-w-0 flex-1 rounded-lg border border-hairline bg-inset px-2.5 text-[13px] text-ink focus:border-focus focus:outline-none" />
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
        </form>
      )}
      {error && <p role="alert" dir="auto" className="mt-3 text-[13px] text-danger">{error}</p>}
    </TemplateModal>
  );
}
