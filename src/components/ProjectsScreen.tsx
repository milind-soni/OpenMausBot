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
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { ProjectRecord } from "@/types/gbs";
import { cn } from "@/lib/cn";
import { useProjects } from "@/state/projects";
import { api } from "@/state/store";

type AddMode = "choose" | "existing" | "create" | "clone";

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "");
}

function repositoryFolderName(repositoryUrl: string): string {
  return repositoryUrl.trim().replace(/[\\/]$/, "").split(/[\\/:]/).at(-1)?.replace(/\.git$/i, "") ?? "";
}

function childPath(parent: string, name: string): string {
  const separator = window.gbs?.platform === "win32" ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function sourceLabel(project: ProjectRecord): string {
  if (project.source === "github") return "GitHub clone";
  if (project.source === "created") return "Created here";
  return "Existing folder";
}

function AddProjectModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (project: ProjectRecord) => void;
}) {
  const projectsApi = window.gbs?.projects;
  const [mode, setMode] = useState<AddMode>("choose");
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
    finish(api("/api/projects/add-existing", {
      method: "POST",
      body: JSON.stringify({ projectPath: existingPath }),
    }).then((result) => result.project as ProjectRecord));
  };

  const createProject = () => projectsApi
    ? projectsApi.create({ parentPath, name: folderName })
    : api("/api/projects/create", {
      method: "POST",
      body: JSON.stringify({ parentPath, name: folderName }),
    }).then((result) => result.project as ProjectRecord);

  const cloneProject = () => projectsApi
    ? projectsApi.clone({ repositoryUrl, destinationPath })
    : api("/api/projects/clone", {
      method: "POST",
      body: JSON.stringify({ repositoryUrl, destinationPath }),
    }).then((result) => result.project as ProjectRecord);

  const chooseParent = async (forClone = false) => {
    if (!projectsApi) return;
    setError(null);
    const selected = await projectsApi.chooseDirectory({
      title: forClone ? "Choose where to clone the repository" : "Choose a parent folder",
      buttonLabel: "Choose",
    });
    if (!selected) return;
    if (forClone) {
      const repositoryName = repositoryFolderName(repositoryUrl);
      setDestinationPath(repositoryName ? childPath(selected, repositoryName) : selected);
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
              {mode === "choose" ? "Add a project" : mode === "existing" ? "Add an existing folder" : mode === "create" ? "Create a project folder" : "Clone from GitHub"}
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
              <div className="mt-3 text-[14px] font-medium text-ink">Existing folder</div>
              <div className="mt-1 text-[12px] leading-5 text-ink-secondary">Add a project already on this computer.</div>
            </button>
            <button
              onClick={() => setMode("create")}
              className="rounded-xl border border-hairline/50 bg-card p-4 text-left hover:border-accent/60 hover:bg-raised/60"
            >
              <FolderPlus size={22} className="text-accent" />
              <div className="mt-3 text-[14px] font-medium text-ink">New folder</div>
              <div className="mt-1 text-[12px] leading-5 text-ink-secondary">Create a clean project directory.</div>
            </button>
            <button
              onClick={() => setMode("clone")}
              className="rounded-xl border border-hairline/50 bg-card p-4 text-left hover:border-accent/60 hover:bg-raised/60"
            >
              <GitFork size={22} className="text-accent" />
              <div className="mt-3 text-[14px] font-medium text-ink">Clone GitHub</div>
              <div className="mt-1 text-[12px] leading-5 text-ink-secondary">Clone a repository into a chosen path.</div>
            </button>
          </div>
        ) : mode === "existing" ? (
          <form className="mt-4 space-y-4" onSubmit={(event) => { event.preventDefault(); registerExisting(); }}>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-ink">Folder path on the host machine</span>
              <input autoFocus value={existingPath} onChange={(event) => setExistingPath(event.target.value)} placeholder="/absolute/path/to/project" className={inputClass} />
            </label>
            <button type="submit" disabled={busy || !existingPath.trim()} className="flex w-full items-center justify-center rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40">
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
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-ink">Create inside</span>
              <div className="flex gap-2">
                <input value={parentPath} readOnly={!!projectsApi} onChange={(event) => setParentPath(event.target.value)} placeholder={projectsApi ? "Choose a parent folder" : "/absolute/path/to/parent"} className={cn(inputClass, "min-w-0 flex-1")} />
                {projectsApi && <button type="button" onClick={() => void chooseParent()} className="rounded-lg bg-raised px-3 text-[13px] text-ink hover:bg-raised-hover">Browse</button>}
              </div>
            </label>
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
              <span className="mb-1.5 block text-[13px] font-medium text-ink">GitHub repository</span>
              <input
                autoFocus
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                placeholder="https://github.com/owner/repository"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-ink">Destination path</span>
              <div className="flex gap-2">
                <input
                  value={destinationPath}
                  onChange={(event) => setDestinationPath(event.target.value)}
                  placeholder="Choose a location, then edit the final path"
                  className={cn(inputClass, "min-w-0 flex-1")}
                />
                {projectsApi && <button type="button" onClick={() => void chooseParent(true)} className="rounded-lg bg-raised px-3 text-[13px] text-ink hover:bg-raised-hover">Browse</button>}
              </div>
            </label>
            <div className="rounded-lg bg-card px-3 py-2 text-[12px] leading-5 text-ink-secondary">
              Public repositories work immediately. Private repositories use the host machine's Git credential or SSH setup.
            </div>
            <button
              type="submit"
              disabled={busy || !repositoryUrl.trim() || !destinationPath.trim()}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
            >
              {busy && <Loader2 size={15} className="animate-spin" />}
              {busy ? "Cloning repository…" : "Clone project"}
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
  const [adding, setAdding] = useState(false);

  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return projects ?? [];
    return (projects ?? []).filter((project) =>
      `${project.name} #${project.mention} ${project.path} ${project.repositoryUrl ?? ""}`.toLowerCase().includes(needle),
    );
  }, [projects, query]);

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <header
        className="flex h-[64px] shrink-0 items-center justify-between gap-3 border-b border-hairline/40 px-6"
        style={{ WebkitAppRegion: "drag", paddingRight: window.gbs?.platform === "win32" ? 148 : undefined } as CSSProperties}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <FolderKanban size={20} className="shrink-0 text-accent" />
          <div className="min-w-0">
            <h1 className="truncate text-[16px] font-semibold text-ink">Projects</h1>
            <p className="hidden truncate text-[12px] text-ink-secondary sm:block">Local workspaces for your bots and code.</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
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
          <button onClick={() => setAdding(true)} className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white hover:brightness-110">
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
              placeholder="Search projects or paths"
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
            <div className="rounded-2xl border border-dashed border-hairline bg-panel px-6 py-16 text-center">
              <FolderPlus size={32} className="mx-auto text-ink-secondary" />
              <h2 className="mt-4 text-[16px] font-semibold text-ink">
                Bring your first project in
              </h2>
              <p className="mx-auto mt-2 max-w-sm text-[13px] leading-5 text-ink-secondary">
                Add an existing folder, create a fresh workspace, or clone a repository from GitHub. Browser sessions use paths on the host machine.
              </p>
              <button onClick={() => setAdding(true)} className="mt-5 rounded-lg bg-raised px-4 py-2 text-[13px] font-medium text-ink hover:bg-raised-hover">Add a project</button>
            </div>
          ) : visibleProjects.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-ink-secondary">No projects match “{query}”.</div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {visibleProjects.map((project) => (
                <article
                  key={project.id}
                  className={cn(
                    "flex min-w-0 items-center gap-4 rounded-xl border bg-card p-4",
                    project.missing ? "border-warning/35" : "border-hairline/50 hover:border-hairline",
                  )}
                >
                  <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl", project.missing ? "bg-warning/10 text-warning" : "bg-raised text-accent")}>
                    {project.source === "github" ? <GitFork size={21} /> : <FolderOpen size={21} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-[14px] font-semibold text-ink">{project.name}</h2>
                      <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">#{project.mention}</span>
                      {project.missing && <span className="shrink-0 text-[11px] font-medium text-warning">Missing</span>}
                    </div>
                    <div className="mt-0.5 truncate text-[12px] text-ink-secondary" title={project.path}>{project.path}</div>
                    <div className="mt-2 text-[11px] text-ink-secondary">{sourceLabel(project)}</div>
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

      {adding && (
        <AddProjectModal
          onClose={() => setAdding(false)}
          onAdded={(project) => {
            upsert(project);
            setAdding(false);
          }}
        />
      )}
    </main>
  );
}
