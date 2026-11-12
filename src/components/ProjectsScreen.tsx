import { UsageRings } from "./UsageRings";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  GitFork,
  Laptop,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { ProjectRecord } from "@/types/gbs";
import { cn } from "@/lib/cn";
import {
  BROWSER_HOST_FOLDER_HINT,
  applySuggestedFolder,
  childPath,
  getSuggestedProjectFolders,
  projectSourceLabel,
  repositoryFolderName,
} from "@/lib/projectSuggestions";
import { useProjects } from "@/state/projects";
import { api } from "@/state/store";

type AddMode = "choose" | "existing" | "create" | "clone";

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "");
}

function BrowserFolderSuggestions({
  suggestions,
  currentValue,
  onSelect,
}: {
  suggestions: string[];
  currentValue: string;
  onSelect: (folder: string) => void;
}) {
  return (
    <div className="mt-2 rounded-lg border border-hairline/40 bg-card/70 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
        <Laptop size={13} className="shrink-0 text-accent" />
        <span>{BROWSER_HOST_FOLDER_HINT}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium text-ink-tertiary">Suggested folders:</span>
        {suggestions.map((folder) => {
          const active =
            currentValue.trim() === folder ||
            currentValue.trim().startsWith(`${folder}/`) ||
            currentValue.trim().startsWith(`${folder}\\`);
          return (
            <button
              key={folder}
              type="button"
              onClick={() => onSelect(folder)}
              className={cn(
                "rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors",
                active
                  ? "border-accent/50 bg-accent/15 text-accent"
                  : "border-hairline/50 bg-raised/70 text-ink-secondary hover:border-accent/40 hover:text-ink",
              )}
            >
              {folder}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AddProjectModal({
  initialMode = "choose",
  suggestedFolders,
  onClose,
  onAdded,
}: {
  initialMode?: AddMode;
  suggestedFolders: string[];
  onClose: () => void;
  onAdded: (project: ProjectRecord) => void;
}) {
  const projectsApi = window.gbs?.projects;
  const [mode, setMode] = useState<AddMode>(initialMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parentPath, setParentPath] = useState("");
  const [existingPath, setExistingPath] = useState("");
  const [folderName, setFolderName] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [destinationPath, setDestinationPath] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      if (mode === "choose") onClose();
      else {
        setMode("choose");
        setError(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, mode, onClose]);

  const finish = (operation: Promise<ProjectRecord>) => {
    setBusy(true);
    setError(null);
    operation
      .then(onAdded)
      .catch((reason) => setError(errorMessage(reason)))
      .finally(() => setBusy(false));
  };

  const addExisting = async () => {
    if (!projectsApi) {
      setMode("existing");
      return;
    }
    setError(null);
    const projectPath = await projectsApi.chooseDirectory({
      title: "Choose an existing project folder",
      buttonLabel: "Add project",
    });
    if (projectPath) finish(projectsApi.addExisting(projectPath));
  };

  const registerExisting = () => {
    finish(
      api("/api/projects/add-existing", {
        method: "POST",
        body: JSON.stringify({ projectPath: existingPath }),
      }).then((result) => result.project as ProjectRecord),
    );
  };

  const createProject = () =>
    projectsApi
      ? projectsApi.create({ parentPath, name: folderName })
      : api("/api/projects/create", {
          method: "POST",
          body: JSON.stringify({ parentPath, name: folderName }),
        }).then((result) => result.project as ProjectRecord);

  const cloneProject = () =>
    projectsApi
      ? projectsApi.clone({ repositoryUrl, destinationPath })
      : api("/api/projects/clone", {
          method: "POST",
          body: JSON.stringify({ repositoryUrl, destinationPath }),
        }).then((result) => result.project as ProjectRecord);

  const chooseParent = async (forClone = false) => {
    if (!projectsApi) return;
    setError(null);
    const selected = await projectsApi.chooseDirectory({
      title: forClone ? "Choose where to copy the project" : "Choose a parent folder",
      buttonLabel: "Choose",
    });
    if (!selected) return;
    if (forClone) {
      const repositoryName = repositoryFolderName(repositoryUrl);
      setDestinationPath(
        repositoryName ? childPath(selected, repositoryName, window.gbs?.platform) : selected,
      );
    } else {
      setParentPath(selected);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2.5 text-[14px] text-ink placeholder:text-ink-secondary focus:border-accent/70 focus:outline-none";

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/55 p-5"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <div className="animate-pop-in w-full max-w-[560px] rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl shadow-black/60">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {mode !== "choose" && (
              <button
                onClick={() => {
                  setMode("choose");
                  setError(null);
                }}
                disabled={busy}
                className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
                aria-label="Back to project options"
              >
                <ArrowLeft size={17} />
              </button>
            )}
            <h2 className="text-[17px] font-semibold text-ink">
              {mode === "choose"
                ? "Add a project"
                : mode === "existing"
                  ? "Add a folder from your computer"
                  : mode === "create"
                    ? "Create a new project folder"
                    : "Copy a project from GitHub"}
            </h2>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {mode === "choose" ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <button
              onClick={() => void addExisting()}
              className="rounded-xl border border-hairline/50 bg-card p-4 text-left hover:border-accent/60 hover:bg-raised/60"
            >
              <FolderOpen size={22} className="text-accent" />
              <div className="mt-3 text-[14px] font-medium text-ink">Folder on your computer</div>
              <div className="mt-1 text-[12px] leading-5 text-ink-secondary">
                Pick an existing folder where your files live.
              </div>
            </button>
            <button
              onClick={() => setMode("create")}
              className="rounded-xl border border-hairline/50 bg-card p-4 text-left hover:border-accent/60 hover:bg-raised/60"
            >
              <FolderPlus size={22} className="text-accent" />
              <div className="mt-3 text-[14px] font-medium text-ink">New folder</div>
              <div className="mt-1 text-[12px] leading-5 text-ink-secondary">
                Create an empty folder for a new project.
              </div>
            </button>
            <button
              onClick={() => setMode("clone")}
              className="rounded-xl border border-hairline/50 bg-card p-4 text-left hover:border-accent/60 hover:bg-raised/60"
            >
              <GitFork size={22} className="text-accent" />
              <div className="mt-3 text-[14px] font-medium text-ink">From GitHub</div>
              <div className="mt-1 text-[12px] leading-5 text-ink-secondary">
                Copy a project from GitHub to your computer.
              </div>
            </button>
          </div>
        ) : mode === "existing" ? (
          <form
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              registerExisting();
            }}
          >
            <div>
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-ink">
                  Folder location on your computer
                </span>
                <input
                  autoFocus
                  value={existingPath}
                  onChange={(event) => setExistingPath(event.target.value)}
                  placeholder="~/Projects/my-app"
                  className={inputClass}
                />
              </label>
              {!projectsApi && (
                <BrowserFolderSuggestions
                  suggestions={suggestedFolders}
                  currentValue={existingPath}
                  onSelect={(folder) =>
                    setExistingPath(
                      applySuggestedFolder(folder, {
                        mode: "existing",
                        platform: window.gbs?.platform,
                      }),
                    )
                  }
                />
              )}
            </div>
            <button
              type="submit"
              disabled={busy || !existingPath.trim()}
              className="flex w-full items-center justify-center rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
            >
              Add project
            </button>
          </form>
        ) : mode === "create" ? (
          <form
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              finish(createProject());
            }}
          >
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-ink">Folder name</span>
              <input
                autoFocus
                value={folderName}
                onChange={(event) => setFolderName(event.target.value)}
                placeholder="my-project"
                className={inputClass}
              />
            </label>
            <div>
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-ink">
                  Where to create it
                </span>
                <div className="flex gap-2">
                  <input
                    value={parentPath}
                    readOnly={!!projectsApi}
                    onChange={(event) => setParentPath(event.target.value)}
                    placeholder={projectsApi ? "Choose a parent folder" : "~/Projects"}
                    className={cn(inputClass, "min-w-0 flex-1")}
                  />
                  {projectsApi && (
                    <button
                      type="button"
                      onClick={() => void chooseParent()}
                      className="rounded-lg bg-raised px-3 text-[13px] text-ink hover:bg-raised-hover"
                    >
                      Browse
                    </button>
                  )}
                </div>
              </label>
              {!projectsApi && (
                <BrowserFolderSuggestions
                  suggestions={suggestedFolders}
                  currentValue={parentPath}
                  onSelect={(folder) =>
                    setParentPath(
                      applySuggestedFolder(folder, {
                        mode: "create",
                        platform: window.gbs?.platform,
                      }),
                    )
                  }
                />
              )}
            </div>
            <button
              type="submit"
              disabled={busy || !folderName.trim() || !parentPath}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
            >
              {busy && <Loader2 size={15} className="animate-spin" />}
              Create project
            </button>
          </form>
        ) : (
          <form
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              finish(cloneProject());
            }}
          >
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-ink">GitHub web link</span>
              <input
                autoFocus
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                placeholder="https://github.com/organization/project"
                className={inputClass}
              />
            </label>
            <div>
              <label className="block">
                <span className="mb-1.5 block text-[13px] font-medium text-ink">
                  Where to save on your computer
                </span>
                <div className="flex gap-2">
                  <input
                    value={destinationPath}
                    onChange={(event) => setDestinationPath(event.target.value)}
                    placeholder="Choose a folder to save this project into"
                    className={cn(inputClass, "min-w-0 flex-1")}
                  />
                  {projectsApi && (
                    <button
                      type="button"
                      onClick={() => void chooseParent(true)}
                      className="rounded-lg bg-raised px-3 text-[13px] text-ink hover:bg-raised-hover"
                    >
                      Browse
                    </button>
                  )}
                </div>
              </label>
              {!projectsApi && (
                <BrowserFolderSuggestions
                  suggestions={suggestedFolders}
                  currentValue={destinationPath}
                  onSelect={(folder) =>
                    setDestinationPath(
                      applySuggestedFolder(folder, {
                        mode: "clone",
                        repositoryUrl,
                        platform: window.gbs?.platform,
                      }),
                    )
                  }
                />
              )}
            </div>
            <div className="rounded-lg bg-card px-3 py-2 text-[12px] leading-5 text-ink-secondary">
              Public projects download right away. For private projects, your computer must already have permission to access them.
            </div>
            <button
              type="submit"
              disabled={busy || !repositoryUrl.trim() || !destinationPath.trim()}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
            >
              {busy && <Loader2 size={15} className="animate-spin" />}
              {busy ? "Copying project…" : "Copy project"}
            </button>
          </form>
        )}

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span className="whitespace-pre-line">{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function ProjectsScreen() {
  const projectsApi = window.gbs?.projects;
  const { projects, error, refreshing, refresh, upsert, open } = useProjects();
  const [query, setQuery] = useState("");
  const [addingMode, setAddingMode] = useState<AddMode | null>(null);

  const suggestedFolders = useMemo(() => getSuggestedProjectFolders(projects), [projects]);

  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects ?? [];
    return (projects ?? []).filter((project) =>
      `${project.name} #${project.mention} ${project.path} ${project.repositoryUrl ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [projects, query]);

  const startQuickExisting = async () => {
    if (!projectsApi) {
      setAddingMode("existing");
      return;
    }
    const projectPath = await projectsApi.chooseDirectory({
      title: "Choose an existing project folder",
      buttonLabel: "Add project",
    });
    if (projectPath) {
      const created = await projectsApi.addExisting(projectPath);
      upsert(created);
    }
  };

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <header
        className="flex h-[64px] shrink-0 items-center justify-between gap-3 border-b border-hairline/40 px-6"
        style={
          {
            WebkitAppRegion: "drag",
            paddingRight: window.gbs?.platform === "win32" ? 148 : undefined,
          } as CSSProperties
        }
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <FolderKanban size={20} className="shrink-0 text-accent" />
          <div className="min-w-0">
            <h1 className="truncate text-[16px] font-semibold text-ink">Projects</h1>
            <p className="hidden truncate text-[12px] text-ink-secondary sm:block">
              Workspaces where your bots read, write, and create files.
            </p>
          </div>
        </div>
        <div
          className="flex shrink-0 items-center gap-2"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          <UsageRings />
          <button
            onClick={() => void refresh(true)}
            disabled={refreshing}
            className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
            title="Refresh projects"
            aria-label="Refresh projects"
          >
            <RefreshCw size={17} className={cn(refreshing && "animate-spin")} />
          </button>
          <button
            onClick={() => setAddingMode("choose")}
            className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:brightness-110"
          >
            <Plus size={16} /> Add project
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-5xl">
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-hairline/40 bg-panel px-3 py-2.5">
            <Search size={16} className="text-ink-secondary" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects or folder locations"
              aria-label="Search projects"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-[13px] text-danger">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}

          {projects === null ? (
            <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-ink-secondary">
              <Loader2 size={16} className="animate-spin" /> Loading projects…
            </div>
          ) : projects.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-hairline bg-panel px-6 py-14 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-accent/12 text-accent">
                <FolderPlus size={24} />
              </div>
              <h2 className="mt-4 text-[16px] font-semibold text-ink">
                Bring your first project in
              </h2>
              <p className="mx-auto mt-2 max-w-md text-[13px] leading-5 text-ink-secondary">
                Add a folder from your computer, create a new one, or copy a project from GitHub to give your bots a workspace.
              </p>
              {!projectsApi && (
                <p className="mx-auto mt-1.5 text-[12px] text-ink-tertiary">
                  {BROWSER_HOST_FOLDER_HINT}
                </p>
              )}
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
                <button
                  onClick={() => setAddingMode("choose")}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white shadow-sm hover:brightness-110"
                >
                  <Plus size={15} /> Add a project
                </button>
              </div>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <span className="text-[11px] font-medium text-ink-tertiary">Quick start:</span>
                <button
                  type="button"
                  onClick={() => void startQuickExisting()}
                  className="inline-flex items-center gap-1.5 rounded-full border border-hairline/50 bg-card px-3 py-1.5 text-[12px] text-ink-secondary transition-colors hover:border-accent/50 hover:bg-raised hover:text-ink"
                >
                  <FolderOpen size={13} className="text-accent" />
                  Folder on your computer
                </button>
                <button
                  type="button"
                  onClick={() => setAddingMode("create")}
                  className="inline-flex items-center gap-1.5 rounded-full border border-hairline/50 bg-card px-3 py-1.5 text-[12px] text-ink-secondary transition-colors hover:border-accent/50 hover:bg-raised hover:text-ink"
                >
                  <FolderPlus size={13} className="text-accent" />
                  New folder
                </button>
                <button
                  type="button"
                  onClick={() => setAddingMode("clone")}
                  className="inline-flex items-center gap-1.5 rounded-full border border-hairline/50 bg-card px-3 py-1.5 text-[12px] text-ink-secondary transition-colors hover:border-accent/50 hover:bg-raised hover:text-ink"
                >
                  <GitFork size={13} className="text-accent" />
                  From GitHub
                </button>
              </div>
            </div>
          ) : visibleProjects.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-ink-secondary">
              No projects match “{query}”.
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {visibleProjects.map((project) => (
                <article
                  key={project.id}
                  className={cn(
                    "flex min-w-0 items-center gap-4 rounded-xl border bg-card p-4",
                    project.missing
                      ? "border-warning/35"
                      : "border-hairline/50 hover:border-hairline",
                  )}
                >
                  <div
                    className={cn(
                      "flex size-11 shrink-0 items-center justify-center rounded-xl",
                      project.missing ? "bg-warning/10 text-warning" : "bg-raised text-accent",
                    )}
                  >
                    {project.source === "github" ? (
                      <GitFork size={21} />
                    ) : (
                      <FolderOpen size={21} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-[14px] font-semibold text-ink">
                        {project.name}
                      </h2>
                      <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">
                        #{project.mention}
                      </span>
                      {project.missing && (
                        <span className="shrink-0 text-[11px] font-medium text-warning">
                          Missing
                        </span>
                      )}
                    </div>
                    <div
                      className="mt-0.5 truncate text-[12px] text-ink-secondary"
                      title={project.path}
                    >
                      {project.path}
                    </div>
                    <div className="mt-2 text-[11px] text-ink-secondary">
                      {projectSourceLabel(project)}
                    </div>
                  </div>
                  {projectsApi && (
                    <button
                      onClick={() => void open(project).catch(() => undefined)}
                      disabled={project.missing}
                      className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-30"
                      title="Open project folder"
                    >
                      <ExternalLink size={17} />
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </div>

      {addingMode && (
        <AddProjectModal
          initialMode={addingMode}
          suggestedFolders={suggestedFolders}
          onClose={() => setAddingMode(null)}
          onAdded={(project) => {
            upsert(project);
            setAddingMode(null);
          }}
        />
      )}
    </main>
  );
}
