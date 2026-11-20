import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Download, FileText, Folder, FolderPlus, Image as ImageIcon, Pencil, Trash2, Upload, X } from "lucide-react";

import type { TeamFileView, TeamFilesListing, TeamFilesRefusal } from "../../../shared/team-files";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { relativeTime } from "@/lib/memory";
import type { LocaleKey } from "@/locales";
import { api, ApiError } from "@/state/api";
import { useStore } from "@/state/store";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageActions, ToolPageHeader } from "../ToolPageShell";

// Team files: the Team Cloud's one shared folder (server/routes/team-files.ts), for every teammate and bot. A folder list
// with breadcrumbs, upload by button or drop, new folder, download, rename, delete (an admin anything, a member what they
// uploaded), a preview of text and pictures, who changed each file last, and the space used.

const BASE = "/api/team-files";
const PREVIEW_MAX_BYTES = 1024 * 1024;
const TEXT = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "log"]);
const PICTURE = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const REFUSALS: Partial<Record<TeamFilesRefusal, LocaleKey>> = {
  exists: "teamFiles.error.exists", forbidden: "teamFiles.error.forbidden", not_found: "teamFiles.error.notFound",
  bad_path: "teamFiles.error.badName", link: "teamFiles.error.badName",
};

const extension = (name: string) => (name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "");
export const previewKind = (name: string): "text" | "picture" | null => (TEXT.has(extension(name)) ? "text" : PICTURE.has(extension(name)) ? "picture" : null);
export const fileUrl = (path: string, download = false) => `${BASE}/file?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 ? value : value < 10 ? Number(value.toFixed(1)) : Math.round(value)} ${units[unit]}`;
}

/** "Changed by Mira with Payroll · 2 hr ago", from the last recorded change. */
export function changedLine(entry: Pick<TeamFileView, "last">, now = Date.now()): string | null {
  const last = entry.last;
  if (!last) return null;
  const person = last.person || t("teamFiles.someone"), when = relativeTime(last.at, now);
  if (last.action === "uploaded") return t("teamFiles.uploaded", { person, when });
  if (last.action === "folder") return t("teamFiles.made", { person, when });
  if (last.bot) return last.person ? t("teamFiles.changedWith", { person, bot: last.bot, when }) : t("teamFiles.changedBy", { person: last.bot, when });
  return t("teamFiles.changedBy", { person, when });
}

/** The words for a refusal the routes answered with, in the person's language. */
export function refusalText(error: unknown, limits: { uploadMax: number; cap: number }): string {
  const body = error instanceof ApiError ? error.body : (error as { body?: Record<string, unknown> } | null)?.body;
  const code = typeof body?.code === "string" ? body.code as TeamFilesRefusal : null;
  if (code === "too_large") return t("teamFiles.error.tooLarge", { mb: Math.round(limits.uploadMax / 1024 ** 2) });
  if (code === "full") return t("teamFiles.error.full", { gb: Math.round(limits.cap / 1024 ** 3) });
  return t((code && REFUSALS[code]) || "teamFiles.error.failed");
}

/** One file up, the bytes as the request body. */
async function uploadFile(folder: string, file: File): Promise<void> {
  const res = await fetch(`${BASE}/file?path=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`, {
    method: "PUT", body: file, headers: { "content-type": "application/octet-stream" },
  });
  if (!res.ok) throw new ApiError(`${res.status}`, res.status, await res.json().catch(() => ({})));
}

type Editing = { kind: "folder" } | { kind: "rename"; entry: TeamFileView } | null;
type Preview = { entry: TeamFileView; text?: string; tooLarge?: boolean } | null;

