import { useEffect, useRef, useState } from "react";
import { FileCode2, FileImage, FileText, FolderOpen, RefreshCw, Search, X } from "lucide-react";
import type { PreviewFileKind, PreviewFileSource } from "@/lib/mobilePreviewUrl";

interface RegisteredProjectSummary {
  id: string;
  name: string;
  path: string;
  available?: boolean;
  missing?: boolean;
}

interface ProjectPreviewFileEntry {
  path: string;
  name: string;
  kind: PreviewFileKind;
  size: number;
}

export interface PreviewFilePickerProps {
  open: boolean;
  onClose: () => void;
  onSelectFile: (source: PreviewFileSource) => void;
  initialProjectId?: string;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function usePreviewAutoRefreshWatcher(
  clientId: string,
  source: { kind: string; projectId?: string; filePath?: string } | null,
  enabled: boolean,
) {
  useEffect(() => {
    const shouldWatch = Boolean(
      enabled && source && source.kind === "file" && source.projectId && source.filePath,
    );

    if (!shouldWatch) {
      void fetch("/api/preview/watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, enabled: false }),
      }).catch(() => {});
      return;
    }

    void fetch("/api/preview/watch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId,
        projectId: source!.projectId,
        path: source!.filePath,
        enabled: true,
      }),
    }).catch(() => {});

    return () => {
      void fetch("/api/preview/watch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, enabled: false }),
      }).catch(() => {});
    };
  }, [clientId, enabled, source]);
}

function fileKindIcon(kind: PreviewFileKind) {
  switch (kind) {
    case "image":
      return <FileImage className="h-3.5 w-3.5 text-accent" />;
    case "markdown":
    case "pdf":
      return <FileText className="h-3.5 w-3.5 text-ink-secondary" />;
    default:
      return <FileCode2 className="h-3.5 w-3.5 text-ink-secondary" />;
  }
}

export function PreviewFilePicker({
  open,
  onClose,
  onSelectFile,
  initialProjectId,
}: PreviewFilePickerProps) {
  const [projects, setProjects] = useState<RegisteredProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(initialProjectId ?? "");
  const [files, setFiles] = useState<ProjectPreviewFileEntry[]>([]);
  const [query, setQuery] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [error, setError] = useState("");

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Focus entry, focus trap, Escape dismissal, and focus return on close
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    searchInputRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (!active || active === first || !dialogRef.current.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else if (!active || active === last || !dialogRef.current.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (previousFocus && typeof previousFocus.focus === "function" && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadingProjects(true);
    setError("");
    fetch("/api/projects")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data?.projects)
          ? data.projects.filter((p: RegisteredProjectSummary) => !p.missing && p.available !== false)
          : [];
        setProjects(list);
        if (list.length > 0) {
          setSelectedProjectId((prev) =>
            prev && list.some((p: RegisteredProjectSummary) => p.id === prev) ? prev : list[0].id,
          );
        }
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load registered projects.");
      })
      .finally(() => {
        if (!cancelled) setLoadingProjects(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !selectedProjectId) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    setLoadingFiles(true);
    setError("");
    fetch(`/api/preview/files?projectId=${encodeURIComponent(selectedProjectId)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Couldn't list project files.");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setFiles(Array.isArray(data?.files) ? data.files : []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't list project files.");
      })
      .finally(() => {
        if (!cancelled) setLoadingFiles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedProjectId]);

  if (!open) return null;

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const filtered = files.filter((file) =>
    query.trim() ? file.path.toLowerCase().includes(query.trim().toLowerCase()) : true,
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Choose a project file to preview"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[480px] w-full max-w-[460px] flex-col overflow-hidden rounded-2xl border border-hairline bg-panel shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-hairline/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-accent" />
            <h3 className="text-[14px] font-semibold text-ink">Choose a project file</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close file picker"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2.5 border-b border-hairline/50 bg-raised/50 px-4 py-3">
          <div>
            <label
              htmlFor="preview-project-select"
              className="mb-1 block text-[11px] font-medium text-ink-secondary"
            >
              Project
            </label>
            <select
              id="preview-project-select"
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              disabled={loadingProjects || projects.length === 0}
              className="h-8 w-full rounded-lg border border-hairline/70 bg-inset px-2.5 text-[12px] text-ink focus:border-accent/60 focus:outline-none"
            >
              {projects.length === 0 ? (
                <option value="">No registered projects found</option>
              ) : (
                projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} ({project.path})
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-secondary" />
            <input
              ref={searchInputRef}
              autoFocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter project files"
              placeholder="Filter HTML, PDF, Markdown, or image files…"
              className="h-8 w-full rounded-lg border border-hairline/70 bg-inset pl-8 pr-3 text-[12px] text-ink placeholder:text-ink-secondary focus:border-accent/60 focus:outline-none"
            />
          </div>
        </div>

        <div className="min-h-[200px] flex-1 overflow-y-auto p-2">
          {loadingProjects || loadingFiles ? (
            <div className="flex h-40 items-center justify-center gap-2 text-[12px] text-ink-secondary">
              <RefreshCw className="h-4 w-4 animate-spin text-accent" />
              Loading project files…
            </div>
          ) : error ? (
            <div className="flex h-40 items-center justify-center px-4 text-center text-[12px] text-danger">
              {error}
            </div>
          ) : projects.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center px-6 text-center text-[12px] text-ink-secondary">
              Add a project folder in Projects first to preview local HTML, PDF, Markdown, or image
              files.
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex h-40 flex-col items-center justify-center px-6 text-center text-[12px] text-ink-secondary">
              No matching previewable files (.html, .pdf, .md, .png, .jpg, .webp, .gif, .svg) in this
              project.
            </div>
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectFile({
                        kind: "file",
                        projectId: selectedProjectId,
                        projectName: selectedProject?.name,
                        filePath: file.path,
                        fileType: file.kind,
                      });
                      onClose();
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-ink transition-colors hover:bg-raised-hover"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {fileKindIcon(file.kind)}
                      <span className="truncate font-mono">{file.path}</span>
                    </span>
                    <span className="shrink-0 rounded bg-inset px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ink-secondary">
                      {file.kind}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
