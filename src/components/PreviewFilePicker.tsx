import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FolderOpen, RefreshCw, Search, X } from "lucide-react";
import { ProjectFileIcon } from "./ProjectFileIcon";
import { buildFileTree, visibleTreeRows } from "@/lib/fileTree";
import { cn } from "@/lib/cn";
import type { PreviewFileKind, PreviewFileSource } from "@/lib/mobilePreviewUrl";
import { useDialogFocus } from "@/lib/dialogFocus";

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
  triggerRef?: React.RefObject<HTMLElement | null> | HTMLElement | null;
}

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PreviewFilePicker({
  open,
  onClose,
  onSelectFile,
  initialProjectId,
  triggerRef,
}: PreviewFilePickerProps) {
  const [projects, setProjects] = useState<RegisteredProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(initialProjectId ?? "");
  const [files, setFiles] = useState<ProjectPreviewFileEntry[]>([]);
  const [query, setQuery] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Focus entry, focus trap, Escape dismissal, and focus return on close
  useDialogFocus({
    open,
    containerRef: dialogRef,
    entryFocusRef: searchInputRef,
    triggerRef,
    onClose,
  });

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

  useEffect(() => {
    setExpanded(new Set());
    setFocusedPath(null);
  }, [selectedProjectId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? files.filter((file) => file.path.toLowerCase().includes(q)) : files;
  }, [files, query]);
  const tree = useMemo(() => buildFileTree(filtered), [filtered]);
  const filtering = query.trim().length > 0;
  const rows = useMemo(
    () => visibleTreeRows(tree, (path) => filtering || expanded.has(path)),
    [tree, expanded, filtering],
  );

  if (!open) return null;

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const toggleFolder = (path: string, force?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (force ?? !next.has(path)) next.add(path);
      else next.delete(path);
      return next;
    });
  const chooseFile = (file: ProjectPreviewFileEntry) => {
    onSelectFile({
      kind: "file",
      projectId: selectedProjectId,
      projectName: selectedProject?.name,
      filePath: file.path,
      fileType: file.kind,
    });
    onClose();
  };
  const activePath = rows.some((r) => r.node.path === focusedPath) ? focusedPath : rows[0]?.node.path ?? null;
  const moveFocus = (path: string | null | undefined) => {
    if (!path) return;
    setFocusedPath(path);
    rowRefs.current.get(path)?.focus();
  };
  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    const index = rows.findIndex((r) => r.node.path === activePath);
    const row = rows[index];
    if (!row) return;
    const isOpen = row.node.type === "folder" && (filtering || expanded.has(row.node.path));
    if (e.key === "ArrowDown") moveFocus(rows[Math.min(rows.length - 1, index + 1)]?.node.path);
    else if (e.key === "ArrowUp") moveFocus(rows[Math.max(0, index - 1)]?.node.path);
    else if (e.key === "Home") moveFocus(rows[0]?.node.path);
    else if (e.key === "End") moveFocus(rows[rows.length - 1]?.node.path);
    else if (e.key === "ArrowRight" && row.node.type === "folder") {
      if (isOpen) moveFocus(rows[index + 1]?.node.path);
      else toggleFolder(row.node.path, true);
    } else if (e.key === "ArrowLeft") {
      if (isOpen && !filtering) toggleFolder(row.node.path, false);
      else moveFocus(row.parentPath);
    } else if (e.key === "Enter" || e.key === " ") {
      if (row.node.type === "file") chooseFile(row.node.file);
      else if (!filtering) toggleFolder(row.node.path);
    } else return;
    e.preventDefault();
  };

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
                  <option key={project.id} value={project.id} title={project.path}>
                    {project.name}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-secondary" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter project files"
              placeholder="Search HTML, PDF, Markdown, text or image files…"
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
              No matching previewable files (.html, .pdf, .md, .txt, .png, .jpg, .webp, .gif, .svg) in this
              project.
            </div>
          ) : (
            <div role="tree" aria-label={`Files in ${selectedProject?.name ?? "project"}`} onKeyDown={onTreeKeyDown} className="py-0.5">
              {rows.map(({ node, depth }) => {
                const isActive = node.path === activePath;
                const isOpen = node.type === "folder" && (filtering || expanded.has(node.path));
                return (
                  <div
                    key={`${node.type}:${node.path}`}
                    ref={(el) => {
                      if (el) rowRefs.current.set(node.path, el);
                      else rowRefs.current.delete(node.path);
                    }}
                    role="treeitem"
                    aria-level={depth + 1}
                    aria-expanded={node.type === "folder" ? isOpen : undefined}
                    aria-selected={isActive}
                    tabIndex={isActive ? 0 : -1}
                    onFocus={() => setFocusedPath(node.path)}
                    onClick={() => (node.type === "file" ? chooseFile(node.file) : !filtering && toggleFolder(node.path))}
                    title={node.type === "file" ? node.path : undefined}
                    style={{ paddingLeft: 8 + depth * 16 }}
                    className={cn(
                      "group flex h-8 cursor-pointer items-center gap-1.5 rounded-md pr-2.5 text-[12.5px] outline-none transition-colors",
                      "hover:bg-raised-hover focus-visible:bg-raised-hover focus-visible:ring-1 focus-visible:ring-accent/60",
                      node.type === "folder" ? "text-ink" : "text-ink/90",
                    )}
                  >
                    {node.type === "folder" ? (
                      <>
                        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-ink-secondary transition-transform", isOpen && "rotate-90")} />
                        <ProjectFileIcon kind="folder" open={isOpen} />
                        <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
                        <span className="shrink-0 text-[10.5px] tabular-nums text-ink-secondary">{node.fileCount}</span>
                      </>
                    ) : (
                      <>
                        <span className="w-3.5 shrink-0" aria-hidden="true" />
                        <ProjectFileIcon kind={node.file.kind} />
                        <span className="min-w-0 flex-1 truncate">{node.name}</span>
                        <span className="shrink-0 text-[10.5px] tabular-nums text-ink-secondary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                          {formatSize(node.file.size)}
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