export function TeamFilesPage() {
  const { state, dispatch } = useStore();
  const [folder, setFolder] = useState("");
  const [listing, setListing] = useState<TeamFilesListing | null>(null);
  const [failed, setFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<Preview>(null);
  const back = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const loading = useRef<AbortController | null>(null);
  const limits = { uploadMax: listing?.uploadMax ?? 100 * 1024 ** 2, cap: listing?.cap ?? 5 * 1024 ** 3 };

  const load = useCallback(async (path: string) => {
    loading.current?.abort();
    const controller = new AbortController();
    loading.current = controller;
    try {
      const answer = await api<TeamFilesListing>(`${BASE}?path=${encodeURIComponent(path)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setListing(answer);
      setFailed(false);
    } catch (error) {
      if (controller.signal.aborted) return;
      // A folder someone removed meanwhile: back to the top.
      if (path && error instanceof ApiError && error.status === 404) { setFolder(""); return; }
      setFailed(true);
    }
  }, []);
  useEffect(() => { void load(folder); }, [folder, load]);
  useEffect(() => () => loading.current?.abort(), []);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);

  const act = async (work: () => Promise<unknown>) => {
    setProblem(null);
    try { await work(); } catch (error) { setProblem(refusalText(error, limits)); }
    await load(folder);
  };
  const upload = (files: readonly File[]) => act(async () => {
    try {
      for (const file of files) {
        setUploading(file.name);
        await uploadFile(folder, file);
      }
    } finally {
      setUploading(null);
    }
  });
  const submitName = () => {
    const wanted = name.trim();
    if (!wanted || !editing) return;
    const current = editing;
    setEditing(null);
    void act(() => current.kind === "folder"
      ? api(`${BASE}/folder`, { method: "POST", body: JSON.stringify({ path: join(folder, wanted) }) })
      : api(`${BASE}/rename`, { method: "POST", body: JSON.stringify({ from: current.entry.path, to: join(folder, wanted) }) }));
  };
  const remove = (entry: TeamFileView) => {
    if (!window.confirm(t("teamFiles.deleteConfirm", { name: entry.name }))) return;
    void act(() => api(`${BASE}/delete`, { method: "POST", body: JSON.stringify({ path: entry.path }) }));
  };
  const open = async (entry: TeamFileView) => {
    if (entry.kind === "folder") { setPreview(null); setFolder(entry.path); return; }
    const kind = previewKind(entry.name);
    if (kind !== "text") { setPreview({ entry }); return; }
    if (entry.size > PREVIEW_MAX_BYTES) { setPreview({ entry, tooLarge: true }); return; }
    try {
      const res = await fetch(fileUrl(entry.path));
      setPreview({ entry, text: res.ok ? await res.text() : "" });
    } catch {
      setPreview({ entry, text: "" });
    }
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) void upload(files);
  };
  const crumbs = folder ? folder.split("/") : [];
  const team = state.config?.team?.name ?? "";

  return (
    <ToolPage label={t("teamFiles.title")}>
      <ToolPageHeader backLabel={t("automations.back")} onBack={() => dispatch({ type: "showChat" })} backRef={back}>
        <h1 className={TOOL_PAGE_TITLE}>{t("teamFiles.title")}</h1>
        <ToolPageActions>
          <button type="button" className="ui-button" onClick={() => { setName(""); setEditing({ kind: "folder" }); }}><FolderPlus size={15} />{t("teamFiles.newFolder")}</button>
          <button type="button" className="ui-button ui-button-primary" disabled={uploading !== null} onClick={() => picker.current?.click()}><Upload size={15} />{t("teamFiles.upload")}</button>
          <input ref={picker} type="file" multiple hidden data-testid="team-files-picker" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; if (files.length) void upload(files); }} />
        </ToolPageActions>
      </ToolPageHeader>
      <div
        className={cn("relative min-h-0 flex-1 overflow-y-auto", dragging && "bg-accent/5")}
        data-team-files={listing ? listing.entries.length : "loading"}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
          {team && <p className="mb-3 text-[13px] text-ink-secondary">{t("teamFiles.intro", { team })}</p>}
          <nav aria-label={t("teamFiles.title")} className="mb-3 flex flex-wrap items-center gap-1 text-[14px]">
            <button type="button" className="rounded px-1 text-ink-secondary hover:text-ink" onClick={() => { setPreview(null); setFolder(""); }}>{t("teamFiles.title")}</button>
            {crumbs.map((part, index) => (
              <span key={index} className="flex items-center gap-1">
                <span className="text-ink-secondary">/</span>
                <button type="button" aria-current={index === crumbs.length - 1 ? "page" : undefined} className="rounded px-1 text-ink hover:underline"
                  onClick={() => { setPreview(null); setFolder(crumbs.slice(0, index + 1).join("/")); }}>{part}</button>
              </span>
            ))}
          </nav>
          {listing && <p data-team-files-used={`${listing.used}/${listing.cap}`} className="mb-3 text-[12px] text-ink-secondary">{t("teamFiles.used", { used: formatSize(listing.used), cap: formatSize(listing.cap) })}</p>}
          {uploading && <p role="status" className="mb-2 text-[13px] text-ink-secondary">{t("teamFiles.uploading", { name: uploading })}</p>}
          {problem && <p role="alert" className="mb-2 text-[13px] text-danger">{problem}</p>}
          {editing && (
            <form className="mb-3 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); submitName(); }}>
              <input autoFocus aria-label={t(editing.kind === "folder" ? "teamFiles.folderName" : "teamFiles.newName")} className="min-w-0 flex-1 rounded-lg bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:ring-1 focus:ring-accent" value={name} onChange={(event) => setName(event.target.value)} />
              <button type="submit" className="ui-button ui-button-primary">{t(editing.kind === "folder" ? "teamFiles.create" : "teamFiles.save")}</button>
              <button type="button" className="ui-button" onClick={() => setEditing(null)}>{t("common.cancel")}</button>
            </form>
          )}
          {dragging && <p className="mb-2 text-center text-[13px] text-accent-text">{t("teamFiles.drop")}</p>}
          {failed && !listing ? (
            <section role="alert" className="px-6 py-16 text-center">
              <p className="text-[14px] text-ink-secondary">{t("teamFiles.loadFailed")}</p>
              <button type="button" className="ui-button mt-4" onClick={() => void load(folder)}>{t("common.tryAgain")}</button>
            </section>
          ) : listing && listing.entries.length === 0 ? (
            <section aria-label={t("teamFiles.empty.title")} className="rounded-xl border border-dashed border-hairline px-6 py-12 text-center">
              <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Folder size={20} /></div>
              <h2 className="text-[16px] font-semibold text-ink">{t("teamFiles.empty.title")}</h2>
              <p className="mx-auto mt-1 max-w-sm text-[13px] leading-relaxed text-ink-secondary">{t("teamFiles.empty.body")}</p>
            </section>
          ) : listing ? (
            <ul aria-label={t("teamFiles.title")} className="divide-y divide-hairline/40 overflow-hidden rounded-xl border border-hairline/40 bg-card">
              {listing.entries.map((entry) => {
                const line = changedLine(entry);
                const Icon = entry.kind === "folder" ? Folder : previewKind(entry.name) === "picture" ? ImageIcon : FileText;
                return (
                  <li key={entry.path} data-team-file={entry.path} className="flex items-center gap-3 px-3 py-2.5">
                    <Icon size={18} className="shrink-0 text-ink-secondary" aria-hidden />
                    <button type="button" className="min-w-0 flex-1 text-left" aria-label={t("teamFiles.open", { name: entry.name })} onClick={() => void open(entry)}>
                      <span className="block truncate text-[14px] text-ink">{entry.name}</span>
                      <span className="block truncate text-[12px] text-ink-secondary">{[entry.kind === "file" ? formatSize(entry.size) : "", line].filter(Boolean).join(" · ")}</span>
                    </button>
                    {entry.kind === "file" && <a className="ui-icon-button" href={fileUrl(entry.path, true)} download={entry.name} aria-label={t("teamFiles.download")} title={t("teamFiles.download")}><Download size={15} /></a>}
                    {entry.canDelete && <button type="button" className="ui-icon-button" aria-label={t("teamFiles.rename")} title={t("teamFiles.rename")} onClick={() => { setName(entry.name); setEditing({ kind: "rename", entry }); }}><Pencil size={15} /></button>}
                    {entry.canDelete && <button type="button" className="ui-icon-button" aria-label={t("teamFiles.delete")} title={t("teamFiles.delete")} onClick={() => remove(entry)}><Trash2 size={15} /></button>}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {preview && (
            <section aria-label={preview.entry.name} className="mt-4 rounded-xl border border-hairline/40 bg-card">
              <header className="flex items-center gap-2 border-b border-hairline/40 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{preview.entry.name}</span>
                <a className="ui-icon-button" href={fileUrl(preview.entry.path, true)} download={preview.entry.name} aria-label={t("teamFiles.download")}><Download size={15} /></a>
                <button type="button" className="ui-icon-button" aria-label={t("teamFiles.closePreview")} onClick={() => setPreview(null)}><X size={15} /></button>
              </header>
              <div className="max-h-[60vh] overflow-auto p-3">
                {previewKind(preview.entry.name) === "picture" ? <img src={fileUrl(preview.entry.path)} alt={preview.entry.name} className="mx-auto max-h-[56vh] max-w-full" />
                  : preview.tooLarge ? <p className="text-[13px] text-ink-secondary">{t("teamFiles.previewTooLarge")}</p>
                    : preview.text !== undefined ? <pre data-team-file-preview="" className="whitespace-pre-wrap break-words text-[13px] text-ink">{preview.text}</pre>
                      : <p className="text-[13px] text-ink-secondary">{t("teamFiles.noPreview")}</p>}
              </div>
            </section>
          )}
        </div>
      </div>
    </ToolPage>
  );
}
